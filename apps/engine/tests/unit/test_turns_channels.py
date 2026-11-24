"""Turns of several speakers (`turns.build_channel_turns`): one speaker per channel, merged by time."""

import random

from aftertalk.models.transcript import Segment, Word
from aftertalk.pipeline.turns import MAX_TURN_SECONDS, ChannelPart, build_channel_turns

SPEAKERS = {0: "s1", 1: "s2"}


def w(text: str, start: float | None = None, end: float | None = None) -> Word:
    return Word(text=text, start=start, end=end)


def seg(*words: Word, start: float | None = None, end: float | None = None) -> Segment:
    timed = [x for x in words if x.start is not None and x.end is not None]
    if start is None and timed:
        start, end = min(x.start for x in timed), max(x.end for x in timed)  # type: ignore[type-var]
    return Segment(text=" ".join(x.text for x in words), start=start, end=end, words=list(words))


def untimed(text: str) -> Segment:
    return Segment(text=text, words=[w(x) for x in text.split()])


def part(channel: int, window: int, start: float, *segments: Segment) -> ChannelPart:
    return ChannelPart(speaker=SPEAKERS[channel], channel=channel, window=window, start=start, segments=segments)


def summary(turns: list[Segment]) -> list[tuple[str | None, str, float | None, float | None]]:
    return [(t.speaker, t.text, t.start, t.end) for t in turns]


def check(turns: list[Segment], parts: list[ChannelPart]) -> None:
    """Every word once; ids t1..tn; each channel's words in their own order; a turn's words are its speaker's."""
    assert [t.id for t in turns] == [f"t{i}" for i in range(1, len(turns) + 1)]
    out = [id(x) for t in turns for x in t.words]
    source = [id(x) for p in parts for s in p.segments if s.text.strip() for x in s.words]
    assert sorted(out) == sorted(source) and len(set(out)) == len(out)
    for channel, speaker in SPEAKERS.items():
        mine = [
            id(x)
            for p in sorted((p for p in parts if p.channel == channel), key=lambda p: p.window)
            for s in p.segments
            if s.text.strip()
            for x in s.words
        ]
        assert [id(x) for t in turns if t.speaker == speaker for x in t.words] == mine
    owner = {id(x): SPEAKERS[p.channel] for p in parts for s in p.segments for x in s.words}
    for t in turns:
        assert {owner[id(x)] for x in t.words} == {t.speaker}
        assert t.text == " ".join(x.text for x in t.words)


# ---- the spec's examples ----


def test_overlap_splits_into_alternating_turns() -> None:
    """A speaks at 0, 0.4 and 0.9 s, B at 0.5 s: A(0-0.4), B(0.5), A(0.9)."""
    parts = [
        part(0, 0, 0.0, seg(w("a1", 0.0, 0.3), w("a2", 0.4, 0.45), w("a3", 0.9, 1.2))),
        part(1, 0, 0.5, seg(w("b1", 0.5, 0.8))),
    ]
    turns = build_channel_turns(parts)
    assert summary(turns) == [
        ("s1", "a1 a2", 0.0, 0.45),
        ("s2", "b1", 0.5, 0.8),
        ("s1", "a3", 0.9, 1.2),
    ]
    check(turns, parts)


def test_a_tie_at_the_same_start_puts_channel_0_first() -> None:
    parts = [
        part(1, 0, 1.0, seg(w("b", 1.0, 1.5))),
        part(0, 0, 1.0, seg(w("a", 1.0, 1.5))),
    ]
    turns = build_channel_turns(parts)
    assert [(t.speaker, t.text) for t in turns] == [("s1", "a"), ("s2", "b")]
    check(turns, parts)


def test_a_gap_inside_one_speech_segment_does_not_end_a_turn() -> None:
    parts = [part(0, 0, 0.0, seg(w("a", 0.0, 0.5)), seg(w("b", 3.0, 3.5)), seg(w("c", 10.0, 10.5)))]
    turns = build_channel_turns(parts)
    assert summary(turns) == [("s1", "a b c", 0.0, 10.5)]
    check(turns, parts)


def test_between_speech_segments_a_short_gap_continues_the_turn() -> None:
    parts = [part(0, 0, 0.0, seg(w("a", 0.0, 1.0))), part(0, 1, 2.49, seg(w("b", 2.49, 3.0)))]
    turns = build_channel_turns(parts)
    assert summary(turns) == [("s1", "a b", 0.0, 3.0)]
    check(turns, parts)


def test_between_speech_segments_a_gap_of_1_5_ends_the_turn() -> None:
    parts = [part(0, 0, 0.0, seg(w("a", 0.0, 1.0))), part(0, 1, 2.5, seg(w("b", 2.5, 3.0)))]
    turns = build_channel_turns(parts)
    assert summary(turns) == [("s1", "a", 0.0, 1.0), ("s1", "b", 2.5, 3.0)]
    check(turns, parts)


def test_windows_are_ordered_by_index_not_by_input_order() -> None:
    parts = [part(0, 1, 5.0, seg(w("b", 5.0, 6.0))), part(0, 0, 0.0, seg(w("a", 0.0, 1.0)))]
    assert [t.text for t in build_channel_turns(parts)] == ["a", "b"]


def test_an_untimed_answer_is_placed_by_its_speech_segment_start() -> None:
    parts = [
        part(1, 0, 0.0, seg(w("early", 0.0, 1.0))),
        part(1, 1, 10.0, seg(w("late", 10.0, 11.0))),
        part(0, 0, 5.0, untimed("no times here")),
    ]
    turns = build_channel_turns(parts)
    assert summary(turns) == [
        ("s2", "early", 0.0, 1.0),
        ("s1", "no times here", None, None),
        ("s2", "late", 10.0, 11.0),
    ]
    check(turns, parts)


def test_an_untimed_answer_before_everything_comes_first() -> None:
    parts = [part(1, 0, 2.0, seg(w("b", 2.0, 3.0))), part(0, 0, 0.5, untimed("hello"))]
    assert [(t.speaker, t.text, t.start) for t in build_channel_turns(parts)] == [
        ("s1", "hello", None),
        ("s2", "b", 2.0),
    ]


def test_a_turn_over_60_s_is_split_at_its_largest_gap() -> None:
    first = [w(f"a{i}", float(i), i + 0.9) for i in range(31)]  # 0 .. 30.9
    second = [w(f"b{i}", 36.0 + i, 36.9 + i) for i in range(35)]  # 36 .. 70.9: a 5.1 s gap before it
    parts = [part(0, 0, 0.0, seg(*first), seg(*second))]
    turns = build_channel_turns(parts)
    assert [(t.start, t.end) for t in turns] == [(0.0, 30.9), (36.0, 70.9)]
    assert all(t.end - t.start <= MAX_TURN_SECONDS for t in turns)  # type: ignore[operator]
    check(turns, parts)


def test_ids_are_in_merged_order() -> None:
    parts = [
        part(0, 0, 0.0, seg(w("a", 0.0, 1.0))),
        part(0, 1, 6.0, seg(w("c", 6.0, 7.0))),
        part(1, 0, 3.0, seg(w("b", 3.0, 4.0))),
        part(1, 1, 9.0, seg(w("d", 9.0, 10.0))),
    ]
    turns = build_channel_turns(parts)
    assert [(t.id, t.text) for t in turns] == [("t1", "a"), ("t2", "b"), ("t3", "c"), ("t4", "d")]
    check(turns, parts)


def test_a_channel_with_no_parts_yields_no_turns() -> None:
    parts = [part(1, 0, 0.0, seg(w("b", 0.0, 1.0)))]
    turns = build_channel_turns(parts)
    assert summary(turns) == [("s2", "b", 0.0, 1.0)]
    assert build_channel_turns([]) == []
    assert build_channel_turns([part(0, 0, 0.0), part(1, 0, 0.0, Segment(text="  "))]) == []


def test_input_is_not_changed() -> None:
    parts = [part(0, 0, 0.0, seg(w("a", 0.0, 0.3), w("b"), w("c", 0.4, 0.5))), part(1, 0, 0.2, untimed("x y"))]
    before = [[s.model_copy(deep=True) for s in p.segments] for p in parts]
    build_channel_turns(parts)
    assert [list(p.segments) for p in parts] == before


# ---- property: no word is lost or duplicated, and a turn has one speaker ----


def _random_parts(rng: random.Random) -> list[ChannelPart]:
    parts: list[ChannelPart] = []
    for channel in (0, 1):
        t = rng.uniform(0, 5)
        for window in range(rng.randint(0, 5)):
            window_start = round(t, 3)
            segments: list[Segment] = []
            for s in range(rng.randint(0, 3)):
                kind = rng.random()
                if kind < 0.15:
                    segments.append(untimed(f"u{channel}x{window}x{s}"))
                    continue
                if kind < 0.25:
                    segments.append(Segment(text=" "))
                    continue
                words = []
                for i in range(rng.randint(1, 6)):
                    name = f"w{channel}x{window}x{s}x{i}"
                    if rng.random() < 0.2:
                        words.append(w(name))
                    else:
                        start = round(t, 3)
                        t += rng.uniform(0.05, 0.8)
                        words.append(w(name, start, round(t, 3)))
                        t += rng.choice([0.0, 0.1, 0.5, 2.0, 0.05])
                if rng.random() < 0.3:  # the segment's own times only
                    seg_start = round(t, 3)
                    t += 1.0
                    segments.append(seg(*[w(x.text) for x in words], start=seg_start, end=round(t, 3)))
                else:
                    segments.append(seg(*words) if any(x.start is not None for x in words) else untimed(name))
            parts.append(part(channel, window, window_start, *segments))
            t += rng.uniform(0.0, 8.0)
    rng.shuffle(parts)
    return parts


def test_random_inputs_keep_every_word_once() -> None:
    rng = random.Random(20261124)
    for _ in range(300):
        parts = _random_parts(rng)
        turns = build_channel_turns(parts)
        check(turns, parts)
        for t in turns:
            assert (t.start is None) == (t.end is None)
            if t.start is not None:  # every unit here is shorter than a second, so a long turn was split
                assert t.end - t.start <= MAX_TURN_SECONDS  # type: ignore[operator]
