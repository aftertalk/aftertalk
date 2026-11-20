import asyncio
import os
import stat
import tempfile
import time
from pathlib import Path

import av
import numpy as np
import pytest
from audio_tools import make_offset_aac, make_tone

from aftertalk.audio import encode
from aftertalk.audio.encode import encode_for_speech
from aftertalk.models.errors import EngineError


@pytest.fixture
def audio_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path / "tmp"))
    (tmp_path / "tmp").mkdir()
    return tmp_path / "tmp" / "aftertalk-audio"


def test_temp_files_live_in_a_private_directory(tmp_path: Path, audio_dir: Path) -> None:
    with encode_for_speech(make_tone(tmp_path / "a.wav"), fmt="flac") as audio:
        assert audio.path is not None and audio.path.parent == audio_dir
        assert stat.S_IMODE(audio_dir.stat().st_mode) == 0o700
    assert list(audio_dir.iterdir()) == []


@pytest.mark.parametrize("error", [KeyboardInterrupt, asyncio.CancelledError, SystemExit])
def test_interrupt_removes_the_temp_file(
    tmp_path: Path, audio_dir: Path, monkeypatch: pytest.MonkeyPatch, error: type[BaseException]
) -> None:
    def boom(source: Path, target: Path, fmt: str, max_bytes: int | None) -> float:
        target.write_bytes(b"partial")
        raise error

    monkeypatch.setattr(encode, "_convert", boom)
    with pytest.raises(error):
        encode_for_speech(make_tone(tmp_path / "a.wav"), fmt="flac")
    assert list(audio_dir.iterdir()) == []


def test_failure_removes_the_temp_file(tmp_path: Path, audio_dir: Path) -> None:
    junk = tmp_path / "junk.wav"
    junk.write_bytes(b"nope" * 100)
    with pytest.raises(EngineError):
        encode_for_speech(junk, fmt="wav")
    assert list(audio_dir.iterdir()) == []


def test_ctrl_c_in_the_cli_exits_130_and_leaves_nothing(
    tmp_path: Path, audio_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from typer.testing import CliRunner

    from aftertalk.cli import app

    def boom(source: Path, target: Path, fmt: str, max_bytes: int | None) -> float:
        target.write_bytes(b"partial")
        raise KeyboardInterrupt

    monkeypatch.setattr(encode, "_convert", boom)
    (tmp_path / "connections.yaml").write_text("speech: {base_url: 'http://127.0.0.1:1/v1', model: m}\n")
    source = make_tone(tmp_path / "a.wav")
    result = CliRunner().invoke(app, ["transcribe", str(source)], env={"AFTERTALK_HOME": str(tmp_path)})
    assert result.exit_code == 130  # the conventional exit code for Ctrl-C
    assert list(audio_dir.iterdir()) == []


def test_old_leftovers_are_swept_and_new_ones_kept(tmp_path: Path, audio_dir: Path) -> None:
    audio_dir.mkdir(parents=True)
    old, fresh, other = audio_dir / "aftertalk-old.flac", audio_dir / "aftertalk-new.flac", audio_dir / "keep.txt"
    for file in (old, fresh, other):
        file.write_bytes(b"x")
    os.utime(old, (time.time() - 7200, time.time() - 7200))
    os.utime(other, (time.time() - 7200, time.time() - 7200))
    encode_for_speech(make_tone(tmp_path / "a.wav"), fmt="flac").close()
    assert not old.exists() and fresh.exists() and other.exists()


def test_playlist_is_refused(tmp_path: Path) -> None:
    make_tone(tmp_path / "secret.mp3", seconds=1.0, codec="mp3")
    playlist = tmp_path / "list.m3u8"
    playlist.write_text(
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:1.0,\nsecret.mp3\n#EXT-X-ENDLIST\n"
    )
    with pytest.raises(EngineError) as info:
        encode_for_speech(playlist, fmt="flac")
    assert info.value.code == "audio_unreadable"


def test_ffconcat_list_is_refused(tmp_path: Path) -> None:
    make_tone(tmp_path / "secret.mp3", seconds=1.0, codec="mp3")
    listing = tmp_path / "list.ffconcat"
    listing.write_text("ffconcat version 1.0\nfile secret.mp3\n")
    with pytest.raises(EngineError) as info:
        encode_for_speech(listing, fmt="flac")
    assert info.value.code == "audio_unreadable"


def test_the_sibling_file_itself_is_fine(tmp_path: Path) -> None:
    with encode_for_speech(make_tone(tmp_path / "secret.mp3", seconds=1.0, codec="mp3"), fmt="flac") as audio:
        assert audio.duration_seconds == pytest.approx(1.0, abs=0.2)


def test_audio_that_starts_late_is_padded_with_silence(tmp_path: Path) -> None:
    source = make_offset_aac(tmp_path / "late.mp4", offset=2.0, seconds=1.0)
    with encode_for_speech(source, fmt="wav") as audio:
        assert audio.duration_seconds == pytest.approx(3.0, abs=0.15)
        assert audio.path is not None
        with av.open(str(audio.path)) as container:
            frames = [f.to_ndarray().reshape(-1) for f in container.decode(container.streams.audio[0])]
    samples = np.concatenate(frames)
    assert np.abs(samples[: 16000 * 3 // 2]).max() == 0  # the first 1.5 s are silence
    assert np.abs(samples[int(16000 * 2.2) :]).max() > 1000  # the tone follows


def test_output_over_the_limit_stops_early(tmp_path: Path, audio_dir: Path) -> None:
    source = make_tone(tmp_path / "long.wav", seconds=20.0)
    with pytest.raises(EngineError) as info:
        encode_for_speech(source, fmt="wav", max_bytes=100_000)  # 20 s of 16 kHz s16 is 640 KB
    assert info.value.code == "audio_too_long" and list(audio_dir.iterdir()) == []
