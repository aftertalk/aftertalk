import pytest
from pydantic import ValidationError

from aftertalk.models import Segment, Source, Speaker, Transcript, Word
from aftertalk.models.transcript import spells, split_words, timing_level


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


# Source, speakers and segment ids: what the pipeline adds to a provider answer.

SHA = "a" * 64


def _turn(id: str | None, speaker: str | None = None, text: str = "hi") -> Segment:
    return Segment(id=id, speaker=speaker, text=text, start=0, end=1, words=[Word(text=text, start=0, end=1)])


def _speakers(*ids: str) -> list[Speaker]:
    return [Speaker(id=i, label=f"Speaker {i}") for i in ids]


def test_provider_shaped_transcript_has_no_ids_speakers_or_source() -> None:
    t = Transcript(text="hi", timing="word", segments=[_turn(None)])
    assert t.source is None and t.speakers == [] and t.segments[0].id is None and t.segments[0].speaker is None


def test_round_trip_with_source_speakers_and_ids() -> None:
    t = Transcript(
        text="hi there",
        language="en",
        duration_seconds=50,
        timing="word",
        source=Source(
            kind="video",
            name="call.mp4",
            sha256=SHA,
            container="mov,mp4",
            channels=2,
            channel_mode="mix",
            start_offset_seconds=45,
        ),
        speakers=[Speaker(id="s1", label="Agent", role="agent", channel=0), Speaker(id="s2", label="Customer")],
        segments=[_turn("t1", "s1"), _turn("t2", "s2", "there")],
    )
    assert Transcript.model_validate_json(t.model_dump_json()) == t
    assert list(t.model_dump()["segments"][0])[:2] == ["id", "speaker"]


def test_speaker_ids_unique() -> None:
    with pytest.raises(ValidationError, match="speaker ids"):
        Transcript(text="", timing="none", speakers=_speakers("s1", "s1"))


def test_one_speaker_per_role() -> None:
    with pytest.raises(ValidationError, match="role"):
        Transcript(
            text="",
            timing="none",
            speakers=[Speaker(id="s1", label="A", role="agent"), Speaker(id="s2", label="B", role="agent")],
        )
    Transcript(text="", timing="none", speakers=_speakers("s1", "s2"))  # two without a role are fine


def test_segment_ids_all_or_none() -> None:
    with pytest.raises(ValidationError, match="all segments"):
        Transcript(text="hi hi", timing="word", segments=[_turn("t1"), _turn(None)])


def test_segment_ids_unique() -> None:
    with pytest.raises(ValidationError, match="segment ids"):
        Transcript(text="hi hi", timing="word", segments=[_turn("t1"), _turn("t1")])


def test_segment_speaker_must_be_known() -> None:
    with pytest.raises(ValidationError, match="speaker"):
        Transcript(text="hi", timing="word", speakers=_speakers("s1"), segments=[_turn("t1", "s2")])
    with pytest.raises(ValidationError, match="speaker"):
        Transcript(text="hi", timing="word", segments=[_turn("t1", "s1")])


def test_speaker_fields() -> None:
    for bad in ({"id": "", "label": "A"}, {"id": "s1", "label": ""}, {"id": "s1", "label": "A", "channel": -1}):
        with pytest.raises(ValidationError):
            Speaker(**bad)


def test_source_name_is_a_file_name() -> None:
    for bad in ("calls/a.mp3", "/tmp/a.mp3", "c:\\calls\\a.mp3"):
        with pytest.raises(ValidationError, match="file name"):
            Source(kind="audio", name=bad)
    assert Source(kind="audio", name="rozmowa 1.mp3").name == "rozmowa 1.mp3"


def test_source_sha256() -> None:
    for bad in ("A" * 64, "a" * 63, "a" * 65, "g" * 64):
        with pytest.raises(ValidationError, match="sha256"):
            Source(kind="audio", sha256=bad)
    with pytest.raises(ValidationError):
        Source(kind="audio", start_offset_seconds=-1)
    with pytest.raises(ValidationError):
        Source(kind="call")
    schema = Source.model_json_schema()["properties"]["sha256"]["anyOf"][0]
    assert schema["pattern"] == "^[0-9a-f]{64}$"  # in the contract, not only in a validator


def test_source_channels_at_least_one() -> None:
    with pytest.raises(ValidationError, match="channels"):
        Source(kind="audio", channels=0)
    assert Source(kind="audio", channels=1).channels == 1


def test_segment_id_not_empty() -> None:
    with pytest.raises(ValidationError, match="id"):
        Segment(id="", text="")
    assert Segment(text="").id is None


def _segments(timed: int, word_timed: int, untimed: int) -> list[Segment]:
    """`word_timed` word-timed segments, `timed` segment-timed only, `untimed` without times, plus a blank one."""
    out = [_turn(None) for _ in range(word_timed)]
    out += [Segment(text="hi", start=0, end=1, words=[Word(text="hi")]) for _ in range(timed)]
    out += [Segment(text="hi", words=[Word(text="hi")]) for _ in range(untimed)]
    return [*out, Segment(text=" ")]


@pytest.mark.parametrize(
    ("timed", "word_timed", "untimed", "level"),
    [
        (0, 9, 0, "word"),
        (1, 9, 0, "word"),  # 9 of 10 word-timed: exactly 90%
        (2, 8, 0, "segment"),
        (0, 9, 1, "word"),  # 9 of 10 timed, and those 9 word-timed: exactly 90% for both
        (1, 8, 1, "segment"),  # 9 of 10 timed: exactly 90%
        (1, 7, 2, "none"),
        (0, 0, 3, "none"),
        (0, 0, 0, "none"),
    ],
)
def test_timing_level_agrees_with_the_validator(timed: int, word_timed: int, untimed: int, level: str) -> None:
    segments = _segments(timed, word_timed, untimed)
    assert timing_level(segments) == level
    text = " ".join(s.text for s in segments).strip()
    order = ["none", "segment", "word"]
    for candidate in order:
        accepted = True
        try:
            Transcript(text=text, timing=candidate, segments=segments)
        except ValidationError:
            accepted = False
        if segments[:-1]:
            assert accepted == (order.index(candidate) <= order.index(level)), candidate
