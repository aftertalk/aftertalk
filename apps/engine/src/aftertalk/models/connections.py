"""Connections to LLM and speech-to-text services. Keys are `SecretStr` and never printed."""

from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    HttpUrl,
    PositiveInt,
    SecretStr,
    StringConstraints,
    field_validator,
    model_validator,
)

LLMAdapter = Literal["openai-compatible", "anthropic", "google"]
LLMPreset = Literal["openai", "ollama", "vllm", "openrouter", "groq", "azure", "litellm"]
OutputMode = Literal["auto", "tool", "native", "prompted"]
SpeechAdapter = Literal["openai-compatible"]
ModelTier = Literal["default", "fast", "smart"]

_RESOURCE_PATHS = ("/chat/completions", "/completions", "/audio/transcriptions", "/models", "/responses")
_AUTH_HEADERS = frozenset({"authorization", "x-api-key", "api-key"})

_CONFIG = ConfigDict(extra="forbid", frozen=True)


def _normalize_base_url(value: object) -> object:
    if value is None:
        return value
    text = str(value).strip().rstrip("/")
    path = text.split("://", 1)[-1].split("?", 1)[0].partition("/")[2]
    for resource in _RESOURCE_PATHS:
        if f"/{path}".endswith(resource):
            raise ValueError(
                f"base_url must be the version path (for example https://api.openai.com/v1), not a resource path ending in {resource}"
            )
    return text


BaseUrl = Annotated[HttpUrl, BeforeValidator(_normalize_base_url)]
ModelName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class LLMConnection(BaseModel):
    """One LLM endpoint. `api_key` None means a keyless own server."""

    model_config = _CONFIG

    adapter: LLMAdapter
    preset: LLMPreset | None = None
    base_url: BaseUrl | None = None
    api_key: SecretStr | None = None
    model: ModelName
    api_version: str | None = None
    extra_headers: dict[str, str] = {}
    output_mode: OutputMode = "auto"
    context_window: PositiveInt | None = None

    @field_validator("extra_headers")
    @classmethod
    def _no_auth_headers(cls, value: dict[str, str]) -> dict[str, str]:
        for name in value:
            if name.strip().lower() in _AUTH_HEADERS:
                raise ValueError(f"header {name!r} is not allowed in extra_headers; put the key in api_key")
        return value

    @model_validator(mode="after")
    def _check_adapter(self) -> "LLMConnection":
        if self.preset is not None and self.adapter != "openai-compatible":
            raise ValueError("preset is only valid with adapter openai-compatible")
        if self.adapter == "openai-compatible" and self.base_url is None:
            raise ValueError("base_url is required for adapter openai-compatible")
        return self


class SpeechConnection(BaseModel):
    """A speech-to-text endpoint (OpenAI-compatible transcription API)."""

    model_config = _CONFIG

    adapter: SpeechAdapter = "openai-compatible"
    base_url: BaseUrl
    api_key: SecretStr | None = None
    model: ModelName
    audio_format: Literal["flac", "wav"] = "flac"


class ModelTiers(BaseModel):
    """LLM connections by tier; unset tiers fall back to `default`."""

    model_config = _CONFIG

    default: LLMConnection
    fast: LLMConnection | None = None
    smart: LLMConnection | None = None

    def resolve(self, tier: ModelTier) -> LLMConnection:
        return getattr(self, tier) or self.default
