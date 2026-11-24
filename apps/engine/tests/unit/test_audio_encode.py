import asyncio
import io
from pathlib import Path

import av
import numpy as np
import pytest
from audio_tools import make_tone

from aftertalk.audio.encode import SAMPLE_RATE, EncodedAudio, encode_pcm, open_encoded, wav_size
from aftertalk.models.errors import EngineError


def decode_bytes(data: bytes) -> tuple[int, int, str, np.ndarray]:
    with av.open(io.BytesIO(data)) as container:
        stream = container.streams.audio[0]
        frames = [frame.to_ndarray().reshape(-1) for frame in container.decode(stream)]
        return stream.rate, len(stream.layout.channels), stream.codec_context.name, np.concatenate(frames)


@pytest.mark.parametrize(
    ("fmt", "filename", "content_type", "codec"),
    [("flac", "audio.flac", "audio/flac", "flac"), ("wav", "audio.wav", "audio/wav", "pcm_s16le")],
)
def test_encode_pcm_round_trips(fmt: str, filename: str, content_type: str, codec: str) -> None:
    samples = (np.sin(np.arange(int(SAMPLE_RATE * 2.5)) / 7) * 9000).astype(np.int16)
    audio = encode_pcm(samples, fmt)  # type: ignore[arg-type]
    assert (audio.filename, audio.content_type) == (filename, content_type)
    assert audio.path is None and audio.data is not None and audio.read() == audio.data
    assert audio.size_bytes == len(audio.data) > 0
    assert audio.duration_seconds == 2.5
    rate, channels, name, decoded = decode_bytes(audio.data)
    assert (rate, channels, name) == (SAMPLE_RATE, 1, codec)
    assert np.array_equal(decoded, samples)  # both formats are lossless


@pytest.mark.parametrize("count", [1, 1000, SAMPLE_RATE * 3 + 17])
def test_wav_size_is_exact(count: int) -> None:
    samples = np.random.default_rng(count).integers(-32768, 32768, count, dtype=np.int16)
    assert encode_pcm(samples, "wav").size_bytes == wav_size(count) == 44 + 2 * count


@pytest.mark.parametrize("seconds", [1, 10, 60])
def test_flac_of_noise_stays_within_the_planner_margin(seconds: int) -> None:
    count = SAMPLE_RATE * seconds
    noise = np.random.default_rng(seconds).integers(-32768, 32768, count, dtype=np.int16)
    assert encode_pcm(noise, "flac").size_bytes <= wav_size(count) * 1.01


def test_encode_pcm_refuses_empty() -> None:
    with pytest.raises(ValueError):
        encode_pcm(np.zeros(0, dtype=np.int16), "flac")


@pytest.mark.parametrize("fmt", ["flac", "wav"])
def test_open_encoded_mixes_the_whole_file(tmp_path: Path, fmt: str) -> None:
    source = make_tone(tmp_path / "in.wav", seconds=2.5)  # stereo, 44.1 kHz

    async def main() -> EncodedAudio:
        async with open_encoded(source, fmt=fmt) as audio:  # type: ignore[arg-type]
            return audio

    audio = asyncio.run(main())
    assert audio.duration_seconds == pytest.approx(2.5, abs=0.05)
    assert audio.data is not None
    rate, channels, _, decoded = decode_bytes(audio.data)
    assert (rate, channels) == (SAMPLE_RATE, 1) and len(decoded) == round(audio.duration_seconds * SAMPLE_RATE)


def test_open_encoded_unreadable(tmp_path: Path) -> None:
    junk = tmp_path / "junk.mp3"
    junk.write_bytes(b"this is not audio at all" * 50)

    async def main() -> None:
        async with open_encoded(junk, fmt="flac"):
            pass

    with pytest.raises(EngineError) as info:
        asyncio.run(main())
    assert info.value.code == "audio_unreadable" and info.value.__context__ is None
