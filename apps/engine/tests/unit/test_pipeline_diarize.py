"""Mixed audio with diarization: the whole track to the diarizer once, windows to the speech provider (both fakes)."""

import asyncio
import json
import math
import time
from pathlib import Path

import numpy as np
import pytest
from audio_tools import make_media, make_stereo, make_tone, nonzero_runs
from fake_pyannote import MARKER as PYANNOTE_MARKER
from fake_pyannote import FakePyannote, segments
from fake_pyannote import Forced as PForced
from fake_speech import FakeSpeech, Forced, error_body, reply

from aftertalk.audio.decode import SAMPLE_RATE
from aftertalk.audio.encode import wav_size
from aftertalk.models.connections import DiarizationConnection, SpeechConnection
from aftertalk.models.errors import EngineError
from aftertalk.models.usage import JobLimits
from aftertalk.pipeline import PipelineEvent, TranscribeOptions, TranscribeResult, transcribe_file
from aftertalk.providers.diarization.protocols import DiarizationCapabilities
from aftertalk.providers.diarization.pyannote import PyannoteDiarization
from aftertalk.providers.net import make_client
from aftertalk.providers.speech.openai_compatible import OpenAICompatibleSpeech

KEY = "pyannote-pipeline-key-9"


def upload_for(seconds: float) -> int:
    """An upload limit whose windows are `seconds` long (the planner's WAV budget with its margins)."""
    return math.ceil((seconds * SAMPLE_RATE * 2 + 4096) * 1.01) + 2


async def run(
    speech_fake: FakeSpeech,
    pyannote_fake: FakePyannote | None,
    path: Path,
    options: TranscribeOptions | None = None,
    *,
    window: float | None = None,
    limits: JobLimits | None = None,
    events: list[PipelineEvent] | None = None,
    capabilities: DiarizationCapabilities | None = None,
    poll_interval: float = 0.0,
    detector=None,
) -> TranscribeResult:
    speech_conn = SpeechConnection.model_validate({"base_url": speech_fake.base_url, "model": "whisper-1"})
    extra = {} if window is None else {"max_upload_bytes": upload_for(window)}
    async with make_client(block_private=False) as client:
        speech = OpenAICompatibleSpeech(speech_conn, client, retry_waits=(0.0, 0.0), **extra)
        diarizer = None
        if pyannote_fake is not None:
            conn = DiarizationConnection.model_validate({"base_url": pyannote_fake.base_url, "api_key": KEY})
            diarizer = PyannoteDiarization(conn, client, poll_interval=poll_interval, retry_waits=(0.0, 0.0))
            if capabilities is not None:
                diarizer.capabilities = capabilities  # type: ignore[misc]
        return await transcribe_file(
            path,
            speech,
            options or TranscribeOptions(),
            limits,
            None if events is None else events.append,
            diarizer=diarizer,
            detector=detector,
        )


async def fails(*args, **kwargs) -> EngineError:
    with pytest.raises(EngineError) as info:
        await run(*args, **kwargs)
    err = info.value
    assert err.__cause__ is None and err.__context__ is None
    return err


@pytest.fixture
def four(tmp_path: Path) -> Path:
    return make_tone(tmp_path / "talk.wav", seconds=4.0, rate=16000, channels=1)


def steps(result: TranscribeResult) -> list[str]:
    return [u.step for u in result.usage]


async def test_two_speakers_end_to_end(fake_speech: FakeSpeech, fake_pyannote: FakePyannote, four: Path) -> None:
    fake_speech.forced = [reply(["hi", "there", "hello", "back"])]  # words at 0, 0.5, 1.0, 1.5 s
    fake_pyannote.output = segments((0.0, 0.95, "SPEAKER_07"), (0.95, 3.0, "SPEAKER_02"))
    result = await run(fake_speech, fake_pyannote, four)
    t = result.transcript
    assert [(s.speaker, s.text) for s in t.segments] == [("s1", "hi there"), ("s2", "hello back")]
    assert [(s.id, s.label, s.role) for s in t.speakers] == [("s1", "Speaker 1", None), ("s2", "Speaker 2", None)]
    assert t.source is not None and t.source.diarized and t.source.channel_mode == "mix"
    assert steps(result) == ["decode", "transcribe", "diarize"]
    diarize = result.usage[2]
    assert diarize.provider == "pyannote-ai" and diarize.audio_seconds == 4.0 and diarize.requests == 6
    assert result.diarization_skipped is None
    assert "SPEAKER_07" not in t.model_dump_json()  # the provider's labels stay inside the engine


async def test_the_upload_is_the_whole_mixed_track(
    fake_speech: FakeSpeech, fake_pyannote: FakePyannote, tmp_path: Path
) -> None:
    path = make_tone(tmp_path / "stereo.wav", seconds=3.0, rate=16000, channels=2)
    fake_speech.forced = [reply(["a"]), reply(["b"])]
    await run(fake_speech, fake_pyannote, path, window=2.0)
    assert len(fake_speech.seen) == 2  # two windows
    (body,) = fake_pyannote.uploads.values()  # one upload of the whole file
    assert len(body) == wav_size(3 * SAMPLE_RATE)
    pcm = np.frombuffer(body[44:], dtype="<i2")
    assert np.abs(pcm).max() > 5000  # the tone, mixed down


async def test_the_start_offset_is_added_to_diarization_times(
    fake_speech: FakeSpeech, fake_pyannote: FakePyannote, tmp_path: Path
) -> None:
    path = make_media(tmp_path / "late.mp4", "aac", seconds=3.0, video="mpeg4", video_seconds=50, audio_offset=45)
    fake_speech.forced = [reply(["one", "two", "three", "four"])]  # 45.0, 45.5, 46.0, 46.5 on the file's timeline
    fake_pyannote.output = segments((0.0, 1.0, "A"), (1.0, 3.0, "B"))  # the decoded track's own times
    t = (await run(fake_speech, fake_pyannote, path)).transcript
    assert [(s.speaker, s.text) for s in t.segments] == [("s1", "one two"), ("s2", "three four")]


async def test_a_speech_failure_on_the_first_window_uploads_nothing(
    fake_speech: FakeSpeech, fake_pyannote: FakePyannote, four: Path
) -> None:
    fake_speech.forced = [Forced(401, error_body())]
    err = await fails(fake_speech, fake_pyannote, four)
    assert err.code == "provider_auth" and err.usage is not None and err.usage.step == "transcribe"
    assert [s.method for s in fake_pyannote.seen] == ["POST"]  # only the key check, no audio


async def test_language_not_allowed_on_the_first_window_uploads_nothing(
    fake_speech: FakeSpeech, fake_pyannote: FakePyannote, four: Path
) -> None:
    fake_speech.forced = [reply(["hello"], language="english")]
    err = await fails(fake_speech, fake_pyannote, four, TranscribeOptions(allowed_languages=["pl", "uk"]))
    assert err.code == "language_not_allowed"
    assert fake_pyannote.requests("upload") == [] and fake_pyannote.jobs == []


async def test_a_bad_diarization_key_fails_before_any_speech_request(
    fake_speech: FakeSpeech, fake_pyannote: FakePyannote, four: Path
) -> None:
    fake_pyannote.forced["media"] = [PForced(401, PYANNOTE_MARKER)]
    err = await fails(fake_speech, fake_pyannote, four)
    assert err.code == "provider_auth"
    assert err.usage is not None and err.usage.step == "diarize" and err.usage.audio_seconds is None
    assert fake_speech.seen == []


async def test_no_text_sends_no_audio_and_has_one_speaker(
    fake_speech: FakeSpeech, fake_pyannote: FakePyannote, four: Path
) -> None:
    fake_speech.forced = [Forced(200, json.dumps({"text": "", "language": "polish", "segments": [], "words": []}))]
    result = await run(fake_speech, fake_pyannote, four)
    assert fake_pyannote.requests("upload") == []
    assert result.diarization_skipped is None and result.transcript.source.diarized is False  # type: ignore[union-attr]
    assert [s.id for s in result.transcript.speakers] == ["s1"]


async def test_no_times_skips_diarization(fake_speech: FakeSpeech, fake_pyannote: FakePyannote, four: Path) -> None:
    fake_speech.forced = [reply(["plain", "text"], shape="text")]
    result = await run(fake_speech, fake_pyannote, four)
    assert result.diarization_skipped == "no_times"
    assert fake_pyannote.requests("upload") == [] and fake_pyannote.jobs == []
    assert [s.speaker for s in result.transcript.segments] == ["s1"]
    assert result.transcript.source.diarized is False  # type: ignore[union-attr]


async def test_segment_times_still_diarize(fake_speech: FakeSpeech, fake_pyannote: FakePyannote, four: Path) -> None:
    fake_speech.forced = [reply(["one", "two"], shape="segments")]
    fake_pyannote.output = segments((0.0, 4.0, "A"))
    result = await run(fake_speech, fake_pyannote, four)
    assert result.transcript.source.diarized and result.diarization_skipped is None  # type: ignore[union-attr]


async def test_over_the_diarizers_limits_is_skipped(
    fake_speech: FakeSpeech, fake_pyannote: FakePyannote, four: Path
) -> None:
    fake_speech.forced = [reply(["a", "b"])]
    caps = DiarizationCapabilities(max_upload_bytes=wav_size(SAMPLE_RATE), max_audio_seconds=None)
    result = await run(fake_speech, fake_pyannote, four, capabilities=caps)
    assert result.diarization_skipped == "too_long"
    assert fake_pyannote.seen == [] and steps(result) == ["decode", "transcribe"]
    caps = DiarizationCapabilities(max_upload_bytes=None, max_audio_seconds=3.0)
    fake_speech.forced = [reply(["a", "b"])]
    result = await run(fake_speech, fake_pyannote, four, capabilities=caps)
    assert result.diarization_skipped == "too_long"


async def test_no_speakers_found_is_one_speaker(
    fake_speech: FakeSpeech, fake_pyannote: FakePyannote, four: Path
) -> None:
    fake_speech.forced = [reply(["a", "b"])]
    fake_pyannote.output = []
    result = await run(fake_speech, fake_pyannote, four)
    assert result.diarization_skipped == "no_speakers"
    assert result.transcript.source.diarized is False  # type: ignore[union-attr]
    assert steps(result) == ["decode", "transcribe", "diarize"]


async def test_a_segment_past_the_audio_is_dropped_and_an_end_cut(
    fake_speech: FakeSpeech, fake_pyannote: FakePyannote, four: Path
) -> None:
    fake_speech.forced = [reply(["a", "b"])]
    fake_pyannote.output = segments((0.0, 9.0, "A"), (4.0, 6.0, "B"))
    t = (await run(fake_speech, fake_pyannote, four)).transcript
    assert [s.id for s in t.speakers] == ["s1"]


async def test_a_failed_job_fails_the_run_with_the_diarize_usage(
    fake_speech: FakeSpeech, fake_pyannote: FakePyannote, four: Path
) -> None:
    fake_speech.forced = [reply(["a", "b"])]
    fake_pyannote.statuses = ["running", "failed"]
    err = await fails(fake_speech, fake_pyannote, four)
    assert err.code == "provider_bad_response"
    assert err.usage is not None and err.usage.step == "diarize" and err.usage.audio_seconds == 4.0


async def test_a_diarize_failure_stops_the_windows(
    fake_speech: FakeSpeech, fake_pyannote: FakePyannote, tmp_path: Path
) -> None:
    path = make_tone(tmp_path / "long.wav", seconds=8.0, rate=16000, channels=1)
    fake_speech.forced = [reply(["a"])]
    fake_pyannote.forced["diarize"] = [PForced(402, PYANNOTE_MARKER)]
    fake_speech.stall = 0.3  # each window takes a while: the diarize failure comes first
    err = await fails(fake_speech, fake_pyannote, path, window=2.0)
    assert err.code == "provider_quota_exceeded" and err.usage is not None and err.usage.step == "diarize"
    assert len(fake_speech.seen) < 4  # the remaining windows were not all sent


async def test_a_window_failure_after_the_gate_cancels_diarization(
    fake_speech: FakeSpeech, fake_pyannote: FakePyannote, tmp_path: Path
) -> None:
    path = make_tone(tmp_path / "long.wav", seconds=6.0, rate=16000, channels=1)
    fake_speech.forced = [reply(["a"]), Forced(500, error_body()), Forced(500, error_body()), Forced(500, error_body())]
    fake_pyannote.statuses = ["running"]  # never finishes
    err = await fails(fake_speech, fake_pyannote, path, window=2.0, poll_interval=0.01)
    assert err.code == "provider_unreachable" and err.usage is not None and err.usage.step == "transcribe"
    assert len(fake_pyannote.jobs) == 1  # the job was created: it may still be billed (documented)


async def test_the_deadline_while_only_polling_reports_the_diarize_usage(
    fake_speech: FakeSpeech, fake_pyannote: FakePyannote, four: Path
) -> None:
    fake_speech.forced = [reply(["a", "b"])]
    fake_pyannote.statuses = ["running"]
    err = await fails(fake_speech, fake_pyannote, four, limits=JobLimits(timeout_seconds=3), poll_interval=0.05)
    assert err.code == "limit_exceeded"
    assert err.usage is not None and err.usage.step == "diarize" and err.usage.audio_seconds == 4.0


async def test_events(fake_speech: FakeSpeech, fake_pyannote: FakePyannote, four: Path) -> None:
    fake_speech.forced = [reply(["a", "b"])]
    events: list[PipelineEvent] = []
    await run(fake_speech, fake_pyannote, four, events=events)
    assert [(e.step, e.kind) for e in events if e.step == "diarize"] == [
        ("diarize", "started"),
        ("diarize", "finished"),
    ]


async def test_without_a_diarizer_nothing_changes(fake_speech: FakeSpeech, four: Path) -> None:
    fake_speech.forced = [reply(["a", "b"])]
    result = await run(fake_speech, None, four)
    assert steps(result) == ["decode", "transcribe"]
    assert result.transcript.source.diarized is False and result.diarization_skipped is None  # type: ignore[union-attr]


@pytest.mark.parametrize("which", ["split", "fallback"])
async def test_split_never_diarizes_but_its_mono_fallback_does(
    fake_speech: FakeSpeech, fake_pyannote: FakePyannote, tmp_path: Path, which: str
) -> None:
    if which == "split":
        path = make_stereo(tmp_path / "call.wav", [(0.2, 1.0, 1100)], [(1.5, 2.5, 2100)], seconds=3.0)
    else:
        path = make_tone(tmp_path / "mono.wav", seconds=3.0, rate=16000, channels=1)
    fake_speech.forced = [reply(["a", "b"]), reply(["c"])]
    result = await run(fake_speech, fake_pyannote, path, TranscribeOptions(channels="split"), detector=nonzero_runs)
    if which == "split":
        assert fake_pyannote.seen == [] and "diarize" not in steps(result)
        assert result.transcript.source.channel_mode == "split" and not result.transcript.source.diarized  # type: ignore[union-attr]
    else:
        assert result.transcript.source.channel_mode == "mix" and result.transcript.source.diarized  # type: ignore[union-attr]


async def test_logs_and_errors_carry_no_provider_text(
    fake_speech: FakeSpeech, fake_pyannote: FakePyannote, four: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    fake_speech.forced = [reply(["a", "b"])]
    fake_pyannote.statuses = ["failed"]
    err = await fails(fake_speech, fake_pyannote, four)
    out = capsys.readouterr()
    for text in (PYANNOTE_MARKER, KEY, "sig="):
        assert text not in out.out and text not in out.err and text not in str(err)


def test_run_is_cancel_safe(fake_speech: FakeSpeech, fake_pyannote: FakePyannote, four: Path) -> None:
    fake_speech.forced = [reply(["a", "b"])]
    fake_pyannote.statuses = ["running"]

    async def main() -> None:
        task = asyncio.ensure_future(run(fake_speech, fake_pyannote, four, poll_interval=0.01))
        async with asyncio.timeout(10):  # a regression fails the test instead of hanging it
            while not fake_pyannote.jobs:
                await asyncio.sleep(0.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(main())


# ---- from the adversarial review ----


async def test_a_later_window_without_times_discards_the_diarization(
    fake_speech: FakeSpeech, fake_pyannote: FakePyannote, tmp_path: Path
) -> None:
    path = make_tone(tmp_path / "long.wav", seconds=4.0, rate=16000, channels=1)
    fake_speech.forced = [reply(["a", "b"]), reply(["c", "d"], shape="text")]
    fake_pyannote.output = segments((0.0, 0.6, "A"), (0.6, 4.0, "B"))
    result = await run(fake_speech, fake_pyannote, path, window=2.0)
    assert result.diarization_skipped == "no_times"
    assert result.transcript.source.diarized is False  # type: ignore[union-attr]
    assert {s.speaker for s in result.transcript.segments} == {"s1"} and len(result.transcript.speakers) == 1
    assert "diarize" in steps(result)  # it was paid for: the usage says so


async def test_a_later_timed_window_does_not_reopen_a_closed_gate(
    fake_speech: FakeSpeech, fake_pyannote: FakePyannote, tmp_path: Path
) -> None:
    path = make_tone(tmp_path / "long.wav", seconds=4.0, rate=16000, channels=1)
    fake_speech.forced = [reply(["a", "b"], shape="text"), reply(["c", "d"])]
    result = await run(fake_speech, fake_pyannote, path, window=2.0)
    assert result.diarization_skipped == "no_times"
    assert fake_pyannote.requests("upload") == [] and fake_pyannote.jobs == []


def test_spans_are_shifted_cut_and_dropped() -> None:
    from types import SimpleNamespace

    from aftertalk.pipeline.transcribe import _Run
    from aftertalk.providers.diarization.protocols import DiarizationOutput, DiarizationSegment

    output = DiarizationOutput(
        segments=(
            DiarizationSegment(0.0, 1.5, "A"),
            DiarizationSegment(3.0, 9.0, "B"),  # past the end: cut to it
            DiarizationSegment(4.0, 5.0, "C"),  # starts at the end: dropped
            DiarizationSegment(3.9994, 4.5, "D"),  # starts just before the end: kept
        )
    )
    spans = _Run._spans(SimpleNamespace(offset=45.0, duration=4.0), output)  # type: ignore[arg-type]
    assert [(s.start, s.end, s.speaker) for s in spans] == [
        (45.0, 46.5, "A"),
        (48.0, 49.0, "B"),
        (48.999, 49.0, "D"),
    ]


async def test_a_bug_in_the_key_check_is_internal_on_the_diarize_step(
    fake_speech: FakeSpeech, fake_pyannote: FakePyannote, four: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def broken(self, *, deadline):  # noqa: ANN001
        raise RuntimeError(PYANNOTE_MARKER)

    monkeypatch.setattr(PyannoteDiarization, "check", broken)
    err = await fails(fake_speech, fake_pyannote, four)
    assert err.code == "internal" and err.usage is not None and err.usage.step == "diarize"
    assert PYANNOTE_MARKER not in str(err) and fake_speech.seen == []


async def test_spans_with_no_timed_word_to_place_say_no_times(
    fake_speech: FakeSpeech, fake_pyannote: FakePyannote, four: Path
) -> None:
    # Times far past the window are dropped by the pipeline (`_bounded`): text with no usable time at all.
    data = {"text": "x y", "language": "polish", "segments": [{"id": 0, "start": 50.0, "end": 51.0, "text": " x y"}]}
    fake_speech.forced = [Forced(200, json.dumps(data))]
    result = await run(fake_speech, fake_pyannote, four)
    assert result.diarization_skipped == "no_times"


@pytest.mark.parametrize("job", ["never finishes", "fails"])
async def test_a_later_untimed_window_stops_waiting_for_the_diarization(
    fake_speech: FakeSpeech, fake_pyannote: FakePyannote, tmp_path: Path, job: str
) -> None:
    path = make_tone(tmp_path / "long.wav", seconds=4.0, rate=16000, channels=1)
    fake_speech.forced = [reply(["a", "b"]), reply(["c", "d"], shape="text")]
    fake_pyannote.statuses = (
        ["running"] if job == "never finishes" else ["running"] * 20 + ["failed"]
    )  # fails after window 2
    fake_speech.stall = 0.2  # the job exists before window 2 answers
    started = time.monotonic()
    result = await run(
        fake_speech, fake_pyannote, path, window=2.0, poll_interval=0.05, limits=JobLimits(timeout_seconds=10)
    )
    assert time.monotonic() - started < 5
    assert result.diarization_skipped == "no_times" and len(fake_pyannote.jobs) == 1


async def test_a_later_window_whose_times_are_all_out_of_range_counts_as_untimed(
    fake_speech: FakeSpeech, fake_pyannote: FakePyannote, tmp_path: Path
) -> None:
    path = make_tone(tmp_path / "long.wav", seconds=4.0, rate=16000, channels=1)
    late = {"text": "x y", "language": "polish", "segments": [{"id": 0, "start": 50.0, "end": 51.0, "text": " x y"}]}
    fake_speech.forced = [reply(["a", "b"]), Forced(200, json.dumps(late))]
    fake_pyannote.output = segments((0.0, 0.6, "A"), (0.6, 4.0, "B"))
    result = await run(fake_speech, fake_pyannote, path, window=2.0, limits=JobLimits(timeout_seconds=20))
    assert result.diarization_skipped == "no_times" and not result.transcript.source.diarized  # type: ignore[union-attr]


async def test_a_later_silent_window_does_not_stop_diarization(
    fake_speech: FakeSpeech, fake_pyannote: FakePyannote, tmp_path: Path
) -> None:
    path = make_tone(tmp_path / "long.wav", seconds=4.0, rate=16000, channels=1)
    silent = {"text": "", "language": "polish", "segments": [], "words": []}
    fake_speech.forced = [reply(["a", "b"]), Forced(200, json.dumps(silent))]
    fake_pyannote.output = segments((0.0, 0.6, "A"), (0.6, 4.0, "B"))
    result = await run(fake_speech, fake_pyannote, path, window=2.0, limits=JobLimits(timeout_seconds=20))
    assert result.diarization_skipped is None and result.transcript.source.diarized  # type: ignore[union-attr]
