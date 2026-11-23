"""Structured output from an LLM, with a ladder of modes.

Servers differ in what they accept: tool calls, a JSON schema in `response_format`, or neither. PydanticAI has no
fallback between these modes, so `run_structured` tries them in order and moves down only when the error means
"this mode is not supported" (see `_mode_unsupported`). Any other failure stops the ladder.

Errors are built inside `except` blocks and raised after them, so no provider exception is chained to them.
"""

import asyncio
import time
from typing import Any, Literal, TypeVar

from pydantic_ai import Agent, NativeOutput, PromptedOutput, ToolOutput, UsageLimits, capture_run_messages
from pydantic_ai.capabilities import TRANSIENT_MODEL_ERRORS, RetryOnModelErrors
from pydantic_ai.exceptions import ModelHTTPError, UnexpectedModelBehavior, UserError
from pydantic_ai.messages import ModelMessage, ModelResponse
from pydantic_ai.models import Model
from pydantic_ai.settings import ModelSettings
from pydantic_ai.usage import RunUsage

from aftertalk.models.connections import LLMConnection, ModelTier
from aftertalk.models.errors import EngineError
from aftertalk.models.usage import JobLimits, StepUsage
from aftertalk.providers.errors import _UNSUPPORTED_MODE_MESSAGES, provider_codes, to_engine_error
from aftertalk.providers.net import BlockedAddressError

T = TypeVar("T")
Mode = Literal["tool", "native", "prompted"]

LADDER: list[Mode] = ["tool", "native", "prompted"]
OUTPUT_RETRIES = 2  # PydanticAI's own re-prompts when the model's output does not validate
REQUEST_ATTEMPTS = 3  # tries per request for rate limits, 5xx and dropped connections
MAX_RETRY_DELAY = 60.0
REQUEST_TIMEOUT = 600.0  # seconds for one request; shortened to what is left of the job's deadline
DEFAULT_REQUEST_LIMIT = 30  # LLM requests per step when the job sets no limit: a backstop against loops

_PARAMETER_CODES = frozenset({"unsupported_parameter", "invalid_parameter", "unsupported_value", "invalid_value"})
# Request parameters that belong to the output modes (a parameter error about them means "try the next mode").
_OUTPUT_PARAMETERS = frozenset(
    {"tools", "tool_choice", "functions", "function_call", "parallel_tool_calls", "response_format", "json_schema"}
)


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


def _error_parameter(exc: ModelHTTPError) -> str | None:
    """The request parameter a 400 names (`error.param`), used only to decide; never reported."""
    body: Any = exc.body
    if isinstance(body, dict):
        error = body.get("error", body)
        if isinstance(error, dict) and isinstance(error.get("param"), str):
            return error["param"].lower()
    return None


def _mode_unsupported(exc: Exception) -> bool:
    """True when the error says this output mode cannot work with this server or model."""
    if isinstance(exc, UserError):
        return exc.message in _UNSUPPORTED_MODE_MESSAGES
    if isinstance(exc, ModelHTTPError):
        # A 400 or 422 the mapper could not classify further (not auth, refusal, missing model, context length).
        if exc.status_code not in (400, 422) or to_engine_error(exc).code != "provider_bad_response":
            return False
        if provider_codes(exc) & _PARAMETER_CODES:
            parameter = _error_parameter(exc)
            return parameter is None or parameter in _OUTPUT_PARAMETERS  # cannot tell: try the next mode
        return True
    if isinstance(exc, UnexpectedModelBehavior):
        # Output still invalid after PydanticAI's own re-prompts. Refusals and malformed provider responses map
        # to other codes and stop the ladder; truncation is caught in `run_structured` before this is asked.
        return to_engine_error(exc).code == "provider_output_invalid"
    return False


def _output_spec(mode: Mode, output_type: type[T]) -> ToolOutput[T] | NativeOutput[T] | PromptedOutput[T]:
    match mode:
        case "tool":
            return ToolOutput(output_type)
        case "native":
            return NativeOutput(output_type)
        case _:
            return PromptedOutput(output_type)


def usage_limits(limits: JobLimits | None) -> UsageLimits:
    # `max_llm_requests` counts requests that got an answer. A request that fails with a retryable error is sent up
    # to 3 times, and those tries are not counted, also not in `usage.requests`. The worst case is 3 HTTP calls per
    # counted request.
    return UsageLimits(
        request_limit=(limits.max_llm_requests if limits else None) or DEFAULT_REQUEST_LIMIT,
        total_tokens_limit=limits.max_total_tokens if limits else None,
    )


def _cut_off(messages: list[ModelMessage]) -> bool:
    """True when the last answer stopped at the output token limit."""
    answers = [m for m in messages if isinstance(m, ModelResponse)]
    return bool(answers) and answers[-1].finish_reason == "length"


def _plan(model: Model, conn: LLMConnection) -> list[Mode]:
    if conn.output_mode != "auto":
        return [conn.output_mode]
    # Keep native unless the profile says the model cannot do it (then it would only fail before any request).
    if model.profile.get("supports_json_schema_output", False):
        return list(LADDER)
    return ["tool", "prompted"]


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
    """Run one structured LLM call. On failure raises an `EngineError` whose `.usage` holds what was used."""
    usage = RunUsage()  # shared by every rung, so tokens, requests and limits add up
    started = time.monotonic()
    timeout = limits.timeout_seconds if limits else None
    deadline = started + timeout if timeout else None
    tried = 0
    output: T | None = None
    worked: Mode | None = None
    error: EngineError | None = None

    def step_usage(mode: Mode | None) -> StepUsage:
        return StepUsage(
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
            attempts=tried,
            duration_ms=int((time.monotonic() - started) * 1000),
            cost_usd=float(usage.cost) if usage.cost is not None else None,
        )

    overall = asyncio.timeout(timeout)
    try:
        async with overall:
            for mode in _plan(model, conn):
                tried += 1
                settings = ModelSettings()
                if deadline is not None:
                    settings["timeout"] = min(REQUEST_TIMEOUT, max(deadline - time.monotonic(), 0.001))
                agent = Agent(
                    model,
                    output_type=_output_spec(mode, output_type),
                    instructions=instructions,
                    capabilities=[retry_capability()],
                    retries=OUTPUT_RETRIES,
                    model_settings=settings,
                )
                with capture_run_messages() as messages:
                    try:
                        result = await agent.run(prompt, usage=usage, usage_limits=usage_limits(limits))
                    except Exception as exc:
                        error = to_engine_error(exc)
                        # A cut-off text answer in tool mode is re-prompted and ends as plain invalid output.
                        if error.code == "provider_output_invalid" and _cut_off(messages):
                            error = EngineError("provider_output_truncated")
                        # Truncation stops the ladder: another mode would be cut off at the same limit.
                        if error.code != "provider_output_truncated" and _mode_unsupported(exc):
                            continue
                        break
                output, worked, error = result.output, mode, None
                break
    except TimeoutError as exc:
        error = EngineError("limit_exceeded") if overall.expired() else to_engine_error(exc)

    if error is not None:
        error.usage = step_usage(None)
        raise error
    assert worked is not None and output is not None
    return output, step_usage(worked)
