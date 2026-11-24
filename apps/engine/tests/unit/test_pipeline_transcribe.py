import asyncio
import dataclasses
import hashlib
import json
import math
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import BinaryIO

import numpy as np
import pytest
from audio_tools import make_media, make_tone, tone
from fake_speech import FakeSpeech, Forced, error_body, reply

from aftertalk.audio import decode
from aftertalk.audio.decode import SAMPLE_RATE, _Decoded
from aftertalk.models.connections import SpeechConnection
from aftertalk.models.errors import EngineError
from aftertalk.models.transcript import Segment, Transcript, Word, timing_level
from aftertalk.models.usage import JobLimits, StepUsage
from aftertalk.pipeline import PipelineEvent, TranscribeOptions, TranscribeResult, transcribe_file
from aftertalk.pipeline.transcribe import SENT_SLACK_SECONDS, _shifted, _Totals
from aftertalk.providers.net import make_client
from aftertalk.providers.speech.openai_compatible import OpenAICompatibleSpeech

MARKER = "PIPELINE-PROVIDER-MARKER-77"


def upload_for(seconds: float) -> int:
    """An upload limit whose windows are `seconds` long (the planner's WAV budget with its margins)."""
    return math.ceil((seconds * SAMPLE_RATE * 2 + 4096) * 1.01) + 2


async def run(
    fake: FakeSpeech,
    path: Path,
    options: TranscribeOptions | None = None,
    *,
    window: float | None = None,
    limits: JobLimits | None = None,
    events: list[PipelineEvent] | None = None,
) -> TranscribeResult:
    conn = SpeechConnection.model_validate({"base_url": fake.base_url, "model": "whisper-1"})
    extra = {} if window is None else {"max_upload_bytes": upload_for(window)}
    async with make_client(block_private=False) as client:
        speech = OpenAICompatibleSpeech(conn, client, retry_waits=(0.0, 0.0), **extra)
        return await transcribe_file(
            path, speech, options or TranscribeOptions(), limits, None if events is None else events.append
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
def audio_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path / "tmp"))
    (tmp_path / "tmp").mkdir()
    return tmp_path / "tmp" / ("aftertalk-audio" if not hasattr(os, "getuid") else f"aftertalk-audio-{os.getuid()}")


def leftovers(tmp_path: Path) -> list[Path]:
    return [p for p in (tmp_path / "tmp").rglob("*") if p.is_file()]


@pytest.fixture
def twelve(tmp_path: Path) -> Path:
    """12 s of steady tone: with 5 s windows it is cut hard at 5 and 10 s."""
    (tmp_path / "in").mkdir()
    return make_tone(tmp_path / "in" / "talk.wav", seconds=12.0, rate=16000, channels=1)


# ---- stitching ----


async def test_windows_are_stitched_on_the_file_timeline(fake_speech: FakeSpeech, twelve: Path) -> None:
    fake_speech.forced = [reply(["one", "two"]), reply(["three", "four"]), reply(["five."])]
    result = await run(fake_speech, twelve, window=5.0)
    t = result.transcript
    assert len(fake_speech.seen) == 3
    assert [seg.id for seg in t.segments] == ["t1", "t2", "t3"]
    assert {seg.speaker for seg in t.segments} == {"s1"}
    assert [seg.start for seg in t.segments] == pytest.approx([0.0, 5.0, 10.0], abs=0.01)
    assert [w.start for w in t.segments[1].words] == pytest.approx([5.0, 5.5], abs=0.01)
    times = [w.start for seg in t.segments for w in seg.words]
    assert times == sorted(times)
    assert t.text == "one two three four five."
    assert t.timing == "word" and t.language == "pl"
    assert t.duration_seconds == pytest.approx(12.0, abs=0.01)
    assert [(sp.id, sp.label) for sp in t.speakers] == [("s1", "Speaker 1")]
    source = t.source
    assert source is not None
    assert source.kind == "audio" and source.name == "talk.wav"  # the file name only, not the directory
    assert source.sha256 == hashlib.sha256(twelve.read_bytes()).hexdigest()
    assert (source.container, source.channels, source.channel_mode) == ("wav", 1, "mix")
    assert source.start_offset_seconds == 0
    assert Transcript.model_validate_json(t.model_dump_json()) == t


async def test_turn_text_is_joined_with_one_space(fake_speech: FakeSpeech, twelve: Path) -> None:
    result = await run(fake_speech, twelve, window=5.0)  # the default answer in every window
    t = result.transcript
    assert len(t.segments) == 3 and t.text == " ".join(seg.text for seg in t.segments)
    assert "  " not in t.text


async def test_each_window_uploads_its_own_slice_of_the_file(fake_speech: FakeSpeech, tmp_path: Path) -> None:
    signal = np.concatenate(
        [tone(5.0, SAMPLE_RATE, 440, 6000), tone(5.0, SAMPLE_RATE, 1000, 12000), tone(2.0, SAMPLE_RATE, 2500, 3000)]
    )
    source = make_media(tmp_path / "three.wav", "pcm_s16le", rate=SAMPLE_RATE, signal=signal[:, None])
    await run(fake_speech, source, TranscribeOptions(audio_format="wav"), window=5.0)
    assert len(fake_speech.seen) == 3
    sent = []
    for seen in fake_speech.seen:
        assert seen.file is not None
        sent.append(np.frombuffer(seen.file.data[44:], dtype="<i2"))  # after the WAV header
    with decode.decode_audio(source) as audio:
        decoded = audio.mono()
    assert sum(len(part) for part in sent) == len(decoded)
    assert np.array_equal(np.concatenate(sent), decoded)
    assert not np.array_equal(sent[1], decoded[: len(sent[1])])  # not the start of the file again


# ---- language ----


async def test_language_is_detected_on_window_one_and_forced_after(fake_speech: FakeSpeech, twelve: Path) -> None:
    result = await run(fake_speech, twelve, window=5.0)
    assert [seen.values("language") for seen in fake_speech.seen] == [[], ["pl"], ["pl"]]
    assert result.transcript.language == "pl"


async def test_the_transcript_language_is_window_ones_and_later_ones_are_forced_to_it(
    fake_speech: FakeSpeech, twelve: Path
) -> None:
    fake_speech.forced = [
        reply(["one"], language="polish"),
        reply(["two"], language="english"),
        reply(["three"], language="german"),
    ]
    result = await run(fake_speech, twelve, window=5.0)
    assert result.transcript.language == "pl"
    assert [seen.values("language") for seen in fake_speech.seen] == [[], ["pl"], ["pl"]]


async def test_a_forced_language_goes_to_every_window(fake_speech: FakeSpeech, twelve: Path) -> None:
    result = await run(fake_speech, twelve, TranscribeOptions(language="English"), window=5.0)
    assert [seen.values("language") for seen in fake_speech.seen] == [["en"], ["en"], ["en"]]
    assert result.transcript.language == "en"


async def test_no_language_reported_with_several_allowed_fails_on_window_one(
    fake_speech: FakeSpeech, twelve: Path
) -> None:
    fake_speech.forced = [reply(["hello"], language=None) for _ in range(3)]
    err = await fails(fake_speech, twelve, TranscribeOptions(allowed_languages=["pl", "en"]), window=5.0)
    assert err.code == "language_not_allowed" and err.detected_language is None
    assert len(fake_speech.seen) == 1  # the rest was never paid for
    assert err.usage is not None and err.usage.step == "transcribe" and err.usage.requests == 1


async def test_a_language_that_is_not_allowed_names_it(fake_speech: FakeSpeech, twelve: Path) -> None:
    fake_speech.language = "ukrainian"
    err = await fails(fake_speech, twelve, TranscribeOptions(allowed_languages=["pl", "en"]), window=5.0)
    assert err.code == "language_not_allowed" and err.detected_language == "uk" and len(fake_speech.seen) == 1


async def test_one_allowed_language_is_used_and_forced(fake_speech: FakeSpeech, twelve: Path) -> None:
    fake_speech.forced = [reply(["hello"], language=None) for _ in range(3)]
    result = await run(fake_speech, twelve, TranscribeOptions(allowed_languages=["pl"]), window=5.0)
    assert result.transcript.language == "pl"
    assert [seen.values("language") for seen in fake_speech.seen] == [[], ["pl"], ["pl"]]


async def test_no_language_from_window_one_leaves_the_rest_unforced(fake_speech: FakeSpeech, twelve: Path) -> None:
    fake_speech.forced = [reply(["hello"], language=None) for _ in range(3)]
    result = await run(fake_speech, twelve, window=5.0)
    assert result.transcript.language is None
    assert [seen.values("language") for seen in fake_speech.seen] == [[], [], []]


async def test_every_window_gets_only_the_callers_prompt(fake_speech: FakeSpeech, twelve: Path) -> None:
    await run(fake_speech, twelve, TranscribeOptions(prompt="Kenobi, Skywalker"), window=5.0)
    assert [seen.values("prompt") for seen in fake_speech.seen] == [["Kenobi, Skywalker"]] * 3
    await run(fake_speech, twelve, window=5.0)
    assert [seen.values("prompt") for seen in fake_speech.seen[3:]] == [[]] * 3  # nothing chained


# ---- timing level ----


async def test_a_window_without_words_lowers_the_timing(fake_speech: FakeSpeech, tmp_path: Path) -> None:
    source = make_tone(tmp_path / "ten.wav", seconds=10.0, rate=16000, channels=1)
    fake_speech.forced = [reply(["one", "two"]), reply(["three", "four"], shape="segments")]
    t = (await run(fake_speech, source, window=5.0)).transcript
    assert t.timing == "segment" == timing_level(t.segments)
    assert t.segments[1].start == pytest.approx(5.0, abs=0.01) and t.segments[1].words[0].start is None
    assert Transcript.model_validate_json(t.model_dump_json()) == t


async def test_a_text_only_window_can_drop_the_timing_to_none(fake_speech: FakeSpeech, twelve: Path) -> None:
    fake_speech.forced = [reply(["one"]), reply(["two"], shape="segments"), reply(["three"], shape="text")]
    t = (await run(fake_speech, twelve, window=5.0)).transcript
    assert t.timing == "none" == timing_level(t.segments)  # 2 of 3 turns timed: under the 90% rule
    assert t.segments[2].start is None and t.text == "one two three"
    assert Transcript.model_validate_json(t.model_dump_json()) == t


async def test_a_text_only_window_in_the_middle_is_one_untimed_turn(fake_speech: FakeSpeech, twelve: Path) -> None:
    # A whole window without times: not glued to a turn whose span would hide it.
    fake_speech.forced = [reply(["one", "two"]), reply(["three", "four"], shape="text"), reply(["five"])]
    t = (await run(fake_speech, twelve, window=5.0)).transcript
    assert [s.text for s in t.segments] == ["one two", "three four", "five"]
    assert [x.text for x in t.segments[1].words] == ["three", "four"]
    assert (t.segments[1].start, t.segments[1].end) == (None, None)
    assert (t.segments[0].start, t.segments[0].end) == pytest.approx((0.0, 0.9), abs=0.01)
    assert (t.segments[2].start, t.segments[2].end) == pytest.approx((10.0, 10.4), abs=0.01)


# ---- provider times past the end of the window ----


def nested(*segments: dict, language: str = "polish") -> Forced:
    """A 200 answer with these segments, words nested in them (whisper.cpp style)."""
    text = " ".join(s["text"] for s in segments)
    return Forced(200, json.dumps({"text": text, "language": language, "segments": list(segments)}))


def sseg(text: str, start: float | None, end: float | None, words: list[tuple[str, float, float]]) -> dict:
    return {
        "text": f" {text}",
        "start": start,
        "end": end,
        "words": [{"word": x, "start": a, "end": b} for x, a, b in words],
    }


def test_sent_slack_constant() -> None:
    assert SENT_SLACK_SECONDS == 1.0


@pytest.mark.parametrize(
    ("start", "end", "expected"),
    [
        (4.0, 5.0, (14.0, 15.0)),  # end <= D: unchanged
        (4.5, 5.6, (14.5, 15.0)),  # end within 1 s past D: cut to D
        (4.5, 6.0, (14.5, 15.0)),  # exactly D + 1: still cut
        (5.0, 5.8, (15.0, 15.0)),  # start at D: zero length
        (4.5, 6.2, (None, None)),  # end more than 1 s past D: no time
        (5.2, 5.4, (None, None)),  # starts past D: no time
        (None, None, (None, None)),
    ],
)
def test_a_time_past_the_window_is_bounded_or_dropped(
    start: float | None, end: float | None, expected: tuple[float | None, float | None]
) -> None:
    # A word (its segment inside the window) and a segment (no words), each on its own.
    word = Segment(text="x", start=0.0, end=1.0, words=[Word(text="x", start=start, end=end)])
    alone = Segment(text="x", start=start, end=end)
    shifted_word, shifted_seg = _shifted([word, alone], 10.0, 5.0)
    assert (shifted_word.words[0].start, shifted_word.words[0].end) == expected
    assert (shifted_word.start, shifted_word.end, shifted_word.text) == (10.0, 11.0, "x")
    assert (shifted_seg.start, shifted_seg.end, shifted_seg.text) == (*expected, "x")  # text kept


def test_the_bound_compares_at_milliseconds() -> None:
    sent = 79_999 / SAMPLE_RATE  # 4.9999375 s: 5.000 at millisecond precision
    (out,) = _shifted([Segment(text="x y", start=4.0, end=5.0, words=[Word(text="x", start=5.0, end=5.0)])], 0.0, sent)
    assert (out.start, out.end) == (4.0, 5.0) and (out.words[0].start, out.words[0].end) == (5.0, 5.0)


def test_a_segment_that_overshoots_keeps_its_words_inside() -> None:
    words = [Word(text="a", start=0.5, end=1.0), Word(text="b", start=4.0, end=4.9)]
    far, near = _shifted(
        [Segment(text="a b", start=0.5, end=7.0, words=words), Segment(text="a b", start=0.5, end=5.5, words=words)],
        0.0,
        5.0,
    )
    assert (far.start, far.end) == (None, None) and (near.start, near.end) == (0.5, 5.0)
    assert far.words == words and near.words == words  # the table applies to the segment alone


async def test_a_word_past_window_one_does_not_join_window_two(fake_speech: FakeSpeech, twelve: Path) -> None:
    # 598-650 s of a 600 s window, scaled: window 1 (5 s) returns a word at 4.9-6.5, window 2 one just after its start.
    fake_speech.forced = [
        nested(sseg("one two", 0.0, 6.5, [("one", 0.0, 0.4), ("two", 4.9, 6.5)])),
        nested(sseg("three", 0.1, 0.5, [("three", 0.1, 0.5)])),
        nested(sseg("four", 1.6, 2.5, [("four", 1.6, 2.5)])),  # the last window is 2 s: its end is cut to 12
    ]
    t = (await run(fake_speech, twelve, window=5.0)).transcript
    assert [s.text for s in t.segments] == ["one two", "three", "four"]
    two = t.segments[0].words[1]
    assert (two.text, two.start, two.end) == ("two", None, None)
    assert (t.segments[0].start, t.segments[0].end) == (0.0, 0.4)
    assert (t.segments[1].start, t.segments[1].end) == (5.1, 5.5)
    assert (t.segments[2].start, t.segments[2].end) == (11.6, 12.0)
    assert t.duration_seconds is not None
    assert all(s.end is None or s.end <= t.duration_seconds for s in t.segments)
    assert t.timing == timing_level(t.segments)
    assert Transcript.model_validate_json(t.model_dump_json()) == t


async def test_negative_provider_times_are_no_time_through_the_pipeline(
    fake_speech: FakeSpeech, tmp_path: Path
) -> None:
    source = make_tone(tmp_path / "two.wav", seconds=2.0, rate=16000, channels=1)
    fake_speech.forced = [nested(sseg("a b", -1.0, 1.0, [("a", -0.5, 0.3), ("b", 0.4, 0.8)]))]
    t = (await run(fake_speech, source)).transcript
    (turn,) = t.segments
    assert [(x.text, x.start, x.end) for x in turn.words] == [("a", None, None), ("b", 0.4, 0.8)]
    assert (turn.start, turn.end) == (0.4, 0.8)


# ---- containers, offsets, channels ----


async def test_start_offset_lands_in_word_times(fake_speech: FakeSpeech, tmp_path: Path) -> None:
    # 3 s of audio: the fake's answer runs to 2.6 s, and a time past the audio sent would be dropped.
    source = make_media(tmp_path / "late.mp4", "aac", seconds=3.0, video="mpeg4", video_seconds=50, audio_offset=45)
    t = (await run(fake_speech, source)).transcript
    assert t.source is not None and t.source.kind == "video" and t.source.container == "mp4"
    assert t.source.start_offset_seconds == pytest.approx(45.0, abs=0.05)
    words = t.segments[0].words
    assert [w.start for w in words] == pytest.approx([45.0, 45.6, 46.4, 47.1], abs=0.05)  # 45 + the provider's times
    assert t.duration_seconds == pytest.approx(48.0, abs=0.1)  # where the audio ends in the file


async def test_mpegts_goes_through(fake_speech: FakeSpeech, tmp_path: Path) -> None:
    source = make_media(
        tmp_path / "a.ts", "mp2", rate=44100, seconds=1.0, video="mpeg4", audio_offset=3600, video_offset=3600
    )
    t = (await run(fake_speech, source)).transcript
    assert t.source is not None and (t.source.container, t.source.kind) == ("mpegts", "video")
    assert t.source.start_offset_seconds == pytest.approx(0.0, abs=0.05) and t.segments[0].start == 0.0


async def test_stereo_is_mixed(fake_speech: FakeSpeech, tmp_path: Path) -> None:
    source = make_media(tmp_path / "s.wav", "pcm_s16le", channels=2)
    t = (await run(fake_speech, source)).transcript
    assert t.source is not None and (t.source.channels, t.source.channel_mode) == (2, "mix")
    assert len(fake_speech.seen) == 1


async def test_a_backslash_in_the_file_name_gives_no_name(fake_speech: FakeSpeech, tmp_path: Path) -> None:
    source = make_tone(tmp_path / "a\\b.wav", seconds=1.0)
    t = (await run(fake_speech, source)).transcript
    assert t.source is not None and t.source.name is None and t.source.sha256 is not None


# ---- limits ----


async def test_max_audio_seconds_stops_before_any_request(
    fake_speech: FakeSpeech, tmp_path: Path, audio_dir: Path
) -> None:
    source = make_tone(tmp_path / "three.wav", seconds=3.0)
    err = await fails(fake_speech, source, limits=JobLimits(max_audio_seconds=1))
    assert err.code == "limit_exceeded" and err.usage is None
    assert fake_speech.seen == [] and leftovers(tmp_path) == []


class SlowConvert:
    """Stands in for the decoder's `_convert`: writes some PCM, then waits until it is cancelled."""

    def __init__(self) -> None:
        self.started = threading.Event()

    def __call__(self, source: Path, out: BinaryIO, max_seconds: float | None, cancelled: object = None) -> _Decoded:
        out.write(bytes(2 * SAMPLE_RATE))
        out.flush()
        self.started.set()
        assert isinstance(cancelled, threading.Event) and cancelled.wait(10)
        raise decode._Cancelled


def test_timeout_during_decoding_is_limit_exceeded_with_no_request(
    fake_speech: FakeSpeech, tmp_path: Path, audio_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(decode, "_convert", SlowConvert())
    source = make_tone(tmp_path / "a.wav")
    started = time.monotonic()
    with pytest.raises(EngineError) as info:
        asyncio.run(run(fake_speech, source, limits=JobLimits(timeout_seconds=1)))  # joins the worker thread
    assert info.value.code == "limit_exceeded" and info.value.__context__ is None
    assert time.monotonic() - started < 5
    assert fake_speech.seen == [] and leftovers(tmp_path) == []


def test_timeout_during_encoding_is_limit_exceeded_with_no_request(
    fake_speech: FakeSpeech, tmp_path: Path, audio_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from aftertalk.audio.encode import encode_pcm
    from aftertalk.pipeline import transcribe as module

    def slow_encode(samples, fmt):  # type: ignore[no-untyped-def]
        time.sleep(1.5)
        return encode_pcm(samples, fmt)

    monkeypatch.setattr(module, "encode_pcm", slow_encode)
    source = make_tone(tmp_path / "a.wav")
    with pytest.raises(EngineError) as info:
        asyncio.run(run(fake_speech, source, limits=JobLimits(timeout_seconds=1)))
    err = info.value
    assert err.code == "limit_exceeded" and err.usage is not None and err.usage.requests == 0
    assert fake_speech.seen == [] and leftovers(tmp_path) == []


# ---- usage ----


async def test_usage_is_one_entry_per_step_summed_over_windows(fake_speech: FakeSpeech, twelve: Path) -> None:
    fake_speech.forced = [
        reply(["one"]),
        Forced(400, error_body("not supported", param="timestamp_granularities[]")),
        reply(["two"], shape="segments"),
        reply(["three"]),
    ]
    result = await run(fake_speech, twelve, window=5.0)
    decode_usage, usage = (next(u for u in result.usage if u.step == name) for name in ("decode", "transcribe"))
    assert decode_usage.step == "decode" and decode_usage.audio_seconds is None and decode_usage.requests == 0
    assert usage.step == "transcribe" and (usage.provider, usage.model) == ("openai-compatible", "whisper-1")
    assert (usage.requests, usage.attempts) == (4, 4)
    assert usage.audio_seconds == pytest.approx(12.0, abs=0.01)
    assert usage.speech_format == "verbose_json_segments"  # the lowest any window needed
    assert usage.duration_ms >= 0 and decode_usage.duration_ms >= 0


async def test_a_failure_on_window_two_carries_the_summed_usage(fake_speech: FakeSpeech, twelve: Path) -> None:
    fake_speech.forced = [reply(["one"]), Forced(401, error_body(f"bad key {MARKER}"))]
    err = await fails(fake_speech, twelve, window=5.0)
    assert err.code == "provider_auth" and MARKER not in str(err)
    assert err.usage is not None and err.usage.step == "transcribe"
    assert (err.usage.requests, err.usage.attempts) == (2, 2)
    assert err.usage.audio_seconds == pytest.approx(10.0, abs=0.01)  # windows one and two
    assert len(fake_speech.seen) == 2


async def test_a_timeout_mid_request_counts_the_window_in_flight(fake_speech: FakeSpeech, twelve: Path) -> None:
    fake_speech.stall = 3.0  # reads the upload, then answers too late
    err = await fails(fake_speech, twelve, window=5.0, limits=JobLimits(timeout_seconds=1))
    assert err.code == "limit_exceeded" and err.usage is not None and err.usage.step == "transcribe"
    assert err.usage.attempts >= 1 and err.usage.requests == 0  # sent, but no response: an attempt, not a request
    assert err.usage.audio_seconds == pytest.approx(5.0, abs=0.01)  # the first window, uploaded before the time ran out
    assert len(fake_speech.seen) == 1


def test_a_window_never_sent_adds_no_audio() -> None:
    totals = _Totals()
    totals.add(StepUsage(step="transcribe", requests=1, attempts=1, audio_seconds=5.0))
    totals.add(StepUsage(step="transcribe", requests=1, attempts=0, audio_seconds=5.0))  # the deadline had passed
    assert (totals.usage().attempts, totals.usage().audio_seconds) == (1, 5.0)


# ---- events and logs ----

_EVENT_WORDS = {"decode", "transcribe", "started", "progress", "finished"}


async def test_events_report_steps_and_window_counts(fake_speech: FakeSpeech, twelve: Path) -> None:
    events: list[PipelineEvent] = []
    await run(fake_speech, twelve, window=5.0, events=events)
    assert [(e.step, e.kind, e.windows_done, e.windows_total) for e in events] == [
        ("decode", "started", None, None),
        ("decode", "finished", None, None),
        ("transcribe", "started", 0, 3),
        ("transcribe", "progress", 1, 3),
        ("transcribe", "progress", 2, 3),
        ("transcribe", "progress", 3, 3),
        ("transcribe", "finished", 3, 3),
    ]
    assert events[1].audio_seconds == pytest.approx(12.0, abs=0.01)
    for event in events:
        for value in dataclasses.asdict(event).values():
            assert not isinstance(value, str) or value in _EVENT_WORDS  # never text


async def test_logs_hold_only_codes_and_counts(
    fake_speech: FakeSpeech, twelve: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level("DEBUG")
    await run(fake_speech, twelve, TranscribeOptions(prompt="Skywalker"), window=5.0)
    fake_speech.forced = [reply(["one"]), Forced(401, error_body(MARKER))]
    await fails(fake_speech, twelve, window=5.0)
    records = [r for r in caplog.records if r.name == "aftertalk"]
    assert records and {r.getMessage() for r in records} == {"transcribe finished", "transcribe failed"}
    assert {k for r in records for k in r.fields} <= {"step", "duration_ms", "error_code"}  # type: ignore[attr-defined]
    for text in ("Kenobi", "Hello", "Skywalker", "talk.wav", "polish", MARKER):
        assert text not in caplog.text


# ---- cancellation ----


def test_cancel_mid_decode_leaves_nothing(
    fake_speech: FakeSpeech, tmp_path: Path, audio_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    slow = SlowConvert()
    monkeypatch.setattr(decode, "_convert", slow)
    source = make_tone(tmp_path / "a.wav")

    async def main() -> None:
        task = asyncio.create_task(run(fake_speech, source))
        await asyncio.to_thread(slow.started.wait, 10)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(main())  # joins the worker threads before it returns
    assert fake_speech.seen == [] and leftovers(tmp_path) == []


def test_cancel_mid_request_leaves_nothing(
    fake_speech: FakeSpeech, twelve: Path, tmp_path: Path, audio_dir: Path
) -> None:
    fake_speech.stall = 3.0

    async def main() -> None:
        task = asyncio.create_task(run(fake_speech, twelve, window=5.0))
        while not fake_speech.seen:
            await asyncio.sleep(0.01)
        assert leftovers(tmp_path) != []  # the decoded audio is on disk while the request runs
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert leftovers(tmp_path) == []

    asyncio.run(main())
    assert len(fake_speech.seen) == 1
