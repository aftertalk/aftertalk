from collections.abc import Iterator

import pytest
from fake_llm import FakeLLM
from fake_speech import FakeSpeech
from pydantic_ai import models

# No test may reach a real model: a test that talks to the local fake server opts in with `fake_llm`.
models.ALLOW_MODEL_REQUESTS = False


@pytest.fixture(autouse=True)
def engine_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENGINE_CALLBACK_SECRET", "test-callback-secret")
    monkeypatch.delenv("BLOCK_PRIVATE_ADDRESSES", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)


@pytest.fixture
def allow_requests() -> Iterator[None]:
    """For a test that sends requests to a local server (never a real provider)."""
    with models.override_allow_model_requests(True):
        yield


@pytest.fixture
def fake_llm(allow_requests: None) -> Iterator[FakeLLM]:
    """A local OpenAI-compatible server on 127.0.0.1."""
    server = FakeLLM()
    server.start()
    yield server
    server.stop()


@pytest.fixture
def fake_speech(allow_requests: None) -> Iterator[FakeSpeech]:
    """A local OpenAI-compatible transcription server on 127.0.0.1."""
    server = FakeSpeech()
    server.start()
    yield server
    server.stop()
