import math
import random
from typing import Any

import pytest

from aftertalk.models.transcript import Segment, Transcript, Word, spells, split_words, word_timed
from aftertalk.providers.speech.languages import _TABLE, CODES, normalize_language
from aftertalk.providers.speech.parse import parse_transcription, reported_language


def parse(data: Any, *, audio_seconds: float | None = 10.0, forced: str | None = None) -> Transcript:
    return parse_transcription(data, audio_seconds=audio_seconds, forced_language=forced)


def seg(text: str, start: Any, end: Any, **extra: Any) -> dict[str, Any]:
    return {"text": text, "start": start, "end": end, **extra}


def word(text: str, start: Any, end: Any, **extra: Any) -> dict[str, Any]:
    return {"word": text, "start": start, "end": end, **extra}


# ---- the 90% rules ----


def ten_segments(with_words: int, timed: int = 10) -> dict[str, Any]:
    segments = [seg(f"s{i}", i, i + 1) if i < timed else {"text": f"s{i}"} for i in range(10)]
    words = [word(f"s{i}", i, i + 0.5) for i in range(with_words)]
    return {"text": " ".join(s["text"] for s in segments), "segments": segments, "words": words}


def test_word_timing_needs_words_on_nine_of_ten_segments() -> None:
    assert parse(ten_segments(with_words=10)).timing == "word"
    t = parse(ten_segments(with_words=9))
    assert t.timing == "word" and sum(1 for s in t.segments if not word_timed(s)) == 1
    assert parse(ten_segments(with_words=8)).timing == "segment"


def test_segments_without_words_keep_their_segment_times() -> None:
    t = parse(ten_segments(with_words=9))
    silent = next(s for s in t.segments if not word_timed(s))
    assert (silent.start, silent.end) == (9.0, 10.0)
    assert [(w.text, w.start, w.end) for w in silent.words] == [("s9", None, None)]


def test_segment_timing_needs_times_on_nine_of_ten_segments() -> None:
    t = parse(ten_segments(with_words=0, timed=9))
    assert t.timing == "segment"
    assert parse(ten_segments(with_words=0, timed=8)).timing == "none"


def test_an_untimed_segment_stays_untimed() -> None:
    segments = [seg(f"s{i}", i * 2, i * 2 + 1) for i in range(10)]
    segments[4] = {"text": "middle"}
    t = parse({"text": "x", "segments": segments})
    assert t.timing == "segment"
    assert (t.segments[4].start, t.segments[4].end) == (None, None) and t.segments[4].text == "middle"
    assert all(s.start is not None for i, s in enumerate(t.segments) if i != 4)


def test_untimed_first_and_last_segments_stay_untimed() -> None:
    segments = [{"text": "first"}] + [seg(f"s{i}", i + 1, i + 2) for i in range(18)] + [{"text": "last"}]
    t = parse({"text": "x", "segments": segments})
    assert t.timing == "segment"
    assert (t.segments[0].start, t.segments[0].end) == (None, None)
    assert (t.segments[-1].start, t.segments[-1].end) == (None, None)


def test_top_level_words_never_land_in_an_untimed_segment() -> None:
    segments = [seg(f"s{i}", i, i + 1) for i in range(10)]
    segments[3] = {"text": "untimed"}
    t = parse({"text": "x", "segments": segments, "words": [word("w", 3.2, 3.4)]})
    assert t.segments[3].words == [Word(text="untimed")]
    # "w" went to a timed neighbour, whose words then no longer spelled its text: split, untimed.
    assert all(w.start is None for s in t.segments for w in s.words)


def test_numeric_strings_are_times() -> None:
    t = parse({"text": "a", "segments": [seg("a", "0.5", "1.5")], "words": [word("a", "0.5", " 1.0 ")]})
    assert t.timing == "word" and (t.segments[0].start, t.segments[0].words[0].end) == (0.5, 1.0)
    assert parse({"text": "a", "segments": [seg("a", "x", "1")]}).timing == "none"


def test_word_probability_is_kept() -> None:
    t = parse({"text": "a", "segments": [seg("a", 0, 1, words=[word("a", 0, 1, probability=0.75)])]})
    assert t.segments[0].words[0].probability == 0.75


def test_words_without_text_make_no_segment() -> None:
    t = parse({"text": "  ", "words": [word("a", 0, 1)]})
    assert t.segments == [] and t.timing == "none"


def test_unsorted_segments_still_get_the_right_words() -> None:
    data = {
        "text": "a b c",
        "segments": [seg("c", 4, 6), seg("a", 0, 2), seg("b", 2, 4)],
        "words": [word("a", 0, 1), word("b", 2.5, 3), word("c", 5, 6)],
    }
    t = parse(data)
    assert [[w.text for w in s.words] for s in t.segments] == [["c"], ["a"], ["b"]]


def S(text: str, start: float | None = None, end: float | None = None, words: list[Word] | None = None) -> Segment:
    return Segment(text=text, start=start, end=end, words=split_words(text) if words is None else words)


def test_validator_rules() -> None:
    timed = [Word(text="a", start=0, end=1)]
    with pytest.raises(ValueError, match="at least 90%"):
        Transcript(text="a", timing="word", segments=[S("a", 0, 1)])
    assert Transcript(text="a", timing="word", segments=[S("a", 0, 1, timed)]).timing == "word"
    ok = [S(f"s{i}", i, i + 1) for i in range(9)] + [S("x")]
    assert Transcript(text="x", timing="segment", segments=ok).segments[-1].start is None
    with pytest.raises(ValueError, match="at least 90%"):
        Transcript(text="x", timing="segment", segments=[*ok, S("y")])
    with pytest.raises(ValueError, match="both start and end"):
        Transcript(text="x", timing="segment", segments=[S("a", start=1)])
    with pytest.raises(ValueError, match="both start and end"):
        Word(text="a", start=0)
    with pytest.raises(ValueError, match="needs words"):
        Transcript(text="a", timing="none", segments=[Segment(text="a")])
    with pytest.raises(ValueError, match="spell"):
        Transcript(text="a b", timing="none", segments=[S("a b", words=[Word(text="a")])])
    with pytest.raises(ValueError, match="needs at least one segment"):
        Transcript(text="a", timing="none")
    assert Transcript(text="a", timing="none", segments=[S("a")]).timing == "none"
    t = Transcript(text="a", timing="segment", segments=[S("a", 0, 1)])
    assert t.segments[0].words == [Word(text="a")]


# ---- no text is ever lost ----


def random_response(rng: random.Random) -> dict[str, Any]:
    junk_times: list[Any] = [None, -1, "x", math.nan, True, [], "1.5", 3, 0.25, {"a": 1}, math.inf]
    segments: list[Any] = []
    for _ in range(rng.randint(0, 12)):
        kind = rng.random()
        if kind < 0.1:
            segments.append(rng.choice([None, 5, "text", []]))
            continue
        text = rng.choice(["hello", " padded ", "  ", "", "two words", "ł ó ź", 7])
        raw: dict[str, Any] = {"text": text}
        if rng.random() < 0.8:
            raw["start"], raw["end"] = rng.choice(junk_times), rng.choice(junk_times)
        if rng.random() < 0.5:
            raw["words"] = [
                {
                    "word": rng.choice(["a", " b ", "", None]),
                    "start": rng.choice(junk_times),
                    "end": rng.choice(junk_times),
                }
                for _ in range(rng.randint(0, 4))
            ]
        segments.append(raw)
    data: dict[str, Any] = {"text": "whole text", "segments": segments}
    if rng.random() < 0.5:
        data["words"] = [
            {"word": "w", "start": rng.choice(junk_times), "end": rng.choice(junk_times)}
            for _ in range(rng.randint(0, 5))
        ]
    return data


@pytest.mark.parametrize("seed", range(300))
def test_no_segment_text_is_lost_or_invented(seed: int) -> None:
    data = random_response(random.Random(seed))
    expected = [
        s["text"].strip()
        for s in data["segments"]
        if isinstance(s, dict) and isinstance(s.get("text"), str) and s["text"].strip()
    ]
    t = parse(data)
    if not expected:  # no usable segments: nothing, or the one segment built from top-level words
        assert [s.text for s in t.segments] in ([], ["whole text"])
        return
    assert [s.text for s in t.segments] == expected
    assert " ".join(s.text for s in t.segments) == " ".join(expected)
    assert t.text == "whole text"
    for s in t.segments:  # every segment has words that spell it; a word has both times or neither
        assert s.words and spells(s.words, s.text)
        assert all((w.start is None) == (w.end is None) for w in s.words)
    if t.timing != "none":
        for s in t.segments:  # both times or neither; never an estimate
            assert (s.start is None) == (s.end is None)
            assert s.start is None or (s.end is not None and s.start <= s.end)
        assert sum(s.start is not None for s in t.segments) >= 0.9 * len(t.segments)


# ---- languages ----


def test_table_is_complete_and_consistent() -> None:
    assert len(CODES) >= 99
    for code, name, iso3 in _TABLE:
        assert normalize_language(code) == normalize_language(name) == normalize_language(iso3) == code
        assert normalize_language(code.upper()) == code and normalize_language(f"{code}-XX") == code


@pytest.mark.parametrize(
    ("raw", "code"),
    [
        ("pl-PL", "pl"),
        ("zh-Hans-CN", "zh"),
        ("zh_TW", "zh"),
        ("mandarin", "zh"),
        ("cym", "cy"),
        ("Welsh", "cy"),
        ("cantonese", "yue"),
        ("haw", "haw"),
        ("iw", "he"),
        ("jw", "jv"),
        ("castilian", "es"),
        ("zz", None),
        ("xx-YY", None),
        ("klingon", None),
        ("a", None),
        ("pl pl", None),
    ],
)
def test_more_language_forms(raw: str, code: str | None) -> None:
    assert normalize_language(raw) == code


def test_reported_language() -> None:
    assert reported_language({"language": "polish"}) == "polish"
    assert reported_language({"languages": ["pl", "en"]}) == "pl"
    assert reported_language({"language": " "}) is None
    assert reported_language({"text": "a"}) is None
    assert reported_language([]) is None


# ---- words far from their segment lose their times (the transcript validator refuses them) ----


def test_nested_word_far_outside_its_segment_loses_its_times() -> None:
    t = parse({"text": "a b", "segments": [seg("a b", 0, 1, words=[word("a", 0, 0.5), word("b", 5, 6)])]})
    assert [(w.text, w.start, w.end) for w in t.segments[0].words] == [("a", 0.0, 0.5), ("b", None, None)]
    assert t.timing == "segment"


def test_top_level_word_in_a_far_gap_is_not_kept() -> None:
    data = {
        "text": "a b",
        "segments": [seg("a", 0, 1), seg("b", 10, 11)],
        "words": [word("a", 0, 0.5), word("lost", 5, 5.5), word("b", 10, 10.5)],
    }
    t = parse(data)
    # "lost" spells no part of any segment, so lining up drops it and "a" keeps its time.
    assert [[(w.text, w.start) for w in s.words] for s in t.segments] == [[("a", 0.0)], [("b", 10.0)]]


def test_a_word_timed_just_past_a_segment_edge_keeps_every_time() -> None:
    # "two" belongs to the first segment but the provider timed it mostly inside the second.
    data = {
        "text": "one two three four",
        "segments": [seg("one two", 0, 2), seg("three four", 2, 4)],
        "words": [word("one", 0, 1), word("two", 1.9, 2.4), word("three", 2.4, 3), word("four", 3, 4)],
    }
    t = parse(data)
    assert [[(w.text, w.start) for w in s.words] for s in t.segments] == [
        [("one", 0.0), ("two", 1.9)],
        [("three", 2.4), ("four", 3.0)],
    ]
    assert t.timing == "word"


@pytest.mark.parametrize("nested", [True, False])
def test_one_word_spelled_differently_costs_only_that_word(nested: bool) -> None:
    words = [word("call", 0, 0.5), word("at", 0.5, 0.7), word("ten", 0.7, 1.0), word("today", 1.0, 1.5)]
    segment = seg("Call at 10 today.", 0, 1.5)
    data = (
        {"text": "Call at 10 today.", "segments": [{**segment, "words": words}]}
        if nested
        else {"text": "Call at 10 today.", "segments": [segment], "words": words}
    )
    t = parse(data)
    assert [(w.text, w.start) for w in t.segments[0].words] == [
        ("Call", 0.0),
        ("at", 0.5),
        ("10", None),
        ("today.", 1.0),
    ]


def test_words_that_together_spell_one_piece_give_it_their_span() -> None:
    words = [word("e", 0, 0.2), word("mail", 0.2, 0.6), word("me", 0.6, 0.9)]
    t = parse(
        {"text": "e-mail me", "segments": [{**seg("e-mail me!", 0, 1), "words": words[:2] + [word("you", 0.6, 0.9)]}]}
    )
    assert [(w.text, w.start, w.end) for w in t.segments[0].words] == [("e-mail", 0.0, 0.6), ("me!", None, None)]
    assert t.timing == "segment"


def test_word_a_little_past_its_segment_is_kept() -> None:
    t = parse({"text": "a", "segments": [seg("a", 0, 1, words=[word("a", 0.9, 1.3)])]})
    assert [w.text for w in t.segments[0].words] == ["a"]


def test_a_segment_whose_words_all_lose_their_times_gives_segment_timing() -> None:
    data = {
        "text": "a b",
        "segments": [seg("a", 0, 1, words=[word("a", 0, 0.5)]), seg("b", 2, 3, words=[word("b", 8, 9)])],
    }
    t = parse(data)
    assert t.timing == "segment" and t.segments[1].words == [Word(text="b")] and t.segments[1].start == 2
