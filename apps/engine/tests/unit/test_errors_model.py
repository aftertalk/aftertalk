from typing import get_args

import pytest

from aftertalk.models.errors import EngineError, ErrorCode

RETRYABLE = {"provider_unreachable", "provider_rate_limited", "internal"}


@pytest.mark.parametrize("code", get_args(ErrorCode))
def test_every_code_has_a_fixed_sentence_and_retryable_flag(code: str) -> None:
    err = EngineError(code)  # type: ignore[arg-type]
    assert err.code == code
    assert err.retryable is (code in RETRYABLE)
    assert str(err).startswith(code)
    assert len(str(err)) > len(code) + 5


def test_codes_are_the_agreed_set() -> None:
    assert set(get_args(ErrorCode)) == {
        "provider_auth",
        "provider_unreachable",
        "provider_rate_limited",
        "provider_quota_exceeded",
        "provider_model_not_found",
        "provider_context_too_long",
        "provider_bad_response",
        "provider_output_invalid",
        "provider_output_truncated",
        "provider_refused",
        "provider_config_invalid",
        "limit_exceeded",
        "internal",
    }


def test_repr_has_no_provider_text() -> None:
    err = EngineError("provider_auth")
    assert "provider_auth" in repr(err)


def test_to_model_carries_code_retryable_and_usage_only() -> None:
    from aftertalk.models.errors import JobError

    assert EngineError("provider_rate_limited").to_model() == JobError(code="provider_rate_limited", retryable=True)
    assert set(JobError.model_fields) == {"code", "retryable", "usage"}
