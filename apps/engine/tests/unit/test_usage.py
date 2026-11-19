from decimal import Decimal

import pytest
from pydantic import ValidationError

from aftertalk.models import JobLimits, StepUsage


def test_step_usage_defaults() -> None:
    u = StepUsage(step="transcribe")
    assert u.input_tokens == 0 and u.requests == 0 and u.cost_usd is None and u.audio_seconds is None


def test_step_usage_rejects_negative_and_extra() -> None:
    with pytest.raises(ValidationError):
        StepUsage(step="x", input_tokens=-1)
    with pytest.raises(ValidationError):
        StepUsage(step="x", audio_seconds=-0.1)
    with pytest.raises(ValidationError):
        StepUsage(step="x", nope=1)


def test_step_usage_cost_decimal_and_frozen() -> None:
    u = StepUsage(step="x", cost_usd="0.0123", tier="fast")
    assert u.cost_usd == Decimal("0.0123")
    with pytest.raises(ValidationError):
        u.step = "y"  # type: ignore[misc]


def test_job_limits() -> None:
    assert JobLimits().timeout_seconds is None
    assert JobLimits(max_llm_requests=3).max_llm_requests == 3
    with pytest.raises(ValidationError):
        JobLimits(max_total_tokens=0)
