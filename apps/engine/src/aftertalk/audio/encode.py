"""Decode any audio or video file and encode it the way speech-to-text services want it.

The output is mono, 16 kHz, 16-bit: what Whisper-family models use internally, and small enough to upload.
"""

import contextlib
import os
import tempfile
import time
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


# Inputs that make FFmpeg open other files or network streams: playlists, concat lists, raw network protocols.
_BLOCKED_DEMUXERS = frozenset({"hls", "applehttp", "concat", "ffconcat", "sdp", "rtp", "rtsp", "image2", "tee", "data"})
_GAP_SECONDS = 0.1  # a hole in the timestamps longer than this is filled with silence
_START_SECONDS = 0.02  # audio that starts later than this is shifted: output time 0 is media time 0
_SWEEP_AFTER_SECONDS = 3600


def _audio_dir() -> Path:
    """A private directory for temp files, so a crash leaves them in one place that is swept later."""
    directory = Path(tempfile.gettempdir()) / "aftertalk-audio"
    directory.mkdir(mode=0o700, exist_ok=True)
    if directory.stat().st_uid != os.getuid():
        raise OSError("temp directory belongs to another user")
    directory.chmod(0o700)
    cutoff = time.time() - _SWEEP_AFTER_SECONDS
    for old in directory.glob("aftertalk-*"):
        with contextlib.suppress(OSError):
            if old.is_file() and old.stat().st_mtime < cutoff:
                old.unlink()
    return directory


def _convert(source: Path, target: Path, fmt: AudioFormat, max_bytes: int | None) -> float:
    """Decode `source`, write `target`; returns the duration in seconds."""
    codec, _, _ = _FORMATS[fmt]
    written = 0  # output samples so far
    size = 0

    with av.open(str(source), options={"protocol_whitelist": "file"}) as inp:
        names = set(inp.format.name.split(","))
        if names & _BLOCKED_DEMUXERS or any("pipe" in name for name in names):
            raise ValueError("input type not allowed")
        if not inp.streams.audio:
            raise ValueError("no audio stream")
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
                remaining = round(seconds * SAMPLE_RATE)
                while remaining > 0:
                    chunk = min(remaining, SAMPLE_RATE)
                    blank = av.AudioFrame.from_ndarray(
                        np.zeros((1, chunk), dtype=np.int16), format="s16", layout="mono"
                    )
                    blank.sample_rate = SAMPLE_RATE
                    put(blank)
                    remaining -= chunk

            for frame in inp.decode(inp.streams.audio[0]):
                if frame.pts is not None and frame.time_base is not None:
                    at = float(frame.pts * frame.time_base)
                    gap = at - written / SAMPLE_RATE
                    if gap > (_START_SECONDS if written == 0 else _GAP_SECONDS):
                        silence(gap)
                for resampled in resampler.resample(frame):
                    put(resampled)
            for resampled in resampler.resample(None):
                put(resampled)
            put(None)
    if written == 0:
        raise ValueError("no audio samples")
    return written / SAMPLE_RATE


def encode_for_speech(path: Path, *, fmt: AudioFormat, max_bytes: int | None = None) -> EncodedAudio:
    """Mono 16 kHz FLAC or WAV in a temp file. Raises `audio_unreadable` for anything PyAV cannot decode.

    Playlists, concat lists and network inputs are refused. Conversion stops with `audio_too_long` once the output
    is larger than `max_bytes`. The temp file is removed if anything, an interrupt included, ends the conversion.
    """
    _, filename, content_type = _FORMATS[fmt]
    code: ErrorCode | None = None
    target: Path | None = None
    duration = 0.0
    try:
        handle, name = tempfile.mkstemp(suffix=f".{fmt}", prefix="aftertalk-", dir=_audio_dir())
        os.close(handle)
        target = Path(name)
        duration = _convert(path, target, fmt, max_bytes)
    except _TooLarge:
        code = "audio_too_long"
    except Exception:  # av raises FFmpegError, ValueError, OSError and more; none of them is worth showing
        code = "audio_unreadable"
    except BaseException:
        if target is not None:
            target.unlink(missing_ok=True)
        raise
    if code is not None:
        if target is not None:
            target.unlink(missing_ok=True)
        raise EngineError(code)  # outside the except block: nothing is chained to it
    assert target is not None
    return EncodedAudio(
        filename=filename,
        content_type=content_type,
        duration_seconds=duration,
        size_bytes=target.stat().st_size,
        path=target,
        owns_file=True,
    )
