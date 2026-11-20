import pytest
from pydantic import ValidationError

from aftertalk.settings import CliSettings, Settings, get_cli_settings


def test_block_private_addresses_defaults_to_off() -> None:
    assert get_cli_settings().block_private_addresses is False
    assert Settings().block_private_addresses is False  # type: ignore[call-arg]


@pytest.mark.parametrize(("raw", "expected"), [("true", True), ("1", True), ("false", False), ("0", False)])
def test_block_private_addresses_from_env(monkeypatch: pytest.MonkeyPatch, raw: str, expected: bool) -> None:
    monkeypatch.setenv("BLOCK_PRIVATE_ADDRESSES", raw)
    assert get_cli_settings().block_private_addresses is expected
    assert Settings().block_private_addresses is expected  # type: ignore[call-arg]


def test_cli_settings_do_not_require_the_callback_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ENGINE_CALLBACK_SECRET")
    CliSettings()
    with pytest.raises(ValidationError):
        Settings()  # type: ignore[call-arg]
