"""Map every failure of a provider call to an `EngineError` code.

The returned error carries no provider text and no chained exception: callers `raise to_engine_error(exc) from None`.
"""

import httpx
import httpx2
from pydantic_ai import ModelHTTPError, UnexpectedModelBehavior, UsageLimitExceeded
from pydantic_ai.exceptions import (
    ContentFilterError,
    ModelAPIError,
    ModelAuthenticationError,
    ModelConnectionError,
    ModelContextWindowExceededError,
    ModelNotFoundError,
    ModelQuotaExceededError,
    ModelRateLimitError,
    ModelRequestTimeout,
    ModelServerError,
    ModelUnavailableError,
    OutputTokenLimitExceeded,
    UserError,
)

from aftertalk.models.errors import EngineError, ErrorCode
from aftertalk.providers.net import BlockedAddressError

# Checked in order: the first matching class wins, so the specific ones come before their parents.
_BY_CLASS: list[tuple[tuple[type[BaseException], ...], ErrorCode]] = [
    ((BlockedAddressError,), "provider_unreachable"),
    ((UsageLimitExceeded,), "limit_exceeded"),
    ((ModelAuthenticationError,), "provider_auth"),
    ((ModelContextWindowExceededError,), "provider_context_too_long"),
    ((ModelQuotaExceededError,), "provider_quota_exceeded"),
    ((ModelRateLimitError,), "provider_rate_limited"),
    ((ModelUnavailableError, ModelServerError, ModelConnectionError, ModelRequestTimeout), "provider_unreachable"),
]


# Codes and types providers send for a refusal by their content policy (Azure's innererror form included).
_REFUSAL_CODES = frozenset({"content_filter", "content_policy_violation", "responsibleaipolicyviolation"})
# A 404 only means "no such model" when the provider says so. Anthropic and Google have one fixed path, so
# their "not found" type can only be the model; for an OpenAI-compatible server a bare 404 is more often a wrong
# base URL (a missing /v1), so it stays `provider_bad_response`.
_MODEL_NOT_FOUND_CODES = frozenset(
    {"model_not_found", "model_not_available", "deploymentnotfound", "not_found_error", "not_found"}
)
# PydanticAI raises these before sending anything when the model profile cannot do the output mode. In `auto`
# the ladder moves on; with a fixed `output_mode` it is the user's setting that is wrong.
_UNSUPPORTED_MODE_MESSAGES = frozenset(
    {
        "Native structured output is not supported by this model.",
        "Tool output is not supported by this model.",
    }
)


def provider_codes(exc: BaseException) -> set[str]:
    """The provider's own error code and type, lowercased. Used only to classify; never put in a message."""
    codes = {getattr(exc, "provider_error_code", None), getattr(exc, "provider_error_type", None)}
    return {str(c).lower() for c in codes if c}


def _http_status_code(status: int) -> ErrorCode:
    if status in (401, 403):
        return "provider_auth"
    if status == 404:
        return "provider_bad_response"
    if status == 429:
        return "provider_rate_limited"
    if status == 408 or status >= 500:
        return "provider_unreachable"
    return "provider_bad_response"


def _code_for(exc: BaseException) -> ErrorCode:
    link: BaseException | None = exc
    for _ in range(8):  # SDKs wrap the transport error; the guard's error can sit a few causes down
        if link is None:
            break
        if isinstance(link, BlockedAddressError):
            return "provider_unreachable"
        link = link.__cause__ or link.__context__
    if isinstance(exc, ModelAPIError):
        codes = provider_codes(exc)
        if codes & _REFUSAL_CODES:
            return "provider_refused"
        if isinstance(exc, ModelNotFoundError) or (isinstance(exc, ModelHTTPError) and exc.status_code == 404):
            return "provider_model_not_found" if codes & _MODEL_NOT_FOUND_CODES else "provider_bad_response"
    for classes, code in _BY_CLASS:
        if isinstance(exc, classes):
            return code
    if isinstance(exc, ModelHTTPError):
        return _http_status_code(exc.status_code)
    if isinstance(exc, ModelAPIError):
        return "provider_bad_response"
    if isinstance(exc, ContentFilterError):
        return "provider_refused"
    if isinstance(exc, OutputTokenLimitExceeded):  # includes IncompleteToolCall
        return "provider_output_truncated"
    if isinstance(exc, UnexpectedModelBehavior) and exc.message.startswith("Invalid response from"):
        # PydanticAI's wording when the provider's HTTP 200 body is not a valid completion (no choices, wrong shape).
        return "provider_bad_response"
    if isinstance(exc, UnexpectedModelBehavior):  # output still invalid after PydanticAI's re-prompts
        return "provider_output_invalid"
    if isinstance(exc, UserError) and exc.message in _UNSUPPORTED_MODE_MESSAGES:
        return "provider_config_invalid"
    if isinstance(exc, httpx2.TransportError | httpx.TransportError | TimeoutError):
        return "provider_unreachable"
    return "internal"


def to_engine_error(exc: BaseException) -> EngineError:
    if isinstance(exc, EngineError):
        return exc
    if not isinstance(exc, Exception):
        raise exc  # cancellation and interpreter exits are not provider failures
    return EngineError(_code_for(exc))
