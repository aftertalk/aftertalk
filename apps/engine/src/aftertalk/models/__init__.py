"""Data models shared with web, which gets them through openapi.json."""

from aftertalk.models.connections import (
    DiarizationAdapter,
    DiarizationConnection,
    LLMAdapter,
    LLMConnection,
    LLMPreset,
    ModelTier,
    ModelTiers,
    OutputMode,
    SpeechAdapter,
    SpeechConnection,
)
from aftertalk.models.errors import EngineError, ErrorCode
from aftertalk.models.transcript import Segment, Source, Speaker, TimingLevel, Transcript, Word
from aftertalk.models.usage import JobLimits, StepUsage

__all__ = [
    "DiarizationAdapter",
    "DiarizationConnection",
    "EngineError",
    "ErrorCode",
    "JobLimits",
    "LLMAdapter",
    "LLMConnection",
    "LLMPreset",
    "ModelTier",
    "ModelTiers",
    "OutputMode",
    "Segment",
    "Source",
    "Speaker",
    "SpeechAdapter",
    "SpeechConnection",
    "StepUsage",
    "TimingLevel",
    "Transcript",
    "Word",
]
