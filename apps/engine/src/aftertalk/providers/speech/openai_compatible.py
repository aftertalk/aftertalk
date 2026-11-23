"""Speech-to-text over the OpenAI-compatible `POST {base_url}/audio/transcriptions` API.

Plain `httpx2` on a client from `make_client`, not the OpenAI SDK: nothing is read from the environment
(`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, proxies), so a connection sends exactly what it configures.
`transcribe` is the only place that reads the key and the extra headers (`get_secret_value()`).

Errors are built inside `except` blocks and raised after them, so no provider text and no request (which carries the
`Authorization` header) is chained to them.
"""

import asyncio
import json
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass, replace
from typing import Any, Literal

import httpx2
from pydantic import ValidationError

from aftertalk.audio.encode import EncodedAudio
from aftertalk.models.connections import SpeechConnection
from aftertalk.models.errors import EngineError, ErrorCode
from aftertalk.models.transcript import Transcript
from aftertalk.models.usage import StepUsage
from aftertalk.providers.net import BlockedAddressError, make_client
from aftertalk.providers.speech.errors import error_object, response_error, retry_after
from aftertalk.providers.speech.languages import normalize_language
from aftertalk.providers.speech.parse import parse_transcription, reported_language
from aftertalk.providers.speech.protocols import SpeechCapabilities
from aftertalk.settings import get_cli_settings

DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # the usual ceiling: OpenAI, and Groq's free tier
ATTEMPTS = 3  # requests that may end in a retryable error, all rungs together
RETRY_WAITS = (2.0, 10.0)
REQUEST_TIMEOUT = 600.0  # seconds without progress in one phase of a request
MAX_REQUEST_SECONDS = 1800.0  # wall-clock cap for one request when the job has no deadline
CONNECT_TIMEOUT = 5.0

SpeechFormat = Literal["verbose_json", "verbose_json_segments", "json"]
# The request forms, most informative first: all timestamps, segments only, plain text.
RUNGS: tuple[SpeechFormat, ...] = ("verbose_json", "verbose_json_segments", "json")

Sleep = Callable[[float], Awaitable[None]]


@dataclass
class _Counters:
    attempts: int = 0  # requests sent, including those that never got an answer
    requests: int = 0  # requests that got a response
    failures: int = 0  # requests that ended in a retryable error: the shared retry budget
    format: SpeechFormat | None = None


class OpenAICompatibleSpeech:
    """Not tied to a client's lifetime: the caller closes `client` (see `open_speech`)."""

    capabilities = SpeechCapabilities(
        word_times=True,
        segment_times=True,
        speakers=False,
        channels=False,
        max_upload_bytes=DEFAULT_MAX_UPLOAD_BYTES,
    )

    def __init__(
        self,
        conn: SpeechConnection,
        client: httpx2.AsyncClient,
        *,
        max_upload_bytes: int | None = None,
        retry_waits: Sequence[float] | None = None,
        sleep: Sleep = asyncio.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._conn = conn
        self._client = client
        self._waits = tuple(RETRY_WAITS if retry_waits is None else retry_waits)
        self._sleep = sleep
        self._clock = clock
        limit = conn.max_upload_mb * 1024 * 1024 if max_upload_bytes is None else max_upload_bytes
        self.capabilities = replace(type(self).capabilities, max_upload_bytes=limit)

    async def transcribe(
        self,
        audio: EncodedAudio,
        *,
        language: str | None,
        prompt: str | None,
        deadline: float | None,
        allowed_languages: Sequence[str] | None = None,
    ) -> tuple[Transcript, StepUsage]:
        started = self._clock()
        counters = _Counters()

        def usage() -> StepUsage:
            return StepUsage(
                step="transcribe",
                provider="openai-compatible",
                model=self._conn.model,
                audio_seconds=audio.duration_seconds,
                requests=counters.requests,
                attempts=counters.attempts,
                speech_format=counters.format,
                duration_ms=int((self._clock() - started) * 1000),
            )

        forced = normalize_language(language) if language else None
        if language and forced is None:
            raise EngineError("provider_config_invalid", usage())
        limit = self.capabilities.max_upload_bytes
        if limit is not None and audio.size_bytes > limit:
            raise EngineError("audio_too_long", usage())
        body = audio.read()

        rung = 0
        temperature = True  # sent as 0 until the server rejects the field
        while True:
            counters.format = RUNGS[rung]
            response = await self._send(
                audio, body, RUNGS[rung], forced, prompt, temperature, deadline, counters, usage
            )
            if response.status_code not in (400, 422):
                break
            if temperature and _mentions(response, "temperature"):
                temperature = False  # resend the same rung once without it; counts in requests, not retries
                continue
            lower = _next_rung(response, rung)
            if lower is None:
                break
            rung = lower
        error = response_error(response, usage())
        if error is not None:
            raise error
        data: Any = None
        valid = True
        try:
            data = json.loads(response.content)
        except ValueError:
            valid = False
        if not valid:
            raise EngineError("provider_bad_response", usage())
        transcript: Transcript | None = None
        try:
            transcript = parse_transcription(data, audio_seconds=audio.duration_seconds, forced_language=forced)
        except EngineError as err:
            err.usage = usage()
            raise
        except (ValidationError, ValueError):
            pass
        if transcript is None:
            raise EngineError("provider_bad_response", usage())
        if forced is None and allowed_languages is not None and reported_language(data) is not None:
            # A provider that reports no language cannot be checked (text-only models); one that reports a
            # language we cannot map, or one that is not allowed, fails.
            allowed = {code for item in allowed_languages if (code := normalize_language(item)) is not None}
            if transcript.language is None or transcript.language not in allowed:
                # Our own code from the language table (None when it could not be mapped), never provider text.
                raise EngineError("language_not_allowed", usage(), detected_language=transcript.language)
        return transcript, usage()

    async def _send(
        self,
        audio: EncodedAudio,
        body: bytes,
        form: SpeechFormat,
        language: str | None,
        prompt: str | None,
        temperature: bool,
        deadline: float | None,
        counters: _Counters,
        usage: Callable[[], StepUsage],
    ) -> httpx2.Response:
        """One request, retried while the shared budget lasts. Returns the response, whatever its status.

        A request that timed out waiting for the answer is not retried: the provider may already have done (and
        billed) the work. Connect errors, write errors and dropped connections are retried.
        """
        fields: dict[str, str | list[str]] = {
            "model": self._conn.model,
            "response_format": "json" if form == "json" else "verbose_json",
        }
        if form == "verbose_json":
            fields["timestamp_granularities[]"] = ["word", "segment"]  # the literal name, one part per value
        if language:
            fields["language"] = language
        if prompt:
            fields["prompt"] = prompt
        if temperature:
            fields["temperature"] = "0"  # the same audio should give the same transcript
        headers = {name: value.get_secret_value() for name, value in self._conn.extra_headers.items()}
        if self._conn.api_key is not None:
            headers["Authorization"] = f"Bearer {self._conn.api_key.get_secret_value()}"
        url = f"{self._conn.base_url}/audio/transcriptions"

        while True:
            total = MAX_REQUEST_SECONDS
            if deadline is not None:
                remaining = deadline - self._clock()
                if remaining <= 0:
                    raise EngineError("limit_exceeded", usage())
                total = min(total, remaining)
            counters.attempts += 1
            response: httpx2.Response | None = None
            problem: ErrorCode | None = None  # set when the request failed without a response
            try:
                async with asyncio.timeout(total):
                    response = await self._client.post(
                        url,
                        data=fields,
                        files={"file": (audio.filename, body, audio.content_type)},
                        headers=headers,
                        timeout=httpx2.Timeout(min(REQUEST_TIMEOUT, total), connect=min(CONNECT_TIMEOUT, total)),
                    )
            except (TimeoutError, httpx2.ReadTimeout):
                late = deadline is not None and self._clock() >= deadline - 0.05
                problem = "limit_exceeded" if late else "provider_unreachable"
                counters.failures = ATTEMPTS  # no second try: the upload may already be transcribed and billed
            except BlockedAddressError:
                problem = "provider_unreachable"
                counters.failures = ATTEMPTS  # spend the whole budget: waiting does not unblock an address
            except (UnicodeEncodeError, httpx2.LocalProtocolError):
                problem = "provider_config_invalid"  # a header or field the client cannot send; retrying cannot help
            except httpx2.TransportError:
                problem = "provider_unreachable"
            except httpx2.HTTPError:
                problem = "provider_bad_response"
            except Exception:
                problem = "internal"
            # Nothing from the failed request is kept: only the code, so no exception (which holds the request and
            # its Authorization header) can be chained to what is raised below.
            pause: float | None = None
            if response is not None:
                counters.requests += 1
                error = response_error(response)
                if error is None or error.code not in ("provider_rate_limited", "provider_unreachable"):
                    return response
                pause = retry_after(response)
            else:
                assert problem is not None
                if problem != "provider_unreachable":
                    raise EngineError(problem, usage())
            counters.failures += 1
            if counters.failures >= ATTEMPTS:
                if response is None:
                    raise EngineError("provider_unreachable", usage())
                return response
            if pause is None:
                pause = self._waits[min(counters.failures - 1, len(self._waits) - 1)]
            if deadline is not None and pause >= deadline - self._clock():
                raise EngineError("limit_exceeded", usage())
            await self._sleep(pause)


def _mentions(response: httpx2.Response, name: str) -> bool:
    """Whether a 400 or 422 error's `param` or `message` names `name`."""
    error = error_object(response)
    return any(isinstance(item, str) and name in item.lower() for item in (error.get("param"), error.get("message")))


def _next_rung(response: httpx2.Response, rung: int) -> int | None:
    """The rung to retry on after a 400 or 422, or None when the error is not about timestamps or the format."""
    error = error_object(response)
    text = " ".join(item.lower() for item in (error.get("param"), error.get("message")) if isinstance(item, str))
    if rung == 0 and "timestamp_granularities" in text:
        return 1
    if rung <= 1 and ("response_format" in text or "verbose_json" in text):
        return 2
    return None


@asynccontextmanager
async def open_speech(conn: SpeechConnection, *, block_private: bool) -> AsyncIterator[OpenAICompatibleSpeech]:
    """The provider with its own HTTP client, which is always closed."""
    client = make_client(block_private=block_private, proxy=get_cli_settings().provider_proxy)
    try:
        yield OpenAICompatibleSpeech(conn, client)
    finally:
        await client.aclose()
