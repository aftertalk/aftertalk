import json
from typing import Any, Literal

import httpx2
import pytest
from pydantic import BaseModel
from pydantic_ai import ModelHTTPError
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.profiles import ModelProfile

from aftertalk.models import JobLimits, LLMConnection
from aftertalk.models.errors import EngineError
from aftertalk.providers.llm import build_model
from aftertalk.providers.output import run_structured


class Probe(BaseModel):
    answer: Literal["ok"]


GOOD = json.dumps({"answer": "ok"})


def conn(mode: str = "auto") -> LLMConnection:
    return LLMConnection(
        adapter="openai-compatible", preset="vllm", base_url="http://x/v1", model="m1", output_mode=mode
    )  # type: ignore[arg-type]


def scripted(ok: set[str], fail: dict[str, Exception] | None = None, calls: list[str] | None = None) -> FunctionModel:
    """A model that answers only in the output modes in `ok` and raises `fail[mode]` otherwise."""
    fail = fail or {}

    def respond(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        mode = info.model_request_parameters.output_mode
        if calls is not None:
            calls.append(mode)
        if mode in fail:
            raise fail[mode]
        if mode in ok and mode == "tool":
            return ModelResponse(parts=[ToolCallPart(info.output_tools[0].name, GOOD)])
        if mode in ok:
            return ModelResponse(parts=[TextPart(GOOD)])
        return ModelResponse(parts=[TextPart("I cannot do that")])

    return FunctionModel(respond, profile=ModelProfile(supports_json_schema_output=True))


def bad_request() -> ModelHTTPError:
    return ModelHTTPError(400, "m1", body="PROVIDER-BODY")


async def run(model: FunctionModel, c: LLMConnection, limits: JobLimits | None = None):
    return await run_structured(
        model,
        conn=c,
        output_type=Probe,
        instructions="Answer ok.",
        prompt="go",
        limits=limits,
        step="probe",
        tier="fast",
        connection_ref="conn-7",
    )


async def test_tool_mode_first() -> None:
    calls: list[str] = []
    out, usage = await run(scripted({"tool"}, calls=calls), conn())
    assert out == Probe(answer="ok")
    assert calls == ["tool"]
    assert usage.output_mode == "tool" and usage.attempts == 1
    assert usage.step == "probe" and usage.tier == "fast" and usage.connection == "conn-7"
    assert usage.provider == "vllm" and usage.model == "m1"
    assert usage.requests == 1 and usage.input_tokens > 0 and usage.output_tokens > 0
    assert usage.duration_ms >= 0


async def test_falls_back_to_native_after_400_on_tools() -> None:
    calls: list[str] = []
    out, usage = await run(scripted({"native"}, fail={"tool": bad_request()}, calls=calls), conn())
    assert out.answer == "ok"
    assert calls == ["tool", "native"]
    assert usage.output_mode == "native" and usage.attempts == 2
    assert usage.requests == 1  # only requests that got a response are counted


async def test_only_prompted_works() -> None:
    calls: list[str] = []
    model = scripted({"prompted"}, fail={"tool": bad_request(), "native": bad_request()}, calls=calls)
    _, usage = await run(model, conn())
    assert calls == ["tool", "native", "prompted"]
    assert usage.output_mode == "prompted" and usage.attempts == 3


async def test_invalid_output_in_a_mode_moves_on() -> None:
    calls: list[str] = []
    _, usage = await run(scripted({"native"}, calls=calls), conn())  # tool mode returns prose until retries run out
    assert calls[0] == "tool" and calls[-1] == "native"
    assert usage.output_mode == "native"
    assert usage.requests == len(calls)


async def test_native_unsupported_profile_moves_on_before_any_request() -> None:
    calls: list[str] = []

    def respond(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        calls.append(info.model_request_parameters.output_mode)
        if info.model_request_parameters.output_mode == "prompted":
            return ModelResponse(parts=[TextPart(GOOD)])
        raise bad_request()

    model = FunctionModel(respond, profile=ModelProfile(supports_json_schema_output=False))
    _, usage = await run(model, conn())
    assert calls == ["tool", "prompted"]  # native is skipped: the profile says it is unsupported
    assert usage.output_mode == "prompted" and usage.attempts == 2


async def test_auth_error_stops_the_ladder() -> None:
    calls: list[str] = []
    model = scripted({"native"}, fail={"tool": ModelHTTPError(401, "m1", body="PROVIDER-BODY")}, calls=calls)
    with pytest.raises(EngineError) as info:
        await run(model, conn())
    assert info.value.code == "provider_auth"
    assert calls == ["tool"]
    assert "PROVIDER-BODY" not in str(info.value)
    assert info.value.__cause__ is None


@pytest.mark.parametrize(
    ("status", "code"), [(404, "provider_bad_response"), (403, "provider_auth"), (500, "provider_unreachable")]
)
async def test_other_http_errors_stop_the_ladder(status: int, code: str) -> None:
    calls: list[str] = []
    with pytest.raises(EngineError) as info:
        await run(scripted(set(), fail={"tool": ModelHTTPError(status, "m1")}, calls=calls), conn())
    assert info.value.code == code
    assert calls[0] == "tool" and "native" not in calls


async def test_all_modes_failing_raises_the_last_error() -> None:
    model = scripted(set(), fail={"tool": bad_request(), "native": bad_request(), "prompted": bad_request()})
    with pytest.raises(EngineError) as info:
        await run(model, conn())
    assert info.value.code == "provider_bad_response"


async def test_unparseable_in_every_mode_is_output_invalid() -> None:
    with pytest.raises(EngineError) as info:
        await run(scripted(set()), conn())
    assert info.value.code == "provider_output_invalid"


@pytest.mark.parametrize("mode", ["tool", "native", "prompted"])
async def test_fixed_mode_skips_the_others(mode: str) -> None:
    calls: list[str] = []
    _, usage = await run(scripted({"tool", "native", "prompted"}, calls=calls), conn(mode))
    assert calls == [mode]
    assert usage.output_mode == mode and usage.attempts == 1


async def test_fixed_mode_does_not_fall_back() -> None:
    calls: list[str] = []
    model = scripted({"native", "prompted"}, fail={"tool": bad_request()}, calls=calls)
    with pytest.raises(EngineError) as info:
        await run(model, conn("tool"))
    assert info.value.code == "provider_bad_response"
    assert calls == ["tool"]


async def test_request_limit_maps_to_limit_exceeded() -> None:
    model = scripted(set())  # prose forces output retries, which need more requests than allowed
    with pytest.raises(EngineError) as info:
        await run(model, conn("tool"), JobLimits(max_llm_requests=1))
    assert info.value.code == "limit_exceeded"


async def test_token_limit_maps_to_limit_exceeded() -> None:
    with pytest.raises(EngineError) as info:
        await run(scripted({"tool"}), conn("tool"), JobLimits(max_total_tokens=1))
    assert info.value.code == "limit_exceeded"


async def test_cost_is_none_for_unknown_models() -> None:
    _, usage = await run(scripted({"tool"}), conn())
    assert usage.cost_usd is None


# Against a real (fake) HTTP server with the real OpenAI model.


async def test_retries_429_with_retry_after_then_succeeds(fake_llm: Any) -> None:
    from fake_llm import Forced

    fake_llm.forced = [Forced(429, json.dumps({"error": {"message": "slow down PROVIDER-BODY"}}), {"Retry-After": "0"})]
    async with httpx2.AsyncClient() as client:
        model = build_model(conn("tool").model_copy(update={"base_url": fake_llm.base_url}), http_client=client)
        out, usage = await run(model, conn("tool"))  # type: ignore[arg-type]
    assert out.answer == "ok"
    assert len(fake_llm.seen) == 2
    assert usage.attempts == 1 and usage.output_mode == "tool"


async def test_401_is_not_retried(fake_llm: Any) -> None:
    from fake_llm import Forced

    fake_llm.always = Forced(401, json.dumps({"error": {"message": "bad key PROVIDER-BODY"}}))
    async with httpx2.AsyncClient() as client:
        model = build_model(conn().model_copy(update={"base_url": fake_llm.base_url}), http_client=client)
        with pytest.raises(EngineError) as info:
            await run(model, conn())  # type: ignore[arg-type]
    assert info.value.code == "provider_auth"
    assert len(fake_llm.seen) == 1


async def test_auto_ladder_over_http(fake_llm: Any) -> None:
    fake_llm.reject = {"tool", "native"}
    c = conn().model_copy(update={"base_url": fake_llm.base_url})
    async with httpx2.AsyncClient() as client:
        _, usage = await run(build_model(c, http_client=client), c)  # type: ignore[arg-type]
    assert usage.output_mode == "prompted" and usage.attempts == 3


def test_only_transient_errors_are_retried() -> None:
    from pydantic_ai.exceptions import ModelConnectionError, ModelRateLimitError

    from aftertalk.providers.net import BlockedAddressError
    from aftertalk.providers.output import _should_retry

    assert _should_retry(ModelRateLimitError("m", "x"))
    assert _should_retry(ModelConnectionError("m", "x"))
    assert not _should_retry(ModelHTTPError(401, "m"))
    blocked = ModelConnectionError("m", "Connection error.")
    blocked.__cause__ = BlockedAddressError()
    assert not _should_retry(blocked)
