"""Error codes shared with web. A code, never provider text, is all that leaves the engine."""

from typing import Literal, get_args

from pydantic import BaseModel

from aftertalk.models.usage import StepUsage

ErrorCode = Literal[
    "provider_auth",
    "provider_unreachable",
    "provider_rate_limited",
    "provider_quota_exceeded",
    "provider_model_not_found",
    "provider_context_too_long",
    "provider_bad_response",
    "provider_output_invalid",
    "provider_refused",
    "provider_config_invalid",
    "limit_exceeded",
    "internal",
]

_SENTENCES: dict[ErrorCode, str] = {
    "provider_auth": "The provider rejected the API key or the account may not use this model.",
    "provider_unreachable": "The provider could not be reached or did not answer in time.",
    "provider_rate_limited": "The provider is rate limiting requests.",
    "provider_quota_exceeded": "The provider account is out of quota or credit.",
    "provider_model_not_found": "The provider does not know this model name.",
    "provider_context_too_long": "The input is longer than the model's context window.",
    "provider_bad_response": "The provider rejected the request or sent a response that could not be used.",
    "provider_output_invalid": "The model did not produce output in the requested format.",
    "provider_refused": "The provider refused to answer this request.",
    "provider_config_invalid": "The connection settings are not valid for this provider.",
    "limit_exceeded": "A limit set for this job was reached.",
    "internal": "An internal error occurred.",
}
assert set(_SENTENCES) == set(get_args(ErrorCode))

_RETRYABLE: frozenset[ErrorCode] = frozenset({"provider_unreachable", "provider_rate_limited", "internal"})


class JobError(BaseModel):
    """A failure as web receives it: the code, whether a retry may help, and what the run used."""

    code: ErrorCode
    retryable: bool
    usage: StepUsage | None = None


class EngineError(Exception):
    """A failure with a stable code. `str()` is the code and a fixed sentence, never provider text."""

    def __init__(self, code: ErrorCode, usage: StepUsage | None = None) -> None:
        super().__init__(code)
        self.code: ErrorCode = code
        # What a failed run used before it stopped, so callers can bill and log it.
        self.usage: StepUsage | None = usage
        self.retryable: bool = code in _RETRYABLE
        # Raised from inside `except` blocks that hold provider bodies; do not chain them.
        self.__suppress_context__ = True

    def __str__(self) -> str:
        return f"{self.code}: {_SENTENCES[self.code]}"

    def to_model(self) -> JobError:
        return JobError(code=self.code, retryable=self.retryable, usage=self.usage)
