"""The `aftertalk` command."""

import asyncio
import json
import math
import os
import time
from collections.abc import Coroutine
from enum import StrEnum
from importlib.metadata import version
from pathlib import Path
from typing import Annotated, Any, get_args

import typer
import yaml

app = typer.Typer(name="aftertalk", no_args_is_help=True, add_completion=False)
config_app = typer.Typer(name="config", no_args_is_help=True, help="Inspect the connections file.")
app.add_typer(config_app)
providers_app = typer.Typer(name="providers", no_args_is_help=True, help="Check the providers you configured.")
app.add_typer(providers_app)


def _print_version(value: bool) -> None:
    if value:
        typer.echo(version("aftertalk"))
        raise typer.Exit()


@app.callback()
def main(
    ctx: typer.Context,
    json_output: Annotated[bool, typer.Option("--json", help="Machine-readable output.")] = False,
    _version: Annotated[
        bool, typer.Option("--version", callback=_print_version, is_eager=True, help="Show the version and exit.")
    ] = False,
) -> None:
    """Coworkers that act on transcripts, with your own keys and models."""
    ctx.obj = {"json": json_output}


def _mask_keys(node: Any) -> Any:
    if isinstance(node, dict):
        out: dict[str, Any] = {}
        for k, v in node.items():
            if k == "api_key" and v:
                out[k] = "***"
            elif k == "extra_headers" and isinstance(v, dict):
                out[k] = {name: "***" for name in v}
            else:
                out[k] = _mask_keys(v)
        return out
    return node


@config_app.command("show")
def config_show(ctx: typer.Context) -> None:
    """Print the connections file with keys masked."""
    from aftertalk.config.profiles import ProfileError, load_profile

    try:
        profile = load_profile()
    except ProfileError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(2)
    data = _mask_keys(profile.model_dump(mode="json"))
    if (ctx.obj or {}).get("json"):
        typer.echo(json.dumps(data, indent=2, ensure_ascii=False))
    else:
        typer.echo(yaml.safe_dump(data, sort_keys=False, allow_unicode=True).rstrip())


PROBE_TIMEOUT_SECONDS = 120  # one `providers test` run, all tries and modes included


async def _probe[T](coro: Coroutine[Any, Any, T]) -> T:
    """Run a provider probe under a time limit. Running out is `provider_unreachable`: it did not answer in time."""
    from aftertalk.models.errors import EngineError

    try:
        async with asyncio.timeout(PROBE_TIMEOUT_SECONDS):
            return await coro
    except TimeoutError:
        pass
    raise EngineError("provider_unreachable")


class Kind(StrEnum):
    llm = "llm"
    speech = "speech"


class OutputFormat(StrEnum):
    json = "json"
    text = "text"
    vtt = "vtt"
    srt = "srt"


async def _probe_llm(conn: Any, block_private: bool) -> tuple[int, str]:
    """Plain text first, then the structured-output ladder. Returns the latency and the output mode that worked."""
    from typing import Literal

    from pydantic import BaseModel
    from pydantic_ai import Agent

    from aftertalk.models.errors import EngineError
    from aftertalk.providers.errors import to_engine_error
    from aftertalk.providers.llm import open_model
    from aftertalk.providers.output import retry_capability, run_structured

    class Probe(BaseModel):
        answer: Literal["ok"]

    started = time.monotonic()
    async with open_model(conn, block_private=block_private) as model:
        error: EngineError | None = None
        try:
            reply = await Agent(model, capabilities=[retry_capability()]).run("Reply with the word ok")
            if "ok" not in reply.output.lower():
                error = EngineError("provider_bad_response")
        except Exception as exc:
            error = to_engine_error(exc)
        if error is not None:
            raise error  # raised outside the except block: nothing from the provider is chained to it
        _, usage = await run_structured(
            model,
            conn=conn,
            output_type=Probe,
            instructions="Answer with the single word ok.",
            prompt="Reply with the word ok",
            limits=None,
            step="providers_test",
        )
    return int((time.monotonic() - started) * 1000), usage.output_mode or conn.output_mode


async def _probe_speech(conn: Any, block_private: bool) -> tuple[int, str, bool]:
    """Send the bundled two-second clip through the same encoder as `transcribe`.

    Returns latency, timing and whether the provider reported a language we recognise: without one, a project that
    allows several languages fails with `language_not_allowed`.
    """
    from importlib import resources

    from aftertalk.audio.encode import open_encoded
    from aftertalk.providers.speech.openai_compatible import open_speech

    started = time.monotonic()
    with resources.as_file(resources.files("aftertalk") / "assets" / "test-2s.wav") as clip:
        async with open_encoded(clip, fmt=conn.audio_format, max_bytes=conn.max_upload_mb * 1024 * 1024) as audio:
            async with open_speech(conn, block_private=block_private) as provider:
                transcript, _ = await provider.transcribe(audio, language=None, prompt=None, deadline=None)
    return int((time.monotonic() - started) * 1000), transcript.timing, transcript.language is not None


def _speech_connection(file: Path | None) -> Any:
    """The profile's speech connection; exits 2 with a message when there is none."""
    from aftertalk.config.profiles import ProfileError, load_profile

    try:
        profile = load_profile(file)
    except ProfileError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(2)
    if profile.speech is None:
        typer.echo("no speech connection is configured; add speech to the connections file", err=True)
        raise typer.Exit(2)
    return profile.speech


def _failure(exc: Exception) -> Any:
    from aftertalk.models.errors import EngineError

    # No traceback for anything else: it could quote what the provider sent.
    return exc if isinstance(exc, EngineError) else EngineError("internal")


def _failure_json(failure: Any) -> str:
    data: dict[str, Any] = {"ok": False, "code": failure.code}
    if failure.detected_language is not None:
        data["detected_language"] = failure.detected_language  # a code from our language table
    return json.dumps(data)


def _failure_text(failure: Any) -> str:
    detected = f" (detected: {failure.detected_language})" if failure.detected_language is not None else ""
    return f"failed: {failure}{detected}"


def _cli_settings() -> Any:
    """The CLI settings; exits 2 when a setting is spelled in a form the engine does not read."""
    from aftertalk.settings import SettingsError, get_cli_settings

    try:
        return get_cli_settings()
    except SettingsError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(2)


@providers_app.command("test")
def providers_test(
    ctx: typer.Context,
    kind: Annotated[Kind, typer.Option(help="What to test.")],
    tier: Annotated[str, typer.Option(help="Which LLM tier: default, fast or smart.")] = "default",
    file: Annotated[Path | None, typer.Option(help="Connections file (default ~/.aftertalk/connections.yaml).")] = None,
) -> None:
    """Send a tiny request to a configured provider. Exit 0 ok, 1 provider failure, 2 configuration error."""
    from aftertalk.config.profiles import ProfileError, load_profile
    from aftertalk.models.connections import ModelTier
    from aftertalk.models.errors import EngineError

    as_json = bool((ctx.obj or {}).get("json"))
    if kind is Kind.speech:
        speech = _speech_connection(file)
        block_private = _cli_settings().block_private_addresses
        speech_failure: EngineError | None = None
        try:
            speech_ms, timing, language_reported = asyncio.run(_probe(_probe_speech(speech, block_private)))
        except Exception as exc:
            speech_failure = _failure(exc)
        if speech_failure is not None:
            typer.echo(_failure_json(speech_failure) if as_json else _failure_text(speech_failure))
            raise typer.Exit(1)
        if as_json:
            payload = {"ok": True, "latency_ms": speech_ms, "timing": timing, "language_reported": language_reported}
            typer.echo(json.dumps(payload))
        else:
            reported = "yes" if language_reported else "no (fails when several languages are allowed)"
            typer.echo(f"ok: speech answered in {speech_ms} ms (timestamps: {timing}, language reported: {reported})")
        return
    if tier not in get_args(ModelTier):
        typer.echo(f"unknown tier {tier!r}; use one of {', '.join(get_args(ModelTier))}", err=True)
        raise typer.Exit(2)
    try:
        profile = load_profile(file)
    except ProfileError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(2)
    if profile.llm is None:
        typer.echo("no llm connection is configured; add llm.default to the connections file", err=True)
        raise typer.Exit(2)
    settings = _cli_settings()
    conn = profile.llm.resolve(tier)  # type: ignore[arg-type]
    failure: EngineError | None = None
    try:
        latency_ms, mode = asyncio.run(_probe(_probe_llm(conn, settings.block_private_addresses)))
    except EngineError as err:
        failure = err
    except Exception:
        failure = EngineError("internal")  # no traceback: it could quote what the provider sent
    if failure is not None:
        # Only the code and its fixed sentence are printed, never what the provider sent.
        typer.echo(json.dumps({"ok": False, "code": failure.code}) if as_json else f"failed: {failure}")
        raise typer.Exit(1)
    if as_json:
        typer.echo(json.dumps({"ok": True, "latency_ms": latency_ms, "output_mode": mode}))
    else:
        typer.echo(f"ok: llm {tier} answered in {latency_ms} ms (output mode: {mode})")


TRANSCRIBE_TIMEOUT_SECONDS = 3600  # the shortest default for `aftertalk transcribe --timeout`


def default_timeout(duration_seconds: float | None) -> int:
    """`--timeout` when it is not given: 3600 s, or twice the file's duration when that is longer.

    An unknown duration (the container does not say, or the file cannot be read) gives 3600 s.
    """
    if duration_seconds is None:
        return TRANSCRIBE_TIMEOUT_SECONDS
    return max(TRANSCRIBE_TIMEOUT_SECONDS, math.ceil(2 * duration_seconds))


def _clock(seconds: float) -> str:
    whole = round(seconds)
    hours, rest = divmod(whole, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


def _progress(event: Any) -> None:
    """Progress lines on stderr: steps, the audio length and window counts, never text."""
    if event.step == "decode" and event.kind == "started":
        typer.echo("decoding audio", err=True)
    elif event.step == "decode" and event.kind == "finished" and event.audio_seconds is not None:
        typer.echo(f"audio length {_clock(event.audio_seconds)}", err=True)
    elif event.step == "transcribe" and event.kind in ("started", "progress"):
        done, total = event.windows_done, event.windows_total
        if done is not None and total is not None and done < total:
            typer.echo(f"transcribing window {done + 1}/{total}", err=True)


async def _transcribe(
    conn: Any, path: Path, language: str | None, prompt: str | None, block_private: bool, timeout: int
) -> Any:
    """Run the pipeline within `timeout` seconds, decoding included; running out is `limit_exceeded`."""
    from aftertalk.models.usage import JobLimits
    from aftertalk.pipeline import TranscribeOptions, transcribe_file
    from aftertalk.providers.speech.openai_compatible import open_speech

    options = TranscribeOptions(language=language, prompt=prompt, audio_format=conn.audio_format)
    async with open_speech(conn, block_private=block_private) as provider:
        return await transcribe_file(path, provider, options, JobLimits(timeout_seconds=timeout), _progress)


@app.command()
def transcribe(
    ctx: typer.Context,
    audio_file: Annotated[
        Path, typer.Argument(metavar="FILE", exists=True, dir_okay=False, readable=True, help="Audio or video file.")
    ],
    format: Annotated[
        OutputFormat, typer.Option("--format", "-f", help="How to write the result.")
    ] = OutputFormat.text,
    language: Annotated[str | None, typer.Option(help="Force the spoken language, for example pl.")] = None,
    prompt: Annotated[str | None, typer.Option(help="Names and terms to help the recogniser.")] = None,
    output: Annotated[Path | None, typer.Option("--output", "-o", help="Write here instead of stdout.")] = None,
    connections: Annotated[
        Path | None, typer.Option(help="Connections file (default ~/.aftertalk/connections.yaml).")
    ] = None,
    timeout: Annotated[
        int | None,
        typer.Option(
            min=1,
            show_default=False,
            help="Give up after this many seconds, decoding included. Default: 3600, or twice the file's duration "
            "when that is longer.",
        ),
    ] = None,
) -> None:
    """Transcribe a file with the speech connection. Exit 0 ok, 1 failure, 2 configuration or usage error.

    Any length: long audio is sent in windows of at most 10 minutes. Progress goes to stderr.
    `--format json` writes {"transcript": ..., "usage": [...]}, with one usage entry per step (decode, transcribe).
    """
    from aftertalk.audio.decode import probe_duration
    from aftertalk.models.errors import EngineError
    from aftertalk.providers.speech.languages import normalize_language
    from aftertalk.render import RenderError, render_srt, render_text, render_vtt, untimed_segments

    as_json = bool((ctx.obj or {}).get("json"))
    if language is not None and normalize_language(language) is None:
        typer.echo(f"unknown language {language!r}; use a code such as pl or en, or a name such as polish", err=True)
        raise typer.Exit(2)
    conn = _speech_connection(connections)
    block_private = _cli_settings().block_private_addresses
    seconds = timeout if timeout is not None else default_timeout(probe_duration(audio_file))
    failure: EngineError | None = None
    result: Any = None
    try:
        result = asyncio.run(_transcribe(conn, audio_file, language, prompt, block_private, seconds))
    except Exception as exc:
        failure = _failure(exc)
    if failure is not None:
        # Only the code and its fixed sentence are printed, never what the provider sent.
        if as_json:
            typer.echo(_failure_json(failure))
        else:
            typer.echo(_failure_text(failure), err=True)
        raise typer.Exit(1)
    transcript = result.transcript
    speech_format = next((u.speech_format for u in result.usage if u.step == "transcribe"), None)
    if speech_format is not None and speech_format != "verbose_json":
        typer.echo(
            f"the provider did not accept word timestamps (used {speech_format}); timestamps are limited",
            err=True,
        )
    text: str | None = None
    problem: str | None = None
    try:
        match format:
            case OutputFormat.json:
                payload = {
                    "transcript": transcript.model_dump(mode="json"),
                    "usage": [usage.model_dump(mode="json") for usage in result.usage],
                }
                text = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
            case OutputFormat.text:
                text = render_text(transcript)
            case OutputFormat.vtt:
                text = render_vtt(transcript)
            case OutputFormat.srt:
                text = render_srt(transcript)
        if format in (OutputFormat.vtt, OutputFormat.srt) and (skipped := untimed_segments(transcript)):
            typer.echo(f"skipped {skipped} segment(s) without timestamps", err=True)
    except RenderError as exc:
        problem = str(exc)
    if text is None:
        typer.echo(problem, err=True)
        raise typer.Exit(1)
    if output is None:
        typer.echo(text, nl=False)
        return
    try:
        # Created private (0600): a transcript is personal data. An existing file keeps its permissions.
        with os.fdopen(os.open(output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w", encoding="utf-8") as handle:
            handle.write(text)
    except OSError as exc:
        typer.echo(f"cannot write {output}: {exc.strerror}", err=True)
        raise typer.Exit(1)


@app.command()
def serve(
    host: Annotated[str, typer.Option(help="Address to listen on.")] = "127.0.0.1",
    port: Annotated[int, typer.Option(help="Port to listen on.")] = 8000,
) -> None:
    r"""Run the HTTP server the web app calls (needs the \[server] extra)."""
    try:
        import uvicorn
    except ImportError:
        typer.echo("aftertalk serve needs the server extra: pip install 'aftertalk[server]'", err=True)
        raise typer.Exit(1)

    from aftertalk.logging import setup_logging
    from aftertalk.settings import get_settings

    setup_logging(get_settings().log_level)
    uvicorn.run("aftertalk.api.app:app", host=host, port=port, log_config=None)
