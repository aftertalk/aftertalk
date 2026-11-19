"""Transcript model (what M1 needs)."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

TimingLevel = Literal["word", "segment", "none"]

_CONFIG = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)

Seconds = Annotated[float, Field(ge=0, allow_inf_nan=False)]


def _check_times(start: Seconds | None, end: Seconds | None) -> None:
    if start is not None and start < 0:
        raise ValueError("start must be >= 0")
    if end is not None and end < 0:
        raise ValueError("end must be >= 0")
    if start is not None and end is not None and start > end:
        raise ValueError("start must be <= end")


class Word(BaseModel):
    model_config = _CONFIG

    text: str
    start: Seconds | None = None
    end: Seconds | None = None
    probability: float | None = None

    @model_validator(mode="after")
    def _times(self) -> "Word":
        _check_times(self.start, self.end)
        return self


class Segment(BaseModel):
    model_config = _CONFIG

    text: str
    start: Seconds | None = None
    end: Seconds | None = None
    words: list[Word] = []
    avg_logprob: float | None = None
    compression_ratio: float | None = None
    no_speech_prob: float | None = None

    @model_validator(mode="after")
    def _times(self) -> "Segment":
        _check_times(self.start, self.end)
        return self


class Transcript(BaseModel):
    """A transcript. The adapter sets `timing` from what the provider actually returned.

    `timing` is the level the transcript can be relied on for: `segment` means every segment has a start and end;
    `word` adds that at least 90% of the segments with text have timed words (and there is at least one word).
    Words are kept wherever the provider gave them, so a `word` transcript may have segments without words (they keep
    their segment times), and a `segment` transcript may still carry some words. `none` is text only (or too few
    segment times to use).
    """

    model_config = _CONFIG

    text: str
    language: str | None = None
    duration_seconds: Seconds | None = None
    timing: TimingLevel
    segments: list[Segment] = []

    @model_validator(mode="after")
    def _timing(self) -> "Transcript":
        if self.timing == "none":
            return self
        if self.text.strip() and not self.segments:
            raise ValueError(f"timing {self.timing!r} requires at least one segment when text is not blank")
        if any(seg.start is None or seg.end is None for seg in self.segments):
            raise ValueError(f"timing {self.timing!r} requires start and end on every segment")
        if self.timing == "word":
            if self.text.strip() and not any(seg.words for seg in self.segments):
                raise ValueError("timing 'word' requires at least one word")
            if any(w.start is None or w.end is None for seg in self.segments for w in seg.words):
                raise ValueError("timing 'word' requires start and end on every word")
        return self
