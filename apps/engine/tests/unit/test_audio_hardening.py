import asyncio
import os
import stat
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import BinaryIO

import av
import numpy as np
import pytest
from audio_tools import make_offset_aac, make_stream, make_tone

from aftertalk.audio import decode
from aftertalk.audio.decode import SAMPLE_RATE, _Decoded, decode_audio, open_decoded
from aftertalk.audio.encode import open_encoded
from aftertalk.models.errors import EngineError


@pytest.fixture
def audio_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path / "tmp"))
    (tmp_path / "tmp").mkdir()
    return tmp_path / "tmp" / ("aftertalk-audio" if not hasattr(os, "getuid") else f"aftertalk-audio-{os.getuid()}")


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX file modes")
def test_temp_files_live_in_a_private_directory(tmp_path: Path, audio_dir: Path) -> None:
    with decode_audio(make_tone(tmp_path / "a.wav")) as audio:
        assert audio.path is not None and audio.path.parent == audio_dir
        assert stat.S_IMODE(audio_dir.stat().st_mode) == 0o700
        assert stat.S_IMODE(audio.path.stat().st_mode) == 0o600
    assert list(audio_dir.iterdir()) == []


@pytest.mark.parametrize("error", [KeyboardInterrupt, asyncio.CancelledError, SystemExit])
def test_interrupt_removes_the_temp_file(
    tmp_path: Path, audio_dir: Path, monkeypatch: pytest.MonkeyPatch, error: type[BaseException]
) -> None:
    def boom(source: Path, out: BinaryIO, max_seconds: float | None, cancelled: object = None) -> _Decoded:
        out.write(b"partial")
        raise error

    monkeypatch.setattr(decode, "_convert", boom)
    with pytest.raises(error):
        decode_audio(make_tone(tmp_path / "a.wav"))
    assert list(audio_dir.iterdir()) == []


def test_failure_removes_the_temp_file(tmp_path: Path, audio_dir: Path) -> None:
    junk = tmp_path / "junk.wav"
    junk.write_bytes(b"nope" * 100)
    with pytest.raises(EngineError):
        decode_audio(junk)
    assert list(audio_dir.iterdir()) == []


class _FullDisk:
    """The temp file, failing as a full disk does: on `write`, or only on the closing flush."""

    def __init__(self, real: BinaryIO, fail_on: str) -> None:
        self.real, self.fail_on = real, fail_on

    def write(self, data: bytes) -> int:
        if self.fail_on == "write":
            raise OSError(28, "No space left on device")
        return len(data)

    def close(self) -> None:
        self.real.close()
        if self.fail_on == "close":
            raise OSError(28, "No space left on device")


@pytest.mark.parametrize("fail_on", ["write", "close"])
@pytest.mark.parametrize("fallback", [False, True])
def test_a_full_disk_is_internal_and_leaves_nothing(
    tmp_path: Path, audio_dir: Path, monkeypatch: pytest.MonkeyPatch, fail_on: str, fallback: bool
) -> None:
    source = make_tone(tmp_path / "a.wav")
    monkeypatch.setattr(decode, "open", lambda *a, **k: _FullDisk(open(*a, **k), fail_on), raising=False)
    if fallback:
        monkeypatch.setattr(decode, "_private_dir", lambda directory, uid: False)
    with pytest.raises(EngineError) as info:
        decode_audio(source)
    assert info.value.code == "internal"  # not the file's fault
    assert info.value.__cause__ is None and info.value.__context__ is None
    assert list((tmp_path / "tmp").rglob("*")) == ([audio_dir] if audio_dir.exists() else [])


def test_ctrl_c_in_the_cli_exits_130_and_leaves_nothing(
    tmp_path: Path, audio_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from typer.testing import CliRunner

    from aftertalk.cli import app

    def boom(source: Path, out: BinaryIO, max_seconds: float | None, cancelled: object = None) -> _Decoded:
        out.write(b"partial")
        raise KeyboardInterrupt

    monkeypatch.setattr(decode, "_convert", boom)
    (tmp_path / "connections.yaml").write_text("speech: {base_url: 'http://127.0.0.1:1/v1', model: m}\n")
    source = make_tone(tmp_path / "a.wav")
    result = CliRunner().invoke(app, ["transcribe", str(source)], env={"AFTERTALK_HOME": str(tmp_path)})
    assert result.exit_code == 130  # the conventional exit code for Ctrl-C
    assert list(audio_dir.iterdir()) == []


def test_old_leftovers_are_swept_and_new_ones_kept(tmp_path: Path, audio_dir: Path) -> None:
    audio_dir.mkdir(parents=True)
    old, fresh, other = audio_dir / "aftertalk-old.pcm", audio_dir / "aftertalk-new.pcm", audio_dir / "keep.txt"
    for file in (old, fresh, other):
        file.write_bytes(b"x")
    os.utime(old, (time.time() - 7200, time.time() - 7200))
    os.utime(other, (time.time() - 7200, time.time() - 7200))
    decode_audio(make_tone(tmp_path / "a.wav")).close()
    assert not old.exists() and fresh.exists() and other.exists()


def test_playlist_is_refused(tmp_path: Path) -> None:
    make_tone(tmp_path / "secret.mp3", seconds=1.0, codec="mp3")
    playlist = tmp_path / "list.m3u8"
    playlist.write_text(
        "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:1.0,\nsecret.mp3\n#EXT-X-ENDLIST\n"
    )
    with pytest.raises(EngineError) as info:
        decode_audio(playlist)
    assert info.value.code == "audio_unreadable"


def test_ffconcat_list_is_refused(tmp_path: Path) -> None:
    make_tone(tmp_path / "secret.mp3", seconds=1.0, codec="mp3")
    listing = tmp_path / "list.ffconcat"
    listing.write_text("ffconcat version 1.0\nfile secret.mp3\n")
    with pytest.raises(EngineError) as info:
        decode_audio(listing)
    assert info.value.code == "audio_unreadable"


def test_the_sibling_file_itself_is_fine(tmp_path: Path) -> None:
    with decode_audio(make_tone(tmp_path / "secret.mp3", seconds=1.0, codec="mp3")) as audio:
        assert audio.duration_seconds == pytest.approx(1.0, abs=0.2)


def test_audio_that_starts_late_is_not_padded(tmp_path: Path) -> None:
    # M1 padded a lead-in up to 30 s; now sample 0 is the first frame and the offset says where it sits.
    source = make_offset_aac(tmp_path / "late.mp4", offset=2.0, seconds=1.0)
    with decode_audio(source) as audio:
        assert audio.duration_seconds == pytest.approx(1.0, abs=0.1)
        assert np.abs(audio.mono()[: SAMPLE_RATE // 2]).max() > 1000  # the tone from the start


def test_audio_over_the_time_limit_stops_early(tmp_path: Path, audio_dir: Path) -> None:
    source = make_tone(tmp_path / "long.wav", seconds=20.0)
    with pytest.raises(EngineError) as info:
        decode_audio(source, max_seconds=5.0)
    assert info.value.code == "limit_exceeded" and list(audio_dir.iterdir()) == []


def test_open_encoded_over_the_byte_limit(tmp_path: Path, audio_dir: Path) -> None:
    source = make_tone(tmp_path / "long.wav", seconds=20.0)

    async def main(fmt: str) -> None:
        async with open_encoded(source, fmt=fmt, max_bytes=100_000):  # type: ignore[arg-type]
            pass

    for fmt in ("wav", "flac"):  # 20 s of 16 kHz s16 is 640 KB; FLAC of a tone is smaller but still over
        with pytest.raises(EngineError) as info:
            asyncio.run(main(fmt))
        assert info.value.code == "audio_too_long" and leftovers(tmp_path / "tmp") == []


# ---- silence padding: measured from the stream's start, capped ----


def leftovers(directory: Path) -> list[Path]:
    return [p for p in directory.rglob("aftertalk-*") if p.is_file()] if directory.exists() else []


def test_mpegts_that_starts_at_one_hour_is_one_second(tmp_path: Path, audio_dir: Path) -> None:
    source = make_stream(tmp_path / "a.ts", "mp2", offset=3600.0)
    with decode_audio(source) as audio:
        assert audio.duration_seconds == pytest.approx(1.0, abs=0.1)
        assert audio.start_offset_seconds == pytest.approx(0.0, abs=0.05)


def test_mka_that_starts_at_one_hour_is_one_second(tmp_path: Path, audio_dir: Path) -> None:
    source = make_stream(tmp_path / "a.mka", "aac", offset=3600.0)
    with decode_audio(source) as audio:
        assert audio.duration_seconds == pytest.approx(1.0, abs=0.15)


def test_a_lone_late_frame_is_refused(tmp_path: Path, audio_dir: Path) -> None:
    source = make_stream(tmp_path / "a.mka", "aac", offset=0.0, late=21600.0)  # over the 30 min cap
    started = time.monotonic()
    with pytest.raises(EngineError) as info:
        decode_audio(source)
    assert info.value.code == "audio_unreadable" and leftovers(tmp_path / "tmp") == []
    assert time.monotonic() - started < 5  # refused before hours of silence are encoded


def test_a_real_gap_is_still_padded(tmp_path: Path, audio_dir: Path) -> None:
    source = make_stream(tmp_path / "a.mka", "aac", offset=0.0, seconds=3.0, late=5.0)
    with decode_audio(source) as audio:
        assert audio.duration_seconds == pytest.approx(5.0, abs=0.15)


def test_a_long_hold_is_padded(tmp_path: Path, audio_dir: Path) -> None:
    # A recorder that writes no packets during a hold: far more silence than audio, under the cap.
    source = make_stream(tmp_path / "a.mka", "aac", offset=0.0, seconds=1.0, late=300.0)
    with decode_audio(source) as audio:
        assert audio.duration_seconds == pytest.approx(300.0, abs=0.5)


# ---- cancellation: no decoded audio left on disk ----


class SlowConvert:
    """Stands in for `_convert`: writes PCM, says it started, then waits to be released."""

    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()

    def __call__(self, source: Path, out: BinaryIO, max_seconds: float | None, cancelled: object = None) -> _Decoded:
        out.write(bytes(2 * SAMPLE_RATE))
        out.flush()
        self.started.set()
        assert self.release.wait(10)
        return _Decoded(SAMPLE_RATE, 1, 1, "wav", False, 0.0)


def cli_conn(tmp_path: Path) -> object:
    from aftertalk.models.connections import SpeechConnection

    return SpeechConnection(base_url="http://127.0.0.1:1/v1", model="m")


@pytest.mark.parametrize("how", ["cancel", "deadline"])
def test_cancel_during_encoding_leaves_nothing(
    tmp_path: Path, audio_dir: Path, monkeypatch: pytest.MonkeyPatch, how: str
) -> None:
    from aftertalk.cli import _transcribe

    slow = SlowConvert()
    monkeypatch.setattr(decode, "_convert", slow)
    source = make_tone(tmp_path / "a.wav")

    async def main() -> None:
        job = _transcribe(cli_conn(tmp_path), source, None, None, False, 3600)
        if how == "cancel":
            task = asyncio.create_task(job)
            await asyncio.to_thread(slow.started.wait, 10)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            waiter = asyncio.create_task(asyncio.wait_for(job, timeout=0.2))
            await asyncio.to_thread(slow.started.wait, 10)
            with pytest.raises(TimeoutError):
                await waiter
        assert audio_dir.exists()
        slow.release.set()  # the thread finishes only now, after the task has gone

    asyncio.run(main())  # joins the worker thread before it returns
    assert leftovers(tmp_path / "tmp") == []


def test_real_decoder_stops_when_cancelled(tmp_path: Path, audio_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = make_tone(tmp_path / "long.wav", seconds=30.0)
    cancelled = threading.Event()
    frames = 0
    real_decode = av.container.InputContainer.decode

    def counting_decode(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        nonlocal frames
        for frame in real_decode(self, *args, **kwargs):
            frames += 1
            yield frame
            cancelled.set()  # set once the first frame has been encoded

    monkeypatch.setattr(av.container.InputContainer, "decode", counting_decode)
    with pytest.raises(decode._Cancelled):
        decode_audio(source, cancelled=cancelled)
    assert frames == 2 and leftovers(tmp_path / "tmp") == []


def test_open_encoded_removes_the_file_after_the_block(tmp_path: Path, audio_dir: Path) -> None:
    async def main() -> None:
        async with open_encoded(make_tone(tmp_path / "a.wav"), fmt="flac") as audio:
            assert audio.data is not None and audio.size_bytes == len(audio.data) > 0
            assert leftovers(tmp_path / "tmp") == []  # the decoded PCM is gone already: the upload is in memory

    asyncio.run(main())
    assert leftovers(tmp_path / "tmp") == []


def test_open_decoded_removes_the_file_after_the_block(tmp_path: Path, audio_dir: Path) -> None:
    async def main() -> Path:
        async with open_decoded(make_tone(tmp_path / "a.wav")) as audio:
            assert audio.path is not None and audio.path.exists()
            return audio.path

    path = asyncio.run(main())
    assert not path.exists() and leftovers(tmp_path / "tmp") == []


@pytest.mark.parametrize("opener", ["decoded", "encoded"])
def test_cancelled_open_leaves_nothing(
    tmp_path: Path, audio_dir: Path, monkeypatch: pytest.MonkeyPatch, opener: str
) -> None:
    slow = SlowConvert()
    monkeypatch.setattr(decode, "_convert", slow)
    source = make_tone(tmp_path / "a.wav")

    async def use() -> None:
        if opener == "decoded":
            async with open_decoded(source):
                pytest.fail("the block must not run")
        async with open_encoded(source, fmt="flac"):
            pytest.fail("the block must not run")

    async def main() -> None:
        task = asyncio.create_task(use())
        await asyncio.to_thread(slow.started.wait, 10)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert leftovers(tmp_path / "tmp") != []  # the worker is still writing...
        slow.release.set()  # ...and cleans up after itself when it finishes

    asyncio.run(main())  # joins the worker thread before it returns
    assert leftovers(tmp_path / "tmp") == []


def test_cancel_while_encoding_leaves_nothing(tmp_path: Path, audio_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from aftertalk.audio import encode

    started, release = threading.Event(), threading.Event()
    real = encode.encode_pcm

    def slow_encode(samples: np.ndarray, fmt: str):  # type: ignore[no-untyped-def]
        started.set()
        assert release.wait(10)
        return real(samples, fmt)  # type: ignore[arg-type]

    monkeypatch.setattr(encode, "encode_pcm", slow_encode)

    async def main() -> None:
        async def use() -> None:
            async with open_encoded(make_tone(tmp_path / "a.wav"), fmt="flac"):
                pytest.fail("the block must not run")

        task = asyncio.create_task(use())
        await asyncio.to_thread(started.wait, 10)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert leftovers(tmp_path / "tmp") == []  # the decoded file goes when the task does
        release.set()

    asyncio.run(main())
    assert leftovers(tmp_path / "tmp") == []


# ---- per-user temp directory ----


def test_works_without_getuid(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    monkeypatch.delattr(os, "getuid", raising=False)
    with decode_audio(make_tone(tmp_path / "a.wav")) as audio:
        assert audio.path is not None and audio.path.parent == tmp_path / "aftertalk-audio"


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX owners and modes")
def test_a_directory_of_another_user_is_not_used(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    other = os.getuid() + 4242
    taken = tmp_path / f"aftertalk-audio-{other}"
    taken.mkdir()  # owned by us, so not by `other`
    monkeypatch.setattr(os, "getuid", lambda: other)
    with decode_audio(make_tone(tmp_path / "a.wav")) as audio:
        assert audio.path is not None and audio.path.parent != taken
        fallback = audio.path.parent
        assert stat.S_IMODE(fallback.stat().st_mode) == 0o700
    assert list(taken.iterdir()) == []
    assert not fallback.exists() and taken.exists()  # the fallback directory goes on close, the shared name stays


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX owners and modes")
def test_a_fallback_directory_is_removed_on_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    (tmp_path / f"aftertalk-audio-{os.getuid()}").write_text("not a directory")
    junk = tmp_path / "junk.wav"
    junk.write_bytes(b"nope" * 100)
    with pytest.raises(EngineError):
        decode_audio(junk)
    assert sorted(p.name for p in tmp_path.iterdir()) == [f"aftertalk-audio-{os.getuid()}", "junk.wav"]


def test_the_shared_directory_is_kept(tmp_path: Path, audio_dir: Path) -> None:
    decode_audio(make_tone(tmp_path / "a.wav")).close()
    assert audio_dir.is_dir() and list(audio_dir.iterdir()) == []


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX symlinks and modes")
def test_a_symlink_at_the_name_is_not_followed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path / "tmp"))
    (tmp_path / "tmp").mkdir()
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (tmp_path / "tmp" / f"aftertalk-audio-{os.getuid()}").symlink_to(elsewhere)
    with decode_audio(make_tone(tmp_path / "a.wav")) as audio:
        assert audio.path is not None and audio.path.parent.parent == tmp_path / "tmp"
        assert audio.path.parent.name != f"aftertalk-audio-{os.getuid()}"
        assert stat.S_IMODE(audio.path.parent.stat().st_mode) == 0o700
    assert list(elsewhere.iterdir()) == []


def test_an_unusable_temp_directory_is_internal(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def broken() -> tuple[Path, bool]:
        raise OSError("disk full")

    monkeypatch.setattr(decode, "_audio_dir", broken)
    with pytest.raises(EngineError) as info:
        decode_audio(make_tone(tmp_path / "a.wav"))
    assert info.value.code == "internal" and info.value.__context__ is None
