import json
from pathlib import Path

import pytest
from fake_llm import FakeLLM, Forced
from typer.testing import CliRunner

from aftertalk.cli import app

KEY = "sk-cli-key-ABC123"
MARKER = "PROVIDER-BODY-MARKER-77"


def profile(tmp_path: Path, base_url: str, output_mode: str = "auto", extra: str = "") -> dict[str, str]:
    (tmp_path / "connections.yaml").write_text(
        f"""
llm:
  default: {{adapter: openai-compatible, base_url: "{base_url}", api_key: "${{K}}", model: m1, output_mode: {output_mode}}}
{extra}
""",
        encoding="utf-8",
    )
    return {"AFTERTALK_HOME": str(tmp_path), "K": KEY}


def invoke(env: dict[str, str], *args: str):
    return CliRunner().invoke(app, [*args], env=env)


def test_ok_json(fake_llm: FakeLLM, tmp_path: Path) -> None:
    env = profile(tmp_path, fake_llm.base_url)
    result = invoke(env, "--json", "providers", "test", "--kind", "llm")
    assert result.exit_code == 0, result.output
    data = json.loads(result.stdout)
    assert data["ok"] is True and data["output_mode"] == "tool" and data["latency_ms"] >= 0
    assert fake_llm.seen[0].headers["authorization"] == f"Bearer {KEY}"
    first = fake_llm.seen[0].body
    assert first["messages"][-1]["content"] == "Reply with the word ok"


def test_ok_human(fake_llm: FakeLLM, tmp_path: Path) -> None:
    result = invoke(profile(tmp_path, fake_llm.base_url), "providers", "test", "--kind", "llm")
    assert result.exit_code == 0
    assert "ok" in result.stdout.lower() and "tool" in result.stdout
    assert KEY not in result.output


def test_ladder_reaches_native_and_prompted(fake_llm: FakeLLM, tmp_path: Path) -> None:
    env = profile(tmp_path, fake_llm.base_url)
    fake_llm.reject = {"tool"}
    data = json.loads(invoke(env, "--json", "providers", "test", "--kind", "llm").stdout)
    assert data["ok"] and data["output_mode"] == "native"
    fake_llm.reject = {"tool", "native"}
    data = json.loads(invoke(env, "--json", "providers", "test", "--kind", "llm").stdout)
    assert data["ok"] and data["output_mode"] == "prompted"


def test_fixed_output_mode(fake_llm: FakeLLM, tmp_path: Path) -> None:
    env = profile(tmp_path, fake_llm.base_url, output_mode="prompted")
    data = json.loads(invoke(env, "--json", "providers", "test", "--kind", "llm").stdout)
    assert data["output_mode"] == "prompted"


def test_auth_failure_exits_1_and_hides_everything(
    fake_llm: FakeLLM, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level("DEBUG")
    fake_llm.always = Forced(401, json.dumps({"error": {"message": f"Incorrect API key {KEY} {MARKER}"}}))
    env = profile(tmp_path, fake_llm.base_url)
    result = invoke(env, "--json", "providers", "test", "--kind", "llm")
    assert result.exit_code == 1
    assert json.loads(result.stdout) == {"ok": False, "code": "provider_auth"}
    for text in (result.output, caplog.text, *(r.getMessage() for r in caplog.records)):
        assert KEY not in text and MARKER not in text
    for record in caplog.records:
        assert KEY not in json.dumps(getattr(record, "fields", {})) and MARKER not in repr(record.__dict__)


def test_failure_human_line(fake_llm: FakeLLM, tmp_path: Path) -> None:
    fake_llm.always = Forced(401, MARKER)
    result = invoke(profile(tmp_path, fake_llm.base_url), "providers", "test", "--kind", "llm")
    assert result.exit_code == 1
    assert "provider_auth" in result.output
    assert MARKER not in result.output and KEY not in result.output


def test_unreachable_server(tmp_path: Path, allow_requests: None) -> None:
    env = profile(tmp_path, "http://127.0.0.1:1/v1")
    result = invoke(env, "--json", "providers", "test", "--kind", "llm")
    assert result.exit_code == 1
    assert json.loads(result.stdout)["code"] == "provider_unreachable"


def test_private_addresses_blocked_by_setting(fake_llm: FakeLLM, tmp_path: Path) -> None:
    env = {**profile(tmp_path, fake_llm.base_url), "BLOCK_PRIVATE_ADDRESSES": "true"}
    result = invoke(env, "--json", "providers", "test", "--kind", "llm")
    assert result.exit_code == 1
    assert json.loads(result.stdout)["code"] == "provider_unreachable"
    assert fake_llm.seen == []


def test_cli_does_not_need_the_callback_secret(
    fake_llm: FakeLLM, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("ENGINE_CALLBACK_SECRET")
    result = invoke(profile(tmp_path, fake_llm.base_url), "--json", "providers", "test", "--kind", "llm")
    assert result.exit_code == 0, result.output


def test_tier_and_fallback_to_default(fake_llm: FakeLLM, tmp_path: Path) -> None:
    env = profile(tmp_path, fake_llm.base_url)
    assert invoke(env, "providers", "test", "--kind", "llm", "--tier", "fast").exit_code == 0
    assert invoke(env, "providers", "test", "--kind", "llm", "--tier", "huge").exit_code == 2


def test_fast_tier_uses_its_own_connection(fake_llm: FakeLLM, tmp_path: Path) -> None:
    extra = f'  fast: {{adapter: openai-compatible, base_url: "{fake_llm.base_url}", model: tiny}}'
    env = profile(tmp_path, fake_llm.base_url, extra=extra)
    assert invoke(env, "providers", "test", "--kind", "llm", "--tier", "fast").exit_code == 0
    assert fake_llm.seen[-1].body["model"] == "tiny"
    assert "authorization" in fake_llm.seen[-1].headers  # keyless sends the placeholder, not the real key
    assert KEY not in fake_llm.seen[-1].headers["authorization"]


def test_file_option(fake_llm: FakeLLM, tmp_path: Path) -> None:
    other = tmp_path / "other"
    other.mkdir()
    profile(other, fake_llm.base_url)
    elsewhere = tmp_path / "x.yaml"
    elsewhere.write_text((other / "connections.yaml").read_text(), encoding="utf-8")
    env = {"AFTERTALK_HOME": str(tmp_path / "nowhere"), "K": KEY}
    result = invoke(env, "providers", "test", "--kind", "llm", "--file", str(elsewhere))
    assert result.exit_code == 0, result.output


def test_no_llm_configured_is_a_config_error(tmp_path: Path) -> None:
    (tmp_path / "connections.yaml").write_text("speech: {base_url: 'http://w/v1', model: w}\n")
    result = invoke({"AFTERTALK_HOME": str(tmp_path)}, "providers", "test", "--kind", "llm")
    assert result.exit_code == 2


def test_bad_file_is_a_config_error(tmp_path: Path) -> None:
    (tmp_path / "connections.yaml").write_text("llm: [oops\n")
    result = invoke({"AFTERTALK_HOME": str(tmp_path)}, "--json", "providers", "test", "--kind", "llm")
    assert result.exit_code == 2


def test_speech_kind_without_a_speech_connection_is_a_config_error(tmp_path: Path) -> None:
    result = invoke({"AFTERTALK_HOME": str(tmp_path)}, "providers", "test", "--kind", "speech")
    assert result.exit_code == 2
    assert "no speech connection is configured" in result.output


def test_unknown_kind_is_rejected(tmp_path: Path) -> None:
    assert invoke({"AFTERTALK_HOME": str(tmp_path)}, "providers", "test", "--kind", "dns").exit_code == 2


def test_prefixed_setting_is_a_config_error(fake_llm: FakeLLM, tmp_path: Path) -> None:
    env = {**profile(tmp_path, fake_llm.base_url), "AFTERTALK_BLOCK_PRIVATE_ADDRESSES": "true"}
    result = invoke(env, "--json", "providers", "test", "--kind", "llm")
    assert result.exit_code == 2
    assert "AFTERTALK_BLOCK_PRIVATE_ADDRESSES is not read; set BLOCK_PRIVATE_ADDRESSES instead" in result.output
    assert fake_llm.seen == []


def test_probe_has_a_time_limit(tmp_path: Path, allow_requests: None, monkeypatch: pytest.MonkeyPatch) -> None:
    import socket
    import time

    import aftertalk.cli

    monkeypatch.setattr(aftertalk.cli, "PROBE_TIMEOUT_SECONDS", 0.2)
    with socket.socket() as silent:  # accepts connections (backlog) and never answers
        silent.bind(("127.0.0.1", 0))
        silent.listen(8)
        env = profile(tmp_path, f"http://127.0.0.1:{silent.getsockname()[1]}/v1")
        started = time.monotonic()
        result = invoke(env, "--json", "providers", "test", "--kind", "llm")
        elapsed = time.monotonic() - started
    assert result.exit_code == 1, result.output
    assert json.loads(result.stdout) == {"ok": False, "code": "provider_unreachable"}
    assert elapsed < 10  # far below the 600 s request timeout
