import math
from typing import Any

import pytest

from aftertalk.models.errors import EngineError
from aftertalk.providers.speech.languages import normalize_language
from aftertalk.providers.speech.parse import parse_transcription


def parse(data: Any, *, audio_seconds: float | None = 10.0, forced: str | None = None):
    return parse_transcription(data, audio_seconds=audio_seconds, forced_language=forced)


def seg(text: str, start: Any, end: Any, **extra: Any) -> dict[str, Any]:
    return {"text": text, "start": start, "end": end, **extra}


def word(text: str, start: Any, end: Any) -> dict[str, Any]:
    return {"word": text, "start": start, "end": end}


# ---- languages ----


@pytest.mark.parametrize(
    ("raw", "code"),
    [
        ("polish", "pl"),
        ("Polish", "pl"),
        (" english ", "en"),
        ("pl", "pl"),
        ("PL", "pl"),
        ("pt-BR", "pt"),
        ("en_US", "en"),
        ("german", "de"),
        ("chinese", "zh"),
        ("pol", "pl"),
        ("klingon", None),
        ("", None),
        (None, None),
        (5, None),
        ("x", None),
    ],
)
def test_normalize_language(raw: Any, code: str | None) -> None:
    assert normalize_language(raw) == code


def test_language_field_and_languages_list() -> None:
    assert parse({"text": "a", "language": "Polish"}).language == "pl"
    assert parse({"text": "a", "languages": ["german", "english"]}).language == "de"
    assert parse({"text": "a", "languages": []}).language is None
    assert parse({"text": "a", "language": "zzzz"}).language is None
    assert parse({"text": "a"}, forced="fr").language == "fr"
    assert parse({"text": "a", "language": "german"}, forced="fr").language == "de"


# ---- timing downgrade ----


def test_words_everywhere_is_word_timing() -> None:
    t = parse(
        {
            "text": "a b",
            "segments": [seg("a", 0, 1), seg("b", 1, 2)],
            "words": [word("a", 0, 1), word("b", 1, 2)],
        }
    )
    assert t.timing == "word" and [len(s.words) for s in t.segments] == [1, 1]


def test_segment_without_words_downgrades_to_segment_and_drops_words() -> None:
    t = parse({"text": "a b", "segments": [seg("a", 0, 1), seg("b", 1, 2)], "words": [word("a", 0, 1)]})
    assert t.timing == "segment" and all(not s.words for s in t.segments)


def test_segment_missing_times_downgrades_to_none() -> None:
    t = parse({"text": "a b", "segments": [seg("a", 0, 1), {"text": "b"}], "words": [word("a", 0, 1)]})
    assert t.timing == "none" and all(not s.words for s in t.segments)


@pytest.mark.parametrize(
    "bad",
    [
        word("x", None, 1),
        word("x", 1, None),
        word("x", -1, 1),
        word("x", 1.5, 1.0),
        word("x", math.nan, 1),
        word("x", 0, math.inf),
        word("x", "0", "1"),
        word("x", True, 1),
        {"word": "x"},
        {"start": 0, "end": 1},
        word("", 0, 1),
        word(" ", 0, 1),
        "word",
        None,
    ],
)
def test_malformed_words_are_dropped_not_fatal(bad: Any) -> None:
    t = parse({"text": "a x", "segments": [seg("a x", 0, 2)], "words": [word("a", 0, 1), bad]})
    assert t.timing == "word"
    assert [w.text for w in t.segments[0].words] == ["a"]


def test_all_words_malformed_downgrades_to_segment() -> None:
    t = parse({"text": "a", "segments": [seg("a", 0, 2)], "words": [word("a", 2, 1)]})
    assert t.timing == "segment" and t.segments[0].words == []


def test_malformed_segment_times_become_unknown() -> None:
    t = parse({"text": "a", "segments": [seg("a", 3, 1)]})
    assert t.timing == "none" and t.segments[0].start is None


def test_blank_segments_are_dropped() -> None:
    t = parse({"text": "a", "segments": [seg("a", 0, 1), seg("  ", 1, 2)], "words": [word("a", 0, 1)]})
    assert t.timing == "word" and len(t.segments) == 1


def test_silence_has_segment_timing_and_no_segments() -> None:
    t = parse({"text": "", "segments": [], "language": "en"})
    assert t.timing == "segment" and t.segments == []


def test_text_only_is_none() -> None:
    t = parse({"text": " hello "})
    assert t.timing == "none" and t.segments == [] and t.text == "hello"


def test_whispercpp_probability_and_nested_words() -> None:
    t = parse({"text": "a", "segments": [seg("a", 0, 1, words=[{**word("a", 0, 1), "probability": 0.5}])]})
    assert t.timing == "word" and t.segments[0].words[0].text == "a"


def test_word_text_is_stripped() -> None:
    t = parse({"text": "a", "segments": [seg(" a", 0, 1)], "words": [word(" a", 0, 1)]})
    assert t.segments[0].words[0].text == "a" and t.segments[0].text == "a"


# ---- assigning top-level words to segments ----


def test_words_go_to_the_segment_they_overlap_most() -> None:
    data = {
        "text": "a b c",
        "segments": [seg("a b", 0, 2), seg("c", 2, 4)],
        "words": [word("a", 0, 1), word("b", 1, 2.1), word("c", 2.1, 3), word("d", 3.0, 4.0)],
    }
    t = parse(data)
    assert [[w.text for w in s.words] for s in t.segments] == [["a", "b"], ["c", "d"]]


def test_word_in_a_gap_goes_to_the_nearest_segment() -> None:
    data = {
        "text": "a b",
        "segments": [seg("a", 0, 1), seg("b", 3, 4)],
        "words": [word("a", 0, 1), word("gap", 2.5, 2.6), word("b", 3, 4)],
    }
    t = parse(data)
    assert [[w.text for w in s.words] for s in t.segments] == [["a"], ["gap", "b"]]


def test_word_order_is_kept_inside_a_segment() -> None:
    data = {"text": "a", "segments": [seg("a", 0, 3)], "words": [word("c", 2, 3), word("a", 0, 1), word("b", 1, 2)]}
    assert [w.text for w in parse(data).segments[0].words] == ["a", "b", "c"]


# ---- bad shapes ----


@pytest.mark.parametrize("data", [[], "text", None, 5, {}, {"text": None}, {"text": 3}, {"text": "a", "segments": "x"}])
def test_wrong_shape_is_bad_response(data: Any) -> None:
    with pytest.raises(EngineError) as info:
        parse(data)
    assert info.value.code == "provider_bad_response"


def test_junk_segments_and_duration_are_tolerated() -> None:
    t = parse({"text": "a", "segments": [None, 5, seg("a", 0, 1)], "duration": "abc"}, audio_seconds=3.0)
    assert len(t.segments) == 1 and t.duration_seconds == 3.0
    assert parse({"text": "a", "duration": "4.5"}).duration_seconds == 4.5
    assert parse({"text": "a", "duration": -1}, audio_seconds=None).duration_seconds is None
