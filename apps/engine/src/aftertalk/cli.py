"""The `aftertalk` command."""

from importlib.metadata import version
from typing import Annotated

import typer

app = typer.Typer(name="aftertalk", no_args_is_help=True, add_completion=False)


def _print_version(value: bool) -> None:
    if value:
        typer.echo(version("aftertalk"))
        raise typer.Exit()


@app.callback()
def main(
    _version: Annotated[
        bool, typer.Option("--version", callback=_print_version, is_eager=True, help="Show the version and exit.")
    ] = False,
) -> None:
    """Coworkers that act on transcripts, with your own keys and models."""


@app.command()
def serve(
    host: Annotated[str, typer.Option(help="Address to listen on.")] = "0.0.0.0",
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
