from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class CliSettings(BaseSettings):
    """The settings the `aftertalk` command needs. It has no required fields, so no server secret is needed."""

    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    # Refuse LLM and speech endpoints that resolve to private, loopback or link-local addresses.
    # Turn on for a shared or hosted engine; leave off when your own models run on localhost.
    block_private_addresses: bool = False


class Settings(CliSettings):
    """Infrastructure settings, read from the environment. Providers come in each job request."""

    data_dir: str = "/data"
    engine_callback_secret: str
    web_url: str = "http://web:3000"
    log_level: Literal["debug", "info", "warning", "error"] = "info"


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


def get_cli_settings() -> CliSettings:
    """Read on every call (not cached): the command runs once, and tests change the environment."""
    return CliSettings()
