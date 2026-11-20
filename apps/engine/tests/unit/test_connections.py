import pytest
from pydantic import ValidationError

from aftertalk.models import LLMConnection, ModelTiers, SpeechConnection
from aftertalk.models.connections import reveal

KEY = "sk-super-secret-123"


def llm(**kw):
    base = {"adapter": "openai-compatible", "base_url": "https://api.openai.com/v1", "model": "gpt-x"}
    return LLMConnection(**{**base, **kw})


@pytest.mark.parametrize("path", ["chat/completions", "completions", "audio/transcriptions", "models", "responses"])
def test_resource_path_rejected(path: str) -> None:
    with pytest.raises(ValidationError, match="version path"):
        llm(base_url=f"https://x.test/v1/{path}")
    with pytest.raises(ValidationError, match="version path"):
        SpeechConnection(base_url=f"https://x.test/v1/{path.upper()}/", model="m")


def test_trailing_slash_stripped() -> None:
    assert llm(base_url="http://whisper:8000/v1/").base_url == "http://whisper:8000/v1"
    assert SpeechConnection(base_url="http://whisper:8000/v1/", model="m").base_url == "http://whisper:8000/v1"


def test_base_url_required_for_openai_compatible() -> None:
    with pytest.raises(ValidationError, match="base_url"):
        LLMConnection(adapter="openai-compatible", model="m")
    assert LLMConnection(adapter="anthropic", model="m").base_url is None
    assert LLMConnection(adapter="google", model="m").base_url is None


def test_base_url_kept_verbatim_without_slash() -> None:
    assert llm(base_url=" http://localhost:11434 ").base_url == "http://localhost:11434"


@pytest.mark.parametrize(
    "url", ["https://u:pw@x.test/v1", "https://x.test/v1?a=1", "https://x.test/v1#f", "ftp://x.test/v1", "nonsense"]
)
def test_base_url_rejected_without_echo(url: str) -> None:
    with pytest.raises(ValidationError) as e:
        llm(base_url=url)
    assert "pw" not in str(e.value) and url not in str(e.value)


def test_base_url_schema_is_uri_string() -> None:
    prop = LLMConnection.model_json_schema()["properties"]["base_url"]
    flat = str(prop)
    assert "'format': 'uri'" in flat and "'type': 'string'" in flat


def test_errors_hide_input() -> None:
    with pytest.raises(ValidationError) as e:
        LLMConnection.model_validate(
            {"adapter": "anthropic", "model": "m", "api_key": "sk-LEAK", "bogus": 1, "base_url": "https://u:pw@x.test"}
        )
    assert "sk-LEAK" not in str(e.value) and "pw@" not in str(e.value)


def test_preset_only_with_openai_compatible() -> None:
    assert llm(preset="groq").preset == "groq"
    with pytest.raises(ValidationError, match="preset"):
        LLMConnection(adapter="anthropic", preset="groq", model="m")


@pytest.mark.parametrize(
    "name",
    [
        "Authorization",
        "x-api-key",
        "API-KEY",
        "X-Goog-Api-Key",
        "Proxy-Authorization",
        "Cookie",
        "Ocp-Apim-Subscription-Key",
    ],
)
def test_forbidden_headers(name: str) -> None:
    with pytest.raises(ValidationError, match="api_key"):
        llm(extra_headers={name: "v"})
    assert llm(extra_headers={"X-Org": "v"}).extra_headers["X-Org"].get_secret_value() == "v"


def test_model_stripped_and_non_empty() -> None:
    assert llm(model="  gpt  ").model == "gpt"
    with pytest.raises(ValidationError):
        llm(model="   ")


def test_frozen_and_extra_forbidden() -> None:
    c = llm()
    with pytest.raises(ValidationError):
        c.model = "other"  # type: ignore[misc]
    with pytest.raises(ValidationError):
        llm(bogus=1)


def test_defaults_and_context_window() -> None:
    c = llm()
    assert c.output_mode == "auto" and c.api_key is None and c.context_window is None
    with pytest.raises(ValidationError):
        llm(context_window=0)


def test_tier_fallback() -> None:
    d, f = llm(model="d"), llm(model="f")
    tiers = ModelTiers(default=d, fast=f)
    assert tiers.resolve("fast") is f
    assert tiers.resolve("smart") is d
    assert tiers.resolve("default") is d


def test_key_never_leaks() -> None:
    c = llm(api_key=KEY)
    s = SpeechConnection(base_url="https://x.test/v1", api_key=KEY, model="m")
    t = ModelTiers(default=c)
    for obj in (c, s, t):
        assert KEY not in repr(obj)
        assert KEY not in str(obj)
        assert KEY not in obj.model_dump_json()
        assert KEY not in str(obj.model_dump())
    assert c.api_key.get_secret_value() == KEY


def test_speech_defaults() -> None:
    s = SpeechConnection(base_url="https://x.test/v1", model="m")
    assert s.adapter == "openai-compatible" and s.audio_format == "flac"


def test_api_key_stripped_and_empty_rejected() -> None:
    assert llm(api_key=" k\n").api_key.get_secret_value() == "k"
    with pytest.raises(ValidationError, match="api_key is empty; leave it out for a server without a key"):
        llm(api_key=" \n")
    with pytest.raises(ValidationError, match="masked placeholder"):
        llm(api_key="**********")
    with pytest.raises(ValidationError):
        llm(extra_headers={"X-Org": "***"})
    with pytest.raises(ValidationError):
        llm(extra_headers={"X-Org": " "})


def test_reveal_round_trip() -> None:
    c = llm(api_key=KEY, extra_headers={"X-Org": "org-secret"})
    assert LLMConnection.model_validate(reveal(c)) == c
    masked = c.model_dump(mode="json")
    assert masked["api_key"] == "**********" and masked["extra_headers"]["X-Org"] == "**********"
    with pytest.raises(ValidationError):
        LLMConnection.model_validate(masked)
    t = ModelTiers(default=c)
    assert ModelTiers.model_validate(reveal(t)) == t


def test_azure_api_version() -> None:
    assert llm(preset="azure", api_version="2024-06-01").api_version == "2024-06-01"
    with pytest.raises(ValidationError, match="api_version"):
        llm(preset="azure")
    with pytest.raises(ValidationError, match="api_version"):
        llm(preset="groq", api_version="x")
    with pytest.raises(ValidationError, match="api_version"):
        llm(api_version="x")


def test_resolve_unknown_tier() -> None:
    with pytest.raises(ValueError, match="tier"):
        ModelTiers(default=llm()).resolve("huge")  # type: ignore[arg-type]
