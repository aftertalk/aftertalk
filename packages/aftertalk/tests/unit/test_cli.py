from importlib.metadata import version

from typer.testing import CliRunner

from aftertalk.cli import app


def test_version() -> None:
    result = CliRunner().invoke(app, ["--version"])
    assert result.exit_code == 0
    assert result.output.strip() == version("aftertalk")


def test_no_args_shows_help() -> None:
    result = CliRunner().invoke(app, [])
    assert "serve" in result.output
