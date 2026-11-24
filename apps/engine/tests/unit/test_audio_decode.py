from pathlib import Path

import av
import numpy as np
import pytest
from audio_tools import make_media, make_offset_aac, make_stream, tone

from aftertalk.audio.decode import SAMPLE_RATE, decode_audio
from aftertalk.models.errors import EngineError

# One file per container and codec, all built with the bundled FFmpeg: (file name, audio codec, video codec, name).
CONTAINERS = [
    ("a.wav", "pcm_s16le", None, "wav"),
    ("a.mp3", "libmp3lame", None, "mp3"),
    ("a.flac", "flac", None, "flac"),
    ("a.opus", "libopus", None, "ogg"),
    ("a.ogg", "vorbis", None, "ogg"),  # FFmpeg's own Vorbis encoder: experimental and stereo only
    ("a.m4a", "aac", None, "mp4"),
    ("a.mp4", "aac", "mpeg4", "mp4"),
    ("a.mkv", "aac", "mpeg4", "matroska"),
    ("a.webm", "libopus", "vp8", "matroska"),  # FFmpeg reads WebM with its Matroska demuxer and does not say which
    ("a.mov", "aac", "mpeg4", "mov"),
]


@pytest.mark.parametrize(("name", "codec", "video", "container"), CONTAINERS)
def test_every_container_decodes(tmp_path: Path, name: str, codec: str, video: str | None, container: str) -> None:
    rate = 44100 if codec in ("libmp3lame", "vorbis") else 48000
    channels = 2 if codec == "vorbis" else 1
    source = make_media(tmp_path / name, codec, seconds=2.0, rate=rate, channels=channels, video=video)
    with decode_audio(source) as audio:
        assert audio.container == container
        assert audio.channels == channels and audio.samples.shape[1] == channels
        assert audio.has_video is (video is not None)
        assert audio.duration_seconds == pytest.approx(2.0, abs=0.1)
        assert audio.duration_seconds == audio.samples.shape[0] / SAMPLE_RATE
        assert audio.start_offset_seconds == pytest.approx(0.0, abs=0.05)
        assert np.abs(audio.mono()[SAMPLE_RATE // 2 : SAMPLE_RATE]).max() > 5000  # the tone is there


def test_mp4_with_audio_that_starts_after_the_video(tmp_path: Path) -> None:
    source = make_media(tmp_path / "late.mp4", "aac", seconds=2.0, video="mpeg4", video_seconds=50, audio_offset=45)
    with decode_audio(source) as audio:
        assert audio.has_video and audio.container == "mp4"
        assert audio.start_offset_seconds == pytest.approx(45.0, abs=0.05)  # AAC priming moves it by ~21 ms
        assert audio.duration_seconds == pytest.approx(2.0, abs=0.1)  # the audio's own length: no lead-in padding
        assert np.abs(audio.mono()[: SAMPLE_RATE // 2]).max() > 1000  # sample 0 is the tone, not silence


def test_late_start_is_not_padded(tmp_path: Path) -> None:
    source = make_offset_aac(tmp_path / "late.m4a", offset=2.0, seconds=1.0)
    with decode_audio(source) as audio:
        assert audio.duration_seconds == pytest.approx(1.0, abs=0.1)
        assert audio.start_offset_seconds == pytest.approx(0.0, abs=0.05)  # the container starts with the audio


@pytest.mark.parametrize("video", [None, "mpeg4"])
def test_mpegts_clock_does_not_count(tmp_path: Path, video: str | None) -> None:
    source = make_media(
        tmp_path / "a.ts", "mp2", rate=44100, seconds=1.0, video=video, audio_offset=3600, video_offset=3600
    )
    with decode_audio(source) as audio:
        assert audio.container == "mpegts" and audio.has_video is (video is not None)
        assert audio.start_offset_seconds == pytest.approx(0.0, abs=0.05)
        assert audio.duration_seconds == pytest.approx(1.0, abs=0.1)


def test_matroska_audio_that_starts_at_one_hour(tmp_path: Path) -> None:
    with decode_audio(make_stream(tmp_path / "a.mka", "aac", offset=3600.0)) as audio:
        assert audio.start_offset_seconds == pytest.approx(0.0, abs=0.05)
        assert audio.duration_seconds == pytest.approx(1.0, abs=0.15)


def test_stereo_keeps_both_channels(tmp_path: Path) -> None:
    left, right = tone(1.0, SAMPLE_RATE, 440, 8000), tone(1.0, SAMPLE_RATE, 1000, 4000)
    source = make_media(
        tmp_path / "s.wav", "pcm_s16le", rate=SAMPLE_RATE, channels=2, signal=np.stack([left, right], 1)
    )
    with decode_audio(source) as audio:
        assert audio.channels == 2 and audio.samples.shape == (SAMPLE_RATE, 2)
        assert np.abs(audio.samples[:, 0].astype(np.int32) - left).max() <= 1
        assert np.abs(audio.samples[:, 1].astype(np.int32) - right).max() <= 1
        expected = (audio.samples.astype(np.int32).sum(axis=1) // 2).astype(np.int16)
        assert np.array_equal(audio.mono(), expected)
        assert np.array_equal(audio.mono(100, 200), expected[100:200])  # a slice is the same mix


def test_stereo_mp3_resampled(tmp_path: Path) -> None:
    source = make_media(tmp_path / "s.mp3", "libmp3lame", rate=44100, channels=2)
    with decode_audio(source) as audio:
        assert audio.channels == 2 and audio.samples.shape[1] == 2
        assert audio.duration_seconds == pytest.approx(2.0, abs=0.1)


@pytest.mark.parametrize(("name", "codec", "channels"), [("six.mkv", "aac", 6), ("three.wav", "pcm_s16le", 3)])
def test_more_than_two_channels_are_mixed(tmp_path: Path, name: str, codec: str, channels: int) -> None:
    with decode_audio(make_media(tmp_path / name, codec, channels=channels)) as audio:
        assert audio.channels == channels and audio.samples.shape[1] == 1
        assert audio.duration_seconds == pytest.approx(2.0, abs=0.1)
        assert np.abs(audio.mono()[SAMPLE_RATE // 2 : SAMPLE_RATE]).max() > 1000


@pytest.mark.parametrize(
    ("name", "codec", "cover", "fmt"), [("c.mp3", "libmp3lame", "png", None), ("c.m4a", "aac", "mjpeg", "mp4")]
)
def test_cover_art_is_not_video(tmp_path: Path, name: str, codec: str, cover: str, fmt: str | None) -> None:
    source = make_media(tmp_path / name, codec, rate=44100, cover=cover, fmt=fmt)
    with av.open(str(source)) as container:
        assert len(container.streams.video) == 1  # the picture is there
    with decode_audio(source) as audio:
        assert not audio.has_video
        assert audio.duration_seconds == pytest.approx(2.0, abs=0.1)


def test_a_gap_inside_is_padded(tmp_path: Path) -> None:
    with decode_audio(make_stream(tmp_path / "a.mka", "aac", offset=0.0, seconds=3.0, late=5.0)) as audio:
        assert audio.duration_seconds == pytest.approx(5.0, abs=0.15)
        assert np.abs(audio.mono()[int(SAMPLE_RATE * 3.3) : int(SAMPLE_RATE * 4.8)]).max() == 0


def test_a_gap_after_a_late_start_is_measured_from_the_first_frame(tmp_path: Path) -> None:
    with decode_audio(make_stream(tmp_path / "a.mka", "aac", offset=10.0, seconds=3.0, late=15.0)) as audio:
        assert audio.duration_seconds == pytest.approx(5.0, abs=0.15)


def test_max_seconds_is_limit_exceeded(tmp_path: Path) -> None:
    source = make_media(tmp_path / "long.wav", "pcm_s16le", rate=SAMPLE_RATE, seconds=5.0)
    with pytest.raises(EngineError) as info:
        decode_audio(source, max_seconds=2.0)
    assert info.value.code == "limit_exceeded"
    assert info.value.__cause__ is None and info.value.__context__ is None
    with decode_audio(source, max_seconds=6.0) as audio:
        assert audio.duration_seconds == pytest.approx(5.0, abs=0.01)


def test_close_is_idempotent_and_deletes_the_file(tmp_path: Path) -> None:
    audio = decode_audio(make_media(tmp_path / "a.wav", "pcm_s16le"))
    path = audio.path
    assert path is not None and path.exists() and path.name.startswith("aftertalk-") and path.suffix == ".pcm"
    audio.close()
    audio.close()
    assert not path.exists() and audio.path is None


def test_unreadable_file(tmp_path: Path) -> None:
    junk = tmp_path / "junk.mp3"
    junk.write_bytes(b"this is not audio at all" * 50)
    with pytest.raises(EngineError) as info:
        decode_audio(junk)
    assert info.value.code == "audio_unreadable" and not info.value.retryable
    assert info.value.__cause__ is None and info.value.__context__ is None


def test_missing_file(tmp_path: Path) -> None:
    with pytest.raises(EngineError) as info:
        decode_audio(tmp_path / "nope.wav")
    assert info.value.code == "audio_unreadable"


def test_video_without_audio_stream(tmp_path: Path) -> None:
    path = tmp_path / "silent.mp4"
    with av.open(str(path), "w") as container:
        stream = container.add_stream("mpeg4", rate=10)
        stream.width, stream.height, stream.pix_fmt = 64, 64, "yuv420p"
        for packet in [*stream.encode(av.VideoFrame(64, 64, "yuv420p")), *stream.encode(None)]:
            container.mux(packet)
    with pytest.raises(EngineError) as info:
        decode_audio(path)
    assert info.value.code == "audio_unreadable"
