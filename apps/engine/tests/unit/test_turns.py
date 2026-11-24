import pytest

from aftertalk.models import Segment, Transcript, Word
from aftertalk.models.transcript import timing_level
from aftertalk.pipeline.turns import MAX_TURN_SECONDS, TURN_GAP_SECONDS, build_turns


def w(text: str, start: float | None = None, end: float | None = None) -> Word:
    return Word(text=text, start=start, end=end)


def seg(*words: Word, start: float | None = None, end: float | None = None, text: str | None = None) -> Segment:
    timed = [x for x in words if x.start is not None]
    if start is None and timed:
        start, end = min(x.start for x in timed), max(x.end for x in timed)
    return Segment(text=text or " ".join(x.text for x in words), start=start, end=end, words=list(words))


def texts(turns: list[Segment]) -> list[str]:
    return [t.text for t in turns]


def check(turns: list[Segment], source: list[Segment]) -> Transcript:
    """Every word once, in order; ids t1..tn; the turns validate as a transcript at their own timing level."""
    assert [x for t in turns for x in t.words] == [x for s in source if s.text.strip() for x in s.words]
    assert [t.id for t in turns] == [f"t{i}" for i in range(1, len(turns) + 1)]
    text = " ".join(t.text for t in turns)
    return Transcript(text=text, timing=timing_level(turns), segments=turns)


def test_constants() -> None:
    assert TURN_GAP_SECONDS == 1.5
    assert MAX_TURN_SECONDS == 60.0


def test_empty_input() -> None:
    assert build_turns([]) == []
    assert build_turns([Segment(text="  ")]) == []


def test_gap_of_exactly_1_5_starts_a_turn() -> None:
    source = [seg(w("a", 0, 1), w("b", 2.5, 3))]
    turns = build_turns(source)
    assert texts(turns) == ["a", "b"]
    assert (turns[1].start, turns[1].end) == (2.5, 3)
    check(turns, source)


def test_gap_of_1_49_does_not() -> None:
    source = [seg(w("a", 0, 1)), seg(w("b", 2.49, 3))]
    turns = build_turns(source)
    assert texts(turns) == ["a b"]
    assert (turns[0].start, turns[0].end) == (0, 3)
    assert check(turns, source).timing == "word"


def test_turns_merge_across_provider_segments_and_drop_scores() -> None:
    source = [
        Segment(text="hi", start=0, end=1, words=[w("hi", 0, 1)], avg_logprob=-0.1, no_speech_prob=0.1),
        Segment(text="there", start=1.2, end=2, words=[w("there", 1.2, 2)], compression_ratio=1.2),
    ]
    (turn,) = build_turns(source, speaker="s1")
    assert turn.speaker == "s1"
    assert turn.avg_logprob is None and turn.compression_ratio is None and turn.no_speech_prob is None


def test_speaker_none_by_default() -> None:
    assert build_turns([seg(w("a", 0, 1))])[0].speaker is None


def _run(start: float, count: int, step: float = 1.0, length: float = 0.5) -> list[Word]:
    return [w(f"w{start + i * step:g}", start + i * step, start + i * step + length) for i in range(count)]


def test_long_turn_split_at_largest_gap_repeatedly() -> None:
    # One turn of 0..150.7 s with 0.5 s gaps and two larger ones (1.0 s before 40.5, 1.2 s before 101.2): it is split
    # at the 1.2 s gap, and the first part (100 s) again at the 1.0 s gap.
    words = _run(0, 40) + _run(40.5, 60) + _run(101.2, 50)
    source = [seg(*words)]
    turns = build_turns(source)
    for t in turns:
        assert t.end - t.start <= MAX_TURN_SECONDS
    starts = [t.start for t in turns]
    assert 101.2 in starts and 40.5 in starts  # the largest gap first, then the next largest
    assert len(turns) == 3
    check(turns, source)


def test_split_tie_goes_to_the_gap_nearest_the_middle() -> None:
    words = [w(f"x{i}", i * 1.0, i * 1.0 + 0.5) for i in range(70)]  # 0..69.5 s, every gap 0.5 s
    turns = build_turns([seg(*words)])
    assert len(turns) == 2
    assert turns[1].start == 35.0  # the gap from 34.5 to 35.0 is at the middle (34.75)


def test_single_long_unit_is_not_split() -> None:
    source = [Segment(text="long one", start=0, end=90, words=[w("long"), w("one")])]
    (turn,) = build_turns(source)
    assert (turn.start, turn.end) == (0, 90)
    assert check([turn], source).timing == "segment"


def test_untimed_word_stays_with_word_before() -> None:
    source = [seg(w("a", 0, 1), w("um"), w("b", 5, 6), start=0, end=6)]
    turns = build_turns(source)
    assert texts(turns) == ["a um", "b"]
    assert turns[0].words[1].start is None  # never given a time
    check(turns, source)


def test_untimed_word_at_segment_start_joins_previous_turn_across_a_gap() -> None:
    source = [seg(w("a", 0, 1)), seg(w("so"), w("b", 10, 11), start=10, end=11)]
    turns = build_turns(source)
    assert texts(turns) == ["a so", "b"]
    check(turns, source)


def test_untimed_word_stays_with_word_before_through_a_split() -> None:
    words = []
    for i in range(70):
        words.append(w(f"x{i}", i * 1.0, i * 1.0 + 0.5))
        if i == 34:
            words.append(w("um"))  # right before the split gap
    turns = build_turns([seg(*words)])
    assert len(turns) == 2
    assert turns[0].words[-1].text == "um" and turns[1].words[0].text == "x35"


def test_leading_untimed_word_joins_first_turn() -> None:
    source = [seg(w("well"), w("a", 3, 4), start=3, end=4), seg(w("b", 10, 11))]
    turns = build_turns(source)
    assert texts(turns) == ["well a", "b"]
    assert turns[0].start == 3
    check(turns, source)


def test_segment_only_fallback_merges_and_splits_by_the_same_rules() -> None:
    def s(text: str, start: float, end: float) -> Segment:
        return Segment(text=text, start=start, end=end, words=[w(x) for x in text.split()])

    source = [s("one two", 0, 2), s("three", 3, 5), s("four", 6.5, 8)]  # gaps 1.0 and 1.5
    turns = build_turns(source)
    assert texts(turns) == ["one two three", "four"]
    assert (turns[0].start, turns[0].end) == (0, 5)
    assert check(turns, source).timing == "segment"

    long = [s(f"p{i}", i * 10.0, i * 10.0 + 9.5) for i in range(8)]  # one turn of 0..79.5 s, 0.5 s gaps
    long[4] = s("p4", 40.7, 49.5)  # a 1.2 s gap: the largest, so the split
    turns = build_turns(long)
    assert [(t.start, t.end) for t in turns] == [(0, 39.5), (40.7, 79.5)]
    check(turns, long)


def test_segment_without_words_uses_its_text() -> None:
    (turn,) = build_turns([Segment(text="hello  there", start=0, end=1)])
    assert [x.text for x in turn.words] == ["hello", "there"]
    assert turn.text == "hello there"


def test_untimed_segment_joins_the_open_turn() -> None:
    source = [seg(w("a", 0, 1)), Segment(text="no time", words=[w("no"), w("time")]), seg(w("b", 1.2, 2))]
    (turn,) = build_turns(source)
    assert turn.text == "a no time b" and (turn.start, turn.end) == (0, 2)
    assert [x.start for x in turn.words] == [0, None, None, 1.2]  # never given a time
    check([turn], source)


def test_untimed_segment_in_a_timed_run_keeps_segment_timing() -> None:
    source = [Segment(text=f"s{i}", start=i, end=i + 1, words=[w(f"s{i}")]) for i in range(10)]
    source[4] = Segment(text="no times here", words=[w("no"), w("times"), w("here")])
    (turn,) = build_turns(source)
    assert (turn.start, turn.end) == (0, 10)
    assert check([turn], source).timing == "segment"  # not "none": the untimed segment is not a turn of its own


def test_untimed_segment_first_is_its_own_turn() -> None:
    source = [Segment(text="no time", words=[w("no"), w("time")]), seg(w("a", 0, 1)), seg(w("b", 1.2, 2))]
    turns = build_turns(source)
    assert texts(turns) == ["no time", "a b"]
    assert (turns[0].start, turns[0].end) == (None, None) and (turns[1].start, turns[1].end) == (0, 2)
    check(turns, source)


def test_all_untimed_is_one_turn_per_segment() -> None:
    source = [Segment(text=x, words=[w(x)]) for x in ("one", "two", "three")]
    turns = build_turns(source)
    assert texts(turns) == ["one", "two", "three"]
    assert all(t.start is None and t.end is None for t in turns)
    assert check(turns, source).timing == "none"


def untimed(text: str) -> Segment:
    return Segment(text=text, words=[w(x) for x in text.split()])


def test_untimed_segment_before_a_gap_is_its_own_turn() -> None:
    source = [seg(w("a", 0, 1)), untimed("so"), seg(w("b", 3, 4))]  # "b" 2 s after "a": the turn would end anyway
    turns = build_turns(source)
    assert texts(turns) == ["a", "so", "b"]
    assert [(t.start, t.end) for t in turns] == [(0, 1), (None, None), (3, 4)]  # the neighbours' spans do not move
    check(turns, source)


def test_untimed_segment_last_is_its_own_turn() -> None:
    source = [seg(w("a", 0, 1)), untimed("the end")]
    turns = build_turns(source)
    assert texts(turns) == ["a", "the end"]
    assert [(t.start, t.end) for t in turns] == [(0, 1), (None, None)]
    check(turns, source)


def test_untimed_segments_in_a_row_inside_a_turn_join_in_order() -> None:
    source = [seg(w("a", 0, 1)), untimed("one two"), untimed("three"), seg(w("b", 1.5, 2))]
    (turn,) = build_turns(source)
    assert turn.text == "a one two three b" and (turn.start, turn.end) == (0, 2)
    check([turn], source)


def test_untimed_segments_in_a_row_before_a_gap_are_one_turn_each() -> None:
    source = [seg(w("a", 0, 1)), untimed("one two"), untimed("three"), seg(w("b", 2.5, 3))]
    turns = build_turns(source)
    assert texts(turns) == ["a", "one two", "three", "b"]
    assert [(t.start, t.end) for t in turns] == [(0, 1), (None, None), (None, None), (2.5, 3)]
    check(turns, source)


@pytest.mark.parametrize(("start", "expected"), [(1.2, ["a x so b"]), (5.0, ["a", "x", "so b"])])
def test_an_untimed_word_waits_behind_pending_segments(start: float, expected: list[str]) -> None:
    # "so" comes after the untimed segment "x": it joins with it, or leads "b" when "x" is a turn of its own.
    source = [seg(w("a", 0, 1)), untimed("x"), seg(w("so"), w("b", start, start + 1), start=start, end=start + 1)]
    turns = build_turns(source)
    assert texts(turns) == expected
    check(turns, source)


def test_untimed_word_after_untimed_segment_joins_the_next_word() -> None:
    source = [Segment(text="x", words=[w("x")]), seg(w("um"), w("b", 3, 4), start=3, end=4)]
    turns = build_turns(source)
    assert texts(turns) == ["x", "um b"]
    check(turns, source)


def test_mixed_input_lowers_the_timing_level() -> None:
    source = [
        seg(w("word"), w("timed", 0.5, 1), w("here", 1, 1.5), start=0, end=1.5),
        Segment(text="segment timed", start=10, end=12, words=[w("segment"), w("timed")]),
        Segment(text="nothing", words=[w("nothing")]),
    ]
    turns = build_turns(source)
    assert texts(turns) == ["word timed here", "segment timed", "nothing"]
    transcript = check(turns, source)
    assert transcript.timing == "none"  # 2 of 3 turns timed: below 90%
    assert timing_level(turns[:2]) == "segment"  # every turn timed, half of them word-timed


def test_input_not_mutated() -> None:
    source = [seg(w("a", 0, 1), w("um"), w("b", 5, 6), start=0, end=6), Segment(text="x", words=[w("x")])]
    before = [s.model_dump() for s in source]
    build_turns(source)
    build_turns(source)
    assert [s.model_dump() for s in source] == before


def test_deterministic() -> None:
    words = _run(0, 40) + _run(40.5, 60)
    assert build_turns([seg(*words)]) == build_turns([seg(*words)])


@pytest.mark.parametrize("count", [1, 5, 200])
def test_every_word_once_in_order(count: int) -> None:
    source = [seg(*_run(i * 3.0, 2)) for i in range(count)] + [Segment(text="end", words=[w("end")])]
    turns = build_turns(source)
    check(turns, source)


@pytest.mark.parametrize("step", [1.0, 3.0])
def test_every_word_once_in_order_with_untimed_segments_and_words(step: float) -> None:
    source: list[Segment] = [untimed("first")]
    for i in range(30):
        at = i * step
        source.append(seg(w(f"u{i}"), w(f"t{i}", at, at + 0.5), start=at, end=at + 0.5))
        if i % 3 == 0:
            source += [untimed(f"x{i}"), untimed(f"y{i}")]
    source.append(untimed("last"))
    check(build_turns(source), source)
