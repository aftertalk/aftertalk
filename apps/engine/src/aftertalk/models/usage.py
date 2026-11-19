"""Usage accounting and limits for a job."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, NonNegativeFloat, NonNegativeInt, PositiveInt

from aftertalk.models.connections import ModelTier


class StepUsage(BaseModel):
    """What one pipeline step used. Raw units are the source of truth; cost is an estimate."""

    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)

    step: str
    provider: str | None = None
    connection: str | None = None  # opaque reference from the caller (never a key)
    model: str | None = None
    tier: ModelTier | None = None
    output_mode: Literal["tool", "native", "prompted"] | None = None  # the mode that worked
    input_tokens: NonNegativeInt = 0
    output_tokens: NonNegativeInt = 0
    cache_read_tokens: NonNegativeInt = 0
    cache_write_tokens: NonNegativeInt = 0
    requests: NonNegativeInt = 0
    audio_seconds: NonNegativeFloat | None = None
    attempts: NonNegativeInt = 0
    duration_ms: NonNegativeInt = 0
    cost_usd: Annotated[float, Field(ge=0)] | None = None


class JobLimits(BaseModel):
    """Per-job caps. None means no limit."""

    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)

    max_audio_seconds: PositiveInt | None = None
    max_llm_requests: PositiveInt | None = None
    max_total_tokens: PositiveInt | None = None
    timeout_seconds: PositiveInt | None = None
