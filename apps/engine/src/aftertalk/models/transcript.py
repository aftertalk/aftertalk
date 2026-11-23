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


def _letters(text: str) -> str:
    return "".join(ch for ch in text.lower() if ch.isalnum())


def spells(words: "list[Word]", text: str) -> bool:
    """Whether the words spell the text, compared on letters and digits, lower-cased."""
    return _letters("".join(w.text for w in words)) == _letters(text)


def split_words(text: str) -> "list[Word]":
    """The text split on whitespace into untimed words: what a segment gets when the provider gave no usable words."""
    return [Word(text=part) for part in text.split()]


class Word(BaseModel):
    """A word. It has `start` and `end`, or neither: a provider may give no usable time for it, and times are never
    estimated or copied from the segment."""

    model_config = _CONFIG

    text: str
    start: Seconds | None = None
    end: Seconds | None = None

    @model_validator(mode="after")
    def _times(self) -> "Word":
        _check_times(self.start, self.end)
        if (self.start is None) != (self.end is None):
            raise ValueError("a word has both start and end, or neither")
        return self


class Segment(BaseModel):
    """A segment. When it has text it has words that spell that text: the provider's, or the text split on whitespace
    into untimed words."""

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

    At every timing level: non-blank text is in segments, every segment with text has words, and the words spell the
    segment's text (letters and digits, lower-cased). A word may have no times; a timed word lies within its timed
    segment, up to 0.5 seconds outside it. `segment` timing also needs start and end on every segment, and `word` timing
    needs, on top of that, times on every word of a segment with text. A consumer that needs a time for a word uses
    the word's time, else its segment's time, else there is none.
    """

    model_config = _CONFIG

    text: str
    language: str | None = None
    duration_seconds: Seconds | None = None
    timing: TimingLevel
    segments: list[Segment] = []

    @model_validator(mode="after")
    def _timing(self) -> "Transcript":
        if self.text.strip() and not self.segments:
            raise ValueError("a transcript with text needs at least one segment")
        for seg in self.segments:
            if seg.text.strip() and not seg.words:
                raise ValueError("every segment with text needs words")
            if not spells(seg.words, seg.text):
                raise ValueError("the words of a segment must spell its text")
            if seg.start is None or seg.end is None:
                continue
            for w in seg.words:
                if w.start is None or w.end is None:
                    continue
                if w.start < seg.start - WORD_SLACK_SECONDS or w.end > seg.end + WORD_SLACK_SECONDS:
                    raise ValueError("a word lies outside its segment")
        if self.timing == "none":
            return self
        if any(seg.start is None or seg.end is None for seg in self.segments):
            raise ValueError(f"timing {self.timing!r} requires start and end on every segment")
        if self.timing == "word" and any(
            w.start is None for seg in self.segments if seg.text.strip() for w in seg.words
        ):
            raise ValueError("timing 'word' requires start and end on every word")
        return self
