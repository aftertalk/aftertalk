import json
import logging

import pytest

from aftertalk.logging import JsonFormatter, log, setup_logging


@pytest.fixture(autouse=True)
def restore_logging():
    """`setup_logging` changes the root logger; put it back so later tests see the logging they expect."""
    root = logging.getLogger()
    handlers, level = root.handlers[:], root.level
    yield
    root.handlers[:] = handlers
    root.setLevel(level)


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


@pytest.mark.parametrize("level", ["info", "debug"])
def test_http_clients_never_log_request_urls(fake_pyannote, capsys: pytest.CaptureFixture[str], level: str) -> None:
    """A presigned upload URL carries its signature: the HTTP client's own request lines must not reach the logs."""
    import asyncio

    from fake_pyannote import SIG

    from aftertalk.providers.net import make_client

    setup_logging(level)  # type: ignore[arg-type]

    async def put() -> None:
        async with make_client(block_private=False) as client:
            await client.put(f"{fake_pyannote.origin}/upload/1?sig={SIG}", content=b"x")

    asyncio.run(put())
    out = capsys.readouterr()
    assert SIG not in out.out and SIG not in out.err
    for name in ("httpx", "httpx2", "httpcore", "httpcore2"):
        assert not logging.getLogger(name).isEnabledFor(logging.INFO)


def test_http_clients_are_quiet_without_setup_logging(fake_pyannote, tmp_path) -> None:
    """Whatever logging a library caller sets up, before or after importing the engine, the HTTP client's request
    lines (URLs with signatures) stay out. In a fresh interpreter, so no earlier test's logging setup can hide it."""
    import subprocess
    import sys

    from fake_pyannote import SIG

    script = tmp_path / "probe.py"
    script.write_text(
        "import asyncio, logging, sys\n"
        "logging.basicConfig(level=logging.DEBUG, stream=sys.stderr)\n"
        "from aftertalk.providers.net import make_client\n"
        "async def put():\n"
        "    async with make_client(block_private=False) as client:\n"
        f"        await client.put('{fake_pyannote.origin}/upload/1?sig={SIG}', content=b'x')\n"
        "asyncio.run(put())\n"
        "print('done')\n",
        encoding="utf-8",
    )
    out = subprocess.run([sys.executable, str(script)], capture_output=True, text=True, timeout=60, check=True)
    assert "done" in out.stdout
    assert SIG not in out.stdout and SIG not in out.stderr
