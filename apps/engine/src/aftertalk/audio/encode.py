"""Encode decoded audio the way speech-to-text services want it: mono, 16 kHz, 16-bit FLAC or WAV, in memory.

That is what Whisper-family models use internally, and small enough to upload. `encode_pcm` encodes one window of
`decode.DecodedAudio`; `open_encoded` decodes and encodes a whole (short) file for `providers test` and the CLI.
The output has no padding block or encoder tag, so a WAV is exactly 44 header bytes plus two bytes per sample and
FLAC of noise stays within about 0.5% of that (the window planner allows 1%).
"""

import asyncio
import contextlib
import io
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

__all__ = ["SAMPLE_RATE", "AudioFormat", "EncodedAudio", "encode_pcm", "open_encoded", "wav_size"]

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
