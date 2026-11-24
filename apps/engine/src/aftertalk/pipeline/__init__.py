"""The pipeline: a file in, the canonical transcript out (see README.md)."""

from aftertalk.pipeline.transcribe import (
    PipelineEvent,
    TimesUnavailable,
    TranscribeOptions,
    TranscribeResult,
    transcribe_file,
)

__all__ = ["PipelineEvent", "TimesUnavailable", "TranscribeOptions", "TranscribeResult", "transcribe_file"]
