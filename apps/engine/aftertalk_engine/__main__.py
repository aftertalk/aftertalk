import uvicorn

from aftertalk_engine.logging import setup_logging
from aftertalk_engine.settings import get_settings


def main() -> None:
    settings = get_settings()
    setup_logging(settings.log_level)
    uvicorn.run("aftertalk_engine.api.app:app", host="0.0.0.0", port=8000, log_config=None)


if __name__ == "__main__":
    main()
