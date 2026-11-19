"""Speech-to-text over the OpenAI-compatible `POST {base_url}/audio/transcriptions` API.

Plain `httpx2` on a client from `make_client`, not the OpenAI SDK: nothing is read from the environment
(`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`), so a connection sends exactly what it configures.
`transcribe` is the only place that reads the key and the extra headers (`get_secret_value()`).

Errors are built inside `except` blocks and raised after them, so no provider text is chained to them.
"""

import asyncio
import json
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass, replace
from typing import Any

import httpx2
from pydantic import ValidationError

from aftertalk.audio.encode import EncodedAudio
from aftertalk.models.connections import SpeechConnection
from aftertalk.models.errors import EngineError
from aftertalk.models.transcript import Transcript
from aftertalk.models.usage import StepUsage
from aftertalk.providers.net import BlockedAddressError, make_client
from aftertalk.providers.speech.errors import (
    TRANSPORT_ERRORS,
    error_object,
    response_error,
    retry_after,
    transport_error,
)
from aftertalk.providers.speech.languages import normalize_language
from aftertalk.providers.speech.parse import parse_transcription
from aftertalk.providers.speech.protocols import SpeechCapabilities

DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # the usual ceiling: OpenAI, and Groq's free tier
ATTEMPTS = 3  # tries per request: the first, then after 2 s, then after 10 s
RETRY_WAITS = (2.0, 10.0)
REQUEST_TIMEOUT = 600.0  # seconds for one request; shortened to what is left of the deadline
CONNECT_TIMEOUT = 5.0
# A 400 or 422 that names one of these (or names no parameter) means "this server cannot do verbose_json".
_FALLBACK_PARAMS = ("response_format", "timestamp_granularities")

Sleep = Callable[[float], Awaitable[None]]


@dataclass(frozen=True)
class SpeechResult:
    transcript: Transcript
    usage: StepUsage
    fallback: bool  # the server rejected verbose_json and the transcript comes from a plain `json` request


@dataclass
class _Counters:
    attempts: int = 0  # requests sent, including those that never got an answer
    requests: int = 0  # requests that got a response


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
        max_upload_bytes: int | None = DEFAULT_MAX_UPLOAD_BYTES,
        retry_waits: Sequence[float] | None = None,
        sleep: Sleep = asyncio.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._conn = conn
        self._client = client
        self._waits = tuple(RETRY_WAITS if retry_waits is None else retry_waits)
        self._sleep = sleep
        self._clock = clock
        self.capabilities = replace(type(self).capabilities, max_upload_bytes=max_upload_bytes)

    async def transcribe(
        self,
        audio: EncodedAudio,
        *,
        language: str | None,
        prompt: str | None,
        deadline: float | None,
        allowed_languages: Sequence[str] | None = None,
    ) -> tuple[Transcript, StepUsage]:
        result = await self.transcribe_detailed(
            audio, language=language, prompt=prompt, deadline=deadline, allowed_languages=allowed_languages
        )
        return result.transcript, result.usage

    async def transcribe_detailed(
        self,
        audio: EncodedAudio,
        *,
        language: str | None,
        prompt: str | None,
        deadline: float | None,
        allowed_languages: Sequence[str] | None = None,
    ) -> SpeechResult:
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
                duration_ms=int((self._clock() - started) * 1000),
            )

        limit = self.capabilities.max_upload_bytes
        if limit is not None and audio.size_bytes > limit:
            raise EngineError("audio_too_long", usage())
        body = audio.read()

        response = await self._post(audio, body, "verbose_json", language, prompt, deadline, counters, usage)
        fallback = response.status_code in (400, 422) and _verbose_unsupported(response)
        if fallback:
            response = await self._post(audio, body, "json", language, prompt, deadline, counters, usage)
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
            transcript = parse_transcription(data, audio_seconds=audio.duration_seconds, forced_language=language)
        except EngineError as err:
            err.usage = usage()
            raise
        except (ValidationError, ValueError):
            pass
        if transcript is None:
            raise EngineError("provider_bad_response", usage())
        if language is None and allowed_languages is not None and transcript.language is not None:
            allowed = {code for item in allowed_languages if (code := normalize_language(item)) is not None}
            if transcript.language not in allowed:
                raise EngineError("language_not_allowed", usage())
        return SpeechResult(transcript, usage(), fallback)

    async def _post(
        self,
        audio: EncodedAudio,
        body: bytes,
        response_format: str,
        language: str | None,
        prompt: str | None,
        deadline: float | None,
        counters: _Counters,
        usage: Callable[[], StepUsage],
    ) -> httpx2.Response:
        """One logical request with up to `ATTEMPTS` tries. Returns the last response, whatever its status."""
        fields: dict[str, str | list[str]] = {"model": self._conn.model, "response_format": response_format}
        if response_format == "verbose_json":
            fields["timestamp_granularities[]"] = ["word", "segment"]  # the literal name, one part per value
        if language:
            fields["language"] = language
        if prompt:
            fields["prompt"] = prompt
        headers = {name: value.get_secret_value() for name, value in self._conn.extra_headers.items()}
        if self._conn.api_key is not None:
            headers["Authorization"] = f"Bearer {self._conn.api_key.get_secret_value()}"
        url = f"{self._conn.base_url}/audio/transcriptions"

        for attempt in range(ATTEMPTS):
            timeout = REQUEST_TIMEOUT
            if deadline is not None:
                remaining = deadline - self._clock()
                if remaining <= 0:
                    raise EngineError("limit_exceeded", usage())
                timeout = min(timeout, remaining)
            counters.attempts += 1
            response: httpx2.Response | None = None
            blocked = False
            try:
                response = await self._client.post(
                    url,
                    data=fields,
                    files={"file": (audio.filename, body, audio.content_type)},
                    headers=headers,
                    timeout=httpx2.Timeout(timeout, connect=min(CONNECT_TIMEOUT, timeout)),
                )
            except TRANSPORT_ERRORS as exc:
                blocked = isinstance(exc, BlockedAddressError)
            pause: float | None = None
            if response is not None:
                counters.requests += 1
                error = response_error(response)
                if error is None or error.code not in ("provider_rate_limited", "provider_unreachable"):
                    return response
                pause = retry_after(response)
            elif blocked:
                raise transport_error(usage())  # waiting does not unblock an address
            if attempt == ATTEMPTS - 1:
                if response is None:
                    raise transport_error(usage())
                return response
            if pause is None:
                pause = self._waits[min(attempt, len(self._waits) - 1)]
            if deadline is not None and pause >= deadline - self._clock():
                raise EngineError("limit_exceeded", usage())
            await self._sleep(pause)
        raise AssertionError("unreachable")  # the loop returns or raises on its last attempt


def _verbose_unsupported(response: httpx2.Response) -> bool:
    """A 400 or 422 about `response_format`, the granularities, or naming no parameter at all."""
    error = error_object(response)
    param = error.get("param")
    message = error.get("message")
    text = " ".join(item.lower() for item in (param, message) if isinstance(item, str))
    if any(name in text for name in _FALLBACK_PARAMS):
        return True
    return not (isinstance(param, str) and param.strip())


@asynccontextmanager
async def open_speech(conn: SpeechConnection, *, block_private: bool) -> AsyncIterator[OpenAICompatibleSpeech]:
    """The provider with its own HTTP client, which is always closed."""
    client = make_client(block_private=block_private)
    try:
        yield OpenAICompatibleSpeech(conn, client)
    finally:
        await client.aclose()
