"""Decode any audio or video file and encode it the way speech-to-text services want it.

The output is mono, 16 kHz, 16-bit: what Whisper-family models use internally, and small enough to upload.
"""

import asyncio
import contextlib
import os
import stat
import tempfile
import threading
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from types import TracebackType
from typing import Literal

import av
import numpy as np

from aftertalk.models.errors import EngineError, ErrorCode

AudioFormat = Literal["flac", "wav"]

SAMPLE_RATE = 16000
_FORMATS: dict[str, tuple[str, str, str]] = {
    # format: (codec, filename, content type)
    "flac": ("flac", "audio.flac", "audio/flac"),
    "wav": ("pcm_s16le", "audio.wav", "audio/wav"),
}


@dataclass
class EncodedAudio:
    """Audio ready to upload: bytes in memory (`data`) or in a file (`path`). Use as a context manager to clean up."""

    filename: str
    content_type: str
    duration_seconds: float
    size_bytes: int
    path: Path | None = None
    data: bytes | None = None
    owns_file: bool = False  # the file at `path` is a temp file this object deletes on close

    def read(self) -> bytes:
        if self.data is not None:
            return self.data
        assert self.path is not None, "EncodedAudio needs data or a path"
        return self.path.read_bytes()

    def close(self) -> None:
        if self.owns_file and self.path is not None:
            with contextlib.suppress(OSError):
                self.path.unlink()

    def __enter__(self) -> "EncodedAudio":
        return self

    def __exit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, tb: TracebackType | None
    ) -> None:
        self.close()


class _TooLarge(Exception):
    pass


class _Cancelled(Exception):
    """The caller stopped waiting; raised between frames so the decoder does not run on."""


# Inputs that make FFmpeg open other files or network streams: playlists, concat lists, raw network protocols.
_BLOCKED_DEMUXERS = frozenset({"hls", "applehttp", "concat", "ffconcat", "sdp", "rtp", "rtsp", "image2", "tee", "data"})
_GAP_SECONDS = 0.1  # a hole in the timestamps longer than this is filled with silence
_START_SECONDS = 0.02  # audio that starts later than this is shifted: output time 0 is media time 0
# Silence padding (hours of padding would be billed as audio):
_MAX_START_SECONDS = 30  # a stream that starts later than this is measured from its first frame, not media time 0
_MAX_PAD_SECONDS = 1800  # more inserted silence than this in one file is refused
_PAD_ALLOWANCE_SECONDS = 30  # inserted silence may exceed the decoded audio by at most this much
_TS_DISCONT = 0x200  # FFmpeg's AVFMT_TS_DISCONT: the container's clock is arbitrary (MPEG-TS, MPEG-PS)
_SWEEP_AFTER_SECONDS = 3600


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


def _audio_dir() -> Path:
    """A private per-user directory for temp files, so a crash leaves them in one place that is swept later.

    POSIX: `aftertalk-audio-<uid>`, mode 0700. Windows (no `os.getuid`): `aftertalk-audio`, as its temp directory
    is already per user. If the name is taken by another user or is not a real directory, a fresh private directory
    with a random name is used instead; it is not swept, but every file in it is deleted on close.
    """
    uid = os.getuid() if hasattr(os, "getuid") else None
    name = "aftertalk-audio" if uid is None else f"aftertalk-audio-{uid}"
    directory = Path(tempfile.gettempdir()) / name
    if not _private_dir(directory, uid):
        return Path(tempfile.mkdtemp(prefix="aftertalk-audio-"))
    cutoff = time.time() - _SWEEP_AFTER_SECONDS
    for old in directory.glob("aftertalk-*"):
        with contextlib.suppress(OSError):
            if old.is_file() and old.stat().st_mtime < cutoff:
                old.unlink()
    return directory


def _convert(
    source: Path, target: Path, fmt: AudioFormat, max_bytes: int | None, cancelled: threading.Event | None = None
) -> float:
    """Decode `source`, write `target`; returns the duration in seconds.

    Holes in the timestamps are filled with silence, measured from `origin`: media time 0, or the first frame's time
    when the container's clock is arbitrary or the first frame is later than `_MAX_START_SECONDS` (or negative).
    Padding over `_MAX_PAD_SECONDS`, or more than `_PAD_ALLOWANCE_SECONDS` beyond the decoded audio, is refused.
    """
    codec, _, _ = _FORMATS[fmt]
    written = 0  # output samples so far
    padded = 0  # of which inserted silence
    size = 0

    with av.open(str(source), options={"protocol_whitelist": "file"}) as inp:
        names = set(inp.format.name.split(","))
        if names & _BLOCKED_DEMUXERS or any("pipe" in name for name in names):
            raise ValueError("input type not allowed")
        if not inp.streams.audio:
            raise ValueError("no audio stream")
        arbitrary_clock = bool(inp.format.flags & _TS_DISCONT)
        resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
        with av.open(str(target), "w", format=fmt) as out:
            stream = out.add_stream(codec, rate=SAMPLE_RATE, layout="mono")

            def put(frame: av.AudioFrame | None) -> None:
                nonlocal written, size
                if frame is not None:
                    frame.pts = written
                    frame.time_base = Fraction(1, SAMPLE_RATE)
                    written += frame.samples
                for packet in stream.encode(frame):
                    size += packet.size
                    out.mux(packet)
                if max_bytes is not None and size > max_bytes:
                    raise _TooLarge

            def silence(seconds: float) -> None:
                nonlocal padded
                remaining = round(seconds * SAMPLE_RATE)
                if (padded + remaining) / SAMPLE_RATE > _MAX_PAD_SECONDS:
                    raise ValueError("too much silence to insert")
                while remaining > 0:
                    chunk = min(remaining, SAMPLE_RATE)
                    blank = av.AudioFrame.from_ndarray(
                        np.zeros((1, chunk), dtype=np.int16), format="s16", layout="mono"
                    )
                    blank.sample_rate = SAMPLE_RATE
                    put(blank)
                    padded += chunk
                    remaining -= chunk

            origin: float | None = None
            for frame in inp.decode(inp.streams.audio[0]):
                if cancelled is not None and cancelled.is_set():
                    raise _Cancelled
                if frame.pts is not None and frame.time_base is not None:
                    at = float(frame.pts * frame.time_base)
                    if origin is None:
                        late = arbitrary_clock or at > _MAX_START_SECONDS or at < 0
                        origin = at if late else 0.0
                    gap = (at - origin) - written / SAMPLE_RATE
                    if gap > (_START_SECONDS if written == 0 else _GAP_SECONDS):
                        silence(gap)
                for resampled in resampler.resample(frame):
                    put(resampled)
            for resampled in resampler.resample(None):
                put(resampled)
            put(None)
    if written == 0:
        raise ValueError("no audio samples")
    if padded / SAMPLE_RATE > _PAD_ALLOWANCE_SECONDS + (written - padded) / SAMPLE_RATE:
        raise ValueError("more inserted silence than audio")
    return written / SAMPLE_RATE


def encode_for_speech(
    path: Path, *, fmt: AudioFormat, max_bytes: int | None = None, cancelled: threading.Event | None = None
) -> EncodedAudio:
    """Mono 16 kHz FLAC or WAV in a temp file. Raises `audio_unreadable` for anything PyAV cannot decode.

    Playlists, concat lists and network inputs are refused. Conversion stops with `audio_too_long` once the output
    is larger than `max_bytes`. The temp file is removed if anything, an interrupt included, ends the conversion.
    Setting `cancelled` stops the decoder at the next frame. A temp directory that cannot be used is `internal`.
    From async code use `open_encoded`.
    """
    _, filename, content_type = _FORMATS[fmt]
    target: Path | None = None
    try:
        handle, name = tempfile.mkstemp(suffix=f".{fmt}", prefix="aftertalk-", dir=_audio_dir())
        os.close(handle)
        target = Path(name)
    except OSError:
        pass
    if target is None:
        raise EngineError("internal")  # not the file's fault; outside the except block, so nothing is chained
    code: ErrorCode | None = None
    duration = 0.0
    try:
        duration = _convert(path, target, fmt, max_bytes, cancelled)
    except _TooLarge:
        code = "audio_too_long"
    except _Cancelled:
        target.unlink(missing_ok=True)
        raise
    except Exception:  # av raises FFmpegError, ValueError, OSError and more; none of them is worth showing
        code = "audio_unreadable"
    except BaseException:
        target.unlink(missing_ok=True)
        raise
    if code is not None:
        target.unlink(missing_ok=True)
        raise EngineError(code)  # outside the except block: nothing is chained to it
    return EncodedAudio(
        filename=filename,
        content_type=content_type,
        duration_seconds=duration,
        size_bytes=target.stat().st_size,
        path=target,
        owns_file=True,
    )


@asynccontextmanager
async def open_encoded(path: Path, *, fmt: AudioFormat, max_bytes: int | None = None) -> AsyncIterator[EncodedAudio]:
    """Encode in a worker thread; the temp file is gone after the block, also when the await is cancelled.

    Use this, not `to_thread(encode_for_speech)`: a cancelled await would leave the file. The thread and the
    awaiting task decide under one lock who closes the file, so it does not depend on the event loop still running,
    and a cancelled encoder stops at the next frame.
    """
    cancelled = threading.Event()
    lock = threading.Lock()
    holder: list[EncodedAudio] = []

    def work() -> EncodedAudio:
        audio = encode_for_speech(path, fmt=fmt, max_bytes=max_bytes, cancelled=cancelled)
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
