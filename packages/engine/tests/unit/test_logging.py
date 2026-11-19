import json
import logging

import pytest

from aftertalk_engine.logging import JsonFormatter, log, setup_logging


def test_log_writes_one_json_line_with_allowed_fields(capsys: pytest.CaptureFixture[str]) -> None:
    setup_logging("info")
    log("info", "step done", job_id="j1", step="transcribe", duration_ms=1200)
    line = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert line["msg"] == "step done"
    assert line["job_id"] == "j1" and line["step"] == "transcribe" and line["duration_ms"] == 1200
    assert line["level"] == "info"


def test_log_refuses_fields_outside_the_fixed_set() -> None:
    with pytest.raises(ValueError, match="transcript"):
        log("info", "oops", transcript="Dzień dobry")


def test_exception_message_is_not_logged() -> None:
    try:
        raise RuntimeError("provider said: secret body")
    except RuntimeError:
        import sys

        record = logging.LogRecord("x", logging.ERROR, __file__, 1, "failed", None, sys.exc_info())
    out = JsonFormatter().format(record)
    assert "secret body" not in out
    assert json.loads(out)["exc_type"] == "RuntimeError"
