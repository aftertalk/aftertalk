from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Infrastructure settings, read from the environment. Providers come in each job request."""

    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    data_dir: str = "/data"
    engine_callback_secret: str
    web_url: str = "http://web:3000"
    log_level: Literal["debug", "info", "warning", "error"] = "info"


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
