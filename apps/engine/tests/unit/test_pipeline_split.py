"""`channels=split`: one speaker per channel, speech segments as windows, chained prompts, the language probe."""

import asyncio
import json
import math
import os
import tempfile
import threading
import time
from collections.abc import Callable
from pathlib import Path

import numpy as np
import pytest
from audio_tools import make_media, make_stereo, nonzero_runs
from fake_speech import FakeSpeech, Forced, Seen, error_body, reply

from aftertalk.audio.windows import max_window_seconds
from aftertalk.models.connections import SpeechConnection
from aftertalk.models.errors import EngineError
from aftertalk.models.transcript import Speaker, Transcript
from aftertalk.models.usage import JobLimits
from aftertalk.pipeline import PipelineEvent, TimesUnavailable, TranscribeOptions, TranscribeResult, transcribe_file
from aftertalk.pipeline.transcribe import CHAIN_CHARS, PROBE_WINDOWS, _has_real_text
from aftertalk.providers.net import make_client
from aftertalk.providers.speech.openai_compatible import OpenAICompatibleSpeech

Key = tuple[int, int]  # (channel, index of the speech segment within its channel)
Spans = list[tuple[float, float]]


# ---- helpers ----


def value_of(channel: int, index: int) -> int:
    """The constant sample value of a channel's speech segment: what tells an upload apart."""
    return 1000 * (channel + 1) + 100 * (index + 1)


def call(path: Path, left: Spans, right: Spans, *, seconds: float) -> Path:
    """A stereo call whose speech segments (seconds) carry their own sample value (`value_of`)."""
    return make_stereo(
        path,
        [(a, b, value_of(0, i)) for i, (a, b) in enumerate(left)],
        [(a, b, value_of(1, i)) for i, (a, b) in enumerate(right)],
        seconds=seconds,
    )


def key_of(seen: Seen) -> Key:
    assert seen.file is not None
    data = np.frombuffer(seen.file.data[44:], dtype="<i2")  # after the WAV header
    values = set(data.tolist())
    assert len(values) == 1, "an upload is exactly one speech segment of one channel"
    (value,) = values
    return value // 1000 - 1, (value % 1000) // 100 - 1


def keys(fake: FakeSpeech) -> list[Key]:
    return [key_of(seen) for seen in fake.seen]


def by_key(fake: FakeSpeech) -> dict[Key, Seen]:
    out: dict[Key, Seen] = {}
    for seen in fake.seen:
        key = key_of(seen)
        assert key not in out, f"{key} was sent twice"
        out[key] = seen
    return out


def default_answer(channel: int, index: int) -> Forced:
    return reply([f"c{channel}w{index}"])


def serve(fake: FakeSpeech, answer: Callable[[int, int], Forced] = default_answer) -> None:
    """Answer each request by what it uploads, not by arrival order: the two channels run concurrently."""

    def _answer(seen: Seen) -> Forced:
        return answer(*key_of(seen))

    fake._answer = _answer  # type: ignore[method-assign]


def answer_with(answers: dict[Key, Forced], *, delays: dict[Key, float] | None = None) -> Callable[[int, int], Forced]:
    def answer(channel: int, index: int) -> Forced:
        if delays and (channel, index) in delays:
            time.sleep(delays[(channel, index)])
        return answers.get((channel, index)) or default_answer(channel, index)

    return answer


def timed(*words: tuple[str, float, float], language: str = "polish", logprob: float | None = None) -> Forced:
    """A verbose answer: one segment over these words, word times relative to the upload."""
    text = " ".join(w for w, _, _ in words)
    segment: dict = {"id": 0, "start": words[0][1], "end": words[-1][2], "text": f" {text}"}
    if logprob is not None:
        segment["avg_logprob"] = logprob
    data = {
        "text": text,
        "language": language,
        "segments": [segment],
        "words": [{"word": w, "start": a, "end": b} for w, a, b in words],
    }
    return Forced(200, json.dumps(data))


def empty(language: str | None = None) -> Forced:
    """An answer without text (and without times)."""
    data: dict = {"text": ""}
    if language is not None:
        data["language"] = language
    return Forced(200, json.dumps(data))


def text_only(text: str, language: str = "polish") -> Forced:
    """An answer with text and no times (`timing` none)."""
    return Forced(200, json.dumps({"text": text, "language": language}))


def split(**kwargs: object) -> TranscribeOptions:
    return TranscribeOptions(channels="split", audio_format="wav", **kwargs)  # type: ignore[arg-type]


class Detector:
    """`nonzero_runs`, counting the channels it was asked about."""

    def __init__(self, inner: Callable[[np.ndarray, float], list[tuple[int, int]]] = nonzero_runs) -> None:
        self.calls = 0
        self.inner = inner

    def __call__(self, samples: np.ndarray, longest: float, stop: object = None) -> list[tuple[int, int]]:
        self.calls += 1
        return self.inner(samples, longest)


async def run(
    fake: FakeSpeech,
    path: Path,
    options: TranscribeOptions | None = None,
    *,
    detector: Callable[[np.ndarray, float], list[tuple[int, int]]] = nonzero_runs,
    limits: JobLimits | None = None,
    events: list[PipelineEvent] | None = None,
    max_upload_bytes: int | None = None,
) -> TranscribeResult:
    conn = SpeechConnection.model_validate({"base_url": fake.base_url, "model": "whisper-1"})
    async with make_client(block_private=False) as client:
        speech = OpenAICompatibleSpeech(conn, client, retry_waits=(0.0, 0.0), max_upload_bytes=max_upload_bytes)
        return await transcribe_file(
            path,
            speech,
            options or split(),
            limits,
            None if events is None else events.append,
            detector=detector,
        )


async def fails(
    fake: FakeSpeech, path: Path, options: TranscribeOptions | None = None, **kwargs: object
) -> EngineError:
    with pytest.raises(EngineError) as info:
        await run(fake, path, options, **kwargs)  # type: ignore[arg-type]
    err = info.value
    assert err.__cause__ is None and err.__context__ is None
    return err


@pytest.fixture
def two(tmp_path: Path) -> Path:
    """Customer at 1-2 s on channel 0, agent at 3-4 s on channel 1."""
    return call(tmp_path / "two.wav", [(1.0, 2.0)], [(3.0, 4.0)], seconds=5.0)


@pytest.fixture
def chained(tmp_path: Path) -> Path:
    """Three speech segments on channel 0, two on channel 1."""
    return call(tmp_path / "chain.wav", [(0.0, 1.0), (2.0, 3.0), (4.0, 5.0)], [(6.0, 7.0), (8.0, 9.0)], seconds=10.0)


@pytest.fixture
def six(tmp_path: Path) -> Path:
    """Six speech segments. In time order: c0w0 (1 s), c1w0 (2.5 s), c0w1 (1.5 s), c1w1, c0w2 (1 s each) are the
    first five; c1w2 (4 s, the longest of the call) is the sixth."""
    return call(
        tmp_path / "six.wav",
        [(0.0, 1.0), (4.0, 5.5), (8.0, 9.0)],
        [(2.0, 4.5), (6.0, 7.0), (10.0, 14.0)],
        seconds=15.0,
    )


# ---- speakers ----


async def test_split_has_one_speaker_per_channel_customer_first(fake_speech: FakeSpeech, two: Path) -> None:
    serve(fake_speech)
    events: list[PipelineEvent] = []
    result = await run(fake_speech, two, events=events)
    t = result.transcript
    assert t.speakers == [
        Speaker(id="s1", label="Customer", role="customer", channel=0),
        Speaker(id="s2", label="Agent", role="agent", channel=1),
    ]
    assert [(s.speaker, s.text, s.start) for s in t.segments] == [("s1", "c0w0", 1.0), ("s2", "c1w0", 3.0)]
    assert t.text == "c0w0 c1w0" and t.language == "pl" and t.timing == "word"
    assert t.source is not None and (t.source.channel_mode, t.source.channels) == ("split", 2)
    assert [u.step for u in result.usage] == ["decode", "vad", "transcribe"]
    assert result.usage[1].provider is None and result.usage[1].audio_seconds is None
    assert result.usage[2].requests == 2 and result.usage[2].audio_seconds == pytest.approx(2.0)
    assert result.dropped_segments == 0
    assert [(e.step, e.kind) for e in events][:4] == [
        ("decode", "started"),
        ("decode", "finished"),
        ("vad", "started"),
        ("vad", "finished"),
    ]
    assert (events[-1].step, events[-1].kind, events[-1].windows_done, events[-1].windows_total) == (
        "transcribe",
        "finished",
        2,
        2,
    )


async def test_split_labels_come_from_the_options(fake_speech: FakeSpeech, two: Path) -> None:
    serve(fake_speech)
    t = (await run(fake_speech, two, split(labels=["Anna", "Bob"]))).transcript
    assert [(s.label, s.role) for s in t.speakers] == [("Anna", "customer"), ("Bob", "agent")]


async def test_split_a_speaker_without_a_role_is_speaker_n(fake_speech: FakeSpeech, two: Path) -> None:
    serve(fake_speech)
    t = (await run(fake_speech, two, split(roles=[None, "customer"]))).transcript
    assert [(s.id, s.label, s.role, s.channel) for s in t.speakers] == [
        ("s1", "Speaker 1", None, 0),
        ("s2", "Customer", "customer", 1),
    ]
    t = (await run(fake_speech, two, split(roles=["agent", None]))).transcript
    assert [(s.label, s.role) for s in t.speakers] == [("Agent", "agent"), ("Speaker 2", None)]


# ---- chains ----


async def test_each_request_gets_the_previous_text_of_its_own_channel(fake_speech: FakeSpeech, chained: Path) -> None:
    serve(fake_speech)
    await run(fake_speech, chained, split(language="pl", prompt="Kenobi"))
    sent = by_key(fake_speech)
    assert {key: seen.values("prompt") for key, seen in sent.items()} == {
        (0, 0): ["Kenobi"],
        (0, 1): ["Kenobi c0w0"],
        (0, 2): ["Kenobi c0w0 c0w1"],
        (1, 0): ["Kenobi"],  # channels do not share a chain
        (1, 1): ["Kenobi c1w0"],
    }


async def test_without_a_callers_prompt_the_first_request_of_a_channel_has_none(
    fake_speech: FakeSpeech, chained: Path
) -> None:
    serve(fake_speech)
    await run(fake_speech, chained, split(language="pl"))
    sent = by_key(fake_speech)
    assert {key: seen.values("prompt") for key, seen in sent.items()} == {
        (0, 0): [],
        (0, 1): ["c0w0"],
        (0, 2): ["c0w0 c0w1"],
        (1, 0): [],
        (1, 1): ["c1w0"],
    }


async def test_a_long_chain_is_cut_to_its_last_500_characters(fake_speech: FakeSpeech, chained: Path) -> None:
    words = [f"word{i:03d}" for i in range(120)]  # 959 characters
    serve(fake_speech, answer_with({(0, 0): reply(words, step=0.005)}))
    await run(fake_speech, chained, split(language="pl", prompt="Kenobi"))
    sent = by_key(fake_speech)
    text = " ".join(words)
    assert CHAIN_CHARS == 500
    assert sent[(0, 1)].values("prompt") == [text[-500:]]
    assert sent[(0, 2)].values("prompt") == [f"{text} c0w1"[-500:]]
    assert sent[(1, 1)].values("prompt") == ["Kenobi c1w0"]


# ---- language ----


async def test_the_longest_of_the_first_five_windows_is_probed_first_and_reused(
    fake_speech: FakeSpeech, six: Path
) -> None:
    serve(fake_speech)
    result = await run(fake_speech, six, split(prompt="Kenobi"))
    order = keys(fake_speech)
    assert order[0] == (1, 0)  # 2.5 s: the longest of the first five (not c1w2, the sixth)
    probe = fake_speech.seen[0]
    assert probe.values("language") == [] and probe.values("prompt") == ["Kenobi"]
    assert len(order) == 6 and len(set(order)) == 6  # the probe's answer is reused, never sent again
    assert [seen.values("language") for seen in fake_speech.seen[1:]] == [["pl"]] * 5
    sent = by_key(fake_speech)
    assert sent[(1, 1)].values("prompt") == ["Kenobi c1w0"]  # the probe's text starts its channel's chain
    assert result.transcript.language == "pl"
    assert result.usage[-1].requests == 6


async def test_a_probe_without_text_tries_the_next_longest(fake_speech: FakeSpeech, six: Path) -> None:
    serve(fake_speech, answer_with({(1, 0): empty()}))
    result = await run(fake_speech, six, split(prompt="Kenobi"))
    order = keys(fake_speech)
    assert order[:2] == [(1, 0), (0, 1)]  # 2.5 s, then 1.5 s
    assert [seen.values("language") for seen in fake_speech.seen[:2]] == [[], []]
    assert fake_speech.seen[1].values("prompt") == ["Kenobi"]  # only the caller's prompt, not a chain
    assert [seen.values("language") for seen in fake_speech.seen[2:]] == [["pl"]] * 4
    assert len(order) == 6 and len(set(order)) == 6
    sent = by_key(fake_speech)
    assert sent[(0, 2)].values("prompt") == ["Kenobi c0w0 c0w1"]  # the reused probe answer is in the chain
    assert sent[(1, 1)].values("prompt") == ["Kenobi"]  # the empty answer adds nothing
    assert result.transcript.language == "pl"


async def test_an_answer_that_fails_the_score_rules_does_not_decide_the_language(
    fake_speech: FakeSpeech, six: Path
) -> None:
    hold_music = timed(("Dziękuję.", 0.0, 2.0), language="ukrainian", logprob=-0.9)
    serve(fake_speech, answer_with({(1, 0): hold_music}))
    result = await run(fake_speech, six, split(allowed_languages=["pl", "en"]))
    assert keys(fake_speech)[:2] == [(1, 0), (0, 1)]
    assert [seen.values("language") for seen in fake_speech.seen] == [[], []] + [["pl"]] * 4
    assert result.transcript.language == "pl"
    assert result.dropped_segments == 1  # the filter drops it afterwards
    assert "Dziękuję." not in result.transcript.text


async def test_an_answer_without_text_never_fails_on_its_language(fake_speech: FakeSpeech, six: Path) -> None:
    serve(fake_speech, answer_with({(1, 0): empty(None), (0, 1): empty("ukrainian")}))
    result = await run(fake_speech, six, split(allowed_languages=["pl", "en"]))
    assert keys(fake_speech)[:3] == [(1, 0), (0, 1), (0, 0)]
    assert [seen.values("language") for seen in fake_speech.seen] == [[], [], []] + [["pl"]] * 3
    assert result.transcript.language == "pl"


async def test_a_language_that_is_not_allowed_fails_on_the_probe(fake_speech: FakeSpeech, six: Path) -> None:
    serve(fake_speech, answer_with({(1, 0): reply(["Привіт"], language="ukrainian")}))
    err = await fails(fake_speech, six, split(allowed_languages=["pl", "en"]))
    assert err.code == "language_not_allowed" and err.detected_language == "uk"
    assert len(fake_speech.seen) == 1  # the later windows were never sent
    assert err.usage is not None and err.usage.step == "transcribe" and err.usage.requests == 1


async def test_no_language_reported_with_several_allowed_fails_on_the_probe(fake_speech: FakeSpeech, six: Path) -> None:
    serve(fake_speech, answer_with({(1, 0): reply(["hello"], language=None)}))
    err = await fails(fake_speech, six, split(allowed_languages=["pl", "en"]))
    assert err.code == "language_not_allowed" and err.detected_language is None
    assert len(fake_speech.seen) == 1


async def test_split_one_allowed_language_is_forced_on_every_window(fake_speech: FakeSpeech, six: Path) -> None:
    serve(fake_speech, answer_with({(1, 0): reply(["hello"], language="english")}))
    result = await run(fake_speech, six, split(allowed_languages=["pl", "PL"], prompt="Kenobi"))
    assert [seen.values("language") for seen in fake_speech.seen] == [["pl"]] * 6
    sent = by_key(fake_speech)
    assert sent[(1, 0)].values("prompt") == ["Kenobi"] and sent[(1, 1)].values("prompt") == ["Kenobi hello"]
    assert result.transcript.language == "pl"


async def test_split_a_forced_language_skips_the_probe(fake_speech: FakeSpeech, six: Path) -> None:
    serve(fake_speech)
    result = await run(fake_speech, six, split(language="English"))
    assert [seen.values("language") for seen in fake_speech.seen] == [["en"]] * 6
    assert keys(fake_speech)[0][1] == 0  # each channel starts at its first window, not at the longest
    assert result.transcript.language == "en"


# ---- no speech ----


async def test_a_file_without_speech_is_an_empty_transcript_and_no_request(fake_speech: FakeSpeech, two: Path) -> None:
    detector = Detector(lambda samples, longest, stop=None: [])
    result = await run(fake_speech, two, detector=detector)
    t = result.transcript
    assert detector.calls == 2
    assert fake_speech.seen == []
    assert (t.text, t.segments, t.timing, t.language) == ("", [], "none", None)
    assert [s.id for s in t.speakers] == ["s1", "s2"]
    assert t.source is not None and t.source.channel_mode == "split"
    assert [u.step for u in result.usage] == ["decode", "vad", "transcribe"]
    assert result.usage[-1].requests == 0 and result.usage[-1].audio_seconds is None


async def test_a_channel_without_speech_is_a_speaker_with_no_turns(fake_speech: FakeSpeech, tmp_path: Path) -> None:
    path = call(tmp_path / "one.wav", [(0.0, 1.0), (3.0, 4.0)], [], seconds=5.0)
    serve(fake_speech)
    t = (await run(fake_speech, path)).transcript
    assert [s.id for s in t.speakers] == ["s1", "s2"]
    assert [(s.speaker, s.text, s.start) for s in t.segments] == [("s1", "c0w0", 0.0), ("s1", "c0w1", 3.0)]
    assert len(fake_speech.seen) == 2


# ---- fallback to mix ----


@pytest.mark.parametrize("channels", [1, 6])
async def test_split_on_a_file_that_is_not_two_channels_is_mixed(
    fake_speech: FakeSpeech, tmp_path: Path, channels: int
) -> None:
    path = make_media(tmp_path / "x.wav", "pcm_s16le", seconds=3.0, rate=16000, channels=channels)
    detector = Detector()
    result = await run(fake_speech, path, split(labels=["Anna", "Bob"]), detector=detector)
    t = result.transcript
    assert detector.calls == 0
    assert t.speakers == [Speaker(id="s1", label="Speaker 1")]
    assert {s.speaker for s in t.segments} == {"s1"}
    assert t.source is not None and (t.source.channel_mode, t.source.channels) == ("mix", channels)
    assert [u.step for u in result.usage] == ["decode", "transcribe"]
    assert len(fake_speech.seen) == 1


# ---- overlap ----


async def test_overlapping_speech_alternates_turns_by_word_start(fake_speech: FakeSpeech, tmp_path: Path) -> None:
    """Spec example: A at 0, 0.4 and 0.9 s, B at 0.5 s gives A, B, A."""
    path = call(tmp_path / "over.wav", [(0.0, 2.0)], [(0.5, 1.5)], seconds=3.0)
    a = timed(("a1", 0.0, 0.3), ("a2", 0.4, 0.7), ("a3", 0.9, 1.2))
    b = timed(("b1", 0.0, 0.3))  # 0.5 s on the file's timeline
    serve(fake_speech, answer_with({(0, 0): a, (1, 0): b}))
    t = (await run(fake_speech, path)).transcript
    assert [(s.id, s.speaker, s.text, s.start, s.end) for s in t.segments] == [
        ("t1", "s1", "a1 a2", 0.0, 0.7),
        ("t2", "s2", "b1", 0.5, 0.8),
        ("t3", "s1", "a3", 0.9, 1.2),
    ]
    assert t.text == "a1 a2 b1 a3"


async def test_words_that_start_together_put_channel_zero_first(fake_speech: FakeSpeech, tmp_path: Path) -> None:
    path = call(tmp_path / "tie.wav", [(0.0, 1.0)], [(0.0, 1.0)], seconds=2.0)
    serve(fake_speech, answer_with({(0, 0): timed(("a", 0.0, 0.3)), (1, 0): timed(("b", 0.0, 0.3))}))
    t = (await run(fake_speech, path)).transcript
    assert [(s.speaker, s.text) for s in t.segments] == [("s1", "a"), ("s2", "b")]


# ---- hallucination filter ----


async def test_a_segment_repeated_three_times_by_one_speaker_is_dropped(
    fake_speech: FakeSpeech, tmp_path: Path
) -> None:
    path = call(tmp_path / "rep.wav", [(0.0, 1.0), (2.0, 3.0), (4.0, 5.0)], [(6.0, 7.0)], seconds=8.0)
    thanks = reply(["Dziękuję."])
    serve(fake_speech, answer_with({(0, 0): thanks, (0, 1): thanks, (0, 2): thanks, (1, 0): reply(["Dzień", "dobry"])}))
    result = await run(fake_speech, path)
    assert result.dropped_segments == 3
    assert [(s.speaker, s.text) for s in result.transcript.segments] == [("s2", "Dzień dobry")]
    assert result.transcript.text == "Dzień dobry"


async def test_the_same_text_three_times_across_two_speakers_is_kept(fake_speech: FakeSpeech, tmp_path: Path) -> None:
    path = call(tmp_path / "rep.wav", [(0.0, 1.0), (2.0, 3.0)], [(4.0, 5.0)], seconds=6.0)
    thanks = reply(["Dziękuję."])
    serve(fake_speech, lambda channel, index: thanks)
    result = await run(fake_speech, path)
    assert result.dropped_segments == 0
    assert [s.speaker for s in result.transcript.segments] == ["s1", "s1", "s2"]


# ---- failures ----


async def test_a_failing_channel_stops_the_other_and_reports_both_in_usage(
    fake_speech: FakeSpeech, tmp_path: Path
) -> None:
    path = call(tmp_path / "fail.wav", [(0.0, 1.0), (2.0, 3.0)], [(0.0, 2.0), (4.0, 5.0)], seconds=6.0)
    serve(
        fake_speech,
        answer_with({(0, 1): Forced(401, error_body("bad key"))}, delays={(1, 0): 2.0}),  # c1w0 is still in flight
    )
    started = time.monotonic()
    err = await fails(fake_speech, path, split(language="pl"))
    assert time.monotonic() - started < 1.5  # it did not wait for the other channel's answer
    assert err.code == "provider_auth"
    assert sorted(keys(fake_speech)) == [(0, 0), (0, 1), (1, 0)]  # c1w1 was never sent
    assert err.usage is not None and err.usage.step == "transcribe"
    assert (err.usage.requests, err.usage.attempts) == (2, 3)  # the cancelled request is an attempt with its audio
    assert err.usage.audio_seconds == pytest.approx(4.0)


# ---- require_times ----


async def test_split_require_times_fails_on_a_channels_first_untimed_answer(
    fake_speech: FakeSpeech, chained: Path
) -> None:
    serve(fake_speech, answer_with({(0, 0): text_only("no times")}))
    with pytest.raises(TimesUnavailable) as info:
        await run(fake_speech, chained, split(language="pl", require_times=True, concurrency=1))
    assert info.value.usage is not None and info.value.usage.requests >= 1
    sent = keys(fake_speech)
    assert (0, 1) not in sent and (0, 2) not in sent and (1, 1) not in sent


async def test_split_require_times_is_checked_on_each_channel(fake_speech: FakeSpeech, chained: Path) -> None:
    serve(fake_speech, answer_with({(1, 0): text_only("no times")}))
    with pytest.raises(TimesUnavailable):
        await run(fake_speech, chained, split(language="pl", require_times=True, concurrency=1))
    assert (1, 1) not in keys(fake_speech)


async def test_split_require_times_checks_only_the_first_answer_with_text(
    fake_speech: FakeSpeech, chained: Path
) -> None:
    # Channel 0: timed, then untimed (not checked). Channel 1: no text (not checked), then timed.
    serve(fake_speech, answer_with({(0, 1): text_only("later"), (1, 0): empty()}))
    result = await run(fake_speech, chained, split(language="pl", require_times=True))
    assert len(fake_speech.seen) == 5
    assert "later" in result.transcript.text


# ---- options ----


@pytest.mark.parametrize(
    "options",
    [
        TranscribeOptions(roles=["customer", "agent"]),
        TranscribeOptions(labels=["Anna", "Bob"]),
        TranscribeOptions(channels="split", labels=["Anna"]),
        TranscribeOptions(channels="split", labels=["Anna", "Bob", "Cyd"]),
        TranscribeOptions(channels="split", roles=["agent"]),
        TranscribeOptions(channels="split", roles=["agent", "agent"]),
        TranscribeOptions(channels="split", roles=["boss", None]),  # type: ignore[list-item]
        TranscribeOptions(channels="split", labels=["", "Bob"]),
        TranscribeOptions(channels="split", labels=["Anna", "  "]),
        TranscribeOptions(channels="split", concurrency=0),
        TranscribeOptions(channels="stereo"),  # type: ignore[arg-type]
        TranscribeOptions(channels="split", allowed_languages=["pl", "engish"]),
        TranscribeOptions(channels="split", allowed_languages=["klingonese"]),
        TranscribeOptions(channels="split", allowed_languages=[]),
        TranscribeOptions(channels="split", language="klingonese"),
        TranscribeOptions(allowed_languages=["pl", "engish"]),
        TranscribeOptions(allowed_languages=[]),
        TranscribeOptions(language="klingonese"),
    ],
)
async def test_bad_options_raise_value_error_before_anything_is_read(
    tmp_path: Path, options: TranscribeOptions
) -> None:
    with pytest.raises(ValueError):
        await transcribe_file(tmp_path / "missing.wav", None, options, detector=nonzero_runs)  # type: ignore[arg-type]


def test_two_speakers_without_roles_are_allowed() -> None:
    # Not an error: both roles None is fine (no duplicate).
    TranscribeOptions(channels="split", roles=[None, None])


# ---- deadline ----


@pytest.fixture
def audio_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path / "tmp"))
    (tmp_path / "tmp").mkdir()
    return tmp_path / "tmp" / ("aftertalk-audio" if not hasattr(os, "getuid") else f"aftertalk-audio-{os.getuid()}")


def leftovers(tmp_path: Path) -> list[Path]:
    return [p for p in (tmp_path / "tmp").rglob("*") if p.is_file()]


def test_a_timeout_during_voice_detection_is_limit_exceeded_with_no_request(
    fake_speech: FakeSpeech, tmp_path: Path, audio_dir: Path
) -> None:
    path = call(tmp_path / "slow.wav", [(0.0, 1.0)], [(2.0, 3.0)], seconds=4.0)
    release = threading.Event()

    def slow(samples: np.ndarray, longest: float, stop: object = None) -> list[tuple[int, int]]:
        release.wait(1.5)
        return nonzero_runs(samples, longest)

    with pytest.raises(EngineError) as info:
        asyncio.run(run(fake_speech, path, detector=slow, limits=JobLimits(timeout_seconds=1)))
    err = info.value
    assert err.code == "limit_exceeded" and err.__context__ is None
    assert err.usage is None  # the transcribe step had not started
    assert fake_speech.seen == [] and leftovers(tmp_path) == []


def test_split_a_timeout_during_encoding_is_limit_exceeded_with_no_request(
    fake_speech: FakeSpeech, tmp_path: Path, audio_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from aftertalk.audio.encode import encode_pcm
    from aftertalk.pipeline import transcribe as module

    def slow_encode(samples, fmt):  # type: ignore[no-untyped-def]
        time.sleep(1.5)
        return encode_pcm(samples, fmt)

    monkeypatch.setattr(module, "encode_pcm", slow_encode)
    path = call(tmp_path / "slow.wav", [(0.0, 1.0)], [(2.0, 3.0)], seconds=4.0)
    with pytest.raises(EngineError) as info:
        asyncio.run(run(fake_speech, path, limits=JobLimits(timeout_seconds=1)))
    err = info.value
    assert err.code == "limit_exceeded" and err.usage is not None and err.usage.requests == 0
    assert fake_speech.seen == [] and leftovers(tmp_path) == []


def test_a_timeout_during_voice_detection_stops_the_detector_thread(
    fake_speech: FakeSpeech, tmp_path: Path, audio_dir: Path
) -> None:
    path = call(tmp_path / "slow.wav", [(0.0, 1.0)], [(2.0, 3.0)], seconds=4.0)
    saw_stop: list[bool] = []

    def looping(samples: np.ndarray, longest: float, stop: threading.Event) -> list[tuple[int, int]]:
        give_up = time.monotonic() + 5.0  # a detector that ignores `stop` makes the test fail, not hang
        while not stop.is_set() and time.monotonic() < give_up:
            time.sleep(0.01)
        saw_stop.append(stop.is_set())
        return []

    started = time.monotonic()
    with pytest.raises(EngineError) as info:
        asyncio.run(run(fake_speech, path, detector=looping, limits=JobLimits.model_construct(timeout_seconds=0.3)))
    assert time.monotonic() - started < 2.0  # asyncio.run joined the detector thread: it gave up when told to
    assert info.value.code == "limit_exceeded"
    assert saw_stop == [True]
    assert fake_speech.seen == [] and leftovers(tmp_path) == []


# ---- upload limit and the detector's longest segment ----


def upload_for(seconds: float) -> int:
    """An upload limit that holds `seconds` of mono audio (the window planner's WAV budget with its margins)."""
    return math.ceil((seconds * 16000 * 2 + 4096) * 1.01) + 2


async def test_split_with_an_upload_limit_under_two_seconds_is_audio_too_long(
    fake_speech: FakeSpeech, two: Path
) -> None:
    detector = Detector()
    err = await fails(fake_speech, two, detector=detector, max_upload_bytes=upload_for(1.9))
    assert err.code == "audio_too_long"
    assert detector.calls == 0 and fake_speech.seen == []


@pytest.mark.parametrize(
    ("max_upload_bytes", "expected"),
    [
        (None, 300.0),  # the default 25 MiB holds more than 300 s
        (upload_for(5.0), max_window_seconds(upload_for(5.0))),
        (upload_for(400.0), 300.0),
    ],
)
async def test_the_detector_gets_the_longest_segment_that_fits_one_upload(
    fake_speech: FakeSpeech, two: Path, max_upload_bytes: int | None, expected: float
) -> None:
    longest: list[float] = []

    def recording(samples: np.ndarray, most: float, stop: object = None) -> list[tuple[int, int]]:
        longest.append(most)
        return nonzero_runs(samples, most)

    serve(fake_speech)
    await run(fake_speech, two, detector=recording, max_upload_bytes=max_upload_bytes)
    assert longest == [expected, expected]
    assert expected == pytest.approx(5.0, abs=0.01) or expected == 300.0


# ---- probe: which windows, what counts as text, the prompt ----


async def test_the_fifth_window_can_be_probed_and_the_sixth_never(fake_speech: FakeSpeech, tmp_path: Path) -> None:
    # In time order: four short windows, the fifth (2 s, the longest of the first five), the sixth (3 s, longer).
    path = call(
        tmp_path / "five.wav",
        [(0.0, 0.5), (1.0, 1.5), (2.0, 2.5), (3.0, 3.5), (4.0, 6.0)],
        [(7.0, 10.0)],
        seconds=11.0,
    )
    serve(fake_speech)
    await run(fake_speech, path)
    assert PROBE_WINDOWS == 5
    assert keys(fake_speech)[0] == (0, 4)
    assert fake_speech.seen[0].values("language") == []
    assert [seen.values("language") for seen in fake_speech.seen[1:]] == [["pl"]] * 5


async def test_the_probe_judges_filler_on_times_bounded_by_the_window(fake_speech: FakeSpeech, tmp_path: Path) -> None:
    # "Danke." over 0-1.2 s of a 0.8 s window: cut to 0.8 s it is short and unsure, so it is filler, not German.
    path = call(tmp_path / "danke.wav", [(0.0, 0.8)], [(2.0, 2.5)], seconds=3.0)
    danke = timed(("Danke.", 0.0, 1.2), language="german", logprob=-0.5)
    serve(fake_speech, answer_with({(0, 0): danke}))
    result = await run(fake_speech, path, split(allowed_languages=["pl", "en"]))
    assert keys(fake_speech) == [(0, 0), (1, 0)]
    assert [seen.values("language") for seen in fake_speech.seen] == [[], []]
    assert result.transcript.language == "pl"
    assert result.dropped_segments == 1 and "Danke." not in result.transcript.text


async def test_a_plain_text_probe_answer_is_real_text(fake_speech: FakeSpeech, six: Path) -> None:
    serve(fake_speech, answer_with({(1, 0): reply(["Dzień", "dobry"], shape="text")}))
    result = await run(fake_speech, six, split(allowed_languages=["pl", "en"]))
    assert keys(fake_speech)[0] == (1, 0)
    assert [seen.values("language") for seen in fake_speech.seen[1:]] == [["pl"]] * 5  # it decided
    assert result.transcript.language == "pl"


def test_has_real_text_without_segments_is_the_plain_text() -> None:
    # The parser turns a plain-text answer into one untimed segment; an answer without segments is judged on its text.
    assert _has_real_text(Transcript.model_construct(text="Dzień dobry", segments=[]), 1.0)
    assert not _has_real_text(Transcript.model_construct(text="  ", segments=[]), 1.0)


async def test_a_long_callers_prompt_is_cut_to_its_last_500_characters_everywhere(
    fake_speech: FakeSpeech, six: Path
) -> None:
    prompt = "  " + " ".join(f"term{i:03d}" for i in range(100)) + "  "  # 799 characters stripped
    expected = prompt.strip()[-CHAIN_CHARS:]
    serve(fake_speech)
    await run(fake_speech, six, split(prompt=prompt))
    sent = by_key(fake_speech)
    assert fake_speech.seen[0].values("prompt") == [expected]  # the probe
    assert sent[(0, 0)].values("prompt") == [expected]  # channel 0's chain starts from it
    assert sent[(1, 1)].values("prompt") == [f"{expected} c1w0"[-CHAIN_CHARS:]]
    for seen in fake_speech.seen:
        (value,) = seen.values("prompt")
        assert len(value) <= CHAIN_CHARS


# ---- language in the channel phase ----


def eight_on_channel_zero(tmp_path: Path) -> Path:
    """Eight 0.5 s windows on channel 0, none on channel 1: the first five are the probe, then w5, w6, w7."""
    return call(tmp_path / "eight.wav", [(float(i), i + 0.5) for i in range(8)], [], seconds=9.0)


async def test_after_an_exhausted_probe_the_first_window_with_real_text_decides(
    fake_speech: FakeSpeech, tmp_path: Path
) -> None:
    path = eight_on_channel_zero(tmp_path)
    filler = timed(("Danke.", 0.0, 0.4), language="german", logprob=-0.9)  # has text, fails the score rules
    answers: dict[Key, Forced] = {(0, i): empty() for i in range(5)}
    answers[(0, 5)] = filler
    serve(fake_speech, answer_with(answers))
    result = await run(fake_speech, path)
    sent = by_key(fake_speech)
    assert [sent[(0, i)].values("language") for i in range(8)] == [[]] * 7 + [["pl"]]
    assert result.transcript.language == "pl"
    assert result.transcript.text == "c0w6 c0w7"  # the filler was dropped


def concurrent(tmp_path: Path) -> Path:
    """Five short windows (the probe), then one window on each channel at 6 s and one more on each at 8 s."""
    return call(
        tmp_path / "both.wav",
        [(0.0, 0.5), (1.0, 1.5), (2.0, 2.5), (6.0, 7.0), (8.0, 9.0)],
        [(0.5, 0.9), (1.5, 1.9), (6.0, 7.0), (8.0, 9.0)],
        seconds=10.0,
    )


EXHAUSTED: dict[Key, Forced] = {key: empty() for key in [(0, 0), (1, 0), (0, 1), (1, 1), (0, 2)]}


@pytest.mark.parametrize("german_last", [True, False], ids=["german-arrives-last", "german-arrives-first"])
async def test_a_detected_window_in_a_language_not_allowed_fails_whichever_arrives_first(
    fake_speech: FakeSpeech, tmp_path: Path, german_last: bool
) -> None:
    path = concurrent(tmp_path)
    late = (1, 2) if german_last else (0, 3)
    serve(
        fake_speech,
        answer_with(
            {**EXHAUSTED, (0, 3): reply(["Dzień"]), (1, 2): reply(["Guten"], language="german")},
            delays={late: 0.3},
        ),
    )
    err = await fails(fake_speech, path, split(allowed_languages=["pl", "en"]))
    assert err.code == "language_not_allowed" and err.detected_language == "de"
    sent = by_key(fake_speech)
    assert sent[(0, 3)].values("language") == [] and sent[(1, 2)].values("language") == []  # both detecting
    assert (1, 3) not in sent  # the failing channel stops there
    if not german_last:
        assert (0, 4) not in sent  # the Polish answer had not come back: its channel never went on


@pytest.mark.parametrize("english_last", [True, False], ids=["polish-first", "english-first"])
async def test_the_first_deciding_answer_wins_and_never_changes(
    fake_speech: FakeSpeech, tmp_path: Path, english_last: bool
) -> None:
    path = concurrent(tmp_path)
    late = (1, 2) if english_last else (0, 3)
    serve(
        fake_speech,
        answer_with(
            {**EXHAUSTED, (0, 3): reply(["Dzień"]), (1, 2): reply(["Hello"], language="english")},
            delays={late: 0.3},
        ),
    )
    result = await run(fake_speech, path)
    first = "pl" if english_last else "en"
    sent = by_key(fake_speech)
    assert sent[(0, 3)].values("language") == [] and sent[(1, 2)].values("language") == []
    assert result.transcript.language == first
    # The window sent after the first answer is forced to it; the one sent after the second answer too.
    assert sent[(0, 4)].values("language") == [first] and sent[(1, 3)].values("language") == [first]


# ---- concurrency ----


@pytest.mark.parametrize("concurrency", [1, 2])
async def test_concurrency_caps_the_requests_in_flight(
    fake_speech: FakeSpeech, chained: Path, concurrency: int
) -> None:
    lock = threading.Lock()
    flying = [0]
    most = [0]

    def answer(channel: int, index: int) -> Forced:
        with lock:
            flying[0] += 1
            most[0] = max(most[0], flying[0])
        time.sleep(0.1)
        with lock:
            flying[0] -= 1
        return default_answer(channel, index)

    serve(fake_speech, answer)
    await run(fake_speech, chained, split(language="pl", concurrency=concurrency))
    assert len(fake_speech.seen) == 5
    assert most[0] == concurrency


# ---- times ----


async def test_split_times_past_the_window_are_bounded(fake_speech: FakeSpeech, tmp_path: Path) -> None:
    path = call(tmp_path / "past.wav", [(1.0, 2.0)], [(3.0, 4.0)], seconds=5.0)
    near = timed(("a", 0.0, 0.3), ("b", 0.5, 1.8))  # b ends 0.8 s past the 1 s window: cut to it
    far = timed(("c", 0.0, 0.3), ("d", 0.5, 2.5))  # d ends 1.5 s past it: no time
    serve(fake_speech, answer_with({(0, 0): near, (1, 0): far}))
    t = (await run(fake_speech, path, split(language="pl"))).transcript
    words = {w.text: (w.start, w.end) for seg in t.segments for w in seg.words}
    assert words == {"a": (1.0, 1.3), "b": (1.5, 2.0), "c": (3.0, 3.3), "d": (None, None)}


async def test_split_times_and_duration_include_the_start_offset(fake_speech: FakeSpeech, tmp_path: Path) -> None:
    signal = np.zeros((3 * 16000, 2), dtype=np.int16)
    signal[16000:32000, 0] = value_of(0, 0)  # 1-2 s of the audio
    signal[8000:16000, 1] = value_of(1, 0)  # 0.5-1 s
    path = make_media(
        tmp_path / "late.mkv",
        "pcm_s16le",
        rate=16000,
        channels=2,
        signal=signal,
        video="mpeg4",
        video_seconds=15,
        audio_offset=10.0,
    )
    serve(fake_speech, answer_with({(0, 0): timed(("a", 0.1, 0.4)), (1, 0): timed(("b", 0.0, 0.2))}))
    t = (await run(fake_speech, path, split(language="pl"))).transcript
    assert t.source is not None and t.source.start_offset_seconds == pytest.approx(10.0, abs=0.001)
    assert [(s.speaker, s.start, s.end) for s in t.segments] == [("s2", 10.5, 10.7), ("s1", 11.1, 11.4)]
    assert t.duration_seconds == pytest.approx(13.0, abs=0.001)  # the offset plus the decoded 3 s
