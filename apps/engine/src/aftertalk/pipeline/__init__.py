"""The pipeline: a file in, the canonical transcript out (see README.md)."""

from aftertalk.pipeline.transcribe import PipelineEvent, TranscribeOptions, TranscribeResult, transcribe_file

__all__ = ["PipelineEvent", "TranscribeOptions", "TranscribeResult", "transcribe_file"]
