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
)

from aftertalk.models.errors import EngineError, ErrorCode
from aftertalk.providers.net import BlockedAddressError

# Checked in order: the first matching class wins, so the specific ones come before their parents.
_BY_CLASS: list[tuple[tuple[type[BaseException], ...], ErrorCode]] = [
    ((BlockedAddressError,), "provider_unreachable"),
    ((UsageLimitExceeded,), "limit_exceeded"),
    ((ModelAuthenticationError,), "provider_auth"),
    ((ModelNotFoundError,), "provider_model_not_found"),
    ((ModelContextWindowExceededError,), "provider_context_too_long"),
    ((ModelQuotaExceededError,), "provider_quota_exceeded"),
    ((ModelRateLimitError,), "provider_rate_limited"),
    ((ModelUnavailableError, ModelServerError, ModelConnectionError, ModelRequestTimeout), "provider_unreachable"),
]


def _http_status_code(status: int) -> ErrorCode:
    if status in (401, 403):
        return "provider_auth"
    if status == 404:
        return "provider_model_not_found"
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
    for classes, code in _BY_CLASS:
        if isinstance(exc, classes):
            return code
    if isinstance(exc, ModelHTTPError):
        return _http_status_code(exc.status_code)
    if isinstance(exc, ModelAPIError):
        return "provider_bad_response"
    if isinstance(exc, ContentFilterError):
        return "provider_refused"
    if isinstance(exc, UnexpectedModelBehavior):  # includes OutputTokenLimitExceeded
        return "provider_output_invalid"
    if isinstance(exc, httpx2.TransportError | httpx.TransportError | TimeoutError):
        return "provider_unreachable"
    return "internal"


def to_engine_error(exc: BaseException) -> EngineError:
    if isinstance(exc, EngineError):
        return exc
    if not isinstance(exc, Exception):
        raise exc  # cancellation and interpreter exits are not provider failures
    return EngineError(_code_for(exc))
