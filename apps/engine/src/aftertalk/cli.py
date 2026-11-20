"""The `aftertalk` command."""

import asyncio
import json
import time
from enum import StrEnum
from importlib.metadata import version
from pathlib import Path
from typing import Annotated, Any, get_args

import typer
import yaml

app = typer.Typer(name="aftertalk", no_args_is_help=True, add_completion=False)
config_app = typer.Typer(name="config", no_args_is_help=True, help="Inspect the connections file.")
app.add_typer(config_app)
providers_app = typer.Typer(name="providers", no_args_is_help=True, help="Check the providers you configured.")
app.add_typer(providers_app)


def _print_version(value: bool) -> None:
    if value:
        typer.echo(version("aftertalk"))
        raise typer.Exit()


@app.callback()
def main(
    ctx: typer.Context,
    json_output: Annotated[bool, typer.Option("--json", help="Machine-readable output.")] = False,
    _version: Annotated[
        bool, typer.Option("--version", callback=_print_version, is_eager=True, help="Show the version and exit.")
    ] = False,
) -> None:
    """Coworkers that act on transcripts, with your own keys and models."""
    ctx.obj = {"json": json_output}


def _mask_keys(node: Any) -> Any:
    if isinstance(node, dict):
        out: dict[str, Any] = {}
        for k, v in node.items():
            if k == "api_key" and v:
                out[k] = "***"
            elif k == "extra_headers" and isinstance(v, dict):
                out[k] = {name: "***" for name in v}
            else:
                out[k] = _mask_keys(v)
        return out
    return node


@config_app.command("show")
def config_show(ctx: typer.Context) -> None:
    """Print the connections file with keys masked."""
    from aftertalk.config.profiles import ProfileError, load_profile

    try:
        profile = load_profile()
    except ProfileError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(2)
    data = _mask_keys(profile.model_dump(mode="json"))
    if (ctx.obj or {}).get("json"):
        typer.echo(json.dumps(data, indent=2, ensure_ascii=False))
    else:
        typer.echo(yaml.safe_dump(data, sort_keys=False, allow_unicode=True).rstrip())


class Kind(StrEnum):
    llm = "llm"
    speech = "speech"


async def _probe_llm(conn: Any, block_private: bool) -> tuple[int, str]:
    """Plain text first, then the structured-output ladder. Returns the latency and the output mode that worked."""
    from typing import Literal

    from pydantic import BaseModel
    from pydantic_ai import Agent

    from aftertalk.models.errors import EngineError
    from aftertalk.providers.errors import to_engine_error
    from aftertalk.providers.llm import open_model
    from aftertalk.providers.output import retry_capability, run_structured

    class Probe(BaseModel):
        answer: Literal["ok"]

    started = time.monotonic()
    async with open_model(conn, block_private=block_private) as model:
        error: EngineError | None = None
        try:
            reply = await Agent(model, capabilities=[retry_capability()]).run("Reply with the word ok")
            if "ok" not in reply.output.lower():
                error = EngineError("provider_bad_response")
        except Exception as exc:
            error = to_engine_error(exc)
        if error is not None:
            raise error  # raised outside the except block: nothing from the provider is chained to it
        _, usage = await run_structured(
            model,
            conn=conn,
            output_type=Probe,
            instructions="Answer with the single word ok.",
            prompt="Reply with the word ok",
            limits=None,
            step="providers_test",
        )
    return int((time.monotonic() - started) * 1000), usage.output_mode or conn.output_mode


@providers_app.command("test")
def providers_test(
    ctx: typer.Context,
    kind: Annotated[Kind, typer.Option(help="What to test.")],
    tier: Annotated[str, typer.Option(help="Which LLM tier: default, fast or smart.")] = "default",
    file: Annotated[Path | None, typer.Option(help="Connections file (default ~/.aftertalk/connections.yaml).")] = None,
) -> None:
    """Send a tiny request to a configured provider. Exit 0 ok, 1 provider failure, 2 configuration error."""
    from aftertalk.config.profiles import ProfileError, load_profile
    from aftertalk.models.connections import ModelTier
    from aftertalk.models.errors import EngineError
    from aftertalk.settings import get_cli_settings

    as_json = bool((ctx.obj or {}).get("json"))
    if kind is Kind.speech:
        typer.echo("speech test arrives in the next PR", err=True)
        raise typer.Exit(2)
    if tier not in get_args(ModelTier):
        typer.echo(f"unknown tier {tier!r}; use one of {', '.join(get_args(ModelTier))}", err=True)
        raise typer.Exit(2)
    try:
        profile = load_profile(file)
    except ProfileError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(2)
    if profile.llm is None:
        typer.echo("no llm connection is configured; add llm.default to the connections file", err=True)
        raise typer.Exit(2)
    conn = profile.llm.resolve(tier)  # type: ignore[arg-type]
    failure: EngineError | None = None
    try:
        latency_ms, mode = asyncio.run(_probe_llm(conn, get_cli_settings().block_private_addresses))
    except EngineError as err:
        failure = err
    except Exception:
        failure = EngineError("internal")  # no traceback: it could quote what the provider sent
    if failure is not None:
        # Only the code and its fixed sentence are printed, never what the provider sent.
        typer.echo(json.dumps({"ok": False, "code": failure.code}) if as_json else f"failed: {failure}")
        raise typer.Exit(1)
    if as_json:
        typer.echo(json.dumps({"ok": True, "latency_ms": latency_ms, "output_mode": mode}))
    else:
        typer.echo(f"ok: llm {tier} answered in {latency_ms} ms (output mode: {mode})")


@app.command()
def serve(
    host: Annotated[str, typer.Option(help="Address to listen on.")] = "127.0.0.1",
    port: Annotated[int, typer.Option(help="Port to listen on.")] = 8000,
) -> None:
    r"""Run the HTTP server the web app calls (needs the \[server] extra)."""
    try:
        import uvicorn
    except ImportError:
        typer.echo("aftertalk serve needs the server extra: pip install 'aftertalk[server]'", err=True)
        raise typer.Exit(1)

    from aftertalk.logging import setup_logging
    from aftertalk.settings import get_settings

    setup_logging(get_settings().log_level)
    uvicorn.run("aftertalk.api.app:app", host=host, port=port, log_config=None)
