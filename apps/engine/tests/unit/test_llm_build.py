import sys
from typing import Any

import httpx2
import pytest
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.google import GoogleModel
from pydantic_ai.models.openai import OpenAIChatModel

from aftertalk.models import LLMConnection
from aftertalk.models.errors import EngineError
from aftertalk.providers import llm
from aftertalk.providers.llm import PRESET_PROFILES, build_model, fingerprint, open_model
from aftertalk.providers.net import make_client


def conn(**kw: Any) -> LLMConnection:
    base: dict[str, Any] = {"adapter": "openai-compatible", "base_url": "https://llm.example.com/v1", "model": "m1"}
    return LLMConnection.model_validate({**base, **kw})


@pytest.fixture
async def client():
    async with make_client(block_private=False) as c:
        yield c


def openai_base(model: OpenAIChatModel) -> str:
    return str(model._provider.client.base_url)  # type: ignore[attr-defined]


@pytest.mark.parametrize(
    ("preset", "provider_name"),
    [
        (None, "openai-compatible"),
        ("openai", "openai"),
        ("groq", "groq"),
        ("vllm", "vllm"),
        ("ollama", "ollama"),
        ("openrouter", "openrouter"),
        ("litellm", "litellm"),
    ],
)
def test_openai_compatible_presets(client: httpx2.AsyncClient, preset: str | None, provider_name: str) -> None:
    name = "openai/m1" if preset == "openrouter" else "m1"  # OpenRouter names carry the vendor
    model = build_model(conn(preset=preset, api_key="sk-x", model=name), http_client=client)
    assert isinstance(model, OpenAIChatModel)
    assert model.model_name == name
    assert model._provider.name == provider_name  # type: ignore[attr-defined]
    assert openai_base(model).rstrip("/").endswith("llm.example.com/v1") or provider_name == "openrouter"
    assert model._provider.client.api_key == "sk-x"  # type: ignore[attr-defined]
    assert model._provider.client._client is client  # type: ignore[attr-defined]


def test_openrouter_uses_the_given_base_url(client: httpx2.AsyncClient) -> None:
    model = build_model(conn(preset="openrouter", api_key="k", model="openai/m1"), http_client=client)
    assert openai_base(model).startswith("https://llm.example.com/v1")


def test_azure(client: httpx2.AsyncClient) -> None:
    c = conn(preset="azure", base_url="https://res.openai.azure.com", api_version="2024-10-21", api_key="az")
    model = build_model(c, http_client=client)
    assert isinstance(model, OpenAIChatModel)
    assert model._provider.name == "azure"  # type: ignore[attr-defined]
    assert "res.openai.azure.com" in openai_base(model)
    assert model._provider.client._api_version == "2024-10-21"  # type: ignore[attr-defined]


def test_anthropic(client: httpx2.AsyncClient) -> None:
    model = build_model(
        conn(adapter="anthropic", base_url="https://proxy.example.com", api_key="ak"), http_client=client
    )
    assert isinstance(model, AnthropicModel)
    assert model.model_name == "m1"
    assert "proxy.example.com" in str(model._provider.client.base_url)  # type: ignore[attr-defined]
    assert model._provider.client.api_key == "ak"  # type: ignore[attr-defined]


def test_google(client: httpx2.AsyncClient) -> None:
    model = build_model(conn(adapter="google", base_url=None, api_key="gk"), http_client=client)
    assert isinstance(model, GoogleModel)
    assert model.model_name == "m1"


def test_extra_headers_go_on_the_http_client(client: httpx2.AsyncClient) -> None:
    c = conn(extra_headers={"X-Org": "org-1", "HTTP-Referer": "https://r"})
    build_model(c, http_client=client)
    assert client.headers["X-Org"] == "org-1" and client.headers["HTTP-Referer"] == "https://r"


def test_keyless_connection_sends_a_dummy_key_never_the_environment_one(
    client: httpx2.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-real-user-key")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-real-anthropic")
    for c in (conn(), conn(preset="ollama"), conn(preset="openai"), conn(adapter="anthropic", base_url=None)):
        model = build_model(c, http_client=client)
        key = model._provider.client.api_key  # type: ignore[attr-defined]
        assert key == llm.KEYLESS_PLACEHOLDER
        assert "real" not in key


def test_generic_profile_disables_strict_tools_and_context_window_is_applied(client: httpx2.AsyncClient) -> None:
    assert PRESET_PROFILES[None] == {"openai_supports_strict_tool_definition": False}
    model = build_model(conn(context_window=32000), http_client=client)
    assert model.profile.get("openai_supports_strict_tool_definition") is False
    assert model.profile.get("context_window") == 32000
    plain = build_model(conn(preset="openai"), http_client=client)
    assert plain.profile.get("openai_supports_strict_tool_definition", True) is True
    assert plain.profile.get("context_window") is None


@pytest.mark.parametrize(
    ("adapter", "module", "extra"), [("anthropic", "anthropic", "anthropic"), ("google", "google", "google")]
)
def test_missing_extra_is_an_internal_error_naming_the_extra(
    client: httpx2.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    adapter: str,
    module: str,
    extra: str,
) -> None:
    monkeypatch.setitem(sys.modules, f"pydantic_ai.models.{module}", None)
    monkeypatch.setitem(sys.modules, f"pydantic_ai.providers.{module}", None)
    caplog.set_level("DEBUG", logger="aftertalk")
    with pytest.raises(EngineError) as info:
        build_model(conn(adapter=adapter, base_url=None, api_key="k"), http_client=client)
    assert info.value.code == "internal"
    record = next(r for r in caplog.records if extra in r.getMessage())
    assert record.fields["error_code"] == "internal"  # type: ignore[attr-defined]
    assert "aftertalk[" in record.getMessage()


def test_fingerprint_is_stable_secret_dependent_and_does_not_leak() -> None:
    a = conn(api_key="sk-one")
    assert fingerprint(a) == fingerprint(conn(api_key="sk-one"))
    assert fingerprint(a) != fingerprint(conn(api_key="sk-two"))
    assert fingerprint(a) != fingerprint(conn(api_key="sk-one", model="other"))
    assert fingerprint(conn(extra_headers={"A": "1", "B": "2"})) == fingerprint(
        conn(extra_headers={"B": "2", "A": "1"})
    )
    assert "sk-one" not in fingerprint(a) and len(fingerprint(a)) == 64


async def test_open_model_closes_the_client() -> None:
    async with open_model(conn(), block_private=False) as model:
        http = model._provider.client._client  # type: ignore[attr-defined]
        assert not http.is_closed
    assert http.is_closed


async def test_open_model_closes_the_client_when_build_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    made: list[httpx2.AsyncClient] = []
    real = llm.make_client

    def spy(**kw: Any) -> httpx2.AsyncClient:
        made.append(real(**kw))
        return made[-1]

    monkeypatch.setattr(llm, "make_client", spy)
    monkeypatch.setitem(sys.modules, "pydantic_ai.models.anthropic", None)
    with pytest.raises(EngineError):
        async with open_model(conn(adapter="anthropic", base_url=None), block_private=False):
            pass
    assert made[0].is_closed


async def test_open_model_blocks_private_hosts_when_asked() -> None:
    from aftertalk.providers.net import BlockedAddressError

    async with open_model(conn(base_url="http://169.254.169.254/v1"), block_private=True) as model:
        http = model._provider.client._client  # type: ignore[attr-defined]
        with pytest.raises(BlockedAddressError):
            await http.get("http://169.254.169.254/v1/models")


def test_a_model_name_the_preset_rejects_is_a_model_not_found_error(client: httpx2.AsyncClient) -> None:
    with pytest.raises(EngineError) as info:
        build_model(conn(preset="openrouter", api_key="k", model="no-vendor-prefix"), http_client=client)
    assert info.value.code == "provider_model_not_found"
