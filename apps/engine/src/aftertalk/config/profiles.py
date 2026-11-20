"""Load `~/.aftertalk/connections.yaml`: the CLI-only connections file."""

import os
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, ConfigDict, ValidationError

from aftertalk.models.connections import ModelTiers, SpeechConnection


class ProfileError(Exception):
    """The connections file is unreadable or invalid. Messages never contain input values."""


class Profile(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)

    llm: ModelTiers | None = None
    speech: SpeechConnection | None = None


_VAR = re.compile(r"\$\$\{|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$\{")


def default_path(env: Mapping[str, str] | None = None) -> Path:
    env = os.environ if env is None else env
    home = env.get("AFTERTALK_HOME")
    base = Path(home).expanduser() if home else Path.home() / ".aftertalk"
    return base / "connections.yaml"


def _interpolate_string(text: str, env: Mapping[str, str], where: str) -> str:
    def repl(match: re.Match[str]) -> str:
        if match.group(0) == "$${":
            return "${"
        name = match.group(1)
        if name is None:
            raise ProfileError(f"invalid variable reference at {where}; use ${{NAME}}")
        if name not in env:
            raise ProfileError(f"environment variable {name} (used at {where}) is not set")
        return env[name]

    return _VAR.sub(repl, text)


def _interpolate(node: Any, env: Mapping[str, str], where: str) -> Any:
    if isinstance(node, str):
        return _interpolate_string(node, env, where)
    if isinstance(node, dict):
        return {k: _interpolate(v, env, f"{where}.{k}" if where else str(k)) for k, v in node.items()}
    if isinstance(node, list):
        return [_interpolate(v, env, f"{where}.{i}" if where else str(i)) for i, v in enumerate(node)]
    return node


def load_profile(path: Path | None = None, env: Mapping[str, str] | None = None) -> Profile:
    env = os.environ if env is None else env
    path = path if path is not None else default_path(env)
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return Profile()
    except UnicodeDecodeError:
        raise ProfileError(f"{path} is not UTF-8 text") from None
    except OSError as exc:
        raise ProfileError(f"cannot read {path}: {exc.strerror}") from None
    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError:
        raise ProfileError(f"{path} is not valid YAML") from None
    if data is None:
        return Profile()
    if not isinstance(data, dict):
        raise ProfileError(f"{path} must contain a mapping at the top level")
    data = _interpolate(data, env, "")
    try:
        return Profile.model_validate(data)
    except ValidationError as exc:
        problems = "; ".join(f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors())
        raise ProfileError(f"invalid {path}: {problems}") from None
