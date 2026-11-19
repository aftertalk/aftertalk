"""Structured output from an LLM, with a ladder of modes.

Servers differ in what they accept: tool calls, a JSON schema in `response_format`, or neither. PydanticAI has no
fallback between these modes, so `run_structured` tries them in order and moves down only when the error means
"this mode is not supported" (see `_mode_unsupported`). Any other failure stops the ladder.
"""

import time
from typing import Literal, TypeVar

import pydantic_ai
from pydantic_ai import Agent, NativeOutput, PromptedOutput, ToolOutput, UsageLimits
from pydantic_ai.capabilities import TRANSIENT_MODEL_ERRORS, RetryOnModelErrors
from pydantic_ai.exceptions import (
    ContentFilterError,
    ModelHTTPError,
    OutputTokenLimitExceeded,
    UnexpectedModelBehavior,
    UserError,
)
from pydantic_ai.models import Model
from pydantic_ai.usage import RunUsage

from aftertalk.models.connections import LLMConnection, ModelTier
from aftertalk.models.errors import EngineError
from aftertalk.models.usage import JobLimits, StepUsage
from aftertalk.providers.errors import to_engine_error
from aftertalk.providers.net import BlockedAddressError

# The CLI prints JSON on stdout; PydanticAI's first-run banner must not land in it.
pydantic_ai.BANNER_ENABLED = False

T = TypeVar("T")
Mode = Literal["tool", "native", "prompted"]

LADDER: list[Mode] = ["tool", "native", "prompted"]
OUTPUT_RETRIES = 2  # PydanticAI's own re-prompts when the model's output does not validate
REQUEST_ATTEMPTS = 3  # tries per request for rate limits, 5xx and dropped connections
MAX_RETRY_DELAY = 60.0


def _should_retry(exc: Exception) -> bool:
    if not isinstance(exc, TRANSIENT_MODEL_ERRORS):
        return False
    cause: BaseException | None = exc
    for _ in range(8):
        if cause is None:
            break
        if isinstance(cause, BlockedAddressError):
            return False  # waiting does not unblock an address
        cause = cause.__cause__ or cause.__context__
    return True


def retry_capability() -> RetryOnModelErrors:
    return RetryOnModelErrors(retry_on=[_should_retry], max_attempts=REQUEST_ATTEMPTS, max_delay=MAX_RETRY_DELAY)


def _mode_unsupported(exc: Exception) -> bool:
    """True when the error says this output mode cannot work with this server or model."""
    if isinstance(exc, UserError):
        return "native" in str(exc).lower()  # NativeOutput on a profile without JSON schema output
    if isinstance(exc, ModelHTTPError):
        # A 400 or 422 the adapter could not classify further (not auth, not a missing model, not context length).
        return exc.status_code in (400, 422) and to_engine_error(exc).code == "provider_bad_response"
    if isinstance(exc, ContentFilterError | OutputTokenLimitExceeded):
        return False
    return isinstance(exc, UnexpectedModelBehavior)  # output still invalid after PydanticAI's own re-prompts


def _output_spec(mode: Mode, output_type: type[T]) -> ToolOutput[T] | NativeOutput[T] | PromptedOutput[T]:
    match mode:
        case "tool":
            return ToolOutput(output_type)
        case "native":
            return NativeOutput(output_type)
        case _:
            return PromptedOutput(output_type)


def usage_limits(limits: JobLimits | None) -> UsageLimits:
    return UsageLimits(
        request_limit=limits.max_llm_requests if limits else None,
        total_tokens_limit=limits.max_total_tokens if limits else None,
    )


async def run_structured(
    model: Model,
    *,
    conn: LLMConnection,
    output_type: type[T],
    instructions: str,
    prompt: str,
    limits: JobLimits | None,
    step: str,
    tier: ModelTier = "default",
    connection_ref: str | None = None,
) -> tuple[T, StepUsage]:
    modes: list[Mode] = LADDER if conn.output_mode == "auto" else [conn.output_mode]
    usage = RunUsage()  # shared by every rung, so tokens, requests and limits add up
    started = time.monotonic()
    last: EngineError | None = None
    for attempt, mode in enumerate(modes, start=1):
        agent = Agent(
            model,
            output_type=_output_spec(mode, output_type),
            instructions=instructions,
            capabilities=[retry_capability()],
            retries=OUTPUT_RETRIES,
        )
        try:
            result = await agent.run(prompt, usage=usage, usage_limits=usage_limits(limits))
        except Exception as exc:
            last = to_engine_error(exc)
            if not _mode_unsupported(exc):
                raise last from None
            continue
        return result.output, StepUsage(
            step=step,
            provider=conn.preset or conn.adapter,
            connection=connection_ref,
            model=conn.model,
            tier=tier,
            output_mode=mode,
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
            cache_read_tokens=usage.cache_read_tokens,
            cache_write_tokens=usage.cache_write_tokens,
            requests=usage.requests,
            attempts=attempt,
            duration_ms=int((time.monotonic() - started) * 1000),
            cost_usd=float(usage.cost) if usage.cost is not None else None,
        )
    assert last is not None
    raise last from None
