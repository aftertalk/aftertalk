"""Turns of mixed audio with diarization: `build_speaker_turns` (spec: Turns, item 68)."""

import random

from aftertalk.models.transcript import Segment, Transcript, Word, timing_level
from aftertalk.pipeline.turns import MAX_TURN_SECONDS, SpeakerSpan, _SpeakerIndex, build_speaker_turns, build_turns


def w(text: str, start: float | None, end: float | None) -> Word:
    return Word(text=text, start=start, end=end)


def seg(*words: Word, start: float | None = None, end: float | None = None, text: str | None = None) -> Segment:
    body = text if text is not None else " ".join(x.text for x in words)
    return Segment(text=body, start=start, end=end, words=list(words))


def span(start: float, end: float, speaker: str) -> SpeakerSpan:
    return SpeakerSpan(start, end, speaker)


def summary(turns: list[Segment]) -> list[tuple[str | None, str]]:
    return [(t.speaker, t.text) for t in turns]


# ---- which span a unit belongs to ----


def test_the_span_covering_the_midpoint() -> None:
    index = _SpeakerIndex([span(0, 2, "A"), span(2, 4, "B")])
    assert index(1.5, 2.3) == "A"  # midpoint 1.9
    assert index(1.8, 2.4) == "B"  # midpoint 2.1


def test_a_midpoint_on_a_shared_edge_belongs_to_the_span_that_starts_there() -> None:
    index = _SpeakerIndex([span(0, 2, "A"), span(2, 4, "B")])
    assert index(1.5, 2.5) == "B"


def test_overlapping_spans_the_larger_overlap_with_the_word_wins() -> None:
    index = _SpeakerIndex([span(0, 5.2, "A"), span(5.0, 9, "B")])
    assert index(4.7, 5.3) == "A"  # midpoint 5.0 in both: A overlaps 0.5 s, B 0.3 s


def test_overlapping_spans_equal_overlap_the_shorter_wins() -> None:
    index = _SpeakerIndex([span(0, 10, "long"), span(4.9, 5.3, "short")])
    assert index(5.0, 5.2) == "short"  # a short interjection inside a long turn goes to the interjector


def test_overlapping_spans_equal_in_all_but_order_the_earlier_in_the_input() -> None:
    assert _SpeakerIndex([span(0, 4, "A"), span(0, 4, "B")])(1, 2) == "A"
    assert _SpeakerIndex([span(0, 4, "B"), span(0, 4, "A")])(1, 2) == "B"


def test_no_span_covers_the_nearest_wins() -> None:
    index = _SpeakerIndex([span(1, 2, "A"), span(5, 6, "B")])
    assert index(0.0, 0.4) == "A"  # before the first
    assert index(2.5, 2.9) == "A"  # midpoint 2.7: 0.7 s after A, 2.3 s before B
    assert index(4.0, 4.6) == "B"  # midpoint 4.3: 0.7 s before B
    assert index(8.0, 9.0) == "B"  # after the last
    assert index(3.4, 3.6) == "A"  # midpoint 3.5: 1.5 s from each, a tie: the earlier


def test_nearest_before_is_the_latest_end_not_the_latest_start() -> None:
    index = _SpeakerIndex([span(0, 10, "A"), span(3, 4, "B"), span(20, 21, "C")])
    assert index(11, 12) == "A"  # A ends at 10, B at 4


def test_a_long_span_earlier_in_the_list_is_still_found_behind_short_ones() -> None:
    spans = [span(0, 100, "A")] + [span(i, i + 0.5, f"x{i}") for i in range(1, 50)]
    assert _SpeakerIndex(spans)(60.0, 60.2) == "A"


def test_zero_length_word() -> None:
    assert _SpeakerIndex([span(0, 2, "A"), span(2, 4, "B")])(2.0, 2.0) == "B"


# ---- turns ----


def test_two_speakers_alternate_and_change_starts_a_turn() -> None:
    segments = [seg(w("hi", 0.0, 0.4), w("there", 0.5, 0.9), w("hello", 1.0, 1.4), w("back", 1.5, 1.9))]
    turns, speakers, diarized = build_speaker_turns(segments, [span(0, 0.95, "SPK_B"), span(0.95, 3, "SPK_A")])
    assert diarized
    assert summary(turns) == [("s1", "hi there"), ("s2", "hello back")]
    assert [(s.id, s.label, s.role, s.channel) for s in speakers] == [
        ("s1", "Speaker 1", None, None),
        ("s2", "Speaker 2", None, None),
    ]
    assert [t.id for t in turns] == ["t1", "t2"]
    assert (turns[1].start, turns[1].end) == (1.0, 1.9)


def test_labels_by_first_speech_not_by_provider_label_or_span_order() -> None:
    segments = [seg(w("one", 5.0, 5.4)), seg(w("two", 9.0, 9.4))]
    spans = [span(0, 1, "SPEAKER_00"), span(8, 10, "SPEAKER_00"), span(4, 6, "SPEAKER_01")]
    turns, speakers, _ = build_speaker_turns(segments, spans)
    assert summary(turns) == [("s1", "one"), ("s2", "two")]
    assert [s.label for s in speakers] == ["Speaker 1", "Speaker 2"]


def test_a_span_speaker_with_no_words_is_not_listed() -> None:
    turns, speakers, _ = build_speaker_turns([seg(w("only", 0.1, 0.5))], [span(0, 1, "A"), span(3, 4, "B")])
    assert summary(turns) == [("s1", "only")]
    assert [s.id for s in speakers] == ["s1"]


def test_a_gap_within_one_speaker_ends_the_turn() -> None:
    segments = [seg(w("a", 0.0, 0.5), w("b", 2.0, 2.5), w("c", 2.6, 3.0))]
    turns, _, _ = build_speaker_turns(segments, [span(0, 10, "A")])
    assert summary(turns) == [("s1", "a"), ("s1", "b c")]


def test_the_same_speaker_after_another_is_a_new_turn() -> None:
    segments = [seg(w("a", 0.0, 0.4), w("b", 0.5, 0.9), w("c", 1.0, 1.4))]
    turns, speakers, _ = build_speaker_turns(segments, [span(0, 0.45, "A"), span(0.45, 0.95, "B"), span(0.95, 2, "A")])
    assert summary(turns) == [("s1", "a"), ("s2", "b"), ("s1", "c")]
    assert len(speakers) == 2


def test_a_long_turn_of_one_speaker_is_split() -> None:
    words = [w(f"w{i}", i * 1.0, i * 1.0 + 0.9) for i in range(80)]
    turns, _, _ = build_speaker_turns([seg(*words)], [span(0, 100, "A")])
    assert len(turns) >= 2
    assert all(t.end - t.start <= MAX_TURN_SECONDS for t in turns)
    assert all(t.speaker == "s1" for t in turns)


def test_a_segment_without_word_times_is_one_unit_by_its_midpoint() -> None:
    segments = [Segment(text="whole segment here", start=0.0, end=3.0)]
    turns, _, _ = build_speaker_turns(segments, [span(0, 1.0, "A"), span(1.0, 3.0, "B")])
    assert summary(turns) == [("s1", "whole segment here")]  # midpoint 1.5: B, the only speaker with words
    assert (turns[0].start, turns[0].end) == (0.0, 3.0)


def test_an_untimed_word_stays_with_the_word_before_it() -> None:
    segments = [seg(w("a", 0.0, 0.4), w("um", None, None), w("b", 1.0, 1.4))]
    turns, _, _ = build_speaker_turns(segments, [span(0, 0.7, "A"), span(0.7, 2, "B")])
    assert summary(turns) == [("s1", "a um"), ("s2", "b")]


def test_a_leading_untimed_word_goes_with_the_word_after_it() -> None:
    segments = [seg(w("so", None, None), w("yes", 1.0, 1.4))]
    turns, _, _ = build_speaker_turns(segments, [span(0, 2, "A")])
    assert summary(turns) == [("s1", "so yes")]


def test_an_edge_word_is_placed_by_its_own_times_not_the_widened_span() -> None:
    # The segment starts at 0.0, so the untimed "well" widens the first unit back to 0.0; the speaker comes from
    # the word's own 1.8-2.2 (B), not from 0.0-2.2 (midpoint 1.1: A).
    segments = [seg(w("well", None, None), w("yes", 1.8, 2.2), start=0.0, end=2.2)]
    turns, _, _ = build_speaker_turns(segments, [span(0, 1.5, "A"), span(1.5, 3, "B")])
    assert summary(turns) == [("s1", "well yes")]
    assert turns[0].start == 0.0


def test_an_untimed_segment_joins_when_the_same_speaker_goes_on() -> None:
    segments = [seg(w("a", 0.0, 0.4)), Segment(text="lost"), seg(w("b", 1.0, 1.4))]
    turns, _, _ = build_speaker_turns(segments, [span(0, 5, "A")])
    assert summary(turns) == [("s1", "a lost b")]


def test_an_untimed_segment_before_a_speaker_change_is_its_own_turn_with_the_previous_speaker() -> None:
    segments = [seg(w("a", 0.0, 0.4)), Segment(text="lost"), seg(w("b", 1.0, 1.4))]
    turns, _, _ = build_speaker_turns(segments, [span(0, 0.7, "A"), span(0.7, 5, "B")])
    assert summary(turns) == [("s1", "a"), ("s1", "lost"), ("s2", "b")]
    assert (turns[1].start, turns[1].end) == (None, None)


def test_an_untimed_segment_first_takes_the_next_speaker() -> None:
    segments = [Segment(text="first"), seg(w("b", 1.0, 1.4))]
    turns, _, _ = build_speaker_turns(segments, [span(0, 5, "A")])
    assert summary(turns) == [("s1", "first"), ("s1", "b")]


def test_no_spans_is_one_speaker_as_without_diarization() -> None:
    segments = [seg(w("a", 0.0, 0.4), w("b", 2.0, 2.4))]
    turns, speakers, diarized = build_speaker_turns(segments, [])
    assert not diarized
    assert turns == build_turns(segments, speaker="s1")
    assert [(s.id, s.label) for s in speakers] == [("s1", "Speaker 1")]


def test_no_timed_unit_is_one_speaker_as_without_diarization() -> None:
    segments = [Segment(text="plain text answer")]
    turns, speakers, diarized = build_speaker_turns(segments, [span(0, 5, "A")])
    assert not diarized
    assert summary(turns) == [("s1", "plain text answer")]
    assert len(speakers) == 1


def test_input_is_not_changed() -> None:
    segments = [seg(w("a", 0.0, 0.4), w("b", 1.0, 1.4))]
    before = [s.model_copy(deep=True) for s in segments]
    build_speaker_turns(segments, [span(0, 0.7, "A"), span(0.7, 2, "B")])
    assert segments == before


def test_property_every_word_once_in_order_and_valid() -> None:
    rng = random.Random(1234)
    for _ in range(300):
        segments: list[Segment] = []
        t = 0.0
        for _ in range(rng.randint(1, 6)):
            words = []
            for i in range(rng.randint(1, 8)):
                t += rng.choice([0.05, 0.3, 1.0, 2.0])
                if rng.random() < 0.15:
                    words.append(w(f"u{i}", None, None))
                else:
                    words.append(w(f"w{i}", round(t, 3), round(t + 0.2, 3)))
                    t += 0.2
            kind = rng.random()
            if kind < 0.1:
                segments.append(Segment(text=" ".join(x.text for x in words)))
            elif kind < 0.2:
                segments.append(
                    Segment(text=" ".join(x.text for x in words), start=round(max(0.0, t - 1), 3), end=round(t, 3))
                )
            else:
                segments.append(seg(*words))
        spans = []
        s = 0.0
        for _ in range(rng.randint(0, 6)):
            length = rng.uniform(0.1, 5)
            spans.append(span(round(s, 3), round(s + length, 3), rng.choice("ABC")))
            s += length * rng.choice([0.5, 1.0, 1.3])
        turns, speakers, _ = build_speaker_turns(segments, spans)
        flat_in = [
            x.text
            for sg in segments
            if sg.text.strip()
            for x in (sg.words or [w(t, None, None) for t in sg.text.split()])
        ]
        flat_out = [x.text for turn in turns for x in turn.words]
        assert flat_out == flat_in
        ids = {sp.id for sp in speakers}
        assert all(turn.speaker in ids for turn in turns)
        assert [sp.id for sp in speakers] == [f"s{i}" for i in range(1, len(speakers) + 1)]
        first_seen = list(dict.fromkeys(turn.speaker for turn in turns))
        assert first_seen == [sp.id for sp in speakers]
        Transcript(
            text=" ".join(turn.text for turn in turns),
            segments=turns,
            speakers=speakers,
            timing=timing_level(turns),
        )
