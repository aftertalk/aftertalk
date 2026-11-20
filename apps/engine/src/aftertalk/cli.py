"""The `aftertalk` command."""

import json
from importlib.metadata import version
from typing import Annotated, Any

import typer
import yaml

app = typer.Typer(name="aftertalk", no_args_is_help=True, add_completion=False)
config_app = typer.Typer(name="config", no_args_is_help=True, help="Inspect the connections file.")
app.add_typer(config_app)


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
