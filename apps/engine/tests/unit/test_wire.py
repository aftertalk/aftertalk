"""What each adapter really puts on the wire, seen through a capturing transport (no network)."""

import json
from typing import Any

import httpx2
import pytest
from pydantic_ai import Agent

from aftertalk.models import LLMConnection
from aftertalk.providers.errors import to_engine_error
from aftertalk.providers.llm import build_model
from aftertalk.providers.net import make_client

KEY = "sk-wire-KEY-123"
LEAK = "LEAK-MARKER-9f3"

COMPLETION = {
    "id": "c1",
    "object": "chat.completion",
    "created": 1,
    "model": "m1",
    "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
}
ANTHROPIC = {
    "id": "msg_1",
    "type": "message",
    "role": "assistant",
    "model": "m1",
    "content": [{"type": "text", "text": "ok"}],
    "stop_reason": "end_turn",
    "usage": {"input_tokens": 1, "output_tokens": 1},
}
GOOGLE = {
    "candidates": [{"content": {"role": "model", "parts": [{"text": "ok"}]}, "finishReason": "STOP"}],
    "usageMetadata": {"promptTokenCount": 1, "candidatesTokenCount": 1, "totalTokenCount": 2},
}


def conn(**kw: Any) -> LLMConnection:
    base: dict[str, Any] = {"adapter": "openai-compatible", "base_url": "https://llm.example.com/v1", "model": "m1"}
    return LLMConnection.model_validate({**base, "api_key": KEY, **kw})


def body_for(c: LLMConnection) -> dict[str, Any]:
    return {"anthropic": ANTHROPIC, "google": GOOGLE}.get(c.adapter, COMPLETION)


class Wire:
    def __init__(self, c: LLMConnection, *, status: int = 200, headers: dict[str, str] | None = None) -> None:
        self.seen: list[httpx2.Request] = []
        self.bodies: list[bytes] = []

        def handler(request: httpx2.Request) -> httpx2.Response:
            self.seen.append(request)
            self.bodies.append(request.content)
            return httpx2.Response(status, json=body_for(c), headers=headers)

        self.client = make_client(block_private=False, inner=httpx2.MockTransport(handler))
        self.conn = c

    async def call(self) -> str:
        model = build_model(self.conn, http_client=self.client)
        result = await Agent(model).run("hi")
        return result.output

    @property
    def request(self) -> httpx2.Request:
        return self.seen[0]

    def everything(self, request: httpx2.Request) -> str:
        parts = [str(request.url), *(f"{k}: {v}" for k, v in request.headers.items()), request.content.decode()]
        return "\n".join(parts)


# (connection settings, host, path, header carrying the key, expected header value)
CASES = [
    (dict(), "llm.example.com", "/v1/chat/completions", "authorization", f"Bearer {KEY}"),
    (dict(preset="openai"), "llm.example.com", "/v1/chat/completions", "authorization", f"Bearer {KEY}"),
    (dict(preset="groq"), "llm.example.com", "/v1/chat/completions", "authorization", f"Bearer {KEY}"),
    (dict(preset="vllm"), "llm.example.com", "/v1/chat/completions", "authorization", f"Bearer {KEY}"),
    (dict(preset="litellm"), "llm.example.com", "/v1/chat/completions", "authorization", f"Bearer {KEY}"),
    (
        dict(preset="ollama", base_url="http://ollama.example.com:11434"),
        "ollama.example.com",
        "/v1/chat/completions",
        "authorization",
        f"Bearer {KEY}",
    ),
    (
        dict(preset="ollama", base_url="http://ollama.example.com:11434/v1"),
        "ollama.example.com",
        "/v1/chat/completions",
        "authorization",
        f"Bearer {KEY}",
    ),
    (
        dict(preset="openrouter", model="openai/m1", base_url="https://or.example.com/api/v1"),
        "or.example.com",
        "/api/v1/chat/completions",
        "authorization",
        f"Bearer {KEY}",
    ),
    (
        dict(adapter="anthropic", base_url=None),
        "api.anthropic.com",
        "/v1/messages",
        "authorization",
        f"Bearer {KEY}",
    ),
    (
        dict(adapter="google", base_url=None),
        "generativelanguage.googleapis.com",
        "/v1beta/models/m1:generateContent",
        "x-goog-api-key",
        KEY,
    ),
]


@pytest.mark.parametrize(
    ("settings", "host", "path", "header", "value"), CASES, ids=[str(i) for i in range(len(CASES))]
)
async def test_url_and_auth_header(
    allow_requests: None, settings: dict[str, Any], host: str, path: str, header: str, value: str
) -> None:
    wire = Wire(conn(**settings))
    assert await wire.call() == "ok"
    assert len(wire.seen) == 1
    assert wire.request.url.host == host
    assert wire.request.url.path == path
    assert wire.request.headers[header] == value


async def test_azure_with_api_version(allow_requests: None) -> None:
    wire = Wire(conn(preset="azure", base_url="https://res.openai.azure.com", api_version="2024-10-21"))
    await wire.call()
    assert wire.request.url.host == "res.openai.azure.com"
    assert wire.request.url.path == "/openai/deployments/m1/chat/completions"
    assert wire.request.url.params["api-version"] == "2024-10-21"
    assert wire.request.headers["api-key"] == KEY


async def test_azure_v1_needs_no_api_version(allow_requests: None) -> None:
    wire = Wire(conn(preset="azure", base_url="https://res.openai.azure.com/openai/v1"))
    await wire.call()
    assert wire.request.url.path == "/openai/v1/chat/completions"
    assert "api-version" not in wire.request.url.params
    assert KEY in wire.request.headers.get("api-key", "") + wire.request.headers.get("authorization", "")


def test_azure_without_version_needs_the_v1_path() -> None:
    with pytest.raises(ValueError, match="api_version"):
        conn(preset="azure", base_url="https://res.openai.azure.com")
    with pytest.raises(ValueError, match="api_version"):
        conn(preset="azure", base_url="https://res.openai.azure.com/openai")
    with pytest.raises(ValueError, match="api_version"):
        conn(preset="groq", api_version="2024-10-21")


# Every variable the SDKs are known to read, set to a marker. None of them may reach the wire.
LEAKY_ENV = {
    "OPENAI_API_KEY": f"{LEAK}-openai-key",
    "OPENAI_ORG_ID": f"{LEAK}-org",
    "OPENAI_PROJECT_ID": f"{LEAK}-project",
    "OPENAI_BASE_URL": f"https://{LEAK.lower()}-openai.example.net/v1",
    "OPENAI_CUSTOM_HEADERS": f"X-Leak-Openai: {LEAK}",
    "OPENAI_WEBHOOK_SECRET": f"{LEAK}-webhook",
    "OPENAI_API_VERSION": f"{LEAK}-version",
    "OPENAI_ADMIN_KEY": f"{LEAK}-admin",
    "ANTHROPIC_API_KEY": f"{LEAK}-anthropic-key",
    "ANTHROPIC_AUTH_TOKEN": f"{LEAK}-anthropic-token",
    "ANTHROPIC_BASE_URL": f"https://{LEAK.lower()}-anthropic.example.net",
    "ANTHROPIC_CUSTOM_HEADERS": f"X-Leak-Anthropic: {LEAK}",
    "ANTHROPIC_PROFILE": f"{LEAK}-profile",
    "GOOGLE_API_KEY": f"{LEAK}-google-key",
    "GEMINI_API_KEY": f"{LEAK}-gemini-key",
    "GOOGLE_GEMINI_BASE_URL": f"https://{LEAK.lower()}-google.example.net",
    "GOOGLE_GENAI_USE_VERTEXAI": "true",
    "GOOGLE_CLOUD_PROJECT": f"{LEAK}-gcp-project",
    "GOOGLE_CLOUD_LOCATION": f"{LEAK}-gcp-location",
    "AZURE_OPENAI_API_KEY": f"{LEAK}-azure-key",
    "AZURE_OPENAI_AD_TOKEN": f"{LEAK}-azure-token",
    "AZURE_OPENAI_ENDPOINT": f"https://{LEAK.lower()}-azure.example.net",
    "OPENROUTER_API_KEY": f"{LEAK}-openrouter",
    "OLLAMA_BASE_URL": f"http://{LEAK.lower()}-ollama.example.net",
    "VLLM_BASE_URL": f"http://{LEAK.lower()}-vllm.example.net",
}

ADAPTERS = [
    dict(),
    dict(preset="openai"),
    dict(preset="vllm"),
    dict(preset="ollama", base_url="http://ollama.example.com:11434"),
    dict(preset="openrouter", model="openai/m1"),
    dict(preset="litellm"),
    dict(preset="groq"),
    dict(preset="azure", base_url="https://res.openai.azure.com", api_version="2024-10-21"),
    dict(preset="azure", base_url="https://res.openai.azure.com/openai/v1"),
    dict(adapter="anthropic", base_url=None),
    dict(adapter="google", base_url=None),
]


@pytest.mark.parametrize("settings", ADAPTERS, ids=[str(i) for i in range(len(ADAPTERS))])
async def test_no_environment_reaches_the_wire(
    allow_requests: None, monkeypatch: pytest.MonkeyPatch, settings: dict[str, Any]
) -> None:
    for name, value in LEAKY_ENV.items():
        monkeypatch.setenv(name, value)
    wire = Wire(conn(**settings))
    await wire.call()
    assert len(wire.seen) == 1
    sent = wire.everything(wire.request)
    assert LEAK not in sent and LEAK.lower() not in sent
    assert KEY in sent  # the configured key is what goes out
    assert "openai-organization" not in wire.request.headers and "openai-project" not in wire.request.headers
    import os

    assert os.environ["OPENAI_API_KEY"] == LEAKY_ENV["OPENAI_API_KEY"]  # restored after the build


async def test_keyless_connection_sends_only_the_placeholder(
    allow_requests: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    for name, value in LEAKY_ENV.items():
        monkeypatch.setenv(name, value)
    c = LLMConnection.model_validate(
        {"adapter": "openai-compatible", "base_url": "https://llm.example.com/v1", "model": "m1"}
    )
    wire = Wire(c)
    await wire.call()
    assert LEAK not in wire.everything(wire.request)


@pytest.mark.parametrize("settings", ADAPTERS[:1] + ADAPTERS[-2:], ids=["openai", "anthropic", "google"])
async def test_redirects_are_not_followed(allow_requests: None, settings: dict[str, Any]) -> None:
    c = conn(**settings)
    wire = Wire(c, status=302, headers={"Location": "https://elsewhere.example.net/steal"})
    with pytest.raises(Exception) as info:
        await wire.call()
    assert len(wire.seen) == 1
    assert to_engine_error(info.value).code in {"provider_bad_response", "provider_unreachable"}


@pytest.mark.parametrize(
    "settings",
    [
        dict(base_url="http://169.254.169.254/v1"),
        dict(adapter="anthropic", base_url="http://169.254.169.254"),
        dict(adapter="google", base_url="http://169.254.169.254"),
    ],
    ids=["openai", "anthropic", "google"],
)
async def test_blocked_address_is_refused_for_every_adapter(allow_requests: None, settings: dict[str, Any]) -> None:
    seen: list[httpx2.Request] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        return httpx2.Response(200, json=COMPLETION)

    client = make_client(block_private=True, inner=httpx2.MockTransport(handler))
    async with client:
        model = build_model(conn(**settings), http_client=client)
        with pytest.raises(Exception) as info:
            await Agent(model).run("hi")
    assert seen == []
    assert to_engine_error(info.value).code == "provider_unreachable"


def test_extra_headers_are_masked_in_reprs() -> None:
    c = conn(extra_headers={"X-Org": "org-secret-value"})
    assert "org-secret-value" not in repr(c) and "org-secret-value" not in str(c)
    assert "org-secret-value" not in json.dumps(c.model_dump(mode="json"))
