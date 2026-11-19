import pytest
from fake_speech import FakeSpeech
from pydantic import ValidationError
from test_speech_openai import audio

from aftertalk.models.connections import LLMConnection, SpeechConnection
from aftertalk.models.errors import EngineError
from aftertalk.models.usage import StepUsage
from aftertalk.providers.llm import open_model
from aftertalk.providers.net import make_client
from aftertalk.providers.speech.openai_compatible import OpenAICompatibleSpeech, open_speech
from aftertalk.settings import get_cli_settings

# ---- extra_headers ----


def speech(**headers: str) -> SpeechConnection:
    return SpeechConnection(base_url="http://h/v1", model="m", extra_headers=headers)


def llm(**headers: str) -> LLMConnection:
    return LLMConnection(adapter="openai-compatible", base_url="http://h/v1", model="m", extra_headers=headers)


@pytest.mark.parametrize("make", [speech, llm])
@pytest.mark.parametrize("name", ["Host", "content-type", "Content-Length", "TRANSFER-ENCODING"])
def test_reserved_headers_cannot_be_overridden(make, name: str) -> None:
    with pytest.raises(ValidationError, match="cannot be overridden"):
        make(**{name: "x"})


@pytest.mark.parametrize("make", [speech, llm])
@pytest.mark.parametrize("name", ["Bad Name", "X:Y", "X\r\nY", "Zażółć", "a/b", "(x)"])
def test_header_names_must_be_http_tokens(make, name: str) -> None:
    with pytest.raises(ValidationError, match="header names"):
        make(**{name: "x"})


@pytest.mark.parametrize("make", [speech, llm])
@pytest.mark.parametrize("value", ["a\r\nX-Evil: 1", "a\nb", "a\rb", "zażółćłć中"])
def test_header_values_must_be_latin1_without_line_breaks(make, value: str) -> None:
    with pytest.raises(ValidationError, match="header 'X-Org' has"):
        make(**{"X-Org": value})


def test_ordinary_headers_still_work() -> None:
    conn = speech(**{"X-Tenant": "acme", "OpenAI-Organization": "org-1", "x_custom.v2": "café"})
    assert conn.extra_headers["X-Tenant"].get_secret_value() == "acme"


# ---- connection and usage fields ----


def test_upload_limit_field() -> None:
    assert SpeechConnection(base_url="http://h/v1", model="m").max_upload_mb == 25
    assert SpeechConnection(base_url="http://h/v1", model="m", max_upload_mb=100).max_upload_mb == 100
    for bad in (0, -1):
        with pytest.raises(ValidationError):
            SpeechConnection(base_url="http://h/v1", model="m", max_upload_mb=bad)


def test_adapter_limit_follows_the_connection() -> None:
    conn = SpeechConnection(base_url="http://h/v1", model="m", max_upload_mb=3)
    assert (
        OpenAICompatibleSpeech(conn, make_client(block_private=False)).capabilities.max_upload_bytes == 3 * 1024 * 1024
    )


def test_usage_speech_format() -> None:
    assert StepUsage(step="transcribe").speech_format is None
    assert StepUsage(step="transcribe", speech_format="verbose_json_segments").speech_format == "verbose_json_segments"
    with pytest.raises(ValidationError):
        StepUsage(step="transcribe", speech_format="srt")  # type: ignore[arg-type]


# ---- proxies ----


async def test_proxy_variables_in_the_environment_are_ignored(
    fake_speech: FakeSpeech, monkeypatch: pytest.MonkeyPatch
) -> None:
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.setenv(name, "http://127.0.0.1:1")
    monkeypatch.delenv("NO_PROXY", raising=False)
    # the fake server is addressed directly, so a proxy from the environment would break the request
    direct = SpeechConnection(base_url=fake_speech.base_url, model="m")
    async with open_speech(direct, block_private=False) as provider:
        await provider.transcribe(audio(), language=None, prompt=None, deadline=None)
    assert fake_speech.seen[0].path == "/v1/audio/transcriptions"


async def test_the_explicit_proxy_is_used(fake_speech: FakeSpeech, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PROVIDER_PROXY", fake_speech.base_url.removesuffix("/v1"))
    assert get_cli_settings().provider_proxy is not None
    conn = SpeechConnection(base_url="http://speech.example.test/v1", model="m")
    async with open_speech(conn, block_private=False) as provider:
        await provider.transcribe(audio(), language=None, prompt=None, deadline=None)
    # a proxied plain-http request carries the full URL of the real target
    assert fake_speech.seen[0].path == "http://speech.example.test/v1/audio/transcriptions"


async def test_a_proxy_with_the_address_guard_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PROVIDER_PROXY", "http://127.0.0.1:3128")
    monkeypatch.setenv("BLOCK_PRIVATE_ADDRESSES", "true")
    conn = SpeechConnection(base_url="https://speech.example.test/v1", model="m")
    with pytest.raises(EngineError) as info:
        async with open_speech(conn, block_private=True):
            pass
    assert info.value.code == "provider_config_invalid" and not info.value.retryable
    with pytest.raises(EngineError) as info:
        async with open_model(llm(), block_private=True):
            pass
    assert info.value.code == "provider_config_invalid"


def test_make_client_proxy_rules() -> None:
    with pytest.raises(EngineError):
        make_client(block_private=True, proxy="http://127.0.0.1:3128")
    assert make_client(block_private=False, proxy="http://127.0.0.1:3128") is not None
    assert make_client(block_private=True) is not None
    assert make_client(block_private=False).trust_env is False


def test_no_proxy_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PROVIDER_PROXY", raising=False)
    assert get_cli_settings().provider_proxy is None
