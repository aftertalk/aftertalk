import gc
import math
import weakref
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
import pytest
from audio_tools import make_tone
from fake_speech import FakeSpeech, Forced, error_body, reply

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
