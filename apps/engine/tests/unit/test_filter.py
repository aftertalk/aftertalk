"""The hallucination filter (`pipeline/filter.py`): the spec's four rules, each just inside and just outside."""

import pytest

from aftertalk.models.transcript import Segment
from aftertalk.pipeline.filter import (
    LOW_COMPRESSION_RATIO,
    LOW_COMPRESSION_SECONDS,
    MIN_AVG_LOGPROB,
    REPETITIONS,
    SHORT_MIN_AVG_LOGPROB,
    SHORT_SECONDS,
    fails_scores,
    filter_hallucinations,
)


def seg(
    text: str = "hello",
    start: float | None = 0.0,
    end: float | None = 5.0,
    *,
    logprob: float | None = None,
    ratio: float | None = None,
    speaker: str | None = "s1",
) -> Segment:
    return Segment(text=text, start=start, end=end, avg_logprob=logprob, compression_ratio=ratio, speaker=speaker)


def kept(segments: list[Segment]) -> list[Segment]:
    return filter_hallucinations(segments)[0]


def test_constants_are_the_spec() -> None:
    assert (SHORT_SECONDS, SHORT_MIN_AVG_LOGPROB) == (1.0, -0.45)
    assert MIN_AVG_LOGPROB == -0.7
    assert (LOW_COMPRESSION_SECONDS, LOW_COMPRESSION_RATIO) == (2.0, 0.5)
    assert REPETITIONS == 3


# ---- rule 1: shorter than 1 s and avg_logprob under -0.45 ----


@pytest.mark.parametrize(
    ("end", "logprob", "dropped"),
    [
        (0.99, -0.46, True),  # just inside both
        (1.0, -0.46, False),  # not shorter than 1 s
        (0.99, -0.45, False),  # not under -0.45
        (0.5, -0.69, True),
    ],
)
def test_rule_short_and_unsure(end: float, logprob: float, dropped: bool) -> None:
    s = seg(start=0.0, end=end, logprob=logprob)
    assert fails_scores(s) is dropped
    assert kept([s]) == ([] if dropped else [s])


# ---- rule 2: avg_logprob under -0.7, whatever the length ----


@pytest.mark.parametrize(("logprob", "dropped"), [(-0.71, True), (-0.7, False), (-0.5, False)])
def test_rule_low_logprob(logprob: float, dropped: bool) -> None:
    s = seg(start=0.0, end=30.0, logprob=logprob)
    assert fails_scores(s) is dropped
    assert kept([s]) == ([] if dropped else [s])


# ---- rule 3: shorter than 2 s and compression_ratio under 0.5 ----


@pytest.mark.parametrize(
    ("end", "ratio", "dropped"),
    [
        (1.99, 0.49, True),
        (2.0, 0.49, False),  # not shorter than 2 s
        (1.99, 0.5, False),  # not under 0.5
    ],
)
def test_rule_low_compression(end: float, ratio: float, dropped: bool) -> None:
    s = seg(start=10.0, end=10.0 + end, ratio=ratio)
    assert fails_scores(s) is dropped
    assert kept([s]) == ([] if dropped else [s])


# ---- rule 4: the same speaker with the same text in 3 or more segments ----


def test_three_repeats_are_all_dropped_two_are_kept() -> None:
    two = [seg("Dziękuję.", start=i, end=i + 0.5) for i in range(2)]
    assert kept(two) == two
    three = [seg("Dziękuję.", start=i, end=i + 0.5) for i in range(3)] + [seg("other", start=9, end=10)]
    out, dropped = filter_hallucinations(three)
    assert [s.text for s in out] == ["other"] and dropped == 3


def test_repeats_compare_stripped_text_exactly() -> None:
    same = [seg(" Thanks."), seg("Thanks. "), seg("Thanks.")]
    assert kept(same) == []
    different = [seg("Thanks."), seg("thanks."), seg("Thanks")]  # case and punctuation count
    assert kept(different) == different


def test_repeats_are_counted_per_speaker() -> None:
    segments = [seg("ok", speaker="s1"), seg("ok", speaker="s1"), seg("ok", speaker="s2")]
    assert kept(segments) == segments
    segments.append(seg("ok", speaker="s2"))
    segments.append(seg("ok", speaker="s2"))
    out = kept(segments)
    assert [s.speaker for s in out] == ["s1", "s1"]


def test_repetition_counts_segments_the_score_rules_drop() -> None:
    """The rule counts the call's provider segments, so a repeat dropped by another rule still counts."""
    segments = [seg("hm", logprob=-0.9), seg("hm"), seg("hm")]
    assert kept(segments) == []


# ---- missing scores and missing times ----


def test_without_scores_only_repetition_runs() -> None:
    short = seg("x", start=0.0, end=0.1)  # very short, but nothing to compare
    assert not fails_scores(short)
    assert kept([short]) == [short]
    repeated = [seg("x", start=i, end=i + 0.1) for i in range(3)]
    assert kept(repeated) == []


def test_only_one_score_missing_skips_only_its_rules() -> None:
    assert fails_scores(seg(start=0.0, end=0.5, logprob=-0.5, ratio=None))  # rule 1 still runs
    assert fails_scores(seg(start=0.0, end=0.5, logprob=None, ratio=0.1))  # rule 3 still runs
    assert not fails_scores(seg(start=0.0, end=0.5, logprob=None, ratio=None))


def test_untimed_segment_skips_the_length_rules_but_not_the_logprob_rule() -> None:
    assert not fails_scores(seg(start=None, end=None, logprob=-0.5))  # rule 1 needs the length
    assert not fails_scores(seg(start=None, end=None, ratio=0.1))  # rule 3 needs the length
    low = seg(start=None, end=None, logprob=-0.71)
    assert fails_scores(low)
    assert kept([low]) == []


# ---- blank segments and the count ----


def test_blank_segments_are_kept_and_not_counted() -> None:
    blanks = [seg("  ", logprob=-5.0, ratio=0.0, start=0, end=0.1) for _ in range(4)]
    out, dropped = filter_hallucinations(blanks)
    assert out == blanks and dropped == 0


def test_dropped_count_and_order() -> None:
    segments = [
        seg("a", start=0, end=5),
        seg("b", start=5, end=5.5, logprob=-0.5),  # rule 1
        seg("c", start=6, end=10),
        seg("d", start=10, end=20, logprob=-0.8),  # rule 2
        seg(" ", start=20, end=21),
        seg("e", start=21, end=22, ratio=0.3),  # rule 3
        seg("f", start=22, end=30, logprob=-0.2, ratio=1.2),
    ]
    out, dropped = filter_hallucinations(segments)
    assert [s.text for s in out] == ["a", "c", " ", "f"] and dropped == 3


def test_input_is_not_changed() -> None:
    segments = [seg("a"), seg("b", logprob=-1.0)]
    before = [s.model_copy() for s in segments]
    filter_hallucinations(segments)
    assert segments == before
    assert filter_hallucinations([]) == ([], 0)
