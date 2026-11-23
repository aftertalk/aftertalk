from pathlib import Path

import pytest

from aftertalk.config.profiles import Profile, ProfileError, default_path, load_profile

SECRET = "gsk_topsecretvalue"

YAML = """
llm:
  default:
    adapter: openai-compatible
    preset: groq
    base_url: https://api.groq.com/openai/v1
    api_key: ${GROQ_API_KEY}
    model: llama
speech:
  base_url: https://api.groq.com/openai/v1
  api_key: ${GROQ_API_KEY}
  model: whisper-large-v3
"""


def write(tmp_path: Path, text: str) -> Path:
    p = tmp_path / "connections.yaml"
    p.write_text(text, encoding="utf-8")
    return p


def test_loads_and_interpolates(tmp_path: Path) -> None:
    prof = load_profile(write(tmp_path, YAML), env={"GROQ_API_KEY": SECRET})
    assert prof.llm.default.api_key.get_secret_value() == SECRET
    assert prof.speech.api_key.get_secret_value() == SECRET
    assert SECRET not in repr(prof)


def test_embedded_and_escape(tmp_path: Path) -> None:
    text = """
llm:
  default:
    adapter: anthropic
    api_key: k
    model: pre-${M}-post
    extra_headers: {X-Lit: "$${NOT_A_VAR}"}
"""
    prof = load_profile(write(tmp_path, text), env={"M": "mid"})
    assert prof.llm.default.model == "pre-mid-post"
    assert prof.llm.default.extra_headers["X-Lit"].get_secret_value() == "${NOT_A_VAR}"


def test_missing_var_names_var_and_path(tmp_path: Path) -> None:
    with pytest.raises(ProfileError) as e:
        load_profile(write(tmp_path, YAML), env={})
    msg = str(e.value)
    assert "GROQ_API_KEY" in msg and "llm.default.api_key" in msg


def test_validation_error_has_no_secret(tmp_path: Path) -> None:
    text = f"""
llm:
  default:
    adapter: openai-compatible
    api_key: {SECRET}
    base_url: not a url
    model: m
    bogus: {SECRET}
"""
    with pytest.raises(ProfileError) as e:
        load_profile(write(tmp_path, text), env={})
    msg = str(e.value)
    assert SECRET not in msg
    assert "llm.default" in msg


def test_bad_key_neighbour_no_secret(tmp_path: Path) -> None:
    text = f"""
speech:
  base_url: https://x.test/v1/chat/completions
  api_key: {SECRET}
  model: m
"""
    with pytest.raises(ProfileError) as e:
        load_profile(write(tmp_path, text), env={})
    assert SECRET not in str(e.value) and "speech.base_url" in str(e.value)


def test_invalid_yaml(tmp_path: Path) -> None:
    with pytest.raises(ProfileError):
        load_profile(write(tmp_path, "a: [unclosed"), env={})
    with pytest.raises(ProfileError):
        load_profile(write(tmp_path, "- just\n- a list\n"), env={})


def test_missing_file_is_empty(tmp_path: Path) -> None:
    assert load_profile(tmp_path / "nope.yaml", env={}) == Profile()


def test_empty_file_is_empty(tmp_path: Path) -> None:
    assert load_profile(write(tmp_path, ""), env={}) == Profile()


def test_aftertalk_home(tmp_path: Path) -> None:
    (tmp_path / "connections.yaml").write_text("speech: {base_url: 'http://w:8000/v1', model: m}\n")
    assert default_path({"AFTERTALK_HOME": str(tmp_path)}) == tmp_path / "connections.yaml"
    prof = load_profile(env={"AFTERTALK_HOME": str(tmp_path)})
    assert prof.speech.model == "m"
    assert default_path({"HOME": "/h"}).name == "connections.yaml"
    assert default_path({}).parent.name == ".aftertalk"


def test_invalid_reference_no_echo(tmp_path: Path) -> None:
    text = "llm:\n  default: {adapter: anthropic, model: 'a-${bad name!}'}\n"
    with pytest.raises(ProfileError) as e:
        load_profile(write(tmp_path, text), env={})
    assert "llm.default.model" in str(e.value) and "bad name" not in str(e.value) and "${NAME}" in str(e.value)


def test_not_utf8(tmp_path: Path) -> None:
    p = tmp_path / "connections.yaml"
    p.write_bytes(b"llm: \xff\xfe\x00")
    with pytest.raises(ProfileError, match="not UTF-8"):
        load_profile(p, env={})


def test_empty_interpolated_key_names_path(tmp_path: Path) -> None:
    with pytest.raises(ProfileError) as e:
        load_profile(write(tmp_path, YAML), env={"GROQ_API_KEY": ""})
    assert "llm.default.api_key" in str(e.value) and "api_key is empty" in str(e.value)


def test_azure_profile_needs_version(tmp_path: Path) -> None:
    text = "llm:\n  default: {adapter: openai-compatible, preset: azure, base_url: 'https://a.test/openai', model: m}\n"
    with pytest.raises(ProfileError, match="api_version"):
        load_profile(write(tmp_path, text), env={})


def test_recursive_alias(tmp_path: Path) -> None:
    with pytest.raises(ProfileError, match="nested too deeply"):
        load_profile(write(tmp_path, "a: &x [*x]\n"), env={})


def test_alias_bomb_fails_fast(tmp_path: Path) -> None:
    import time

    lines = ["l0: &l0 [x, x, x, x, x, x, x, x, x]"]
    for i in range(1, 9):
        refs = ", ".join([f"*l{i - 1}"] * 9)
        lines.append(f"l{i}: &l{i} [{refs}]")
    started = time.monotonic()
    with pytest.raises(ProfileError, match="too large"):
        load_profile(write(tmp_path, "\n".join(lines) + "\n"), env={})
    assert time.monotonic() - started < 2


def test_alias_reuse_allowed(tmp_path: Path) -> None:
    text = """
llm:
  default: &d {adapter: openai-compatible, base_url: "http://o:11434/v1", model: m}
  fast: *d
"""
    prof = load_profile(write(tmp_path, text), env={})
    assert prof.llm.fast == prof.llm.default


def test_deep_flow_sequence_is_invalid_yaml(tmp_path: Path) -> None:
    with pytest.raises(ProfileError, match="nested too deeply|not valid YAML"):
        load_profile(write(tmp_path, "a: " + "[" * 5000 + "]" * 5000 + "\n"), env={})


def test_unknown_key_not_echoed(tmp_path: Path) -> None:
    text = """
llm:
  default:
    adapter: openai-compatible
    base_url: "http://o:11434/v1"
    model: m
    sk-SECRET123: 1
"""
    with pytest.raises(ProfileError) as e:
        load_profile(write(tmp_path, text), env={})
    assert "llm.default: unknown key" in str(e.value) and "sk-SECRET123" not in str(e.value)


def test_unknown_key_suggests_field(tmp_path: Path) -> None:
    text = """
llm:
  default:
    adapter: openai-compatible
    base_url: "http://o:11434/v1"
    modle: x
"""
    with pytest.raises(ProfileError) as e:
        load_profile(write(tmp_path, text), env={})
    assert "did you mean model?" in str(e.value) and "modle" not in str(e.value)


def test_unknown_top_level_key(tmp_path: Path) -> None:
    with pytest.raises(ProfileError) as e:
        load_profile(write(tmp_path, "sk-TOP: 1\n"), env={})
    assert "top level: unknown key" in str(e.value) and "sk-TOP" not in str(e.value)
