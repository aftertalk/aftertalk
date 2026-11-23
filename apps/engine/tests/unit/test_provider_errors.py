import asyncio

import httpx
import httpx2
import pytest
from pydantic_ai import (
    ModelHTTPError,
    UnexpectedModelBehavior,
    UsageLimitExceeded,
    UserError,
)
from pydantic_ai.exceptions import (
    ContentFilterError,
    IncompleteToolCall,
    ModelAPIError,
    ModelAuthenticationError,
    ModelConnectionError,
    ModelContextWindowExceededError,
    ModelNotFoundError,
    ModelOverloadedError,
    ModelQuotaExceededError,
    ModelRateLimitError,
    ModelRequestRejectedError,
    ModelServerError,
    ModelTimeoutError,
    ModelUnavailableError,
    OutputTokenLimitExceeded,
)

from aftertalk.models.errors import EngineError
from aftertalk.providers.errors import to_engine_error
from aftertalk.providers.net import BlockedAddressError

BODY = "PROVIDER-BODY-sk-secret-123"


def http(
    category: type[ModelAPIError] | None, status: int, code: str | None = None, kind: str | None = None
) -> ModelHTTPError:
    return ModelHTTPError.for_category(
        category,  # type: ignore[arg-type]
        status_code=status,
        model_name="m",
        body=BODY,
        provider_error_code=code,
        provider_error_type=kind,
    )


CASES = [
    (http(ModelAuthenticationError, 401), "provider_auth"),
    (http(None, 401), "provider_auth"),
    (http(None, 403), "provider_auth"),
    (http(ModelNotFoundError, 404, code="model_not_found"), "provider_model_not_found"),
    (http(None, 404, code="model_not_found"), "provider_model_not_found"),
    (http(ModelNotFoundError, 404, kind="not_found_error"), "provider_model_not_found"),
    (http(ModelNotFoundError, 404), "provider_bad_response"),  # a bare 404 is more often a wrong base URL
    (http(None, 404), "provider_bad_response"),
    (http(None, 404, code="404"), "provider_bad_response"),
    (http(None, 400, code="content_filter"), "provider_refused"),
    (http(ModelRequestRejectedError, 400, code="content_policy_violation"), "provider_refused"),
    (http(None, 400, kind="ResponsibleAIPolicyViolation"), "provider_refused"),
    (http(ModelContextWindowExceededError, 400), "provider_context_too_long"),
    (http(ModelRateLimitError, 429), "provider_rate_limited"),
    (http(None, 429), "provider_rate_limited"),
    (http(ModelQuotaExceededError, 429), "provider_quota_exceeded"),
    (http(ModelUnavailableError, 503), "provider_unreachable"),
    (http(ModelOverloadedError, 529), "provider_unreachable"),
    (http(ModelServerError, 500), "provider_unreachable"),
    (http(None, 500), "provider_unreachable"),
    (http(None, 502), "provider_unreachable"),
    (http(None, 408), "provider_unreachable"),
    (http(ModelTimeoutError, 408), "provider_unreachable"),
    (http(None, 400), "provider_bad_response"),
    (http(None, 422), "provider_bad_response"),
    (http(ModelRequestRejectedError, 400), "provider_bad_response"),
    (ModelConnectionError("m", BODY), "provider_unreachable"),
    (ModelTimeoutError("m", BODY), "provider_unreachable"),
    (ModelAPIError("m", BODY), "provider_bad_response"),
    (ContentFilterError(BODY, body=BODY), "provider_refused"),
    (UnexpectedModelBehavior(BODY, body=BODY), "provider_output_invalid"),
    (OutputTokenLimitExceeded(BODY, body=BODY), "provider_output_truncated"),
    (IncompleteToolCall(BODY, body=BODY), "provider_output_truncated"),
    (UsageLimitExceeded(BODY), "limit_exceeded"),
    (BlockedAddressError(), "provider_unreachable"),
    (httpx2.ConnectError(BODY), "provider_unreachable"),
    (httpx2.ReadTimeout(BODY), "provider_unreachable"),
    (httpx.ConnectError(BODY), "provider_unreachable"),
    (TimeoutError(BODY), "provider_unreachable"),
    (UserError(BODY), "internal"),
    (RuntimeError(BODY), "internal"),
    (EngineError("provider_auth"), "provider_auth"),
]


@pytest.mark.parametrize(("exc", "code"), CASES, ids=[f"{type(e).__name__}-{c}-{i}" for i, (e, c) in enumerate(CASES)])
def test_mapping_table(exc: BaseException, code: str) -> None:
    err = to_engine_error(exc)
    assert isinstance(err, EngineError)
    assert err.code == code


@pytest.mark.parametrize("exc", [e for e, _ in CASES], ids=[str(i) for i in range(len(CASES))])
def test_provider_text_never_reaches_the_error(exc: BaseException) -> None:
    err = to_engine_error(exc)
    assert "PROVIDER-BODY" not in str(err) and "sk-secret" not in str(err)
    assert "PROVIDER-BODY" not in repr(err) and "sk-secret" not in repr(err)
    assert err.__cause__ is None
    assert err.__suppress_context__ is True


def test_blocked_address_found_through_the_cause_chain() -> None:
    wrapped = ModelConnectionError("m", "Connection error.")
    wrapped.__cause__ = RuntimeError("api connection error")
    wrapped.__cause__.__cause__ = BlockedAddressError()
    assert to_engine_error(wrapped).code == "provider_unreachable"


def test_retryable_flags_follow_codes() -> None:
    assert to_engine_error(http(None, 429)).retryable
    assert to_engine_error(http(None, 500)).retryable
    assert not to_engine_error(http(None, 401)).retryable
    assert not to_engine_error(UsageLimitExceeded("x")).retryable


def test_raise_from_none_leaves_no_traceback_chain() -> None:
    # The pattern the engine uses: build the error inside the except, raise it after the block.
    error: EngineError | None = None
    try:
        raise http(None, 401)
    except ModelHTTPError as exc:
        error = to_engine_error(exc)
    with pytest.raises(EngineError) as info:
        raise error
    assert info.value.__cause__ is None and info.value.__context__ is None


def test_cancellation_is_not_mapped() -> None:
    with pytest.raises(asyncio.CancelledError):
        to_engine_error(asyncio.CancelledError())
