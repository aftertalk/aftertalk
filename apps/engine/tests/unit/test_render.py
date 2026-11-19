import pytest

from aftertalk.models.transcript import Segment, Transcript
from aftertalk.render import RenderError, render_srt, render_text, render_vtt


def transcript(timing: str = "segment") -> Transcript:
    return Transcript(
        text="Hello there. General Kenobi.",
        timing=timing,  # type: ignore[arg-type]
        segments=[
            Segment(text="Hello there.", start=0.0, end=1.25),
            Segment(text="General Kenobi.", start=3661.5, end=3662.004),
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
    assert render_text(transcript()) == "Hello there. General Kenobi.\n"


@pytest.mark.parametrize("render", [render_vtt, render_srt])
def test_subtitles_need_timing(render) -> None:
    with pytest.raises(RenderError, match="timestamps"):
        render(Transcript(text="x", timing="none"))


def test_rounding_never_shows_1000_ms() -> None:
    t = Transcript(text="a", timing="segment", segments=[Segment(text="a", start=0.9996, end=1.9999)])
    assert "00:00:01.000 --> 00:00:02.000" in render_vtt(t)


def test_blank_lines_inside_a_cue_are_removed() -> None:
    t = Transcript(text="a", timing="segment", segments=[Segment(text="a\n\nb", start=0, end=1)])
    assert "a\nb" in render_vtt(t)
