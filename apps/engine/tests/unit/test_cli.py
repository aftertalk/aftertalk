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


def _profile_home(tmp_path, text: str) -> dict[str, str]:
    (tmp_path / "connections.yaml").write_text(text, encoding="utf-8")
    return {"AFTERTALK_HOME": str(tmp_path), "K": "sk-cli-secret"}


GOOD = """
llm:
  default: {adapter: anthropic, model: m, api_key: "${K}"}
speech: {base_url: "http://w:8000/v1", model: w}
"""


def test_config_show_yaml_masks(tmp_path) -> None:
    env = _profile_home(tmp_path, GOOD)
    result = CliRunner().invoke(app, ["config", "show"], env=env)
    assert result.exit_code == 0
    assert "sk-cli-secret" not in result.output
    assert "'***'" in result.output or "***" in result.output
    assert "api_key: null" in result.output


def test_config_show_json_masks(tmp_path) -> None:
    import json

    env = _profile_home(tmp_path, GOOD)
    result = CliRunner().invoke(app, ["--json", "config", "show"], env=env)
    assert result.exit_code == 0
    data = json.loads(result.stdout)
    assert data["llm"]["default"]["api_key"] == "***"
    assert data["speech"]["api_key"] is None
    assert "sk-cli-secret" not in result.output


def test_config_show_bad_file_exits_2(tmp_path) -> None:
    env = _profile_home(tmp_path, "llm: [oops\n")
    result = CliRunner().invoke(app, ["config", "show"], env=env)
    assert result.exit_code == 2
    assert result.output.strip()
