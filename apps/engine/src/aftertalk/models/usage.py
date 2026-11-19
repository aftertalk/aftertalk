"""Usage accounting and limits for a job."""

from decimal import Decimal

from pydantic import BaseModel, ConfigDict, NonNegativeFloat, NonNegativeInt, PositiveInt

from aftertalk.models.connections import ModelTier


class StepUsage(BaseModel):
    """What one pipeline step used. Raw units are the source of truth; cost is an estimate."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    step: str
    provider: str | None = None
    model: str | None = None
    tier: ModelTier | None = None
    input_tokens: NonNegativeInt = 0
    output_tokens: NonNegativeInt = 0
    cache_read_tokens: NonNegativeInt = 0
    cache_write_tokens: NonNegativeInt = 0
    requests: NonNegativeInt = 0
    audio_seconds: NonNegativeFloat | None = None
    attempts: NonNegativeInt = 0
    duration_ms: NonNegativeInt = 0
    cost_usd: Decimal | None = None


class JobLimits(BaseModel):
    """Per-job caps. None means no limit."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    max_audio_seconds: PositiveInt | None = None
    max_llm_requests: PositiveInt | None = None
    max_total_tokens: PositiveInt | None = None
    timeout_seconds: PositiveInt | None = None
