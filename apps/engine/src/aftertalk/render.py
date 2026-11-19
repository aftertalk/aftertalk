"""Write a `Transcript` as plain text, WebVTT or SRT (one cue per segment)."""

from aftertalk.models.transcript import Transcript


class RenderError(Exception):
    """The transcript cannot be written in this format. The message is safe to print."""


def _stamp(seconds: float, sep: str) -> str:
    millis = round(seconds * 1000)
    hours, rest = divmod(millis, 3_600_000)
    minutes, rest = divmod(rest, 60_000)
    secs, ms = divmod(rest, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}{sep}{ms:03d}"


def _cue_text(text: str) -> str:
    return "\n".join(line.strip() for line in text.splitlines() if line.strip())  # a blank line ends a cue


def _cues(transcript: Transcript, sep: str, name: str) -> list[tuple[str, str]]:
    if transcript.timing == "none":
        raise RenderError(f"{name} needs timestamps, and this provider returned none; use --format json or text")
    return [
        (f"{_stamp(seg.start, sep)} --> {_stamp(seg.end, sep)}", _cue_text(seg.text))
        for seg in transcript.segments
        if seg.start is not None and seg.end is not None  # an untimed segment gets no cue: times are never invented
    ]


def untimed_segments(transcript: Transcript) -> int:
    """How many segments `render_vtt` and `render_srt` skip because they have no times."""
    return sum(1 for seg in transcript.segments if seg.start is None or seg.end is None)


def render_text(transcript: Transcript) -> str:
    return transcript.text + "\n"


def render_vtt(transcript: Transcript) -> str:
    cues = _cues(transcript, ".", "vtt")
    return "WEBVTT\n\n" + "\n\n".join(f"{when}\n{text}" for when, text in cues) + ("\n" if cues else "")


def render_srt(transcript: Transcript) -> str:
    cues = _cues(transcript, ",", "srt")
    return "\n\n".join(f"{n}\n{when}\n{text}" for n, (when, text) in enumerate(cues, start=1)) + ("\n" if cues else "")
