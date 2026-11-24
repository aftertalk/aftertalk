"""Transcript model: what a speech provider returns, and the canonical transcript the pipeline builds from it.

A provider answer has segments as the provider cut them, and no ids, speakers or source. A pipeline result adds the
source, the speakers, and segments that are the turns, each with an id and a speaker. Both validate as `Transcript`.
"""

import re
from collections.abc import Sequence
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

TimingLevel = Literal["word", "segment", "none"]

_CONFIG = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)

COVERAGE = 0.9  # share of segments with text that must be timed (and fully word-timed) for `segment` and `word`
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


def word_timed(seg: "Segment") -> bool:
    """Whether the segment has a start and end and words that all have times."""
    return seg.start is not None and bool(seg.words) and all(w.start is not None for w in seg.words)


def timing_level(segments: "Sequence[Segment]") -> TimingLevel:
    """The highest level the `Transcript` validator accepts for these segments (the 90% rule, on segments with text).

    Without any segment with text it is `none`: there is nothing to time.
    """
    spoken = [seg for seg in segments if seg.text.strip()]
    if not spoken:
        return "none"
    if sum(seg.start is not None for seg in spoken) < COVERAGE * len(spoken):
        return "none"
    if sum(word_timed(seg) for seg in spoken) < COVERAGE * len(spoken):
        return "segment"
    return "word"


_SHA256 = re.compile(r"[0-9a-f]{64}")


class Source(BaseModel):
    """Where the transcript comes from. All times in the transcript are already on the original file's timeline."""

    model_config = _CONFIG

    kind: Literal["audio", "video", "text"]  # the medium only; "call" or "meeting" is not a kind
    name: str | None = None  # file name only, never a path
    sha256: str | None = None  # of the original bytes, 64 lowercase hex characters: the file's identity
    url: str | None = None
    container: str | None = None
    channels: int | None = None  # in the original audio stream
    channel_mode: Literal["mix", "split"] | None = None
    start_offset_seconds: Seconds = 0  # where the audio starts in the file; already added to all times

    @model_validator(mode="after")
    def _fields(self) -> "Source":
        if self.name is not None and ("/" in self.name or "\\" in self.name):
            raise ValueError("source name is a file name, not a path")
        if self.sha256 is not None and not _SHA256.fullmatch(self.sha256):
            raise ValueError("source sha256 must be 64 lowercase hex characters")
        return self


class Speaker(BaseModel):
    """A speaker. `id` is stable within the transcript and is what segments refer to; `label` is for display only."""

    model_config = _CONFIG

    id: str = Field(min_length=1)  # "s1", "s2"
    label: str = Field(min_length=1)  # "Agent", "Speaker 1"
    role: Literal["agent", "customer"] | None = None  # calls only; at most one speaker per role
    channel: int | None = Field(default=None, ge=0)


class Word(BaseModel):
    """A word. It has `start` and `end`, or neither: a provider may give no usable time for it, and times are never
    estimated or copied from the segment."""

    model_config = _CONFIG

    text: str
    start: Seconds | None = None
    end: Seconds | None = None
    probability: float | None = None

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

    id: str | None = None  # "t1", "t2": all segments of a transcript have one, or none do
    speaker: str | None = None  # a `Speaker.id` of the transcript
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
    """A transcript. The adapter sets `timing` from what the provider actually returned; the pipeline recomputes it
    on the turns with `timing_level`.

    A provider answer has no ids, speakers or source. In a pipeline result the segments are the turns: every segment
    has an id ("t1", "t2"... in order) and a speaker from `speakers`, and a word is addressed as (segment id, word
    index). Speaker ids are unique, at most one speaker has each role, and segment ids are unique.

    At every timing level: non-blank text is in segments, every segment with text has words, and the words spell the
    segment's text (letters and digits, lower-cased). A segment or a word has start and end, or neither: times are
    never estimated or copied. A timed word lies within its timed segment, up to 0.5 seconds outside it.

    `timing` is the level the transcript can be relied on for. `segment`: at least 90% of the segments with text have
    a start and end. `word`: that too, and at least 90% of the segments with text have times on all their words.
    `none` is text only (or too few times to use). A consumer that needs a time for a word uses the word's time, else
    its segment's time, else there is none (no playback).

    `text`: in a pipeline result, the turn texts joined with one space, with no turn or speaker structure; read
    `segments` for that. `duration_seconds`: in a pipeline result, where the audio ends on the file's timeline
    (`source.start_offset_seconds` plus the decoded length), not the container's duration; the audio's own length is
    the difference, and the billed length is in the usage. In a provider answer it is the upload's length.
    """

    model_config = _CONFIG

    text: str
    language: str | None = None
    duration_seconds: Seconds | None = None
    timing: TimingLevel
    segments: list[Segment] = []
    source: Source | None = None
    speakers: list[Speaker] = []

    @model_validator(mode="after")
    def _ids(self) -> "Transcript":
        speaker_ids = [sp.id for sp in self.speakers]
        if len(set(speaker_ids)) != len(speaker_ids):
            raise ValueError("speaker ids must be unique")
        roles = [sp.role for sp in self.speakers if sp.role is not None]
        if len(set(roles)) != len(roles):
            raise ValueError("at most one speaker per role")
        ids = [seg.id for seg in self.segments if seg.id is not None]
        if ids and len(ids) != len(self.segments):
            raise ValueError("all segments have an id, or none do")
        if len(set(ids)) != len(ids):
            raise ValueError("segment ids must be unique")
        known = set(speaker_ids)
        if any(seg.speaker is not None and seg.speaker not in known for seg in self.segments):
            raise ValueError("a segment's speaker must be one of the transcript's speakers")
        return self

    @model_validator(mode="after")
    def _timing(self) -> "Transcript":
        spoken = [seg for seg in self.segments if seg.text.strip()]
        if self.text.strip() and not spoken:
            raise ValueError("a transcript with text needs at least one segment")
        for seg in self.segments:
            if (seg.start is None) != (seg.end is None):
                raise ValueError("a segment has both start and end, or neither")
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
        if self.timing == "none" or not spoken:
            return self
        if sum(seg.start is not None for seg in spoken) < COVERAGE * len(spoken):
            raise ValueError(f"timing {self.timing!r} requires start and end on at least 90% of the segments")
        if self.timing == "word" and sum(word_timed(seg) for seg in spoken) < COVERAGE * len(spoken):
            raise ValueError("timing 'word' requires times on all words of at least 90% of the segments")
        return self
