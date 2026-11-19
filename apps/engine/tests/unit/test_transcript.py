import pytest
from pydantic import ValidationError

from aftertalk.models import Segment, Transcript, Word


def test_word_timing_ok() -> None:
    seg = Segment(text="hi", start=0, end=1, words=[Word(text="hi", start=0, end=1)])
    t = Transcript(text="hi", timing="word", segments=[seg])
    assert t.segments[0].words[0].end == 1


def test_word_timing_requires_word_times() -> None:
    seg = Segment(text="hi", start=0, end=1, words=[Word(text="hi", start=0)])
    with pytest.raises(ValidationError, match="word"):
        Transcript(text="hi", timing="word", segments=[seg])


def test_segment_timing_requires_segment_times() -> None:
    with pytest.raises(ValidationError, match="segment"):
        Transcript(text="hi", timing="segment", segments=[Segment(text="hi", start=0)])
    Transcript(text="hi", timing="segment", segments=[Segment(text="hi", start=0, end=2)])


def test_none_timing_allows_anything() -> None:
    Transcript(text="hi", timing="none", segments=[Segment(text="hi")])
    Transcript(text="", timing="none")


def test_times_ordered_and_non_negative() -> None:
    with pytest.raises(ValidationError):
        Segment(text="x", start=2, end=1)
    with pytest.raises(ValidationError):
        Segment(text="x", start=-1, end=1)
    with pytest.raises(ValidationError):
        Word(text="x", start=3, end=2)
