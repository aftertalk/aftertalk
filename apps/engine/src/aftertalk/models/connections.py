"""Connections to LLM and speech-to-text services. Keys are `SecretStr` and never printed."""

from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    HttpUrl,
    PlainSerializer,
    PositiveInt,
    SecretStr,
    SerializationInfo,
    StringConstraints,
    TypeAdapter,
    ValidationError,
    WithJsonSchema,
    field_validator,
    model_validator,
)

LLMAdapter = Literal["openai-compatible", "anthropic", "google"]
LLMPreset = Literal["openai", "ollama", "vllm", "openrouter", "groq", "azure", "litellm"]
OutputMode = Literal["auto", "tool", "native", "prompted"]
SpeechAdapter = Literal["openai-compatible"]
ModelTier = Literal["default", "fast", "smart"]

_RESOURCE_PATHS = ("/chat/completions", "/completions", "/audio/transcriptions", "/models", "/responses")
_AUTH_HEADERS = frozenset(
    {
        "authorization",
        "x-api-key",
        "api-key",
        "x-goog-api-key",
        "proxy-authorization",
        "cookie",
        "ocp-apim-subscription-key",
    }
)

_CONFIG = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)

_MASK = "**********"
_URL_TYPE = TypeAdapter(HttpUrl)


def _validate_base_url(value: str) -> str:
    text = value.strip().rstrip("/")
    try:
        _URL_TYPE.validate_python(text)
        parts = urlsplit(text)
    except (ValidationError, ValueError):
        raise ValueError("base_url must be a valid http or https URL") from None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError("base_url must be a valid http or https URL")
    if "@" in parts.netloc:
        raise ValueError("base_url must not contain a username or password; use api_key")
    if "?" in text or "#" in text:
        raise ValueError("base_url must not contain a query string or fragment")
    path = parts.path.lower()
    for resource in _RESOURCE_PATHS:
        if path.endswith(resource):
            raise ValueError(
                "base_url must end at the version path (for example https://api.openai.com/v1), "
                f"not at a resource path such as {resource}"
            )
    return text


BaseUrl = Annotated[str, AfterValidator(_validate_base_url), WithJsonSchema({"type": "string", "format": "uri"})]
ModelName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


def _secret_cleaner(empty_message: str):
    def clean(value: Any) -> Any:
        if isinstance(value, SecretStr):
            value = value.get_secret_value()
        if isinstance(value, str):
            value = value.strip()
            if not value:
                raise ValueError(empty_message)
            if set(value) == {"*"}:
                raise ValueError("value is a masked placeholder, not a real secret")
        return value

    return clean


def _serialize_secret(value: SecretStr, info: SerializationInfo) -> str:
    if isinstance(info.context, dict) and info.context.get("reveal_secrets"):
        return value.get_secret_value()
    return _MASK


_secret_serializer = PlainSerializer(_serialize_secret, return_type=str, when_used="json")

ApiKey = Annotated[
    SecretStr,
    BeforeValidator(_secret_cleaner("api_key is empty; leave it out for a server without a key")),
    _secret_serializer,
]
HeaderValue = Annotated[SecretStr, BeforeValidator(_secret_cleaner("header value is empty")), _secret_serializer]


def reveal(model: BaseModel) -> dict[str, Any]:
    """Dump a model with secrets in plaintext. Only for sending a job to the engine; never log it."""
    return model.model_dump(mode="json", context={"reveal_secrets": True})


class LLMConnection(BaseModel):
    """One LLM endpoint. `api_key` None means a keyless own server."""

    model_config = _CONFIG

    adapter: LLMAdapter
    preset: LLMPreset | None = None
    base_url: BaseUrl | None = None
    api_key: ApiKey | None = None
    model: ModelName
    api_version: str | None = None
    extra_headers: dict[str, HeaderValue] = {}
    output_mode: OutputMode = "auto"
    context_window: PositiveInt | None = None

    @field_validator("extra_headers")
    @classmethod
    def _no_auth_headers(cls, value: dict[str, SecretStr]) -> dict[str, SecretStr]:
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
        if self.api_version is not None and self.preset != "azure":
            raise ValueError("api_version is only valid with preset azure")
        if self.preset == "azure" and self.api_version is None:
            # The Azure v1 API (https://<resource>.openai.azure.com/openai/v1) takes no api-version.
            assert self.base_url is not None
            if not urlsplit(self.base_url).path.lower().rstrip("/").endswith("/openai/v1"):
                raise ValueError("preset azure requires api_version unless base_url ends in /openai/v1")
        return self


class SpeechConnection(BaseModel):
    """A speech-to-text endpoint (OpenAI-compatible transcription API)."""

    model_config = _CONFIG

    adapter: SpeechAdapter = "openai-compatible"
    base_url: BaseUrl
    api_key: ApiKey | None = None
    model: ModelName
    audio_format: Literal["flac", "wav"] = "flac"


class ModelTiers(BaseModel):
    """LLM connections by tier; unset tiers fall back to `default`."""

    model_config = _CONFIG

    default: LLMConnection
    fast: LLMConnection | None = None
    smart: LLMConnection | None = None

    def resolve(self, tier: ModelTier) -> LLMConnection:
        tiers = {"default": self.default, "fast": self.fast, "smart": self.smart}
        if tier not in tiers:
            raise ValueError(f"unknown tier {tier!r}")
        return tiers[tier] or self.default
