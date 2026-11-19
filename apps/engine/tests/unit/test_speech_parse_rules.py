import math
import random
from typing import Any

import pytest

from aftertalk.models.transcript import Segment, Transcript
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
    words = [word(f"w{i}", i, i + 0.5) for i in range(with_words)]
    return {"text": " ".join(s["text"] for s in segments), "segments": segments, "words": words}


def test_word_timing_needs_words_on_nine_of_ten_segments() -> None:
    assert parse(ten_segments(with_words=10)).timing == "word"
    t = parse(ten_segments(with_words=9))
    assert t.timing == "word" and sum(1 for s in t.segments if not s.words) == 1
    assert parse(ten_segments(with_words=8)).timing == "segment"


def test_segments_without_words_keep_their_segment_times() -> None:
    t = parse(ten_segments(with_words=9))
    silent = next(s for s in t.segments if not s.words)
    assert (silent.start, silent.end) == (9.0, 10.0)


def test_segment_timing_needs_times_on_nine_of_ten_segments() -> None:
    t = parse(ten_segments(with_words=0, timed=9))
    assert t.timing == "segment" and all(s.start is not None for s in t.segments)
    assert parse(ten_segments(with_words=0, timed=8)).timing == "none"


def test_an_untimed_segment_gets_the_gap_between_its_neighbours() -> None:
    segments = [seg(f"s{i}", i * 2, i * 2 + 1) for i in range(10)]
    segments[4] = {"text": "middle"}
    t = parse({"text": "x", "segments": segments})
    assert t.timing == "segment"
    assert (t.segments[4].start, t.segments[4].end) == (7.0, 10.0) and t.segments[4].text == "middle"


def test_untimed_first_and_last_segments() -> None:
    segments = [{"text": "first"}] + [seg(f"s{i}", i + 1, i + 2) for i in range(18)] + [{"text": "last"}]
    t = parse({"text": "x", "segments": segments})
    assert t.timing == "segment"
    assert (t.segments[0].start, t.segments[0].end) == (0.0, 1.0)
    assert t.segments[-1].start == t.segments[-1].end == 19.0


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


def test_word_validator_rule() -> None:
    with pytest.raises(ValueError, match="at least one word"):
        Transcript(text="a", timing="word", segments=[Segment(text="a", start=0, end=1)])
    t = Transcript(text="a", timing="segment", segments=[Segment(text="a", start=0, end=1)])
    assert t.segments[0].words == []


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
    if t.timing != "none":
        assert all(s.start is not None and s.end is not None and s.start <= s.end for s in t.segments)


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
