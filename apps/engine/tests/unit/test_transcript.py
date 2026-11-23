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


def test_nan_inf_rejected() -> None:
    for bad in (float("nan"), float("inf")):
        with pytest.raises(ValidationError):
            Word(text="x", start=0, end=bad)
        with pytest.raises(ValidationError):
            Transcript(text="", timing="none", duration_seconds=bad)
    with pytest.raises(ValidationError):
        Transcript(text="", timing="none", duration_seconds=-1)


def test_word_timing_requires_segment_times_and_words() -> None:
    with pytest.raises(ValidationError):
        Transcript(text="hi", timing="word", segments=[Segment(text="hi", words=[Word(text="hi", start=0, end=1)])])
    with pytest.raises(ValidationError):
        Transcript(text="hi", timing="word", segments=[Segment(text="hi", start=0, end=1)])
    Transcript(text="", timing="word", segments=[Segment(text=" ", start=0, end=1)])


def test_text_requires_segments_unless_none() -> None:
    for timing in ("word", "segment"):
        with pytest.raises(ValidationError):
            Transcript(text="hello", timing=timing)
    Transcript(text="hello", timing="none")
    Transcript(text="  ", timing="segment")


def test_segment_timing_requires_word_times() -> None:
    seg = Segment(text="hi", start=0, end=1, words=[Word(text="hi")])
    with pytest.raises(ValidationError, match="every word"):
        Transcript(text="hi", timing="segment", segments=[seg])


def test_word_outside_segment_rejected() -> None:
    seg = Segment(text="hi", start=0, end=1, words=[Word(text="hi", start=5, end=6)])
    with pytest.raises(ValidationError, match="outside its segment"):
        Transcript(text="hi", timing="word", segments=[seg])


def test_word_may_spill_a_little() -> None:
    seg = Segment(text="hi", start=0, end=1, words=[Word(text="hi", start=0.9, end=1.3)])
    Transcript(text="hi", timing="word", segments=[seg])


def test_none_timing_allows_untimed_words() -> None:
    Transcript(text="hi", timing="none", segments=[Segment(text="hi", words=[Word(text="hi")])])
