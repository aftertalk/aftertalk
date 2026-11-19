"""JSON logs on stdout with a fixed set of fields (spec: Logging section).

Provider response bodies, transcript text and keys are never logged: a log call
accepts only the fields below, and anything else raises.
"""

import json
import logging
import sys
import time
from typing import Literal

ALLOWED_FIELDS = frozenset(
    {"job_id", "call_id", "project_id", "user_id", "attempt", "step", "error_code", "duration_ms"}
)

Level = Literal["debug", "info", "warning", "error"]

_logger = logging.getLogger("aftertalk_engine")


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        line: dict[str, object] = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)) + f".{int(record.msecs):03d}Z",
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
        }
        line.update(getattr(record, "fields", {}))
        if record.exc_info and record.exc_info[0] is not None:
            # The exception type only: messages can carry provider response text.
            line["exc_type"] = record.exc_info[0].__name__
        return json.dumps(line, ensure_ascii=False)


def setup_logging(level: Level = "info") -> None:
    """Route every logger (ours, uvicorn's, libraries') through one JSON handler on stdout."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logging.getLogger(name).handlers[:] = []
        logging.getLogger(name).propagate = True


def log(level: Level, msg: str, **fields: object) -> None:
    unknown = fields.keys() - ALLOWED_FIELDS
    if unknown:
        raise ValueError(f"log fields not allowed: {sorted(unknown)}")
    _logger.log(getattr(logging, level.upper()), msg, extra={"fields": fields})
