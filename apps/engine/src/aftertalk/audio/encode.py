"""Decode any audio or video file and encode it the way speech-to-text services want it.

The output is mono, 16 kHz, 16-bit: what Whisper-family models use internally, and small enough to upload.
"""

import contextlib
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from types import TracebackType
from typing import Literal

import av

from aftertalk.models.errors import EngineError

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


def _convert(source: Path, target: Path, fmt: AudioFormat) -> float:
    """Decode `source`, write `target`; returns the duration in seconds."""
    codec, _, _ = _FORMATS[fmt]
    samples = 0
    with av.open(str(source)) as inp:
        if not inp.streams.audio:
            raise ValueError("no audio stream")
        resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
        with av.open(str(target), "w", format=fmt) as out:
            stream = out.add_stream(codec, rate=SAMPLE_RATE, layout="mono")
            for frame in inp.decode(inp.streams.audio[0]):
                for resampled in resampler.resample(frame):
                    samples += resampled.samples
                    for packet in stream.encode(resampled):
                        out.mux(packet)
            for resampled in resampler.resample(None):
                samples += resampled.samples
                for packet in stream.encode(resampled):
                    out.mux(packet)
            for packet in stream.encode(None):
                out.mux(packet)
    if samples == 0:
        raise ValueError("no audio samples")
    return samples / SAMPLE_RATE


def encode_for_speech(path: Path, *, fmt: AudioFormat) -> EncodedAudio:
    """Mono 16 kHz FLAC or WAV in a temp file. Raises `audio_unreadable` for anything PyAV cannot decode."""
    _, filename, content_type = _FORMATS[fmt]
    handle, name = tempfile.mkstemp(suffix=f".{fmt}", prefix="aftertalk-")
    os.close(handle)
    target = Path(name)
    duration = 0.0
    failed = False
    try:
        duration = _convert(path, target, fmt)
    except Exception:  # av raises FFmpegError, ValueError, OSError and more; none of them is worth showing
        failed = True
    if failed:
        target.unlink(missing_ok=True)
        raise EngineError("audio_unreadable")  # outside the except block: nothing is chained to it
    return EncodedAudio(
        filename=filename,
        content_type=content_type,
        duration_seconds=duration,
        size_bytes=target.stat().st_size,
        path=target,
        owns_file=True,
    )
