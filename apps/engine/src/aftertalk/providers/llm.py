"""Turn an `LLMConnection` into a PydanticAI model.

`build_model` is the only place that calls `get_secret_value()` on an LLM key or header.
"""

import hashlib
import json
import os
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager, contextmanager
from typing import Any
from urllib.parse import urlsplit

import httpx2
from pydantic_ai.exceptions import UserError
from pydantic_ai.models import Model
from pydantic_ai.profiles import ModelProfile

from aftertalk.logging import log
from aftertalk.models.connections import LLMConnection, reveal
from aftertalk.models.errors import EngineError
from aftertalk.providers.net import make_client
from aftertalk.settings import get_cli_settings

# The OpenAI SDK refuses to start without a key and, when none is given, reads OPENAI_API_KEY from the
# environment, which would send the operator's real OpenAI key to whatever server the connection points at.
# A keyless own server (Ollama, vLLM) therefore gets this placeholder, never a real key.
KEYLESS_PLACEHOLDER = "aftertalk-keyless"

# Default hosts of the native adapters, passed explicitly so that no environment variable can redirect a key.
ANTHROPIC_BASE_URL = "https://api.anthropic.com"
GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com/"

# Safe defaults per preset, applied over what PydanticAI knows. Not part of the schema: a connection cannot
# change them. `None` is the generic OpenAI-compatible server, which may not accept `strict` in tool schemas.
PRESET_PROFILES: dict[str | None, dict[str, Any]] = {
    None: {"openai_supports_strict_tool_definition": False},
}


def _missing_extra(extra: str) -> EngineError:
    log("error", f"missing optional dependency: install aftertalk[{extra}]", error_code="internal")
    return EngineError("internal")


def _profile(conn: LLMConnection) -> ModelProfile | None:
    profile: dict[str, Any] = {}
    if conn.adapter == "openai-compatible":
        profile.update(PRESET_PROFILES.get(conn.preset, {}))
    if conn.context_window is not None:
        profile["context_window"] = conn.context_window
    return profile or None  # type: ignore[return-value]


def _openai_compatible(conn: LLMConnection, key: str, http_client: httpx2.AsyncClient) -> Any:
    from pydantic_ai.providers.litellm import LiteLLMProvider
    from pydantic_ai.providers.ollama import OllamaProvider
    from pydantic_ai.providers.openai import OpenAIProvider
    from pydantic_ai.providers.openai_compatible import OpenAICompatibleProvider
    from pydantic_ai.providers.openrouter import OpenRouterProvider
    from pydantic_ai.providers.vllm import VLLMProvider

    base_url = conn.base_url
    assert base_url is not None  # LLMConnection requires it for this adapter
    match conn.preset:
        case "openai":
            return OpenAIProvider(base_url=base_url, api_key=key, http_client=http_client)
        case "ollama":
            return OllamaProvider(base_url=_ollama_base_url(base_url), api_key=key, http_client=http_client)
        case "vllm":
            return VLLMProvider(base_url=base_url, api_key=key, http_client=http_client)
        case "openrouter":
            return OpenRouterProvider(base_url=base_url, api_key=key, http_client=http_client)
        case "litellm":
            return LiteLLMProvider(api_base=base_url, api_key=key, http_client=http_client)
        case "azure":
            from pydantic_ai.providers.azure import AzureProvider

            return AzureProvider(
                azure_endpoint=base_url, api_version=conn.api_version, api_key=key, http_client=http_client
            )
        case "groq":
            # Groq's PydanticAI provider still uses the legacy httpx client and its own SDK; its API is
            # OpenAI-compatible, so it goes through the same route as any other server.
            return OpenAICompatibleProvider("groq", base_url=base_url, api_key=key, http_client=http_client)
        case _:
            return OpenAICompatibleProvider(
                "openai-compatible", base_url=base_url, api_key=key, http_client=http_client
            )


def build_model(conn: LLMConnection, *, http_client: httpx2.AsyncClient) -> Model:
    """Build the model for a connection. The caller owns `http_client` and closes it (see `open_model`)."""
    key = conn.api_key.get_secret_value() if conn.api_key is not None else KEYLESS_PLACEHOLDER
    headers = {name: value.get_secret_value() for name, value in conn.extra_headers.items()}
    if headers:
        http_client.headers.update(headers)
    error: EngineError | None = None
    model: Model | None = None
    try:
        with _without_sdk_environment():
            model = _build(conn, key, http_client)
    except _MissingExtra as missing:
        error = _missing_extra(missing.extra)
    except (UserError, ValueError):
        # A bad setting for this provider, for example an OpenRouter model name without its vendor prefix.
        # The message is neither logged nor passed on: it can quote the connection.
        log("error", "connection settings rejected by the provider preset", error_code="provider_config_invalid")
        error = EngineError("provider_config_invalid")
    if error is not None:
        raise error  # raised outside the except blocks, so nothing is chained to it
    assert model is not None
    return model


class _MissingExtra(Exception):
    def __init__(self, extra: str) -> None:
        super().__init__(extra)
        self.extra = extra


# The SDKs read these from the environment when a setting is missing: other keys, organisations, base URLs,
# extra headers, Azure and Vertex settings. A connection must send exactly what it configures, so they are hidden
# while the clients are built (the SDKs read them in their constructors, not per request).
_SDK_ENV_PREFIXES = (
    "OPENAI_",
    "ANTHROPIC_",
    "GOOGLE_",
    "GEMINI_",
    "AZURE_",
    "OPENROUTER_",
    "LITELLM_",
    "OLLAMA_",
    "VLLM_",
    "GROQ_",
)


@contextmanager
def _without_sdk_environment() -> Iterator[None]:
    # Not thread-safe against other threads reading these variables at the same moment; nothing in the engine
    # reads them, and build_model is synchronous and short.
    hidden = {k: v for k, v in os.environ.items() if k.upper().startswith(_SDK_ENV_PREFIXES)}
    for name in hidden:
        del os.environ[name]
    try:
        yield
    finally:
        os.environ.update(hidden)


def _ollama_base_url(base_url: str) -> str:
    """Ollama serves its OpenAI-compatible API under /v1; the bare address (http://localhost:11434) is a 404."""
    return base_url if urlsplit(base_url).path.rstrip("/").endswith("/v1") else base_url.rstrip("/") + "/v1"


def _build(conn: LLMConnection, key: str, http_client: httpx2.AsyncClient) -> Model:
    profile = _profile(conn)

    if conn.adapter == "anthropic":
        try:
            from pydantic_ai.models.anthropic import AnthropicModel
            from pydantic_ai.providers.anthropic import AnthropicProvider
        except ImportError:
            raise _MissingExtra("anthropic") from None
        base = conn.base_url or ANTHROPIC_BASE_URL  # explicit: the SDK would read ANTHROPIC_BASE_URL
        provider = AnthropicProvider(api_key=key, base_url=base, http_client=http_client)
        return AnthropicModel(conn.model, provider=provider, profile=profile)

    if conn.adapter == "google":
        try:
            from pydantic_ai.models.google import GoogleModel
            from pydantic_ai.providers.google import GoogleProvider
        except ImportError:
            raise _MissingExtra("google") from None
        base = conn.base_url or GOOGLE_BASE_URL  # explicit: the SDK would read GOOGLE_GEMINI_BASE_URL
        google = GoogleProvider(api_key=key, base_url=base, http_client=http_client)
        return GoogleModel(conn.model, provider=google, profile=profile)

    from pydantic_ai.models.openai import OpenAIChatModel

    # Chat Completions for every OpenAI-compatible server, including OpenAI itself: it is the one API they all share.
    provider = _openai_compatible(conn, key, http_client)
    # `organization` and `project` come from the environment when unset; the environment is hidden, but
    # clear them anyway so that no header can be sent.
    sdk_client = getattr(provider, "client", None)
    if sdk_client is not None:
        sdk_client.organization = None
        sdk_client.project = None
    return OpenAIChatModel(conn.model, provider=provider, profile=profile)


def fingerprint(conn: LLMConnection) -> str:
    """A cache key that changes with any field, secrets included. Never log it."""
    return hashlib.sha256(json.dumps(reveal(conn), sort_keys=True).encode()).hexdigest()


@asynccontextmanager
async def open_model(conn: LLMConnection, *, block_private: bool) -> AsyncIterator[Model]:
    """Build the model with its own HTTP client and always close the client."""
    client = make_client(block_private=block_private, proxy=get_cli_settings().provider_proxy)
    try:
        yield build_model(conn, http_client=client)
    finally:
        await client.aclose()
