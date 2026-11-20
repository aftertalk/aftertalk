"""The interface of a speech-to-text provider and what it can do.

`capabilities` lets the pipeline pick a strategy per provider (words or segments only, speaker labels, one stream
per channel, an upload ceiling) instead of testing for a name. M1 has one adapter, `openai-compatible`; a native
one (for example Deepgram, which labels speakers) implements the same protocol.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

from aftertalk.audio.encode import EncodedAudio
from aftertalk.models.transcript import Transcript
from aftertalk.models.usage import StepUsage

__all__ = ["EncodedAudio", "SpeechCapabilities", "SpeechProvider"]


@dataclass(frozen=True)
class SpeechCapabilities:
    word_times: bool  # can return word timestamps (the transcript's `timing` says what a request did return)
    segment_times: bool
    speakers: bool  # labels who spoke (diarization built in)
    channels: bool  # transcribes each channel of a multi-channel file separately
    max_upload_bytes: int | None  # None: no known limit


class SpeechProvider(Protocol):
    capabilities: SpeechCapabilities

    async def transcribe(
        self,
        audio: EncodedAudio,
        *,
        language: str | None,
        prompt: str | None,
        deadline: float | None,
        allowed_languages: Sequence[str] | None = None,
    ) -> tuple[Transcript, StepUsage]:
        """Transcribe one upload.

        `language` forces a language; without it the provider detects it, and a detected language outside
        `allowed_languages` fails with `language_not_allowed`. `deadline` is an absolute `time.monotonic()` value.
        """
        ...
