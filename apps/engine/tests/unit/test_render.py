import pytest

from aftertalk.models.transcript import Segment, Speaker, Transcript, Word, split_words, timing_level
from aftertalk.render import (
    RenderError,
    _lines,
    render_md,
    render_srt,
    render_text,
    render_turns,
    render_vtt,
    untimed_segments,
)


def seg(text: str, start: float | None = None, end: float | None = None) -> Segment:
    return Segment(text=text, start=start, end=end, words=split_words(text))


def transcript(timing: str = "segment") -> Transcript:
    return Transcript(
        text="Hello there. General Kenobi.",
        timing=timing,  # type: ignore[arg-type]
        segments=[
            seg(text="Hello there.", start=0.0, end=1.25),
            seg(text="General Kenobi.", start=3661.5, end=3662.004),
        ],
    )


def test_vtt() -> None:
    assert render_vtt(transcript()) == (
        "WEBVTT\n\n00:00:00.000 --> 00:00:01.250\nHello there.\n\n01:01:01.500 --> 01:01:02.004\nGeneral Kenobi.\n"
    )


def test_srt() -> None:
    assert render_srt(transcript()) == (
        "1\n00:00:00,000 --> 00:00:01,250\nHello there.\n\n2\n01:01:01,500 --> 01:01:02,004\nGeneral Kenobi.\n"
    )


def test_text() -> None:
    assert render_text(transcript()) == "Hello there.\nGeneral Kenobi.\n"  # one turn per line


@pytest.mark.parametrize("render", [render_vtt, render_srt])
def test_subtitles_need_timing(render) -> None:
    with pytest.raises(RenderError, match="timestamps"):
        render(Transcript(text="x", timing="none", segments=[seg(text="x")]))


def test_rounding_never_shows_1000_ms() -> None:
    t = Transcript(text="a", timing="segment", segments=[seg(text="a", start=0.9996, end=1.9999)])
    assert "00:00:01.000 --> 00:00:02.000" in render_vtt(t)


def test_line_breaks_inside_a_turn_never_end_a_cue() -> None:
    t = Transcript(text="a", timing="segment", segments=[seg(text="a\n\nb", start=0, end=1)])
    assert "00:00:01.000\na b\n" in render_vtt(t)


def test_untimed_segments_get_no_cue() -> None:
    segments = [seg(text=f"s{i}", start=i, end=i + 1) for i in range(9)] + [seg(text="lost")]
    t = Transcript(text="x", timing="segment", segments=segments)
    assert untimed_segments(t) == 1
    for out in (render_vtt(t), render_srt(t)):
        assert "lost" not in out and out.count("-->") == 9
    assert untimed_segments(transcript()) == 0


# ---- several speakers, Markdown and cues ----

CUSTOMER = Speaker(id="s1", label="Customer", role="customer", channel=0)
AGENT = Speaker(id="s2", label="Agent", role="agent", channel=1)


def turn(ident: str, speaker: str | None, text: str, start: float | None = None, end: float | None = None) -> Segment:
    return Segment(id=ident, speaker=speaker, text=text, start=start, end=end, words=split_words(text))


def timed_turn(
    words: list[tuple[str, float | None, float | None]],
    start: float | None = None,
    end: float | None = None,
    speaker: str | None = None,
) -> Segment:
    ws = [Word(text=t, start=s, end=e) for t, s, e in words]
    starts = [x.start for x in ws if x.start is not None]
    ends = [x.end for x in ws if x.end is not None]
    return Segment(
        id="t1",
        speaker=speaker,
        text=" ".join(x.text for x in ws),
        start=min(starts) if start is None else start,
        end=max(ends) if end is None else end,
        words=ws,
    )


def calls(segments: list[Segment], speakers: list[Speaker] | None = None, timing: str | None = None) -> Transcript:
    return Transcript(
        text=" ".join(s.text for s in segments),
        timing=timing or timing_level(segments),  # type: ignore[arg-type]
        segments=segments,
        speakers=[CUSTOMER, AGENT] if speakers is None else speakers,
    )


def cue_texts(out: str) -> list[str]:
    """The SRT cue bodies, without numbers and times."""
    return [block.split("\n", 2)[2] for block in out.strip("\n").split("\n\n")]


def cue_times(out: str) -> list[str]:
    return [block.split("\n")[1] for block in out.strip("\n").split("\n\n")]


def test_text_names_speakers_with_two_or_more() -> None:
    t = calls([turn("t1", "s1", "Hello."), turn("t2", "s2", "Hi,\nhow can I help?")])
    assert render_text(t) == "Customer: Hello.\nAgent: Hi, how can I help?\n"


def test_text_names_speakers_even_when_one_has_no_turns() -> None:
    t = calls([turn("t1", "s2", "Anyone there?")])
    assert render_text(t) == "Agent: Anyone there?\n"


def test_text_with_one_speaker_has_no_prefix() -> None:
    t = calls([turn("t1", "s1", "Just me."), turn("t2", "s1", "Again.")], speakers=[CUSTOMER])
    assert render_text(t) == "Just me.\nAgain.\n"


def test_render_turns_lines() -> None:
    t = calls(
        [
            turn("t12", "s2", "With times.", 83.999, 85.0),
            turn("t13", "s1", "No times."),
            turn("t14", "s2", "  "),
            turn("t15", "s1", "An hour in.", 3725.99, 3727.0),
        ]
    )
    assert render_turns(t) == [
        "[t12 00:01:23] Agent: With times.",  # floored, never rounded up to 00:01:24
        "[t13] Customer: No times.",
        "[t15 01:02:05] Customer: An hour in.",
    ]


def test_render_md() -> None:
    t = calls([turn("t1", "s1", "Hello.", 0.0, 1.0), turn("t2", "s2", "Hi.", 61.5, 62.0)], speakers=[CUSTOMER, AGENT])
    assert render_md(t) == (
        "# Transcript\n\n"
        "Speakers: Customer (customer), Agent (agent)\n\n"
        "[t1 00:00:00] Customer: Hello.\n"
        "[t2 00:01:01] Agent: Hi.\n"
    )


def test_render_md_speaker_without_a_role() -> None:
    t = calls([turn("t1", "s1", "Hello.")], speakers=[Speaker(id="s1", label="Speaker 1")], timing="none")
    assert render_md(t) == "# Transcript\n\nSpeakers: Speaker 1\n\n[t1] Speaker 1: Hello.\n"


def test_subtitles_name_speakers_only_with_two_or_more() -> None:
    two = calls([turn("t1", "s2", "Hi.", 0.0, 1.0)])
    assert render_vtt(two) == "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n<v Agent>Hi.\n"
    assert render_srt(two) == "1\n00:00:00,000 --> 00:00:01,000\nAgent: Hi.\n"
    one = calls([turn("t1", "s2", "Hi.", 0.0, 1.0)], speakers=[AGENT])
    assert render_vtt(one) == "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHi.\n"
    assert render_srt(one) == "1\n00:00:00,000 --> 00:00:01,000\nHi.\n"


def test_vtt_escapes_text_and_labels() -> None:
    odd = Speaker(id="s1", label="R&D <team>")
    t = calls([turn("t1", "s1", "a < b & c > d", 0.0, 1.0)], speakers=[odd, AGENT])
    assert "<v R&amp;D &lt;team&gt;>a &lt; b &amp; c &gt; d\n" in render_vtt(t)


@pytest.mark.parametrize(("render", "name"), [(render_vtt, "vtt"), (render_srt, "srt")])
def test_refusal_for_timing_none_names_the_provider(render, name: str) -> None:
    with pytest.raises(RenderError) as info:
        render(Transcript(text="x", timing="none", segments=[seg(text="x")]))
    assert "speech provider returned none" in str(info.value) and name in str(info.value)


# ---- cues ----


def _spaced(texts: list[str], step: float = 0.3) -> list[tuple[str, float | None, float | None]]:
    return [(x, round(i * step, 3), round(i * step + 0.2, 3)) for i, x in enumerate(texts)]


def test_cue_holds_84_characters() -> None:
    words = ["a" * 9] * 6 + ["b" * 24] + ["c" * 5]
    assert len(" ".join(words[:7])) == 84
    out = render_srt(calls([timed_turn(_spaced(words))], speakers=[]))
    assert [x.replace("\n", " ") for x in cue_texts(out)] == [" ".join(words[:7]), "c" * 5]


def test_cue_over_84_characters_starts_a_new_cue() -> None:
    words = ["a" * 9] * 6 + ["b" * 25]
    out = render_srt(calls([timed_turn(_spaced(words))], speakers=[]))
    assert [x.replace("\n", " ") for x in cue_texts(out)] == [" ".join(words[:6]), "b" * 25]


def test_cue_holds_7_seconds() -> None:
    words = [("a", 0.0, 0.5), ("b", 3.0, 3.5), ("c", 6.5, 7.0), ("d", 7.0, 7.5)]
    out = render_srt(calls([timed_turn(words)], speakers=[]))
    assert cue_texts(out) == ["a b c", "d"]
    assert cue_times(out) == ["00:00:00,000 --> 00:00:07,000", "00:00:07,000 --> 00:00:07,500"]


@pytest.mark.parametrize("mark", [".", "?", "!", "…"])
def test_sentence_end_after_a_second_starts_a_cue(mark: str) -> None:
    words = [("One", 0.0, 0.4), (f"two{mark}", 0.5, 1.0), ("Three", 1.2, 1.5)]
    out = render_srt(calls([timed_turn(words)], speakers=[]))
    assert cue_texts(out) == [f"One two{mark}", "Three"]


def test_sentence_end_before_a_second_does_not() -> None:
    words = [("Hi.", 0.0, 0.9), ("There", 1.0, 1.5)]
    assert cue_texts(render_srt(calls([timed_turn(words)], speakers=[]))) == ["Hi. There"]


def test_untimed_words_stay_with_the_previous_timed_word() -> None:
    words = [("so", None, None), ("One.", 0.5, 1.5), ("um", None, None), ("Two", 2.0, 2.5), ("uh", None, None)]
    out = render_srt(calls([timed_turn(words, start=0.0, end=3.0)], speakers=[]))
    assert cue_texts(out) == ["so One. um", "Two uh"]
    # The first cue starts at the turn's start, the last ends at the turn's end.
    assert cue_times(out) == ["00:00:00,000 --> 00:00:01,500", "00:00:02,000 --> 00:00:03,000"]


def test_cues_use_turn_edges() -> None:
    words = [("One.", 0.3, 1.5), ("Two", 2.0, 4.0)]
    out = render_vtt(calls([timed_turn(words, start=0.0, end=5.0)], speakers=[]))
    assert out == "WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nOne.\n\n00:00:02.000 --> 00:00:05.000\nTwo\n"


def test_a_turn_without_word_times_is_one_cue() -> None:
    text = "no word times here. Even with sentences! And more."
    out = render_srt(calls([turn("t1", None, text, 1.0, 9.5)], speakers=[]))
    assert cue_times(out) == ["00:00:01,000 --> 00:00:09,500"]
    assert cue_texts(out)[0].replace("\n", " ") == text


def test_a_long_cue_is_two_lines_split_near_the_middle() -> None:
    text = "one two three four five six seven eight nine ten"  # 48 characters, one cue
    out = render_srt(calls([timed_turn(_spaced(text.split(), step=0.1))], speakers=[]))
    assert cue_texts(out) == ["one two three four five\nsix seven eight nine ten"]
    short = render_srt(calls([timed_turn(_spaced("forty two characters at most fit one".split(), 0.1))], []))
    assert "\n" not in cue_texts(short)[0]


# ---- zero-length and out-of-order cues ----


def test_a_zero_length_last_word_joins_the_cue_before_it() -> None:
    words = [("Good", 0.0, 0.4), ("morning", 0.4, 0.9), ("everyone.", 0.9, 1.4), ("Yes", 1.4, 1.4)]
    t = calls([timed_turn(words, start=0.0, end=1.4)], speakers=[])
    srt = render_srt(t)
    assert cue_texts(srt) == ["Good morning everyone. Yes"]
    assert cue_times(srt) == ["00:00:00,000 --> 00:00:01,400"]
    assert render_vtt(t) == "WEBVTT\n\n00:00:00.000 --> 00:00:01.400\nGood morning everyone. Yes\n"


def test_a_zero_length_first_word_joins_the_next_cue() -> None:
    words = [("Hi", 0.0, 0.0), ("there", 7.0, 7.5)]  # "there" would make the cue longer than 7 s
    out = render_srt(calls([timed_turn(words, start=0.0, end=7.5)], speakers=[]))
    assert cue_texts(out) == ["Hi there"]
    assert cue_times(out) == ["00:00:00,000 --> 00:00:07,500"]


def _ms(stamp: str) -> int:
    hours, minutes, rest = stamp.split(":")
    secs, ms = rest.replace(",", ".").split(".")
    return ((int(hours) * 60 + int(minutes)) * 60 + int(secs)) * 1000 + int(ms)


@pytest.mark.parametrize(
    "words",
    [
        # "Three" starts before "two." ends and ends earlier; "five" closes it by the 7 s rule.
        [("One", 0.0, 0.5), ("two.", 0.4, 1.5), ("Three", 1.0, 1.2), ("five", 8.5, 9.0)],
        # A later sentence starts before the previous one ended.
        [("One", 0.0, 0.6), ("two.", 0.6, 2.0), ("Three", 1.5, 1.8), ("four.", 1.8, 3.2), ("Six", 2.5, 3.0)],
        # Each word ends before the one before it.
        [("A.", 0.0, 3.0), ("B.", 0.5, 2.5), ("C.", 1.0, 2.0), ("D", 1.5, 1.6)],
        # "Three" joins the cue before it; the next cue starts after that cue's end (1.5), not after "Three" (1.2).
        [("One", 0.0, 0.5), ("two.", 0.4, 1.5), ("Three", 1.0, 1.2), ("y" * 80, 1.3, 2.0)],
    ],
)
def test_cues_with_out_of_order_word_times_never_go_backwards(words: list[tuple[str, float, float]]) -> None:
    turn_end = max(e for _, _, e in words)
    out = render_srt(calls([timed_turn(words, start=0.0, end=turn_end)], speakers=[]))
    spans = [(_ms(a), _ms(b)) for a, b in _spans(out)]
    assert spans[0][0] == 0 and spans[-1][1] == round(turn_end * 1000)
    for start, end in spans:
        assert end > start
    for (_, previous_end), (start, _) in zip(spans, spans[1:], strict=False):
        assert start >= previous_end
    assert " ".join(cue_texts(out)).replace("\n", " ") == " ".join(w for w, _, _ in words)  # no word lost


def _spans(out: str) -> list[tuple[str, str]]:
    return [(a, b) for a, b in (line.split(" --> ") for line in cue_times(out))]


# ---- two lines ----


def test_lines_split_at_the_space_nearest_the_middle() -> None:
    text = "x" * 10 + " " + "y" * 20 + " " + "z" * 15  # 47 characters, middle 23.5: spaces at 10 and 31
    assert _lines(text) == "x" * 10 + " " + "y" * 20 + "\n" + "z" * 15
    text = "x" * 15 + " " + "y" * 20 + " " + "z" * 10  # spaces at 15 and 36
    assert _lines(text) == "x" * 15 + "\n" + "y" * 20 + " " + "z" * 10


def test_lines_on_a_tie_split_at_the_earlier_space() -> None:
    text = "a" * 21 + " bb " + "c" * 20  # 45 characters, middle 22.5: spaces at 21 and 24, both 1.5 away
    assert _lines(text) == "a" * 21 + "\nbb " + "c" * 20


def test_lines_leave_a_short_text_or_one_without_spaces_alone() -> None:
    assert _lines("x" * 42) == "x" * 42
    assert _lines("x" * 50) == "x" * 50
