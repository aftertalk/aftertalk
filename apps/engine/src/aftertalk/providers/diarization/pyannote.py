"""Speaker diarization with pyannote.ai (adapter `pyannote-ai`), ported from the old service's `pyannote.py`.

The flow (spec, Adapters): `POST {base_url}/media/input` for an upload address, `PUT` the WAV to that presigned URL,
`POST {base_url}/diarize` to create a job, then `GET {base_url}/jobs/{id}` every `POLL_INTERVAL` seconds.

- One client from `make_client` for every request, the presigned upload included: with `BLOCK_PRIVATE_ADDRESSES` the
  guard checks the upload host too, and redirects are never followed. The upload address must be https (or http when
  `base_url` is http: an own server, the tests) and is never logged or put in an error: it carries a signature.
- The key goes only to the three `{base_url}` requests, never to the upload host; it is read when a request is built.
- Each request is tried up to `ATTEMPTS` times on a connection error, a timeout, 408, 429 or 5xx (waits
  `RETRY_WAITS`, or `Retry-After`). Job creation is not sent again after a timeout once it was sent: a job may exist,
  and pyannote bills every job that succeeds. There is no endpoint to cancel a job, so one we stop polling runs on.
- Polling stops at the larger of `MIN_POLL_SECONDS` and half the audio's length, and always at the deadline: both are
  `limit_exceeded` (`PollingTimeout` for the cap, so the CLI can say which).
- `exclusive: true` asks for one speaker at a time; `exclusiveDiarization` is read when the answer has it.
- Errors carry a fixed code and the usage so far, never provider text, and are raised outside `except` blocks.
"""

import asyncio
import json
import math
import re
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import httpx2

from aftertalk.models.connections import DiarizationConnection
from aftertalk.models.errors import EngineError, ErrorCode
from aftertalk.models.usage import StepUsage
from aftertalk.providers.diarization.protocols import (
    DiarizationCapabilities,
    DiarizationOutput,
    DiarizationSegment,
    DiarizationUpload,
)
from aftertalk.providers.net import BlockedAddressError, make_client
from aftertalk.providers.speech.errors import retry_after
from aftertalk.settings import get_cli_settings

__all__ = ["MODEL", "PollingTimeout", "PyannoteDiarization", "open_diarization"]

MODEL = "community-1"  # spec item 67; sent explicitly (the API's own default differs)
ATTEMPTS = 3
RETRY_WAITS = (2.0, 10.0)
POLL_INTERVAL = 2.0
MIN_POLL_SECONDS = 300.0  # the cloud's cap; a long file gets half its length
PHASE_TIMEOUT = 30.0  # seconds without progress in one phase of a request (the old client's timeout)
CONNECT_TIMEOUT = 5.0
JSON_REQUEST_SECONDS = 60.0  # wall-clock cap for one JSON request
MAX_UPLOAD_SECONDS = 1800.0  # wall-clock cap for the upload when the job has no deadline
MAX_UPLOAD_BYTES = 1024**3  # pyannote.ai's media limit
MAX_AUDIO_SECONDS = 24 * 3600.0
MAX_URL_CHARS = 4096
_JOB_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_RUNNING = frozenset({"pending", "created", "running"})

Sleep = Callable[[float], Awaitable[None]]


class PollingTimeout(EngineError):
    """The job did not finish within the polling cap (not the run's deadline). Code `limit_exceeded`."""

    def __init__(self, usage: StepUsage | None = None) -> None:
        super().__init__("limit_exceeded", usage)


@dataclass
class _Counters:
    started: float | None = None
    attempts: int = 0  # requests sent, also those that never got an answer
    requests: int = 0  # requests that got a response
    audio_seconds: float | None = None  # set once job creation was attempted: what may be billed


def _status_code(status: int, *, upload: bool) -> ErrorCode:
    if status == 402:
        return "provider_quota_exceeded"
    if status in (401, 403):
        return "provider_bad_response" if upload else "provider_auth"  # the presigned URL is pyannote's, not our key
    if status == 413 and upload:
        return "audio_too_long"
    if status == 429:
        return "provider_rate_limited"
    if status == 408 or status >= 500:
        return "provider_unreachable"
    return "provider_bad_response"  # other 4xx, and 3xx: redirects are never followed


def _retryable(status: int) -> bool:
    return status in (408, 429) or status >= 500


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _segments(items: Any) -> tuple[DiarizationSegment, ...] | None:
    """The answer's segments, or None when the list is not one we can use (the whole answer is then bad)."""
    if not isinstance(items, list):
        return None
    out: list[DiarizationSegment] = []
    for item in items:
        if not isinstance(item, dict):
            return None
        start, end, speaker = _number(item.get("start")), _number(item.get("end")), item.get("speaker")
        if start is None or end is None or start < 0 or not isinstance(speaker, str) or not speaker.strip():
            return None
        if end > start:  # a segment of no length is dropped
            out.append(DiarizationSegment(start=start, end=end, speaker=speaker))
    return tuple(out)


def _body(response: httpx2.Response) -> Any:
    try:
        return json.loads(response.content)
    except ValueError:
        return None


class PyannoteDiarization:
    """One instance per run (one file, one job): it sums the run's requests into one usage entry."""

    name = "pyannote-ai"
    capabilities = DiarizationCapabilities(max_upload_bytes=MAX_UPLOAD_BYTES, max_audio_seconds=MAX_AUDIO_SECONDS)

    def __init__(
        self,
        conn: DiarizationConnection,
        client: httpx2.AsyncClient,
        *,
        poll_interval: float = POLL_INTERVAL,
        min_poll_seconds: float = MIN_POLL_SECONDS,
        retry_waits: Sequence[float] | None = None,
        sleep: Sleep = asyncio.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._conn = conn
        self._client = client
        self._poll_interval = poll_interval
        self._min_poll = min_poll_seconds
        self._waits = tuple(RETRY_WAITS if retry_waits is None else retry_waits)
        self._sleep = sleep
        self._clock = clock
        self._counters = _Counters()

    def usage(self) -> StepUsage:
        c = self._counters
        return StepUsage(
            step="diarize",
            provider=self.name,
            model=MODEL,
            requests=c.requests,
            attempts=c.attempts,
            audio_seconds=None if c.audio_seconds is None else round(c.audio_seconds, 3),
            duration_ms=0 if c.started is None else max(0, int((self._clock() - c.started) * 1000)),
        )

    def _fail(self, code: ErrorCode) -> EngineError:
        return EngineError(code, self.usage())

    def _auth(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._conn.api_key.get_secret_value()}"}

    async def check(self, *, deadline: float | None) -> None:
        await self._upload_address(deadline)  # the address is thrown away: a fresh one is asked for the upload

    async def diarize(self, audio: DiarizationUpload, *, deadline: float | None) -> tuple[DiarizationOutput, StepUsage]:
        limit = self.capabilities.max_upload_bytes
        if (limit is not None and audio.size_bytes > limit) or audio.duration_seconds > MAX_AUDIO_SECONDS:
            raise self._fail("audio_too_long")
        media, url = await self._upload_address(deadline)
        await self._upload(url, audio, deadline)
        job = await self._create(media, audio, deadline)
        output = await self._poll(job, audio.duration_seconds, deadline)
        return output, self.usage()

    async def _upload_address(self, deadline: float | None) -> tuple[str, str]:
        media = f"media://aftertalk-{uuid.uuid4().hex}.wav"  # random: never the file name or its hash
        response = await self._send(
            lambda timeout: self._client.post(
                f"{self._conn.base_url}/media/input", json={"url": media}, headers=self._auth(), timeout=timeout
            ),
            wall=JSON_REQUEST_SECONDS,
            deadline=deadline,
            resend_after_timeout=True,
        )
        data = _body(response)
        url = data.get("url") if isinstance(data, dict) else None
        if not self._upload_url_ok(url):
            raise self._fail("provider_bad_response")
        assert isinstance(url, str)
        return media, url

    def _upload_url_ok(self, url: Any) -> bool:
        if not isinstance(url, str) or not url or len(url) > MAX_URL_CHARS:
            return False
        try:
            parts = urlsplit(url)
            host = parts.hostname
        except ValueError:
            return False
        if not host or "@" in parts.netloc or any(c in url for c in "\r\n\t "):
            return False
        allowed = {"https"} if urlsplit(self._conn.base_url).scheme == "https" else {"https", "http"}
        return parts.scheme in allowed

    async def _upload(self, url: str, audio: DiarizationUpload, deadline: float | None) -> None:
        headers = {"Content-Type": "application/octet-stream", "Content-Length": str(audio.size_bytes)}
        await self._send(
            lambda timeout: self._client.put(url, content=audio.chunks(), headers=headers, timeout=timeout),
            wall=MAX_UPLOAD_SECONDS,
            deadline=deadline,
            resend_after_timeout=True,  # a repeat overwrites the same object
            upload=True,
        )

    async def _create(self, media: str, audio: DiarizationUpload, deadline: float | None) -> str:
        body = {"url": media, "model": MODEL, "exclusive": True}
        self._counters.audio_seconds = audio.duration_seconds  # from here a job may exist and be billed
        response = await self._send(
            lambda timeout: self._client.post(
                f"{self._conn.base_url}/diarize", json=body, headers=self._auth(), timeout=timeout
            ),
            wall=JSON_REQUEST_SECONDS,
            deadline=deadline,
            resend_after_timeout=False,
        )
        data = _body(response)
        job = data.get("jobId") if isinstance(data, dict) else None
        if not isinstance(job, str) or not _JOB_ID.match(job):
            raise self._fail("provider_bad_response")
        return job

    async def _poll(self, job: str, audio_seconds: float, deadline: float | None) -> DiarizationOutput:
        stop_at = self._clock() + max(self._min_poll, audio_seconds / 2)
        url = f"{self._conn.base_url}/jobs/{job}"
        while True:
            response = await self._send(
                lambda timeout: self._client.get(url, headers=self._auth(), timeout=timeout),
                wall=JSON_REQUEST_SECONDS,
                deadline=deadline,
                resend_after_timeout=True,
            )
            data = _body(response)
            status = data.get("status") if isinstance(data, dict) else None
            if not isinstance(status, str):
                raise self._fail("provider_bad_response")
            if status == "succeeded":
                return self._output(data)
            if status in ("failed", "canceled"):
                raise self._fail("provider_bad_response")
            # Any other status (pending, created, running, or one added later) keeps polling.
            now = self._clock()
            if deadline is not None and now >= deadline:
                raise self._fail("limit_exceeded")
            if now >= stop_at:
                raise PollingTimeout(self.usage())
            pause = min(self._poll_interval, stop_at - now)
            if deadline is not None:
                pause = min(pause, deadline - now)
            await self._sleep(max(0.0, pause))

    def _output(self, data: dict[str, Any]) -> DiarizationOutput:
        output = data.get("output")
        if not isinstance(output, dict):
            raise self._fail("provider_bad_response")
        exclusive = output.get("exclusiveDiarization")
        source = exclusive if isinstance(exclusive, list) and exclusive else output.get("diarization")
        segments = _segments(source)
        if segments is None:
            raise self._fail("provider_bad_response")
        return DiarizationOutput(segments=segments)

    async def _send(
        self,
        request: Callable[[httpx2.Timeout], Awaitable[httpx2.Response]],
        *,
        wall: float,
        deadline: float | None,
        resend_after_timeout: bool,
        upload: bool = False,
    ) -> httpx2.Response:
        """One request with its own retry budget. Returns a 200 or 201 response; anything else raises."""
        counters = self._counters
        if counters.started is None:
            counters.started = self._clock()
        failures = 0
        while True:
            total = wall
            if deadline is not None:
                remaining = deadline - self._clock()
                if remaining <= 0:
                    raise self._fail("limit_exceeded")
                total = min(total, remaining)
            counters.attempts += 1
            response: httpx2.Response | None = None
            problem: ErrorCode | None = None
            try:
                async with asyncio.timeout(total):
                    response = await request(
                        httpx2.Timeout(min(PHASE_TIMEOUT, total), connect=min(CONNECT_TIMEOUT, total))
                    )
            except (TimeoutError, httpx2.ReadTimeout):
                late = deadline is not None and self._clock() >= deadline - 0.05
                problem = "limit_exceeded" if late else "provider_unreachable"
                if not resend_after_timeout:
                    failures = ATTEMPTS  # the request may have been acted on: never sent twice
            except BlockedAddressError:
                problem = "provider_unreachable"
                failures = ATTEMPTS  # waiting does not unblock an address
            except (UnicodeEncodeError, httpx2.LocalProtocolError):
                problem = "provider_config_invalid"
            except httpx2.TransportError:
                problem = "provider_unreachable"
            except httpx2.HTTPError:
                problem = "provider_bad_response"
            except Exception:
                problem = "internal"
            pause: float | None = None
            if response is not None:
                counters.requests += 1
                status = response.status_code
                if status in (200, 201):
                    return response
                if not _retryable(status):
                    raise self._fail(_status_code(status, upload=upload))
                problem = _status_code(status, upload=upload)
                pause = retry_after(response)
                response = None
            assert problem is not None
            if problem not in ("provider_unreachable", "provider_rate_limited"):
                raise self._fail(problem)
            failures += 1
            if failures >= ATTEMPTS:
                raise self._fail(problem)
            if pause is None:
                pause = self._waits[min(failures - 1, len(self._waits) - 1)]
            if deadline is not None and pause >= deadline - self._clock():
                raise self._fail("limit_exceeded")
            await self._sleep(pause)


@asynccontextmanager
async def open_diarization(conn: DiarizationConnection, *, block_private: bool) -> AsyncIterator[PyannoteDiarization]:
    """The provider with its own HTTP client, which is always closed. One per run."""
    client = make_client(block_private=block_private, proxy=get_cli_settings().provider_proxy)
    try:
        yield PyannoteDiarization(conn, client)
    finally:
        await client.aclose()
