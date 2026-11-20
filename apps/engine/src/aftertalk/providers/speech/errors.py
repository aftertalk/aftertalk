"""Map a transcription response or a transport failure to an `EngineError`.

Works on a bare `httpx2.Response`. The code comes from the status and, at most, the JSON `error.code` and
`error.type`; no body text is ever put in an error. Callers build the error inside `except` and raise it after the
block, so the result carries no `__cause__` or `__context__`.
"""

import json
import math
import time
from collections.abc import Callable
from datetime import UTC
from email.utils import parsedate_to_datetime
from typing import Any

import httpx2

from aftertalk.models.errors import EngineError, ErrorCode
from aftertalk.models.usage import StepUsage

MAX_RETRY_AFTER = 60.0

_MODEL_CODES = frozenset({"model_not_found", "model_not_available", "deploymentnotfound"})
_QUOTA_CODES = frozenset({"insufficient_quota", "billing_hard_limit_reached", "quota_exceeded"})


def error_object(response: httpx2.Response) -> dict[str, Any]:
    """The JSON `error` object of a response, or {} when the body is not shaped like one."""
    try:
        body = json.loads(response.content)
    except ValueError:
        return {}
    error = body.get("error") if isinstance(body, dict) else None
    return error if isinstance(error, dict) else {}


def error_codes(response: httpx2.Response) -> set[str]:
    """`error.code` and `error.type`, lowercased. Used to classify; never put in a message."""
    error = error_object(response)
    return {str(error[key]).lower() for key in ("code", "type") if isinstance(error.get(key), str)}


def retry_after(response: httpx2.Response, now: Callable[[], float] = time.time) -> float | None:
    """Seconds from `Retry-After` (a number of seconds or an HTTP date), capped. None when absent or unusable."""
    raw = response.headers.get("retry-after")
    if raw is None:
        return None
    raw = raw.strip()
    try:
        seconds = float(raw)
    except ValueError:
        try:
            when = parsedate_to_datetime(raw)
        except (TypeError, ValueError, IndexError):
            return None
        if when.tzinfo is None:
            when = when.replace(tzinfo=UTC)
        seconds = when.timestamp() - now()
    return min(max(seconds, 0.0), MAX_RETRY_AFTER) if math.isfinite(seconds) else None


def status_code(response: httpx2.Response) -> ErrorCode | None:
    """The error code for a non-200 status, None for 200."""
    status = response.status_code
    if status == 200:
        return None
    codes = error_codes(response)
    if status in (401, 403):
        return "provider_auth"
    if status == 404:
        return "provider_model_not_found" if codes & _MODEL_CODES else "provider_bad_response"
    if status == 413:
        return "audio_too_long"
    if status == 429:
        return "provider_quota_exceeded" if codes & _QUOTA_CODES else "provider_rate_limited"
    if status == 408 or status >= 500:
        return "provider_unreachable"
    return "provider_bad_response"  # other 4xx, and 3xx: redirects are never followed


def response_error(response: httpx2.Response, usage: StepUsage | None = None) -> EngineError | None:
    code = status_code(response)
    return None if code is None else EngineError(code, usage)
