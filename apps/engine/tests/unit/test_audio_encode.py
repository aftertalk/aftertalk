from pathlib import Path

import av
import pytest
from audio_tools import make_tone

from aftertalk.audio.encode import encode_for_speech
from aftertalk.models.errors import EngineError


def probe(path: Path) -> tuple[int, int, str]:
    with av.open(str(path)) as container:
        stream = container.streams.audio[0]
        return stream.rate, len(stream.layout.channels), stream.codec_context.name


@pytest.mark.parametrize(
    ("fmt", "filename", "content_type", "codec"),
    [("flac", "audio.flac", "audio/flac", "flac"), ("wav", "audio.wav", "audio/wav", "pcm_s16le")],
)
def test_stereo_44k_becomes_mono_16k(tmp_path: Path, fmt: str, filename: str, content_type: str, codec: str) -> None:
    source = make_tone(tmp_path / "in.wav", seconds=2.5)
    with encode_for_speech(source, fmt=fmt) as audio:  # type: ignore[arg-type]
        assert audio.filename == filename and audio.content_type == content_type
        assert audio.path is not None and audio.path.exists()
        assert audio.size_bytes == audio.path.stat().st_size > 0
        assert audio.duration_seconds == pytest.approx(2.5, abs=0.05)
        assert probe(audio.path) == (16000, 1, codec)
        assert audio.read() == audio.path.read_bytes()
    assert not audio.path.exists()  # the temp file goes away with the context


def test_other_containers_and_codecs_decode(tmp_path: Path) -> None:
    source = make_tone(tmp_path / "in.flac", seconds=1.0, rate=48000, codec="flac")
    with encode_for_speech(source, fmt="wav") as audio:
        assert audio.duration_seconds == pytest.approx(1.0, abs=0.05)


def test_mono_input(tmp_path: Path) -> None:
    source = make_tone(tmp_path / "in.wav", seconds=1.0, rate=16000, channels=1)
    with encode_for_speech(source, fmt="flac") as audio:
        assert audio.duration_seconds == pytest.approx(1.0, abs=0.05)


def test_unreadable_file(tmp_path: Path) -> None:
    junk = tmp_path / "junk.mp3"
    junk.write_bytes(b"this is not audio at all" * 50)
    with pytest.raises(EngineError) as info:
        encode_for_speech(junk, fmt="flac")
    assert info.value.code == "audio_unreadable" and not info.value.retryable
    assert info.value.__cause__ is None and info.value.__context__ is None


def test_missing_file(tmp_path: Path) -> None:
    with pytest.raises(EngineError) as info:
        encode_for_speech(tmp_path / "nope.wav", fmt="flac")
    assert info.value.code == "audio_unreadable"


def test_video_without_audio_stream(tmp_path: Path) -> None:
    path = tmp_path / "silent.mp4"
    with av.open(str(path), "w") as container:
        stream = container.add_stream("mpeg4", rate=10)
        stream.width, stream.height, stream.pix_fmt = 64, 64, "yuv420p"
        frame = av.VideoFrame(64, 64, "yuv420p")
        for packet in stream.encode(frame):
            container.mux(packet)
        for packet in stream.encode(None):
            container.mux(packet)
    with pytest.raises(EngineError) as info:
        encode_for_speech(path, fmt="flac")
    assert info.value.code == "audio_unreadable"
