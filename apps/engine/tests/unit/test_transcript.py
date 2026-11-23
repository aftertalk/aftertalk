import pytest
from pydantic import ValidationError

from aftertalk.models import Segment, Transcript, Word
from aftertalk.models.transcript import spells, split_words


def test_word_timing_ok() -> None:
    seg = Segment(text="hi", start=0, end=1, words=[Word(text="hi", start=0, end=1)])
    t = Transcript(text="hi", timing="word", segments=[seg])
    assert t.segments[0].words[0].end == 1


def test_word_has_both_times_or_neither() -> None:
    with pytest.raises(ValidationError, match="both"):
        Word(text="hi", start=0)
    with pytest.raises(ValidationError, match="both"):
        Word(text="hi", end=1)
    assert Word(text="hi").start is None


def test_word_timing_requires_word_times() -> None:
    seg = Segment(text="hi", start=0, end=1, words=[Word(text="hi")])
    with pytest.raises(ValidationError, match="timing 'word'"):
        Transcript(text="hi", timing="word", segments=[seg])


def test_segment_timing_requires_segment_times() -> None:
    with pytest.raises(ValidationError, match="segment"):
        Transcript(text="hi", timing="segment", segments=[Segment(text="hi", start=0, words=[Word(text="hi")])])
    Transcript(text="hi", timing="segment", segments=[Segment(text="hi", start=0, end=2, words=[Word(text="hi")])])


def test_none_timing_allows_untimed_segments() -> None:
    Transcript(text="hi", timing="none", segments=[Segment(text="hi", words=[Word(text="hi")])])
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


def test_text_requires_segments_at_every_level() -> None:
    for timing in ("word", "segment", "none"):
        with pytest.raises(ValidationError, match="segment"):
            Transcript(text="hello", timing=timing)
    Transcript(text="  ", timing="segment")
    Transcript(text="  ", timing="none")


def test_segment_timing_allows_untimed_words() -> None:
    seg = Segment(text="hi there", start=0, end=1, words=[Word(text="hi"), Word(text="there")])
    assert Transcript(text="hi there", timing="segment", segments=[seg]).segments[0].words[1].start is None


def test_segment_with_text_needs_words_at_every_level() -> None:
    for timing in ("word", "segment", "none"):
        with pytest.raises(ValidationError, match="words"):
            Transcript(text="hi", timing=timing, segments=[Segment(text="hi", start=0, end=1)])


def test_words_must_spell_their_segment() -> None:
    for timing in ("segment", "none"):
        seg = Segment(text="hi there", start=0, end=1, words=[Word(text="hi")])
        with pytest.raises(ValidationError, match="spell"):
            Transcript(text="hi there", timing=timing, segments=[seg])
    # Compared on letters and digits, lower-cased: punctuation, spacing and case do not matter.
    seg = Segment(text="Hi, there! 42.", start=0, end=1, words=[Word(text="hi"), Word(text="THERE"), Word(text="4 2")])
    Transcript(text="Hi, there! 42.", timing="segment", segments=[seg])
    seg = Segment(text="Zażółć gęślą", words=[Word(text="ZAŻÓŁĆ"), Word(text="gęślą")])
    Transcript(text="Zażółć gęślą", timing="none", segments=[seg])


def test_split_words() -> None:
    words = split_words("  Hi,  there\n42 ")
    assert [w.text for w in words] == ["Hi,", "there", "42"]
    assert all(w.start is None and w.end is None for w in words)
    assert spells(words, "hi there 42")
    assert not spells(words, "hi there")


def test_word_outside_segment_rejected() -> None:
    seg = Segment(text="hi", start=0, end=1, words=[Word(text="hi", start=5, end=6)])
    with pytest.raises(ValidationError, match="outside its segment"):
        Transcript(text="hi", timing="word", segments=[seg])


def test_word_may_spill_a_little() -> None:
    seg = Segment(text="hi", start=0, end=1, words=[Word(text="hi", start=0.9, end=1.3)])
    Transcript(text="hi", timing="word", segments=[seg])


def test_untimed_word_in_timed_segment_is_not_checked_for_position() -> None:
    seg = Segment(text="hi there", start=0, end=1, words=[Word(text="hi", start=0, end=0.5), Word(text="there")])
    Transcript(text="hi there", timing="segment", segments=[seg])


def test_word_outside_segment_rejected_at_none_too() -> None:
    seg = Segment(text="hi", start=0, end=1, words=[Word(text="hi", start=5, end=6)])
    with pytest.raises(ValidationError, match="outside its segment"):
        Transcript(text="hi", timing="none", segments=[seg])


def test_timed_words_in_untimed_segment_allowed_at_none() -> None:
    seg = Segment(text="hi", words=[Word(text="hi", start=5, end=6)])
    Transcript(text="hi", timing="none", segments=[seg])
