"""Transcript model (what M1 needs)."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

TimingLevel = Literal["word", "segment", "none"]

_CONFIG = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)

# Providers align words separately from segments, so a word may spill a little past a segment edge.
WORD_SLACK_SECONDS = 0.5

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
    """A transcript. The adapter sets `timing` from what the provider actually returned."""

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
        for seg in self.segments:
            if self.timing == "word" and seg.text.strip() and not seg.words:
                raise ValueError("timing 'word' requires words on every segment with text")
            for w in seg.words:
                if w.start is None or w.end is None:
                    raise ValueError(f"timing {self.timing!r} requires start and end on every word")
                assert seg.start is not None and seg.end is not None
                if w.start < seg.start - WORD_SLACK_SECONDS or w.end > seg.end + WORD_SLACK_SECONDS:
                    raise ValueError("a word lies outside its segment")
        return self
