"""Transcribe one audio or video file into the canonical transcript: decode once, send windows, stitch the turns.

Rules (`channels=mix`, the only mode until PR 2):
- The file is decoded once to 16 kHz PCM (`audio/decode.py`) and mixed to mono. `JobLimits.max_audio_seconds` stops
  the decoder, and the deadline (`JobLimits.timeout_seconds` from the call) covers everything, decoding included;
  running out anywhere is `limit_exceeded`. Both are checked before any provider request.
- The mono track is cut into windows (`audio/windows.py`) that fit `speech.capabilities.max_upload_bytes`. Windows
  are sent one at a time, in order, each with only the caller's prompt: no text is chained from window to window.
- Language: a forced language goes to every window. Otherwise window 1 is detected (with `allowed_languages`, so a
  language that is not allowed, or none reported when several are allowed, fails there, before the rest is paid
  for), and every later window is forced to what window 1 returned. When window 1 returned none, the rest are sent
  unforced.
- A provider time is first bounded by the window's audio (compared in milliseconds, each word and each segment on
  its own): an end up to `SENT_SLACK_SECONDS` past the window's end is cut to it; an end further past, or a start
  past it, is no time (the text is kept). So a turn never takes in the next window's words by a time the provider
  overshot, nor ends after the audio.
- Every time is shifted by the window's start plus the audio's start offset in the file, rounded to milliseconds:
  times are seconds from the start of the original file. The windows' segments are joined in order and regrouped
  into the turns of one speaker (`turns.py`); the turns are the transcript's segments, its text is their texts
  joined with one space, and its timing level is recomputed on them (it can be lower than any single window's).
- Usage is one `StepUsage` per step: `decode` (time only) and `transcribe` (all windows summed, with the lowest
  `speech_format` any window needed). An entry without a `provider` is a step that was not billed, and
  `audio_seconds` is only on the `transcribe` entry, so a sum over the entries counts the audio once. A failure raises an `EngineError` with a fixed code; one that comes from a
  window carries the transcribe step's usage so far, that window's included (a request still in flight when the time
  runs out counts as one attempt, not a request, with its audio), so what was used can be billed. A window that was never sent adds
  no audio. Nothing from the provider is chained to it.
- Events and logs carry step names, counts and durations only: never transcript text, file names or languages.
"""

import asyncio
import hashlib
import threading
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import numpy as np

from aftertalk.audio.decode import SAMPLE_RATE, open_decoded, to_mono
from aftertalk.audio.encode import AudioFormat, encode_pcm
from aftertalk.audio.windows import Window, plan_mix_windows
from aftertalk.logging import log
from aftertalk.models.errors import EngineError
from aftertalk.models.transcript import Segment, Source, Speaker, Transcript, Word, timing_level
from aftertalk.models.usage import JobLimits, StepUsage
from aftertalk.pipeline.turns import build_turns
from aftertalk.providers.speech.languages import normalize_language
from aftertalk.providers.speech.protocols import SpeechProvider

__all__ = ["PipelineEvent", "TranscribeOptions", "TranscribeResult", "transcribe_file"]

Step = Literal["decode", "transcribe"]
EventKind = Literal["started", "progress", "finished"]

# The request forms of `StepUsage.speech_format`, most informative first: all timestamps, segments only, plain text.
_FORMATS = ("verbose_json", "verbose_json_segments", "json")
_HASH_CHUNK = 1024 * 1024
_SPEAKER = Speaker(id="s1", label="Speaker 1")
SENT_SLACK_SECONDS = 1.0  # how far past the audio sent a provider's end time may be and still be cut to it


@dataclass(frozen=True)
class TranscribeOptions:
    language: str | None = None  # forced on every window; None: detected on window 1
    allowed_languages: Sequence[str] | None = None  # checked on window 1 when no language is forced
    prompt: str | None = None  # names and terms; every window gets this and nothing else
    audio_format: AudioFormat = "flac"


@dataclass(frozen=True)
class TranscribeResult:
    transcript: Transcript
    usage: list[StepUsage]  # one entry per step, in order: decode, transcribe


@dataclass(frozen=True)
class PipelineEvent:
    """Progress for the caller. Counts and durations only, never text."""

    step: Step
    kind: EventKind
    windows_done: int | None = None  # transcribe: windows finished so far
    windows_total: int | None = None  # transcribe: windows planned
    audio_seconds: float | None = None  # the decoded audio's length, once known


@dataclass
class _Totals:
    """The transcribe step's usage, summed over the windows sent so far, the one in flight included."""

    started: float = 0.0
    requests: int = 0
    attempts: int = 0
    audio_seconds: float | None = None
    provider: str | None = None
    model: str | None = None
    format: int | None = None  # index into _FORMATS: the lowest form any window needed
    # The window being sent: one attempt with its audio until the call returns. A timeout that cancels the call
    # leaves it here, so the error's usage still counts what was uploaded.
    in_flight: float | None = None

    def add(self, usage: StepUsage | None) -> None:
        if usage is None:
            return
        self.requests += usage.requests
        self.attempts += usage.attempts
        if usage.audio_seconds is not None and usage.attempts > 0:  # audio never sent is not billed
            self.audio_seconds = (self.audio_seconds or 0.0) + usage.audio_seconds
        self.provider = self.provider or usage.provider
        self.model = self.model or usage.model
        if usage.speech_format is not None:
            rung = _FORMATS.index(usage.speech_format)
            self.format = rung if self.format is None else max(self.format, rung)

    def usage(self) -> StepUsage:
        flying = int(self.in_flight is not None)
        audio = self.audio_seconds if self.in_flight is None else (self.audio_seconds or 0.0) + self.in_flight
        return StepUsage(
            step="transcribe",
            provider=self.provider,
            model=self.model,
            requests=self.requests,  # requests that got a response; the one in flight has none yet
            attempts=self.attempts + flying,
            audio_seconds=None if audio is None else round(audio, 3),
            speech_format=None if self.format is None else _FORMATS[self.format],  # type: ignore[arg-type]
            duration_ms=_ms_since(self.started),
        )


@dataclass
class _State:
    step: Step = "decode"
    totals: _Totals = field(default_factory=_Totals)

    def usage(self) -> StepUsage | None:
        """What a failure reports: the transcribe step's usage once it has started, else nothing."""
        return self.totals.usage() if self.step == "transcribe" else None


def _ms_since(started: float) -> int:
    return max(0, int((time.monotonic() - started) * 1000))


def _sha256(path: Path, stop: threading.Event) -> str | None:
    """sha256 of the file's bytes, read in chunks; None when the caller stopped waiting."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(_HASH_CHUNK):
            if stop.is_set():
                return None
            digest.update(chunk)
    return digest.hexdigest()


def _shift(t: float | None, offset: float) -> float | None:
    return None if t is None else round(t + offset, 3)


def _bounded(start: float | None, end: float | None, sent: float) -> tuple[float | None, float | None]:
    """A provider time bounded by the `sent` seconds of audio, compared in milliseconds: an end up to
    `SENT_SLACK_SECONDS` past it is cut to it; one further, or a start past it, is no time."""
    if start is None or end is None:
        return start, end
    start_ms, end_ms, sent_ms = round(start * 1000), round(end * 1000), round(sent * 1000)
    if end_ms <= sent_ms:
        return start, end
    if start_ms > sent_ms or end_ms > sent_ms + round(SENT_SLACK_SECONDS * 1000):
        return None, None
    return start, max(start, sent)  # max: a start equal to `sent` in milliseconds may be a hair above it


def _shifted(segments: Sequence[Segment], offset: float, sent: float) -> list[Segment]:
    """The segments with every time bounded by the `sent` seconds of audio (`_bounded`), each word and each
    segment on its own, then moved by `offset` seconds onto the file's timeline."""
    out: list[Segment] = []
    for seg in segments:
        start, end = _bounded(seg.start, seg.end, sent)
        words = []
        for w in seg.words:
            w_start, w_end = _bounded(w.start, w.end, sent)
            words.append(
                Word(text=w.text, start=_shift(w_start, offset), end=_shift(w_end, offset), probability=w.probability)
            )
        out.append(seg.model_copy(update={"start": _shift(start, offset), "end": _shift(end, offset), "words": words}))
    return out


async def transcribe_file(
    path: Path,
    speech: SpeechProvider,
    options: TranscribeOptions,
    limits: JobLimits | None = None,
    on_event: Callable[[PipelineEvent], None] | None = None,
) -> TranscribeResult:
    """Transcribe `path` with `speech`. Raises `EngineError` with a fixed code on any failure."""
    started = time.monotonic()
    timeout = limits.timeout_seconds if limits is not None else None
    deadline = None if timeout is None else started + timeout
    state = _State()
    error: EngineError | None = None
    try:
        async with asyncio.timeout(timeout):
            result = await _run(path, speech, options, limits, deadline, on_event, state)
        log("info", "transcribe finished", step="transcribe", duration_ms=_ms_since(started))
        return result
    except TimeoutError:
        error = EngineError("limit_exceeded", state.usage())
    except EngineError as err:
        error = err
    except Exception:
        error = EngineError("internal", state.usage())  # a bug of ours; its text is not shown
    # Raised outside the except block: nothing is chained to it.
    log("info", "transcribe failed", step=state.step, error_code=error.code, duration_ms=_ms_since(started))
    try:
        raise error
    finally:
        del error  # its traceback holds this frame: no cycle that keeps the decoded audio mapped


async def _run(
    path: Path,
    speech: SpeechProvider,
    options: TranscribeOptions,
    limits: JobLimits | None,
    deadline: float | None,
    on_event: Callable[[PipelineEvent], None] | None,
    state: _State,
) -> TranscribeResult:
    def emit(event: PipelineEvent) -> None:
        if on_event is not None:
            on_event(event)

    decode_started = time.monotonic()
    emit(PipelineEvent("decode", "started"))
    stop_hashing = threading.Event()
    hashing = asyncio.ensure_future(asyncio.to_thread(_sha256, path, stop_hashing))
    hashing.add_done_callback(lambda task: task.cancelled() or task.exception())  # never "never retrieved"
    try:
        max_seconds = limits.max_audio_seconds if limits is not None else None
        async with open_decoded(path, max_seconds=max_seconds) as audio:
            sha: str | None = None
            unreadable = False
            try:
                sha = await hashing
            except OSError:
                unreadable = True
            if unreadable or sha is None:
                raise EngineError("audio_unreadable")
            decode_usage = StepUsage(step="decode", duration_ms=_ms_since(decode_started))
            emit(PipelineEvent("decode", "finished", audio_seconds=audio.duration_seconds))

            state.step = "transcribe"
            state.totals.started = time.monotonic()
            samples = audio.samples  # the worker threads keep the map alive even if the block is left early
            windows = await asyncio.to_thread(plan_mix_windows, audio, max_bytes=speech.capabilities.max_upload_bytes)
            emit(PipelineEvent("transcribe", "started", 0, len(windows), audio.duration_seconds))
            segments: list[Segment] = []
            forced = normalize_language(options.language) if options.language else None
            language: str | None = None
            for i, window in enumerate(windows):
                if deadline is not None and time.monotonic() >= deadline:
                    raise EngineError("limit_exceeded", state.totals.usage())
                part = await _window(speech, samples, window, i, options, language, deadline, state.totals)
                if i == 0:
                    language = forced or part.language
                offset = window.start / SAMPLE_RATE + audio.start_offset_seconds
                segments.extend(_shifted(part.segments, offset, (window.stop - window.start) / SAMPLE_RATE))
                emit(PipelineEvent("transcribe", "progress", i + 1, len(windows), audio.duration_seconds))

            turns = build_turns(segments, speaker=_SPEAKER.id)
            name = path.name if "/" not in path.name and "\\" not in path.name else None
            transcript = Transcript(
                text=" ".join(turn.text for turn in turns),
                language=language,
                duration_seconds=round(audio.start_offset_seconds + audio.duration_seconds, 3),
                timing=timing_level(turns),
                segments=turns,
                speakers=[_SPEAKER],
                source=Source(
                    kind="video" if audio.has_video else "audio",
                    name=name,
                    sha256=sha,
                    container=audio.container,
                    channels=audio.channels,
                    channel_mode="mix",
                    start_offset_seconds=round(audio.start_offset_seconds, 3),
                ),
            )
            transcribe_usage = state.totals.usage()
            emit(PipelineEvent("transcribe", "finished", len(windows), len(windows), audio.duration_seconds))
            return TranscribeResult(transcript=transcript, usage=[decode_usage, transcribe_usage])
    finally:
        stop_hashing.set()
        hashing.cancel()


async def _window(
    speech: SpeechProvider,
    samples: np.ndarray,
    window: Window,
    index: int,
    options: TranscribeOptions,
    detected: str | None,
    deadline: float | None,
    totals: _Totals,
) -> Transcript:
    """Encode and send one window; its usage is added to `totals`, also when it fails."""
    upload = await asyncio.to_thread(
        lambda: encode_pcm(to_mono(samples, window.start, window.stop), options.audio_format)
    )
    first = index == 0
    language = options.language if options.language or first else detected
    allowed = options.allowed_languages if first and not options.language else None
    part: Transcript | None = None
    failure: EngineError | None = None
    totals.in_flight = upload.duration_seconds
    try:
        part, usage = await speech.transcribe(
            upload, language=language, prompt=options.prompt, deadline=deadline, allowed_languages=allowed
        )
        totals.in_flight = None
    except EngineError as err:
        totals.in_flight = None
        totals.add(err.usage)
        failure = EngineError(err.code, detected_language=err.detected_language)
    except Exception:  # left in flight: whether it was sent is not known, so it counts as sent
        failure = EngineError("internal")  # an adapter maps its own errors; anything else is ours, and not shown
    if failure is not None or part is None:
        failure = failure or EngineError("internal")
        failure.usage = totals.usage()
        try:
            raise failure  # outside the except block: nothing from the provider is chained to it
        finally:
            del failure  # its traceback holds this frame, and the frame holds the map
    totals.add(usage)
    return part
