"""Transcribe one audio or video file into the canonical transcript: decode once, send windows, stitch the turns.

Rules for both modes:
- The file is decoded once to 16 kHz PCM (`audio/decode.py`). `JobLimits.max_audio_seconds` stops the decoder, and
  the deadline (`JobLimits.timeout_seconds` from the call) covers everything, decoding included; running out anywhere
  is `limit_exceeded`. Both are checked before any provider request.
- Language. The allowed languages are normalised and de-duplicated; an unknown one is a `ValueError`. A forced
  language, or else exactly one allowed language, goes to every window. Otherwise windows are sent with detection
  until one returns text (`_has_text`); that window decides, and every window sent after it is forced to it. Every
  answer with text that was sent with detection is checked: a language that is not allowed, or none reported when
  several are allowed, fails there (`language_not_allowed`, checked here, not in the adapter), whichever answer
  arrives first. A window without text never fails on its language and never decides; when no window has text the
  transcript has no language. The order in which windows are tried differs per mode (below).
- `require_times` (the caller will write subtitles): the first answer with text that comes back without any times
  (`timing` none) fails there with `TimesUnavailable`, before the rest is paid for; per channel for `split`.
- A provider time is first bounded by the window's audio (compared in milliseconds, each word and each segment on
  its own): an end up to `SENT_SLACK_SECONDS` past the window's end is cut to it; an end further past, or a start
  past it, is no time (the text is kept). Every time is then shifted by the window's start plus the audio's start
  offset, rounded to milliseconds: times are seconds from the start of the original file.
- The turns are the transcript's segments; its text is their texts joined with one space, and its timing level is
  recomputed on them (it can be lower than any single window's).
- Usage is one `StepUsage` per step: `decode` and (for `split`) `vad` carry time only, `transcribe` all windows summed,
  with the lowest `speech_format` any window needed, and `diarize` (mixed audio with a diarizer, whenever it sent a
  request) the diarizer's requests. An entry without a `provider` is a step that was not billed; `audio_seconds` is on
  the `transcribe` entry, and on `diarize` once a diarization job was asked for. A failure raises an `EngineError` with a fixed code; one that
  comes from a window carries the transcribe step's usage so far, that window's included (a request still in flight
  when the run stops counts as one attempt, not a request, with its audio). A window that was never sent adds no
  audio. Nothing from the provider is chained to it.
- Events and logs carry step names, counts and durations only: never transcript text, file names or languages.

`channels="mix"` (the default): all channels mixed to mono, one speaker "Speaker 1". The track is cut into windows
(`audio/windows.py`) of at most 600 s that fit `speech.capabilities.max_upload_bytes`, sent one at a time, in order,
each with only the caller's prompt. Language: window 1, 2... in order until one has text.

`mix` with a `diarizer` (a real two-channel `split` never diarizes; its fallback to `mix` does): a request that sends
no audio checks the diarizer's key before window 1. The whole track, mixed to mono (`audio.encode.MonoWav`, streamed),
goes to the diarizer once, after the first window with text passed the language and times checks; the windows go on
meanwhile. A failure on either side cancels the other and fails the run (spec #14); its error carries the failing
side's usage, the windows' when both failed, and diarize's for a deadline once only diarization is left. Diarization
times are shifted by the start offset, and the turns come from `turns.build_speaker_turns` (speakers "Speaker 1",
"Speaker 2"... by first speech; `source.diarized`). It is skipped, with one speaker and `diarization_skipped` saying
why, when that first window has no times (`no_times`), the track is over the diarizer's limits (`too_long`, nothing
sent) or the diarizer found no speakers (`no_speakers`); a file without text sends it no audio.

`channels="split"` (a two-channel file; anything else falls back to `mix`, with speakers that have no role and the
default label, and `source.channel_mode` says "mix"): one speaker per channel, channel 0 first, with the caller's
labels and roles (default: customer on channel 0, agent on channel 1; a label defaults from its role). The windows
are each channel's speech segments (`audio/vad.py`, one channel at a time). Channels are sent concurrently (at most
`concurrency` requests at once), the windows of one channel in order, each with the previous text of the same
channel as the prompt (the last `CHAIN_CHARS` characters, starting from the caller's prompt or empty). Language:
the first five windows of the call in time order (both channels, ties channel 0 first) are tried longest first, each
with only the caller's prompt, until one has text that survives the filter's score rules; each answer is kept and
reused in its channel's chain, never sent twice. After the windows, the hallucination filter (`filter.py`) drops
provider segments, and the turns of several speakers are built (`turns.build_channel_turns`). A channel without
speech is a speaker with no turns; a file without speech is an empty transcript, and no request is sent.
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

from aftertalk.audio.decode import SAMPLE_RATE, DecodedAudio, open_decoded, retry_removals, to_mono
from aftertalk.audio.encode import AudioFormat, EncodedAudio, MonoWav, encode_pcm, wav_size
from aftertalk.audio.vad import INSTALL_HINT, MAX_SPEECH_SECONDS, AudioExtraMissing, SpeechDetector, load_detector
from aftertalk.audio.windows import Window, max_window_seconds, plan_mix_windows
from aftertalk.logging import log
from aftertalk.models.errors import EngineError
from aftertalk.models.transcript import Segment, Source, Speaker, Transcript, Word, timing_level
from aftertalk.models.usage import JobLimits, StepUsage
from aftertalk.pipeline.filter import fails_scores, filter_hallucinations
from aftertalk.pipeline.turns import ChannelPart, SpeakerSpan, build_channel_turns, build_speaker_turns, build_turns
from aftertalk.providers.diarization.protocols import DiarizationOutput, DiarizationProvider
from aftertalk.providers.speech.languages import normalize_language
from aftertalk.providers.speech.protocols import SpeechProvider

__all__ = ["PipelineEvent", "TimesUnavailable", "TranscribeOptions", "TranscribeResult", "transcribe_file"]

Step = Literal["decode", "vad", "transcribe", "diarize"]
DiarizationSkipped = Literal["no_times", "too_long", "no_speakers"]
EventKind = Literal["started", "progress", "finished"]
ChannelMode = Literal["mix", "split"]
Role = Literal["agent", "customer"]

# The request forms of `StepUsage.speech_format`, most informative first: all timestamps, segments only, plain text.
_FORMATS = ("verbose_json", "verbose_json_segments", "json")
_HASH_CHUNK = 1024 * 1024
_MIX_SPEAKER = Speaker(id="s1", label="Speaker 1")
_ROLE_LABELS: dict[str, str] = {"customer": "Customer", "agent": "Agent"}
DEFAULT_ROLES: tuple[Role, Role] = ("customer", "agent")  # channel 0, channel 1 (spec)
SENT_SLACK_SECONDS = 1.0  # how far past the audio sent a provider's end time may be and still be cut to it
CHAIN_CHARS = 500  # `split`: how much of a channel's previous text each request gets as its prompt
PROBE_WINDOWS = 5  # `split`: the language comes from the longest of this many first windows that has text
MIN_SPLIT_SECONDS = 2.0  # `split`: an upload limit that holds less audio than this is `audio_too_long`


@dataclass(frozen=True)
class TranscribeOptions:
    language: str | None = None  # forced on every window; None: detected (see the module docstring)
    allowed_languages: Sequence[str] | None = None  # checked on the window that decides; one entry is forced
    prompt: str | None = None  # names and terms; `mix`: every window gets this; `split`: the start of each chain
    audio_format: AudioFormat = "flac"
    channels: ChannelMode = "mix"
    labels: Sequence[str] | None = None  # `split`: one per channel; default from the role, else "Speaker N"
    roles: Sequence[Role | None] | None = None  # `split`: one per channel; default customer, agent
    require_times: bool = False  # fail early (`TimesUnavailable`) when the provider returns no times
    concurrency: int = 2  # `split`: requests in flight at once


@dataclass(frozen=True)
class TranscribeResult:
    transcript: Transcript
    usage: list[StepUsage]  # one entry per step, in order: decode, vad (split only), transcribe, diarize (see below)
    dropped_segments: int = 0  # provider segments the hallucination filter dropped (`split` only)
    # With a diarizer on mixed audio, why the speakers did not come from it (None when they did, or when there was no
    # text to diarize): the speech provider returned no times, the file is over the diarizer's limits, or the
    # diarizer found no speakers. `source.diarized` says whether they did.
    diarization_skipped: DiarizationSkipped | None = None


@dataclass(frozen=True)
class PipelineEvent:
    """Progress for the caller. Counts and durations only, never text."""

    step: Step
    kind: EventKind
    windows_done: int | None = None  # transcribe: windows finished so far
    windows_total: int | None = None  # transcribe: windows planned
    audio_seconds: float | None = None  # the decoded audio's length, once known


class TimesUnavailable(Exception):
    """`require_times` was set and the provider returned an answer with text but no times. `usage` is what was used."""

    def __init__(self, usage: StepUsage | None = None) -> None:
        super().__init__("the speech provider returned no timestamps")
        self.usage = usage


@dataclass
class _Totals:
    """The transcribe step's usage, summed over the windows sent so far, those in flight included."""

    started: float = 0.0
    requests: int = 0
    attempts: int = 0
    audio_seconds: float | None = None
    provider: str | None = None
    model: str | None = None
    format: int | None = None  # index into _FORMATS: the lowest form any window needed
    # The windows being sent: one attempt each with its audio until the call returns. A timeout or a failing
    # channel that cancels a call leaves it here, so the error's usage still counts what was uploaded.
    in_flight: dict[int, float] = field(default_factory=dict)
    _next: int = 0

    def fly(self, seconds: float) -> int:
        self._next += 1
        self.in_flight[self._next] = seconds
        return self._next

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
        flying = len(self.in_flight)
        audio = self.audio_seconds
        if flying:
            audio = (audio or 0.0) + sum(self.in_flight.values())
        return StepUsage(
            step="transcribe",
            provider=self.provider,
            model=self.model,
            requests=self.requests,  # requests that got a response; those in flight have none yet
            attempts=self.attempts + flying,
            audio_seconds=None if audio is None else round(audio, 3),
            speech_format=None if self.format is None else _FORMATS[self.format],  # type: ignore[arg-type]
            duration_ms=_ms_since(self.started),
        )


@dataclass
class _State:
    step: Step = "decode"
    totals: _Totals = field(default_factory=_Totals)
    diarizer: DiarizationProvider | None = None

    def usage(self) -> StepUsage | None:
        """What a failure reports: the running step's usage (transcribe, or diarize once only it is left)."""
        if self.step == "diarize" and self.diarizer is not None:
            return self.diarizer.usage()
        return self.totals.usage() if self.step == "transcribe" else None


@dataclass
class _Language:
    """The run's language: decided by a forced language, or by the first window with text."""

    allowed: frozenset[str] | None  # checked on the deciding window; None: no check
    decided: bool = False
    value: str | None = None

    def request(self) -> str | None:
        """What a window is sent with: the decided language, or None (detect)."""
        return self.value if self.decided else None

    def decide(self, part: Transcript, totals: _Totals) -> None:
        """Called with every answer that has text and was sent with detection: each is checked against the allowed
        languages, so a window that was in flight when another one decided cannot slip through (the outcome does not
        depend on which answer arrives first); the first one decides."""
        if self.allowed is not None and (part.language is None or part.language not in self.allowed):
            # Our own code from the language table (None when it was not reported or could not be mapped).
            raise EngineError("language_not_allowed", totals.usage(), detected_language=part.language)
        if not self.decided:
            self.decided, self.value = True, part.language


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


def _shifted(segments: Sequence[Segment], offset: float, sent: float, speaker: str | None = None) -> list[Segment]:
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
        update = {"start": _shift(start, offset), "end": _shift(end, offset), "words": words}
        if speaker is not None:
            update["speaker"] = speaker
        out.append(seg.model_copy(update=update))
    return out


def _has_text(part: Transcript) -> bool:
    return bool(part.text.strip()) or any(seg.text.strip() for seg in part.segments)


def _has_real_text(part: Transcript, sent: float) -> bool:
    """`split`: text that the filter's score rules would keep (filler on hold music does not count), judged on the
    times as the filter sees them: bounded by the `sent` seconds of audio."""
    if not part.segments:
        return bool(part.text.strip())
    return any(seg.text.strip() and not fails_scores(seg) for seg in _shifted(part.segments, 0.0, sent))


def _encode(samples: np.ndarray, window: Window, channel: int | None, fmt: AudioFormat) -> EncodedAudio:
    """One window as an upload: the mono mix (`channel` None) or one channel."""
    if channel is None:
        return encode_pcm(to_mono(samples, window.start, window.stop), fmt)
    return encode_pcm(np.ascontiguousarray(samples[window.start : window.stop, channel]), fmt)


def _detect(
    detector: SpeechDetector, samples: np.ndarray, channel: int, longest: float, stop: threading.Event
) -> list[tuple[int, int]]:
    return detector(samples[:, channel], longest, stop)


def _speakers(options: TranscribeOptions) -> list[Speaker]:
    """The two `split` speakers, s1 on channel 0 and s2 on channel 1."""
    roles = list(options.roles) if options.roles is not None else list(DEFAULT_ROLES)
    labels = list(options.labels) if options.labels is not None else [None, None]
    out = []
    for channel in (0, 1):
        role = roles[channel]
        label = labels[channel] or (_ROLE_LABELS[role] if role is not None else f"Speaker {channel + 1}")
        out.append(Speaker(id=f"s{channel + 1}", label=label, role=role, channel=channel))
    return out


def _check_options(options: TranscribeOptions) -> None:
    if options.channels not in ("mix", "split"):
        raise ValueError("channels is mix or split")
    if options.channels != "split" and (options.roles is not None or options.labels is not None):
        raise ValueError("labels and roles need channels='split'")
    for name, values in (("labels", options.labels), ("roles", options.roles)):
        if values is not None and len(values) != 2:
            raise ValueError(f"{name}: one per channel, two in all")
    if options.labels is not None and any(not label or not label.strip() for label in options.labels):
        raise ValueError("labels must not be empty")
    if options.roles is not None:
        roles = [role for role in options.roles if role is not None]
        if any(role not in _ROLE_LABELS for role in roles) or len(set(roles)) != len(roles):
            raise ValueError("roles: agent or customer, at most one speaker each")
    if options.concurrency < 1:
        raise ValueError("concurrency must be at least 1")
    if options.language and normalize_language(options.language) is None:
        raise ValueError("language: not a language the engine knows")
    if options.allowed_languages is not None:
        if not options.allowed_languages or any(normalize_language(item) is None for item in options.allowed_languages):
            raise ValueError("allowed_languages: at least one, each a language the engine knows")


async def transcribe_file(
    path: Path,
    speech: SpeechProvider,
    options: TranscribeOptions,
    limits: JobLimits | None = None,
    on_event: Callable[[PipelineEvent], None] | None = None,
    *,
    detector: SpeechDetector | None = None,
    diarizer: DiarizationProvider | None = None,
) -> TranscribeResult:
    """Transcribe `path` with `speech`, and with `diarizer` find the speakers of mixed audio (see the module docstring).
    Raises `EngineError` with a fixed code on any failure, or `TimesUnavailable` with `require_times`. Bad options (an
    unknown language among them) raise `ValueError`, and `split` without the `[audio]` extra (and no `detector`)
    raises `AudioExtraMissing`, both before anything is read."""
    _check_options(options)
    if options.channels == "split" and detector is None:
        try:
            detector = load_detector()
        except AudioExtraMissing:
            pass
        if detector is None:
            raise AudioExtraMissing(INSTALL_HINT)
    started = time.monotonic()
    timeout = limits.timeout_seconds if limits is not None else None
    deadline = None if timeout is None else started + timeout
    state = _State(diarizer=diarizer)
    error: Exception | None = None
    try:
        async with asyncio.timeout(timeout):
            result = await _run(path, speech, options, limits, deadline, on_event, state, detector, diarizer)
        log("info", "transcribe finished", step="transcribe", duration_ms=_ms_since(started))
        retry_removals()
        return result
    except TimeoutError:
        error = EngineError("limit_exceeded", state.usage())
    except (EngineError, TimesUnavailable) as err:
        error = err
    except Exception:
        error = EngineError("internal", state.usage())  # a bug of ours; its text is not shown
    except BaseException:  # cancelled or interrupted: still try to delete what Windows kept
        retry_removals()
        raise
    # Raised outside the except block: nothing is chained to it. Its traceback is dropped, so the frames that held
    # the decoded audio are gone and a temp file Windows would not delete while mapped can be deleted now.
    error = error.with_traceback(None)
    code = error.code if isinstance(error, EngineError) else "internal"
    log("info", "transcribe failed", step=state.step, error_code=code, duration_ms=_ms_since(started))
    retry_removals()
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
    detector: SpeechDetector | None,
    diarizer: DiarizationProvider | None,
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
            usage = [StepUsage(step="decode", duration_ms=_ms_since(decode_started))]
            emit(PipelineEvent("decode", "finished", audio_seconds=audio.duration_seconds))
            name = path.name if "/" not in path.name and "\\" not in path.name else None
            run = _Run(speech, options, deadline, state, emit, audio, _language(options), diarizer)
            try:
                if options.channels == "split" and audio.samples.shape[1] == 2 and detector is not None:
                    return await run.split(detector, usage, sha, name)
                return await run.mix(usage, sha, name)
            finally:
                run.drop()  # no reference to the map outlives the block, so close() can delete the file
    finally:
        stop_hashing.set()
        hashing.cancel()


def _language(options: TranscribeOptions) -> _Language:
    allowed = None
    if options.allowed_languages is not None:
        allowed = frozenset(code for item in options.allowed_languages if (code := normalize_language(item)))
    forced = normalize_language(options.language) if options.language else None
    if forced is None and allowed is not None and len(allowed) == 1:
        forced = next(iter(allowed))  # one allowed language is a forced one (#15)
    if forced is not None:
        return _Language(allowed=None, decided=True, value=forced)
    return _Language(allowed=allowed or None)


def _source(audio: DecodedAudio, sha: str, name: str | None, mode: ChannelMode, diarized: bool = False) -> Source:
    return Source(
        kind="video" if audio.has_video else "audio",
        name=name,
        sha256=sha,
        container=audio.container,
        channels=audio.channels,
        channel_mode=mode,
        start_offset_seconds=round(audio.start_offset_seconds, 3),
        diarized=diarized,
    )


class _Gate:
    """When diarization may start (`_Run._mix_diarized`): opened once, to go or to skip, with the reason for a skip."""

    def __init__(self) -> None:
        self.event = asyncio.Event()
        self.go = False
        self.reason: DiarizationSkipped | None = None

    def decide(self, *, go: bool, reason: DiarizationSkipped | None = "no_times") -> None:
        self.go = go
        self.reason = None if go else reason
        self.event.set()


class _Run:
    """One run's windows: the decoded audio, the language, the usage totals and progress."""

    def __init__(
        self,
        speech: SpeechProvider,
        options: TranscribeOptions,
        deadline: float | None,
        state: _State,
        emit: Callable[[PipelineEvent], None],
        audio: DecodedAudio,
        language: _Language,
        diarizer: DiarizationProvider | None = None,
    ) -> None:
        self.speech = speech
        self.diarizer = diarizer
        self.upload: MonoWav | None = None
        self.options = options
        self.deadline = deadline
        self.state = state
        self.emit = emit
        self.audio: DecodedAudio | None = audio
        self.samples: np.ndarray | None = audio.samples  # worker threads keep the map alive even if the block is left
        self.duration = audio.duration_seconds
        self.offset = audio.start_offset_seconds
        self.language = language
        self.done = 0
        self.total = 0
        self.timed_checked: set[int] = set()  # channels whose first answer with text was checked for times

    def drop(self) -> None:
        if self.upload is not None:
            self.upload.close()
        self.upload = None
        self.samples = None
        self.audio = None

    def _progress(self, kind: EventKind) -> None:
        self.emit(PipelineEvent("transcribe", kind, self.done, self.total, self.duration))

    def _times(self, part: Transcript, channel: int) -> None:
        """`require_times`: the channel's first answer with text must have times."""
        if not self.options.require_times or channel in self.timed_checked or not _has_text(part):
            return
        self.timed_checked.add(channel)
        if part.timing == "none":
            raise TimesUnavailable(self.state.totals.usage())

    async def _send(self, window: Window, channel: int | None, prompt: str | None) -> Transcript:
        """Encode and send one window; its usage is added to the totals, also when it fails."""
        if self.deadline is not None and time.monotonic() >= self.deadline:
            raise EngineError("limit_exceeded", self.state.totals.usage())
        assert self.samples is not None
        upload = await asyncio.to_thread(_encode, self.samples, window, channel, self.options.audio_format)
        totals = self.state.totals
        part: Transcript | None = None
        failure: EngineError | None = None
        token = totals.fly(upload.duration_seconds)
        try:
            part, usage = await self.speech.transcribe(
                upload, language=self.language.request(), prompt=prompt, deadline=self.deadline
            )
            totals.in_flight.pop(token, None)
        except EngineError as err:
            totals.in_flight.pop(token, None)
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
                del failure  # its traceback holds this frame
        totals.add(usage)
        return part

    # ---- mix ----

    async def mix(self, usage: list[StepUsage], sha: str, name: str | None) -> TranscribeResult:
        audio = self.audio
        assert audio is not None
        self.state.step = "transcribe"
        self.state.totals.started = time.monotonic()
        windows = await asyncio.to_thread(plan_mix_windows, audio, max_bytes=self.speech.capabilities.max_upload_bytes)
        frames = audio.samples.shape[0]
        del audio
        self.total = len(windows)
        diarizer = self.diarizer
        skipped: DiarizationSkipped | None = None
        if diarizer is not None:
            caps = diarizer.capabilities
            if (caps.max_upload_bytes is not None and wav_size(frames) > caps.max_upload_bytes) or (
                caps.max_audio_seconds is not None and self.duration > caps.max_audio_seconds
            ):
                skipped, diarizer = "too_long", None  # transcribed as without a diarizer, one speaker
        self._progress("started")
        segments: list[Segment] = []
        if diarizer is None:
            await self._mix_windows(windows, segments, None)
            output = None
        else:
            output, skipped = await self._mix_diarized(diarizer, windows, segments)
        turns: list[Segment] | None = None
        speakers = [_MIX_SPEAKER]
        diarized = False
        if output is not None:
            turns, found, diarized = build_speaker_turns(segments, self._spans(output))
            if diarized:
                speakers = found
            else:
                skipped = "no_speakers" if any(seg.text.strip() for seg in segments) else None
        if not diarized:
            turns = build_turns(segments, speaker=_MIX_SPEAKER.id)
        assert turns is not None and self.audio is not None
        transcript = Transcript(
            text=" ".join(turn.text for turn in turns),
            language=self.language.value,
            duration_seconds=round(self.offset + self.duration, 3),
            timing=timing_level(turns),
            segments=turns,
            speakers=speakers,
            source=_source(self.audio, sha, name, "mix", diarized),
        )
        usage.append(self.state.totals.usage())
        if self.diarizer is not None and self.diarizer.usage().attempts:
            usage.append(self.diarizer.usage())
        self._progress("finished")
        return TranscribeResult(transcript=transcript, usage=usage, diarization_skipped=skipped)

    def _spans(self, output: DiarizationOutput) -> list[SpeakerSpan]:
        """The diarizer's segments on the file's timeline: it heard the decoded track from 0, so the start offset is
        added; an end past the audio is cut to it, and a segment starting at or after its end is dropped."""
        return [
            SpeakerSpan(
                round(seg.start + self.offset, 3), round(min(seg.end, self.duration) + self.offset, 3), seg.speaker
            )
            for seg in output.segments
            if seg.start < self.duration
        ]

    async def _mix_windows(self, windows: Sequence[Window], segments: list[Segment], gate: "_Gate | None") -> None:
        """The windows in order, each with only the caller's prompt. With a `gate`, the first window with text that
        passed the language and times checks opens it (diarization starts); one without times closes it."""
        for window in windows:
            detecting = not self.language.decided
            part = await self._send(window, None, self.options.prompt)
            if detecting and _has_text(part):
                self.language.decide(part, self.state.totals)
            self._times(part, 0)
            if gate is not None and not gate.event.is_set() and _has_text(part):
                gate.decide(go=part.timing != "none")
            offset = window.start / SAMPLE_RATE + self.offset
            segments.extend(_shifted(part.segments, offset, (window.stop - window.start) / SAMPLE_RATE))
            self.done += 1
            self._progress("progress")
        if gate is not None and not gate.event.is_set():
            gate.decide(go=False, reason=None)  # no window had text: nothing to diarize

    async def _mix_diarized(
        self, diarizer: DiarizationProvider, windows: Sequence[Window], segments: list[Segment]
    ) -> tuple[DiarizationOutput | None, DiarizationSkipped | None]:
        """Windows and diarization together (spec #14: a diarize failure fails the run).

        A request that sends no audio checks the diarizer's key first. The whole mixed track is uploaded once, after
        the first window with text passed its checks (`_Gate`), so an early speech failure, a file without text and
        a provider without times send nothing to the diarizer. The windows go on meanwhile. A failure on either side
        cancels the other; when both failed, the windows' error is raised. Once only diarization is left, the step is
        `diarize`, so a deadline then reports its usage.
        """
        failure: EngineError | None = None
        try:
            await diarizer.check(deadline=self.deadline)
        except EngineError as err:
            failure = err
        if failure is not None:
            self.state.step = "diarize"
            try:
                raise failure
            finally:
                del failure
        assert self.samples is not None
        self.upload = MonoWav(self.samples)
        gate = _Gate()

        async def run_windows() -> None:
            await self._mix_windows(windows, segments, gate)
            if gate.go:
                self.state.step = "diarize"  # only diarization is left: a deadline now reports its usage

        async def run_diarize() -> DiarizationOutput | None:
            await gate.event.wait()
            if not gate.go:
                return None
            upload = self.upload
            assert upload is not None
            self.emit(PipelineEvent("diarize", "started", audio_seconds=self.duration))
            output, _ = await diarizer.diarize(upload, deadline=self.deadline)
            self.emit(PipelineEvent("diarize", "finished", audio_seconds=self.duration))
            return output

        diarizing = asyncio.ensure_future(run_diarize())
        transcribing = asyncio.ensure_future(run_windows())
        tasks = [transcribing, diarizing]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            if self.upload is not None:
                self.upload.close()
        failed: BaseException | None = None
        if not transcribing.cancelled() and transcribing.exception() is not None:
            failed = transcribing.exception()
            self.state.step = "transcribe"
        elif not diarizing.cancelled() and diarizing.exception() is not None:
            failed = diarizing.exception()
            self.state.step = "diarize"
            if isinstance(failed, EngineError):
                failed.usage = diarizer.usage()
            else:
                failed = EngineError("internal", diarizer.usage())  # a bug of ours; its text is not shown
        if failed is not None:
            del tasks, transcribing, diarizing
            try:
                raise failed
            finally:
                del failed
        output = diarizing.result()
        del tasks, transcribing, diarizing
        return output, gate.reason

    # ---- split ----

    async def split(
        self, detector: SpeechDetector, usage: list[StepUsage], sha: str, name: str | None
    ) -> TranscribeResult:
        speakers = _speakers(self.options)
        self.state.step = "vad"
        vad_started = time.monotonic()
        self.emit(PipelineEvent("vad", "started", audio_seconds=self.duration))
        longest = min(MAX_SPEECH_SECONDS, max_window_seconds(self.speech.capabilities.max_upload_bytes))
        if longest < MIN_SPLIT_SECONDS:
            raise EngineError("audio_too_long")  # as for mix: an upload limit under two seconds of audio
        windows: list[list[Window]] = []
        for channel in (0, 1):  # one channel at a time: Silero holds a float copy of the channel
            assert self.samples is not None
            stop = threading.Event()
            try:
                ranges = await asyncio.to_thread(_detect, detector, self.samples, channel, longest, stop)
            except BaseException:
                stop.set()  # a timeout or a cancel: the detector thread gives up at its next step
                raise
            windows.append([Window(start, stop) for start, stop in ranges])
        usage.append(StepUsage(step="vad", duration_ms=_ms_since(vad_started)))
        self.emit(PipelineEvent("vad", "finished", audio_seconds=self.duration))

        self.state.step = "transcribe"
        self.state.totals.started = time.monotonic()
        self.total = sum(len(w) for w in windows)
        self._progress("started")
        answers: dict[tuple[int, int], Transcript] = {}
        if self.total:
            await self._probe(windows, answers)
        parts: list[ChannelPart] = []
        limit = asyncio.Semaphore(self.options.concurrency)
        tasks = [
            asyncio.ensure_future(self._channel(channel, windows[channel], answers, parts, speakers[channel].id, limit))
            for channel in (0, 1)
        ]
        failed: BaseException | None = None
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        for task in tasks:
            if not task.cancelled() and task.exception() is not None:
                failed = task.exception()
                break
        del tasks
        if failed is not None:
            if isinstance(failed, (EngineError, TimesUnavailable)):
                failed.usage = self.state.totals.usage()  # the other channel's cancelled request included
            try:
                raise failed
            finally:
                del failed

        provider_segments = [seg for part in parts for seg in part.segments]
        kept, dropped = filter_hallucinations(provider_segments)
        keep = {id(seg) for seg in kept}
        parts = [
            ChannelPart(p.speaker, p.channel, p.window, p.start, [s for s in p.segments if id(s) in keep])
            for p in parts
        ]
        turns = build_channel_turns(parts)
        assert self.audio is not None
        transcript = Transcript(
            text=" ".join(turn.text for turn in turns),
            language=self.language.value,
            duration_seconds=round(self.offset + self.duration, 3),
            timing=timing_level(turns),
            segments=turns,
            speakers=speakers,
            source=_source(self.audio, sha, name, "split"),
        )
        usage.append(self.state.totals.usage())
        self._progress("finished")
        return TranscribeResult(transcript=transcript, usage=usage, dropped_segments=dropped)

    async def _probe(self, windows: list[list[Window]], answers: dict[tuple[int, int], Transcript]) -> None:
        """Language for `split`: the first windows of the call, longest first, until one has real text."""
        if self.language.decided:
            return
        first = sorted(
            ((w.start, channel, index) for channel in (0, 1) for index, w in enumerate(windows[channel])),
        )[:PROBE_WINDOWS]
        length = {(c, i): windows[c][i].stop - windows[c][i].start for _, c, i in first}
        start = (self.options.prompt or "").strip()[-CHAIN_CHARS:] or None  # what each chain starts from
        for _, channel, index in sorted(first, key=lambda item: -length[(item[1], item[2])]):
            window = windows[channel][index]
            part = await self._send(window, channel, start)
            answers[(channel, index)] = part
            if _has_real_text(part, (window.stop - window.start) / SAMPLE_RATE):
                self.language.decide(part, self.state.totals)  # language before times, as in the channel phase
                self._times(part, channel)
                return
            self._times(part, channel)

    async def _channel(
        self,
        channel: int,
        windows: list[Window],
        answers: dict[tuple[int, int], Transcript],
        parts: list[ChannelPart],
        speaker: str,
        limit: asyncio.Semaphore,
    ) -> None:
        chain = (self.options.prompt or "").strip()
        for index, window in enumerate(windows):
            part = answers.pop((channel, index), None)
            if part is None:
                detecting = not self.language.decided
                async with limit:
                    part = await self._send(window, channel, chain[-CHAIN_CHARS:] or None)
                if detecting and _has_real_text(part, (window.stop - window.start) / SAMPLE_RATE):
                    self.language.decide(part, self.state.totals)
                self._times(part, channel)
            text = part.text.strip()
            if text:
                chain = f"{chain} {text}".strip()[-CHAIN_CHARS:]
            start = window.start / SAMPLE_RATE + self.offset
            sent = (window.stop - window.start) / SAMPLE_RATE
            parts.append(
                ChannelPart(speaker, channel, index, round(start, 3), _shifted(part.segments, start, sent, speaker))
            )
            self.done += 1
            self._progress("progress")
