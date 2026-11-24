"""Decode any audio or video file once, to 16 kHz 16-bit PCM in a private temp file read back as a memory map.

Rules:
- Only the first audio stream is read. Mono stays one channel, stereo stays two (a call may need them apart), more
  channels are mixed down to mono by the resampler.
- Output sample 0 is the first decoded frame: the lead-in is never padded. Where that frame sits in the file is
  `start_offset_seconds`: the audio stream's first timestamp minus the container's start time, so an mp4 whose
  audio starts 45 s after its video gives 45, and an MPEG-TS whose clock starts at one hour gives 0.
- Holes inside the stream (recorders that write no packets during a hold) are filled with silence, measured from
  the first frame; more than `_MAX_PAD_SECONDS` of it in one file is refused. There is no rule against more silence
  than audio.
- Playlists, concat lists and network inputs are refused; only plain files are opened.
- Errors are fixed codes raised outside `except` blocks, so no FFmpeg text is chained to them. A source that cannot
  be read or decoded is `audio_unreadable`; a temp file that cannot be written (disk full) is `internal`, as it is
  not the file's fault. The temp file is removed on every failure, an interrupt included, and by `close()`.
"""

import asyncio
import contextlib
import math
import os
import shutil
import stat
import tempfile
import threading
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from types import TracebackType
from typing import BinaryIO, NamedTuple

import av
import numpy as np

from aftertalk.models.errors import EngineError, ErrorCode

SAMPLE_RATE = 16000

# Inputs that make FFmpeg open other files or network streams: playlists, concat lists, raw network protocols.
_BLOCKED_DEMUXERS = frozenset({"hls", "applehttp", "concat", "ffconcat", "sdp", "rtp", "rtsp", "image2", "tee", "data"})
_GAP_SECONDS = 0.1  # a hole in the timestamps longer than this is filled with silence
_MAX_PAD_SECONDS = 1800  # more inserted silence than this in one file is refused (it would be billed as audio)
_SWEEP_AFTER_SECONDS = 3600  # leftovers of a crash older than this are deleted from the shared temp directory
_SHORT_NAMES = {"mov,mp4,m4a,3gp,3g2,mj2": "mp4", "matroska,webm": "matroska"}


class _Cancelled(Exception):
    """The caller stopped waiting; raised between frames so the decoder does not run on."""


class _TooLong(Exception):
    pass


class _WriteFailed(Exception):
    """Writing the temp PCM file failed (disk full): ours, not the source's."""


class _Decoded(NamedTuple):
    frames: int
    stored_channels: int
    channels: int
    container: str
    has_video: bool
    start_offset_seconds: float


def to_mono(samples: np.ndarray, start: int = 0, stop: int | None = None) -> np.ndarray:
    """int16 1-D mix of `samples[start:stop]`; only that slice is read, so a long memory map is never loaded whole."""
    part = samples[start:stop]
    if part.shape[1] == 1:
        return part[:, 0]
    return (part.astype(np.int32).sum(axis=1) // part.shape[1]).astype(np.int16)


@dataclass
class DecodedAudio:
    """16 kHz int16 PCM of a file's first audio stream. Close it (or use it as a context manager) to delete it."""

    samples: np.ndarray  # memory map, shape (frames, stored_channels); stored_channels is 1 or 2
    channels: int  # channel count of the original audio stream
    container: str  # short container name: "mp4", "matroska", "mpegts", "wav", "mp3", "ogg"...
    has_video: bool  # a real video stream exists; cover art does not count
    duration_seconds: float  # frames / SAMPLE_RATE, inserted gap silence included
    start_offset_seconds: float  # where sample 0 sits in the file, in seconds from the file's start; >= 0
    path: Path | None = None  # the temp PCM file; None once closed
    _own_dir: Path | None = field(default=None, repr=False)  # a fallback temp directory that close() removes

    def mono(self, start: int = 0, stop: int | None = None) -> np.ndarray:
        return to_mono(self.samples, start, stop)

    def close(self) -> None:
        self.samples = np.zeros((0, self.samples.shape[1]), dtype=np.int16)  # drop our reference to the map
        _remove(self.path, self._own_dir)
        self.path = None
        self._own_dir = None

    def __enter__(self) -> "DecodedAudio":
        return self

    def __exit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None
    ) -> None:
        self.close()


def _remove(path: Path | None, own_dir: Path | None) -> None:
    """Delete the temp file; on POSIX a live memory map keeps working until it is dropped."""
    if path is not None:
        with contextlib.suppress(OSError):
            path.unlink(missing_ok=True)
    if own_dir is not None:
        shutil.rmtree(own_dir, ignore_errors=True)


def _discard(handle: int, path: Path | None, own_dir: Path | None) -> None:
    """Close the descriptor from `mkstemp` that no file object took over, then delete the temp file."""
    if handle >= 0:
        with contextlib.suppress(OSError):
            os.close(handle)
    _remove(path, own_dir)


def _private_dir(directory: Path, uid: int | None) -> bool:
    """Create `directory` (or accept it) when it is a real directory we own; False when it cannot be trusted."""
    try:
        directory.mkdir(mode=0o700, exist_ok=True)
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode):
            return False  # a symlink or a file: someone else may control where it points
        if uid is not None:
            if info.st_uid != uid:
                return False
            directory.chmod(0o700)
    except OSError:
        return False
    return True


def _audio_dir() -> tuple[Path, bool]:
    """A private per-user directory for temp files, so a crash leaves them in one place that is swept later.

    POSIX: `aftertalk-audio-<uid>`, mode 0700. Windows (no `os.getuid`): `aftertalk-audio`, as its temp directory
    is already per user. If the name is taken by another user or is not a real directory, a fresh private directory
    with a random name is used instead; it is not swept, and the second value (True) says the caller removes it.
    """
    uid = os.getuid() if hasattr(os, "getuid") else None
    name = "aftertalk-audio" if uid is None else f"aftertalk-audio-{uid}"
    directory = Path(tempfile.gettempdir()) / name
    if not _private_dir(directory, uid):
        return Path(tempfile.mkdtemp(prefix="aftertalk-audio-")), True
    cutoff = time.time() - _SWEEP_AFTER_SECONDS
    for old in directory.glob("aftertalk-*"):
        with contextlib.suppress(OSError):
            if old.is_file() and old.stat().st_mtime < cutoff:
                old.unlink()
    return directory, False


def _container_name(inp: av.container.InputContainer) -> str:
    name = _SHORT_NAMES.get(inp.format.name, inp.format.name.split(",")[0])
    if name == "mp4" and inp.metadata.get("major_brand", "").strip() == "qt":
        return "mov"
    return name


def _convert(source: Path, out: BinaryIO, max_seconds: float | None, cancelled: threading.Event | None) -> _Decoded:
    """Decode `source`'s first audio stream into `out` as interleaved s16 PCM at 16 kHz."""
    written = 0  # output frames so far
    padded = 0  # of which inserted silence
    limit = None if max_seconds is None else max_seconds * SAMPLE_RATE

    with av.open(str(source), options={"protocol_whitelist": "file"}) as inp:
        if _blocked(inp):
            raise ValueError("input type not allowed")
        if not inp.streams.audio:
            raise ValueError("no audio stream")
        stream = inp.streams.audio[0]
        channels = stream.codec_context.channels or len(stream.layout.channels)
        stored = 2 if channels == 2 else 1
        resampler = av.AudioResampler(format="s16", layout="stereo" if stored == 2 else "mono", rate=SAMPLE_RATE)
        has_video = any(not (video.disposition & av.stream.Disposition.attached_pic) for video in inp.streams.video)
        container_start = (inp.start_time or 0) / av.time_base

        def put(data: np.ndarray, frames: int) -> None:
            nonlocal written
            try:
                out.write(data.tobytes())
            except OSError:
                raise _WriteFailed from None
            written += frames
            if limit is not None and written > limit:
                raise _TooLong

        def silence(seconds: float) -> None:
            nonlocal padded
            remaining = round(seconds * SAMPLE_RATE)
            if (padded + remaining) / SAMPLE_RATE > _MAX_PAD_SECONDS:
                raise ValueError("too much silence to insert")
            while remaining > 0:
                chunk = min(remaining, SAMPLE_RATE)
                put(np.zeros(chunk * stored, dtype=np.int16), chunk)
                padded += chunk
                remaining -= chunk

        origin: float | None = None  # media time of output sample 0
        offset: float | None = None
        for frame in inp.decode(stream):
            if cancelled is not None and cancelled.is_set():
                raise _Cancelled
            at = float(frame.pts * frame.time_base) if frame.pts is not None and frame.time_base is not None else None
            if offset is None:
                offset = 0.0 if at is None else max(0.0, at - container_start)
            if at is not None:
                if origin is None:
                    origin = at - written / SAMPLE_RATE
                gap = (at - origin) - written / SAMPLE_RATE
                if gap > _GAP_SECONDS:
                    silence(gap)
            for resampled in resampler.resample(frame):
                put(resampled.to_ndarray(), resampled.samples)
        for resampled in resampler.resample(None):
            put(resampled.to_ndarray(), resampled.samples)
        container = _container_name(inp)
    if written == 0:
        raise ValueError("no audio samples")
    return _Decoded(written, stored, channels, container, has_video, offset or 0.0)


def _close(out: BinaryIO) -> bool:
    """Flush and close the temp file; False when the flush fails (disk full). The descriptor is closed either way."""
    try:
        out.close()
    except OSError:
        return False
    return True


def _blocked(inp: av.container.InputContainer) -> bool:
    names = set(inp.format.name.split(","))
    return bool(names & _BLOCKED_DEMUXERS) or any("pipe" in name for name in names)


def probe_duration(path: Path) -> float | None:
    """The file's length in seconds from its container or audio stream metadata, without decoding.

    Opened with the decoder's limits (plain files only, the same demuxers refused). None on any problem, or when the
    file does not say: decoding then reports the real error. For sizing limits only, never for times.
    """
    seconds: float | None = None
    try:
        with av.open(str(path), options={"protocol_whitelist": "file"}) as inp:
            if not _blocked(inp):
                if inp.duration is not None and inp.duration > 0:
                    seconds = inp.duration / av.time_base
                elif inp.streams.audio:
                    stream = inp.streams.audio[0]
                    if stream.duration is not None and stream.time_base is not None and stream.duration > 0:
                        seconds = float(stream.duration * stream.time_base)
    except Exception:  # av raises FFmpegError, ValueError, OSError and more; none of them is worth showing
        seconds = None
    if seconds is None or not math.isfinite(seconds) or seconds <= 0:
        return None
    return seconds


def decode_audio(
    path: Path, *, max_seconds: float | None = None, cancelled: threading.Event | None = None
) -> DecodedAudio:
    """Decode `path` to a temp PCM file. Raises `audio_unreadable` for anything PyAV cannot decode.

    Decoding stops with `limit_exceeded` once the audio is longer than `max_seconds`. Setting `cancelled` stops the
    decoder at the next frame. A temp directory or temp file that cannot be used (disk full) is `internal`. From
    async code use `open_decoded`.
    """
    target: Path | None = None
    own_dir: Path | None = None
    handle = -1
    out: BinaryIO | None = None
    try:
        directory, fallback = _audio_dir()
        own_dir = directory if fallback else None
        handle, name = tempfile.mkstemp(suffix=".pcm", prefix="aftertalk-", dir=directory)
        target = Path(name)
        out = open(handle, "wb")
    except OSError:
        pass
    except BaseException:
        _discard(handle, target, own_dir)
        raise
    if out is None:
        _discard(handle, target, own_dir)
        raise EngineError("internal")  # not the file's fault; outside the except block, so nothing is chained
    code: ErrorCode | None = None
    info: _Decoded | None = None
    closed = True
    try:
        try:
            info = _convert(path, out, max_seconds, cancelled)
        finally:
            closed = _close(out)  # the closing flush can fail too; it never replaces an error from decoding
    except _TooLong:
        code = "limit_exceeded"
    except _WriteFailed:
        code = "internal"
    except _Cancelled:
        _remove(target, own_dir)
        raise
    except Exception:  # av raises FFmpegError, ValueError, OSError and more; none of them is worth showing
        code = "audio_unreadable"
    except BaseException:
        _remove(target, own_dir)
        raise
    if not closed and code is None:
        code = "internal"  # the data did not reach the disk
    samples: np.ndarray | None = None
    if info is not None and code is None:
        try:
            samples = np.memmap(target, dtype=np.int16, mode="r", shape=(info.frames, info.stored_channels))
        except (OSError, ValueError):
            code = "internal"
        except BaseException:
            _remove(target, own_dir)
            raise
    if code is not None or info is None or samples is None:
        _remove(target, own_dir)
        raise EngineError(code or "internal")  # outside the except block: nothing is chained to it
    return DecodedAudio(
        samples=samples,
        channels=info.channels,
        container=info.container,
        has_video=info.has_video,
        duration_seconds=info.frames / SAMPLE_RATE,
        start_offset_seconds=info.start_offset_seconds,
        path=target,
        _own_dir=own_dir,
    )


@asynccontextmanager
async def open_decoded(path: Path, *, max_seconds: float | None = None) -> AsyncIterator[DecodedAudio]:
    """Decode in a worker thread; the temp file is gone after the block, also when the await is cancelled.

    Use this, not `to_thread(decode_audio)`: a cancelled await would leave the file. The thread and the awaiting
    task decide under one lock who closes the result, so it does not depend on the event loop still running, and a
    cancelled decoder stops at the next frame.
    """
    cancelled = threading.Event()
    lock = threading.Lock()
    holder: list[DecodedAudio] = []

    def work() -> DecodedAudio:
        audio = decode_audio(path, max_seconds=max_seconds, cancelled=cancelled)
        with lock:
            if cancelled.is_set():
                audio.close()  # nobody is waiting for it any more
            else:
                holder.append(audio)
        return audio

    try:
        audio = await asyncio.to_thread(work)
    except BaseException:
        with lock:
            cancelled.set()
            for held in holder:
                held.close()
        raise
    try:
        yield audio
    finally:
        audio.close()
