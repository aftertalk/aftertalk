import asyncio
import json
import traceback
from typing import Any, Literal

import pytest
from fake_llm import FakeLLM, Forced
from pydantic import BaseModel
from pydantic_ai import ModelHTTPError, UserError
from pydantic_ai.exceptions import ModelServerError
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart, ToolCallPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.profiles import ModelProfile
from typer.testing import CliRunner

from aftertalk.cli import app
from aftertalk.models import JobLimits, LLMConnection
from aftertalk.models.errors import EngineError
from aftertalk.providers import output
from aftertalk.providers.llm import open_model
from aftertalk.providers.output import _mode_unsupported, run_structured, usage_limits

MARKER = "PROVIDER-BODY-MARKER-31"
GOOD = json.dumps({"answer": "ok"})


class Probe(BaseModel):
    answer: Literal["ok"]


def conn(mode: str = "auto") -> LLMConnection:
    return LLMConnection(
        adapter="openai-compatible",
        base_url="http://x/v1",
        model="m1",
        output_mode=mode,  # type: ignore[arg-type]
    )


def model_with(
    respond: Any, *, native: bool = True, calls: list[str] | None = None, settings: list[Any] | None = None
) -> FunctionModel:
    def wrapper(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        mode = info.model_request_parameters.output_mode
        if calls is not None:
            calls.append(mode)
        if settings is not None:
            settings.append(info.model_settings)
        return respond(mode, info)

    return FunctionModel(wrapper, profile=ModelProfile(supports_json_schema_output=native))


def good(mode: str, info: AgentInfo) -> ModelResponse:
    if mode == "tool":
        return ModelResponse(parts=[ToolCallPart(info.output_tools[0].name, GOOD)])
    return ModelResponse(parts=[TextPart(GOOD)])


async def run(model: FunctionModel, c: LLMConnection | None = None, limits: JobLimits | None = None):
    return await run_structured(
        model, conn=c or conn(), output_type=Probe, instructions="x", prompt="y", limits=limits, step="probe"
    )


def chain(exc: BaseException) -> list[BaseException]:
    out, todo = [], [exc]
    while todo:
        e = todo.pop()
        if e is None or any(e is seen for seen in out):
            continue
        out.append(e)
        todo += [e.__cause__, e.__context__]  # type: ignore[list-item]
    return out


def api_error(status: int, code: str | None = None, param: str | None = None) -> ModelHTTPError:
    body = {"error": {"message": MARKER, "code": code, "param": param}}
    return ModelHTTPError.for_category(None, status_code=status, model_name="m1", body=body, provider_error_code=code)


# Item 2: nothing from the provider is chained to the error


async def test_failed_run_has_no_provider_exception_in_its_chain(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(output, "REQUEST_ATTEMPTS", 1)  # no waiting between retries
    server_error = ModelHTTPError.for_category(
        ModelServerError, status_code=500, model_name="m1", body={"error": {"message": MARKER}}
    )

    def fail(mode: str, info: AgentInfo) -> ModelResponse:
        raise server_error

    with pytest.raises(EngineError) as info:
        await run(model_with(fail))
    assert info.value.code == "provider_unreachable"
    assert chain(info.value) == [info.value]
    text = "".join(traceback.format_exception(info.value)) + str(info.value) + repr(info.value)
    assert MARKER not in text


# Item 7: refusals and parameter errors


async def test_content_filter_400_stops_as_refused() -> None:
    calls: list[str] = []

    def fail(mode: str, info: AgentInfo) -> ModelResponse:
        raise api_error(400, code="content_filter")

    with pytest.raises(EngineError) as info:
        await run(model_with(fail, calls=calls))
    assert info.value.code == "provider_refused"
    assert calls == ["tool"]


@pytest.mark.parametrize(
    ("param", "advances"),
    [("tools", True), ("response_format", True), ("tool_choice", True), (None, True), ("temperature", False)],
)
async def test_parameter_errors_advance_only_for_output_parameters(param: str | None, advances: bool) -> None:
    calls: list[str] = []

    def respond(mode: str, info: AgentInfo) -> ModelResponse:
        if mode == "tool":
            raise api_error(400, code="unsupported_parameter", param=param)
        return good(mode, info)

    if advances:
        _, usage = await run(model_with(respond, calls=calls))
        assert usage.output_mode == "native"
    else:
        with pytest.raises(EngineError) as info:
            await run(model_with(respond, calls=calls))
        assert info.value.code == "provider_bad_response"
        assert calls == ["tool"]


def test_native_user_error_is_matched_by_its_exact_message() -> None:
    assert _mode_unsupported(UserError("Native structured output is not supported by this model."))
    assert not _mode_unsupported(UserError("something native went wrong"))


# Item 11: a 200 that is not a valid completion


@pytest.mark.parametrize("body", ["<html>gateway page</html>", "{}", '{"choices": []}'])
async def test_a_bad_200_is_a_bad_response_and_stops(fake_llm: FakeLLM, body: str) -> None:
    fake_llm.always = Forced(200, body)
    c = conn().model_copy(update={"base_url": fake_llm.base_url})
    async with open_model(c, block_private=False) as model:
        with pytest.raises(EngineError) as info:
            await run(model, c)  # type: ignore[arg-type]
    assert info.value.code == "provider_bad_response"
    assert len(fake_llm.seen) == 1


# Item 8: deadline


async def test_deadline_maps_to_limit_exceeded_and_keeps_usage() -> None:
    async def slow(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        await asyncio.sleep(10)
        return ModelResponse(parts=[TextPart(GOOD)])

    with pytest.raises(EngineError) as info:
        await run(FunctionModel(slow), limits=JobLimits(timeout_seconds=1))
    assert info.value.code == "limit_exceeded"
    assert info.value.usage is not None and info.value.usage.output_mode is None


async def test_request_timeout_is_capped_by_the_remaining_deadline() -> None:
    settings: list[Any] = []
    await run(model_with(good, settings=settings), limits=JobLimits(timeout_seconds=30))
    assert 0 < settings[0]["timeout"] <= 30
    settings.clear()
    await run(model_with(good, settings=settings))
    assert not settings[0] or "timeout" not in settings[0]


def test_default_request_limit_is_a_backstop() -> None:
    assert usage_limits(None).request_limit == output.DEFAULT_REQUEST_LIMIT
    assert usage_limits(JobLimits(max_llm_requests=3)).request_limit == 3


# Item 9: usage on failure


async def test_failed_run_carries_the_usage_it_accumulated() -> None:
    calls: list[str] = []

    def respond(mode: str, info: AgentInfo) -> ModelResponse:
        if mode == "tool":
            return ModelResponse(parts=[TextPart("not json")])  # invalid: PydanticAI re-prompts, then gives up
        raise ModelHTTPError(401, "m1", body=MARKER)

    with pytest.raises(EngineError) as info:
        await run(model_with(respond, calls=calls))
    err = info.value
    assert err.code == "provider_auth"
    assert err.usage is not None
    assert err.usage.output_mode is None
    assert err.usage.attempts == 2 and err.usage.requests == calls.count("tool")
    assert err.usage.input_tokens > 0 and err.usage.step == "probe" and err.usage.model == "m1"


def test_engine_error_usage_defaults_to_none() -> None:
    assert EngineError("internal").usage is None


# Item 10: the CLI never shows a traceback


def test_cli_turns_unexpected_exceptions_into_internal(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    (tmp_path / "connections.yaml").write_text(
        'llm:\n  default: {adapter: openai-compatible, base_url: "http://127.0.0.1:1/v1", model: m}\n'
    )

    async def boom(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError(MARKER)

    monkeypatch.setattr("aftertalk.cli._probe_llm", boom)
    result = CliRunner().invoke(
        app, ["--json", "providers", "test", "--kind", "llm"], env={"AFTERTALK_HOME": str(tmp_path)}
    )
    assert result.exit_code == 1
    assert json.loads(result.stdout) == {"ok": False, "code": "internal"}
    assert MARKER not in result.output and "Traceback" not in result.output
