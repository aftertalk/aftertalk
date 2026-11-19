"""Transcript model (what M1 needs)."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, model_validator

TimingLevel = Literal["word", "segment", "none"]

_CONFIG = ConfigDict(extra="forbid", frozen=True)


def _check_times(start: float | None, end: float | None) -> None:
    if start is not None and start < 0:
        raise ValueError("start must be >= 0")
    if end is not None and end < 0:
        raise ValueError("end must be >= 0")
    if start is not None and end is not None and start > end:
        raise ValueError("start must be <= end")


class Word(BaseModel):
    model_config = _CONFIG

    text: str
    start: float | None = None
    end: float | None = None

    @model_validator(mode="after")
    def _times(self) -> "Word":
        _check_times(self.start, self.end)
        return self


class Segment(BaseModel):
    model_config = _CONFIG

    text: str
    start: float | None = None
    end: float | None = None
    words: list[Word] = []
    avg_logprob: float | None = None
    compression_ratio: float | None = None
    no_speech_prob: float | None = None

    @model_validator(mode="after")
    def _times(self) -> "Segment":
        _check_times(self.start, self.end)
        return self


class Transcript(BaseModel):
    model_config = _CONFIG

    text: str
    language: str | None = None
    duration_seconds: float | None = None
    timing: TimingLevel
    segments: list[Segment] = []

    @model_validator(mode="after")
    def _timing(self) -> "Transcript":
        if self.timing == "word":
            for seg in self.segments:
                if any(w.start is None or w.end is None for w in seg.words):
                    raise ValueError("timing 'word' requires start and end on every word")
        elif self.timing == "segment":
            if any(seg.start is None or seg.end is None for seg in self.segments):
                raise ValueError("timing 'segment' requires start and end on every segment")
        return self
