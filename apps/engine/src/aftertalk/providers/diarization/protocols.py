"""The interface of a diarization provider: audio in, speaker segments out (spec #6: separate from speech).

The pipeline sends the whole mixed track once (`audio.encode.MonoWav`) and assigns words to speakers itself
(`pipeline.turns.build_speaker_turns`). The provider's speaker labels are only grouping keys: they never leave the
engine.
"""

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Protocol

from aftertalk.models.usage import StepUsage

__all__ = [
    "DiarizationCapabilities",
    "DiarizationOutput",
    "DiarizationProvider",
    "DiarizationSegment",
    "DiarizationUpload",
]


@dataclass(frozen=True)
class DiarizationSegment:
    start: float  # seconds from the start of the upload
    end: float
    speaker: str  # the provider's label


@dataclass(frozen=True)
class DiarizationOutput:
    segments: tuple[DiarizationSegment, ...]


@dataclass(frozen=True)
class DiarizationCapabilities:
    max_upload_bytes: int | None  # None: no known limit
    max_audio_seconds: float | None


class DiarizationUpload(Protocol):
    content_type: str
    size_bytes: int
    duration_seconds: float

    def chunks(self) -> AsyncIterator[bytes]:
        """The body from its first byte: a new iterator on every call, so a retried upload sends it whole."""
        ...


class DiarizationProvider(Protocol):
    name: str  # the `provider` of its usage entry
    capabilities: DiarizationCapabilities

    async def check(self, *, deadline: float | None) -> None:
        """A request that sends no audio, to find a rejected key before anything is paid. Raises `EngineError`."""
        ...

    async def diarize(self, audio: DiarizationUpload, *, deadline: float | None) -> tuple[DiarizationOutput, StepUsage]:
        """The speaker segments of `audio`. Raises `EngineError` with a fixed code and the usage so far.

        `deadline` is an absolute `time.monotonic()` value.
        """
        ...

    def usage(self) -> StepUsage:
        """What this run's requests used so far, `check` included."""
        ...
