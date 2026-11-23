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


def test_prefixed_setting_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    from aftertalk.settings import SettingsError, get_settings

    monkeypatch.setenv("AFTERTALK_BLOCK_PRIVATE_ADDRESSES", "1")
    with pytest.raises(
        SettingsError, match="AFTERTALK_BLOCK_PRIVATE_ADDRESSES is not read; set BLOCK_PRIVATE_ADDRESSES"
    ):
        get_cli_settings()
    get_settings.cache_clear()
    with pytest.raises(SettingsError, match="set BLOCK_PRIVATE_ADDRESSES instead"):
        get_settings()
    get_settings.cache_clear()


def test_aftertalk_home_is_not_a_setting(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    from aftertalk.settings import get_settings

    monkeypatch.setenv("AFTERTALK_HOME", str(tmp_path))
    get_cli_settings()
    get_settings.cache_clear()
    get_settings()
    get_settings.cache_clear()
