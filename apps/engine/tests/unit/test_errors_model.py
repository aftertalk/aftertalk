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
        "audio_unreadable",
        "audio_too_long",
        "language_not_allowed",
        "limit_exceeded",
        "internal",
    }


def test_repr_has_no_provider_text() -> None:
    err = EngineError("provider_auth")
    assert "provider_auth" in repr(err)


def test_to_model_carries_code_retryable_usage_and_language_only() -> None:
    from aftertalk.models.errors import JobError

    assert EngineError("provider_rate_limited").to_model() == JobError(code="provider_rate_limited", retryable=True)
    assert set(JobError.model_fields) == {"code", "retryable", "usage", "detected_language"}


def test_detected_language_defaults_to_none() -> None:
    assert EngineError("provider_auth").detected_language is None
    assert EngineError("provider_auth").to_model().detected_language is None
    err = EngineError("language_not_allowed", detected_language="uk")
    assert err.to_model().detected_language == "uk" and str(err) == str(EngineError("language_not_allowed"))
