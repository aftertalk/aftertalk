"""Encode decoded audio the way speech-to-text services want it: mono, 16 kHz, 16-bit FLAC or WAV, in memory.

That is what Whisper-family models use internally, and small enough to upload. `encode_pcm` encodes one window of
`decode.DecodedAudio`; `open_encoded` decodes and encodes a whole (short) file for `providers test` and the CLI.
The output has no padding block or encoder tag, so a WAV is exactly 44 header bytes plus two bytes per sample and
FLAC of noise stays within about 0.5% of that (the window planner allows 1%).
"""

import asyncio
import contextlib
import io
import struct
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from types import TracebackType
from typing import Literal

import av
import numpy as np

from aftertalk.audio.decode import SAMPLE_RATE, open_decoded, to_mono
from aftertalk.models.errors import EngineError

__all__ = ["SAMPLE_RATE", "AudioFormat", "EncodedAudio", "MonoWav", "encode_pcm", "open_encoded", "wav_size"]

AudioFormat = Literal["flac", "wav"]

_FORMATS: dict[str, tuple[str, str, str]] = {
    # format: (codec, filename, content type)
    "flac": ("flac", "audio.flac", "audio/flac"),
    "wav": ("pcm_s16le", "audio.wav", "audio/wav"),
}
_CHUNK = SAMPLE_RATE * 10  # samples handed to the encoder at a time
# No 8 KiB FLAC padding block and no "Lavf" tag in the WAV header: sizes stay predictable for the window planner.
_MUX_OPTIONS = {"metadata_header_padding": "0", "fflags": "+bitexact"}
_WAV_HEADER_BYTES = 44


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


def wav_size(samples: int) -> int:
    """Bytes of `samples` mono 16-bit samples as WAV from `encode_pcm`."""
    return _WAV_HEADER_BYTES + 2 * samples


_STREAM_FRAMES = 1 << 19  # samples mixed and sent per chunk of a `MonoWav` (32 s, 1 MiB)


class MonoWav:
    """A whole decoded track mixed to mono as 16-bit WAV, streamed from the memory map, never built in memory.

    The bytes equal `encode_pcm(to_mono(samples), "wav").data`: the same 44-byte header, then the samples. `close()`
    drops the map, so nothing of it outlives the decoder's block. Each `chunks()` starts again from the header.
    """

    content_type = "audio/wav"

    def __init__(self, samples: np.ndarray) -> None:
        self._samples: np.ndarray | None = samples
        self.frames = int(samples.shape[0])
        self.size_bytes = wav_size(self.frames)
        self.duration_seconds = self.frames / SAMPLE_RATE

    def header(self) -> bytes:
        data = 2 * self.frames
        rate = SAMPLE_RATE
        return (
            b"RIFF"
            + struct.pack("<I", 36 + data)
            + b"WAVEfmt "
            + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
            + b"data"
            + struct.pack("<I", data)
        )

    def chunks(self) -> "_WavChunks":
        if self._samples is None:
            raise ValueError("MonoWav is closed")
        return _WavChunks(self)

    def close(self) -> None:
        self._samples = None


class _WavChunks:
    """One pass over a `MonoWav`. It reads the map through the `MonoWav` on every step and keeps no reference of its
    own, so once `close()` ran, a request (or a traceback) still holding this iterator does not keep the map open. A
    class, not an async generator: nothing is left suspended holding a frame. A pass cut by `close()` raises."""

    def __init__(self, wav: MonoWav) -> None:
        self._wav: MonoWav | None = wav
        self._next = -1  # -1: the header comes first

    def __aiter__(self) -> "_WavChunks":
        return self

    async def __anext__(self) -> bytes:
        wav = self._wav
        if wav is None:
            raise StopAsyncIteration
        if self._next < 0:
            self._next = 0
            return wav.header()
        start = self._next
        if start >= wav.frames:
            self._wav = None
            raise StopAsyncIteration
        samples = wav._samples
        if samples is None:
            self._wav = None
            raise ValueError("MonoWav was closed during the upload")
        self._next = start + _STREAM_FRAMES
        return to_mono(samples, start, self._next).astype("<i2", copy=False).tobytes()


def encode_pcm(samples: np.ndarray, fmt: AudioFormat) -> EncodedAudio:
    """Mono int16 samples at 16 kHz as FLAC or WAV bytes. An empty array is a ValueError."""
    if samples.ndim != 1 or len(samples) == 0:
        raise ValueError("encode_pcm needs a non-empty 1-D array")
    codec, filename, content_type = _FORMATS[fmt]
    buffer = io.BytesIO()
    with av.open(buffer, "w", format=fmt, options=_MUX_OPTIONS) as out:
        stream = out.add_stream(codec, rate=SAMPLE_RATE, layout="mono")
        for start in range(0, len(samples), _CHUNK):
            chunk = np.ascontiguousarray(samples[start : start + _CHUNK], dtype=np.int16).reshape(1, -1)
            frame = av.AudioFrame.from_ndarray(chunk, format="s16", layout="mono")
            frame.sample_rate = SAMPLE_RATE
            for packet in stream.encode(frame):
                out.mux(packet)
        for packet in stream.encode(None):
            out.mux(packet)
    data = buffer.getvalue()
    return EncodedAudio(
        filename=filename,
        content_type=content_type,
        duration_seconds=len(samples) / SAMPLE_RATE,
        size_bytes=len(data),
        data=data,
    )


@asynccontextmanager
async def open_encoded(path: Path, *, fmt: AudioFormat, max_bytes: int | None = None) -> AsyncIterator[EncodedAudio]:
    """The whole file, mixed to mono, as one upload; over `max_bytes` is `audio_too_long`.

    Decoding and encoding run in worker threads. The decoded temp file is gone after the block, also when the await
    is cancelled (see `open_decoded`); the encoded bytes live only in memory.
    """
    async with open_decoded(path) as decoded:
        if fmt == "wav" and max_bytes is not None and wav_size(decoded.samples.shape[0]) > max_bytes:
            raise EngineError("audio_too_long")  # the WAV size is known up front: do not spend the encode on it
        samples = decoded.samples  # the thread keeps the map alive even if the block is left early
        audio = await asyncio.to_thread(lambda: encode_pcm(to_mono(samples), fmt))
    if max_bytes is not None and audio.size_bytes > max_bytes:
        raise EngineError("audio_too_long")
    yield audio
