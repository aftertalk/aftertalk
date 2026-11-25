import asyncio
import gc
import math
import weakref
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
import pytest
from audio_tools import make_stereo, make_tone, nonzero_runs
from fake_pyannote import FakePyannote
from fake_speech import FakeSpeech, Forced, error_body, reply

from aftertalk.audio import decode
from aftertalk.audio.decode import SAMPLE_RATE, DecodedAudio, open_decoded
from aftertalk.models.connections import SpeechConnection
from aftertalk.models.errors import EngineError
from aftertalk.pipeline import TranscribeOptions, transcribe_file
from aftertalk.pipeline import transcribe as transcribe_module
from aftertalk.providers.net import make_client
from aftertalk.providers.speech.openai_compatible import OpenAICompatibleSpeech


async def test_a_failed_window_leaves_no_map_of_the_decoded_audio(
    fake_speech: FakeSpeech, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No reference cycle keeps the map (and the unlinked temp file) alive until a cyclic GC pass."""
    path = make_tone(tmp_path / "talk.wav", seconds=12.0, rate=16000, channels=1)
    maps: list[weakref.ref[np.ndarray]] = []

    @asynccontextmanager
    async def watched(*args: object, **kwargs: object) -> AsyncIterator[DecodedAudio]:
        async with open_decoded(*args, **kwargs) as audio:  # type: ignore[arg-type]
            maps.append(weakref.ref(audio.samples))
            yield audio

    monkeypatch.setattr(transcribe_module, "open_decoded", watched)
    fake_speech.forced = [reply(["one"]), Forced(400, error_body())]
    conn = SpeechConnection.model_validate({"base_url": fake_speech.base_url, "model": "whisper-1"})
    window = math.ceil((5.0 * SAMPLE_RATE * 2 + 4096) * 1.01) + 2  # 5 s windows
    gc.collect()
    gc.disable()
    try:
        async with make_client(block_private=False) as client:
            speech = OpenAICompatibleSpeech(conn, client, retry_waits=(0.0, 0.0), max_upload_bytes=window)
            code = None
            try:
                await transcribe_file(path, speech, TranscribeOptions())
            except EngineError as err:
                code = err.code
        assert code is not None and len(fake_speech.seen) == 2
        assert len(maps) == 1 and maps[0]() is None
    finally:
        gc.enable()


def _watch(monkeypatch: pytest.MonkeyPatch, *, hold: bool = False) -> list[weakref.ref[np.ndarray]]:
    """Weak references to every decoded map the pipeline opens. `hold`: a reference to the map outlives the decode
    block's close() by a moment (as a slow worker thread could), so the file can only go in `retry_removals`."""
    maps: list[weakref.ref[np.ndarray]] = []

    @asynccontextmanager
    async def watched(*args: object, **kwargs: object) -> AsyncIterator[DecodedAudio]:
        held: list[np.ndarray] = []
        async with open_decoded(*args, **kwargs) as audio:  # type: ignore[arg-type]
            maps.append(weakref.ref(audio.samples))
            if hold:
                held.append(audio.samples)
            yield audio
        held.clear()

    monkeypatch.setattr(transcribe_module, "open_decoded", watched)
    return maps


async def _split(fake_speech: FakeSpeech, path: Path) -> None:
    conn = SpeechConnection.model_validate({"base_url": fake_speech.base_url, "model": "whisper-1"})
    async with make_client(block_private=False) as client:
        speech = OpenAICompatibleSpeech(conn, client, retry_waits=(0.0, 0.0))
        await transcribe_file(path, speech, TranscribeOptions(channels="split"), detector=nonzero_runs)


async def test_a_failed_split_window_leaves_no_map_of_the_decoded_audio(
    fake_speech: FakeSpeech, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = make_stereo(tmp_path / "call.wav", [(0.0, 2.0, 1000)], [(3.0, 4.0, 2000)], seconds=5.0)
    maps = _watch(monkeypatch)
    # The probe (channel 0's longer window) answers; the other channel's window fails.
    fake_speech.forced = [reply(["one"]), Forced(400, error_body())]
    gc.collect()
    gc.disable()
    try:
        with pytest.raises(EngineError):
            await _split(fake_speech, path)
        assert len(fake_speech.seen) == 2
        assert len(maps) == 1 and maps[0]() is None
    finally:
        gc.enable()


def _windows_unlink(
    monkeypatch: pytest.MonkeyPatch, *, hold: bool = False
) -> tuple[list[weakref.ref[np.ndarray]], list[Path]]:
    """Windows emulation: a temp PCM file cannot be unlinked while a map of it is alive (PermissionError)."""
    maps = _watch(monkeypatch, hold=hold)
    refused: list[Path] = []
    unlink = Path.unlink

    def guarded(self: Path, missing_ok: bool = False) -> None:
        for ref in maps:
            mapped = ref()
            alive = mapped is not None and Path(mapped.filename).resolve() == self.resolve()  # type: ignore[attr-defined]
            del mapped
            if alive:
                refused.append(self)
                raise PermissionError(13, "The process cannot access the file", str(self))
        unlink(self, missing_ok=missing_ok)

    monkeypatch.setattr(Path, "unlink", guarded)
    return maps, refused


def test_the_windows_emulation_refuses_a_mapped_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The emulation itself: a map kept alive past close() keeps the file until `retry_removals`."""
    maps, refused = _windows_unlink(monkeypatch)
    audio = decode.decode_audio(make_tone(tmp_path / "a.wav", seconds=1.0))
    held = audio.samples
    maps.append(weakref.ref(held))
    temp = audio.path
    assert temp is not None
    audio.close()
    assert refused == [temp] and temp.exists() and temp in decode._PENDING
    assert decode.retry_removals() == 1 and temp.exists()  # still mapped
    del held
    assert decode.retry_removals() == 0
    assert not temp.exists() and decode._PENDING == {}


def _remember_temps(monkeypatch: pytest.MonkeyPatch) -> list[Path]:
    """The temp PCM file of every decode."""
    temps: list[Path] = []
    real = decode.decode_audio

    def remember(*args: object, **kwargs: object) -> DecodedAudio:
        audio = real(*args, **kwargs)  # type: ignore[arg-type]
        assert audio.path is not None
        temps.append(audio.path)
        return audio

    monkeypatch.setattr(decode, "decode_audio", remember)
    return temps


@pytest.mark.parametrize("hold", [False, True], ids=["dropped", "held"])
@pytest.mark.parametrize("mode", ["mix", "split"])
async def test_on_windows_the_temp_file_is_gone_after_a_run_that_succeeds(
    fake_speech: FakeSpeech,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    mode: str,
    hold: bool,
) -> None:
    maps, refused = _windows_unlink(monkeypatch, hold=hold)
    temps = _remember_temps(monkeypatch)
    path = make_stereo(tmp_path / "call.wav", [(0.0, 3.0, 1000)], [(3.0, 6.0, 2000)], seconds=7.0)
    gc.collect()
    gc.disable()
    try:
        conn = SpeechConnection.model_validate({"base_url": fake_speech.base_url, "model": "whisper-1"})
        async with make_client(block_private=False) as client:
            speech = OpenAICompatibleSpeech(conn, client, retry_waits=(0.0, 0.0))
            result = await transcribe_file(
                path,
                speech,
                TranscribeOptions(channels=mode),
                detector=nonzero_runs,  # type: ignore[arg-type]
            )
        assert result.transcript.text
        assert len(maps) == 1 and maps[0]() is None
        assert len(temps) == 1 and not temps[0].exists()
        assert decode._PENDING == {}
        assert len(refused) == (1 if hold else 0)  # held: close() could not delete it, the end of the run did
    finally:
        gc.enable()


@pytest.mark.parametrize("hold", [False, True], ids=["dropped", "held"])
@pytest.mark.parametrize("mode", ["mix", "split"])
async def test_on_windows_the_temp_file_is_gone_after_a_run_that_fails(
    fake_speech: FakeSpeech,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    mode: str,
    hold: bool,
) -> None:
    maps, refused = _windows_unlink(monkeypatch, hold=hold)
    temps = _remember_temps(monkeypatch)
    path = make_stereo(tmp_path / "call.wav", [(0.0, 3.0, 1000)], [(3.0, 6.0, 2000)], seconds=7.0)
    fake_speech.always = Forced(401, error_body("bad key"))
    gc.collect()
    gc.disable()
    try:
        conn = SpeechConnection.model_validate({"base_url": fake_speech.base_url, "model": "whisper-1"})
        async with make_client(block_private=False) as client:
            speech = OpenAICompatibleSpeech(conn, client, retry_waits=(0.0, 0.0))
            with pytest.raises(EngineError) as info:
                await transcribe_file(
                    path,
                    speech,
                    TranscribeOptions(channels=mode),
                    detector=nonzero_runs,  # type: ignore[arg-type]
                )
        assert info.value.code == "provider_auth"
        del info
        assert len(maps) == 1 and maps[0]() is None
        assert len(temps) == 1 and not temps[0].exists()
        assert decode._PENDING == {}
        assert len(refused) == (1 if hold else 0)  # held: close() could not delete it, the end of the run did
    finally:
        gc.enable()


def test_a_pending_removal_in_a_fallback_directory_removes_the_directory_too(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(decode, "_PENDING", {})
    own_dir = tmp_path / "aftertalk-audio-fallback"
    own_dir.mkdir()
    temp = own_dir / "aftertalk-x.pcm"
    temp.write_bytes(b"\0" * 16)
    locked = [True]
    unlink = Path.unlink

    def guarded(self: Path, missing_ok: bool = False) -> None:
        if locked[0] and self == temp:
            raise PermissionError(13, "The process cannot access the file", str(self))
        unlink(self, missing_ok=missing_ok)

    monkeypatch.setattr(Path, "unlink", guarded)
    decode._remove(temp, own_dir)
    assert decode._PENDING == {temp: own_dir}
    assert temp.exists() and own_dir.exists()  # the directory waits for its file
    assert decode.retry_removals() == 1 and decode._PENDING == {temp: own_dir} and own_dir.exists()
    locked[0] = False
    assert decode.retry_removals() == 0
    assert not temp.exists() and not own_dir.exists() and decode._PENDING == {}


async def test_cancelling_a_run_still_retries_the_removals(
    fake_speech: FakeSpeech, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    retried: list[int] = []
    real = transcribe_module.retry_removals

    def counting() -> int:
        retried.append(1)
        return real()

    monkeypatch.setattr(transcribe_module, "retry_removals", counting)
    path = make_tone(tmp_path / "talk.wav", seconds=3.0, rate=16000, channels=1)
    fake_speech.stall = 3.0
    conn = SpeechConnection.model_validate({"base_url": fake_speech.base_url, "model": "whisper-1"})
    async with make_client(block_private=False) as client:
        speech = OpenAICompatibleSpeech(conn, client, retry_waits=(0.0, 0.0))
        task = asyncio.create_task(transcribe_file(path, speech, TranscribeOptions()))
        while not fake_speech.seen:
            await asyncio.sleep(0.01)
        assert retried == []
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert retried == [1]


# ---- diarization (mixed audio): the streamed upload holds no map past the run ----


async def _diarized(fake_speech: FakeSpeech, fake_pyannote: FakePyannote, path: Path) -> None:
    from aftertalk.models.connections import DiarizationConnection
    from aftertalk.providers.diarization.pyannote import PyannoteDiarization

    conn = SpeechConnection.model_validate({"base_url": fake_speech.base_url, "model": "whisper-1"})
    dconn = DiarizationConnection.model_validate({"base_url": fake_pyannote.base_url, "api_key": "k"})
    window = math.ceil((2.0 * SAMPLE_RATE * 2 + 4096) * 1.01) + 2  # 2 s windows
    async with make_client(block_private=False) as client:
        speech = OpenAICompatibleSpeech(conn, client, retry_waits=(0.0, 0.0), max_upload_bytes=window)
        diarizer = PyannoteDiarization(dconn, client, poll_interval=0.01, retry_waits=(0.0, 0.0))
        await transcribe_file(path, speech, TranscribeOptions(), diarizer=diarizer)


@pytest.mark.parametrize("outcome", ["success", "job failed", "window failed", "cancelled"])
@pytest.mark.parametrize("hold", [False, True], ids=["dropped", "held"])
async def test_on_windows_a_diarized_run_leaves_no_map_and_no_temp_file(
    fake_speech: FakeSpeech,
    fake_pyannote: FakePyannote,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    outcome: str,
    hold: bool,
) -> None:
    maps, _ = _windows_unlink(monkeypatch, hold=hold)
    temps = _remember_temps(monkeypatch)
    path = make_tone(tmp_path / "talk.wav", seconds=5.0, rate=16000, channels=1)
    fake_speech.forced = [reply(["one"]), reply(["two"]), reply(["three"])]
    if outcome == "job failed":
        fake_pyannote.statuses = ["running", "failed"]
    elif outcome == "window failed":
        fake_speech.forced = [reply(["one"])] + [Forced(500, error_body())] * 3
        fake_pyannote.statuses = ["running"]
    elif outcome == "cancelled":
        fake_pyannote.statuses = ["running"]
    gc.collect()
    gc.disable()
    try:
        if outcome == "success":
            await _diarized(fake_speech, fake_pyannote, path)
        elif outcome == "cancelled":
            task = asyncio.ensure_future(_diarized(fake_speech, fake_pyannote, path))
            async with asyncio.timeout(10):  # a regression fails the test instead of hanging it
                while not fake_pyannote.jobs:
                    await asyncio.sleep(0.01)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            del task
        else:
            with pytest.raises(EngineError):
                await _diarized(fake_speech, fake_pyannote, path)
        assert len(fake_pyannote.uploads) == 1
        assert len(maps) == 1 and maps[0]() is None
        assert len(temps) == 1 and not temps[0].exists()
        assert decode._PENDING == {}
    finally:
        gc.enable()
