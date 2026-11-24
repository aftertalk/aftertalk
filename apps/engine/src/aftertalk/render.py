"""Write a `Transcript` as plain text, Markdown, WebVTT or SRT.

- Text: one turn per line. With two or more speakers in `transcript.speakers` each line starts with "Label: ".
- Markdown (`render_md`): a short header naming the speakers and their roles, then `render_turns`: one numbered turn
  per line, "[t12 00:01:23] Agent: ...", or "[t12] Agent: ..." for a turn without times. The ids are the JSON's
  segment ids, so a model that cites "t12" cites the JSON's turn t12. The M3 prompt reuses `render_turns`.
- VTT and SRT: a turn is cut into cues by its word times. A new cue starts at a timed word that would make the cue
  longer than `CUE_CHARS` characters or `CUE_SECONDS` seconds, or that follows a word ending a sentence (. ? !) once
  the cue is at least `CUE_MIN_SECONDS` long. An untimed word stays in the cue of the timed word before it (one at the
  start of the turn goes to the first cue), so it may push a cue past the limits; times are never invented. A cue
  runs from its first timed word's start to its last timed word's end; the turn's first cue starts at the turn's start
  and its last ends at the turn's end. A turn without word times is one cue; a turn without times has none. A cue
  longer than `CUE_LINE_CHARS` is shown on two lines. With two or more speakers, a VTT cue starts with `<v Label>`
  and an SRT cue with "Label: ".
"""

from collections.abc import Sequence

from aftertalk.models.transcript import Segment, Transcript, Word

CUE_CHARS = 84  # two lines of 42
CUE_LINE_CHARS = 42
CUE_SECONDS = 7.0
CUE_MIN_SECONDS = 1.0
_SENTENCE_END = (".", "?", "!", "…")
_TIE = 1e-9  # durations this close to a limit count as on it (1.402 - 0.402 is 0.9999999999999999)


class RenderError(Exception):
    """The transcript cannot be written in this format. The message is safe to print."""


def times_needed(name: str) -> str:
    """The message for a subtitle format and a transcript without times."""
    return (
        f"{name} needs timestamps, and the speech provider returned none for this file; use --format json, text or md"
    )


def _stamp(seconds: float, sep: str) -> str:
    millis = round(seconds * 1000)
    hours, rest = divmod(millis, 3_600_000)
    minutes, rest = divmod(rest, 60_000)
    secs, ms = divmod(rest, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}{sep}{ms:03d}"


def _clock(seconds: float) -> str:
    whole = int(seconds)
    hours, rest = divmod(whole, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def _one_line(text: str) -> str:
    return " ".join(text.split())


def _labels(transcript: Transcript) -> dict[str, str]:
    return {sp.id: _one_line(sp.label) for sp in transcript.speakers}


def _named(transcript: Transcript) -> bool:
    """Whether lines and cues name their speaker: with two or more speakers in the transcript."""
    return len(transcript.speakers) >= 2


def untimed_segments(transcript: Transcript) -> int:
    """How many segments `render_vtt` and `render_srt` skip because they have no times."""
    return sum(1 for seg in transcript.segments if seg.text.strip() and (seg.start is None or seg.end is None))


def render_text(transcript: Transcript) -> str:
    labels = _labels(transcript) if _named(transcript) else {}
    lines = []
    for seg in transcript.segments:
        text = _one_line(seg.text)
        if not text:
            continue
        label = labels.get(seg.speaker) if seg.speaker is not None else None
        lines.append(f"{label}: {text}" if label else text)
    return "\n".join(lines) + "\n"


def render_turns(transcript: Transcript) -> list[str]:
    """One line per turn with text: "[t12 00:01:23] Agent: ...", "[t12] Agent: ..." without times."""
    labels = _labels(transcript)
    lines = []
    for index, seg in enumerate(transcript.segments, start=1):
        text = _one_line(seg.text)
        if not text:
            continue
        ident = seg.id or f"t{index}"
        head = f"[{ident} {_clock(seg.start)}]" if seg.start is not None else f"[{ident}]"
        label = labels.get(seg.speaker) if seg.speaker is not None else None
        lines.append(f"{head} {label}: {text}" if label else f"{head} {text}")
    return lines


def render_md(transcript: Transcript) -> str:
    out = ["# Transcript", ""]
    if transcript.speakers:
        names = []
        for sp in transcript.speakers:
            label = _one_line(sp.label)
            names.append(f"{label} ({sp.role})" if sp.role is not None else label)
        out += [f"Speakers: {', '.join(names)}", ""]
    out += render_turns(transcript)
    return "\n".join(out) + "\n"


def _cues_of(seg: Segment) -> list[tuple[float, float, list[Word]]]:
    """The cues of one timed turn (see the module docstring)."""
    assert seg.start is not None and seg.end is not None
    if not any(w.start is not None for w in seg.words):
        return [(seg.start, seg.end, list(seg.words))]
    cues: list[tuple[float, float, list[Word]]] = []
    words: list[Word] = []
    first: float | None = None  # the cue's first timed word's start
    last: float | None = None  # its last timed word's end
    sentence_done = False

    def close() -> None:
        nonlocal words, first, last, sentence_done
        assert first is not None and last is not None
        cues.append((first, last, words))
        words, first, last, sentence_done = [], None, None, False

    for w in seg.words:
        if w.start is None or w.end is None:
            words.append(w)
            continue
        if first is not None and last is not None:
            longer = len(" ".join(x.text for x in [*words, w])) > CUE_CHARS
            if sentence_done or longer or w.end - first > CUE_SECONDS + _TIE:
                close()
        words.append(w)
        first = w.start if first is None else first
        last = w.end if last is None else max(last, w.end)
        sentence_done = w.text.rstrip().endswith(_SENTENCE_END) and last - first >= CUE_MIN_SECONDS - _TIE
    close()  # a cue is closed only before a timed word, so the last one is open here, untimed tail included
    out: list[tuple[float, float, list[Word]]] = []
    previous = seg.start
    for i, (start, end, cue_words) in enumerate(cues):
        start = seg.start if i == 0 else max(start, previous)
        end = seg.end if i == len(cues) - 1 else max(end, start)
        if out and round(end * 1000) <= round(start * 1000):  # no cue of zero length: it joins the one before
            out[-1] = (out[-1][0], max(out[-1][1], end), out[-1][2] + cue_words)
        else:
            out.append((start, end, cue_words))
        previous = max(previous, end)
    if len(out) > 1 and round(out[0][1] * 1000) <= round(out[0][0] * 1000):  # a first one joins the next
        out[1] = (out[0][0], out[1][1], out[0][2] + out[1][2])
        out.pop(0)
    return out


def _lines(text: str) -> str:
    """The cue's text, on two lines when it is longer than one: split at the space nearest the middle."""
    if len(text) <= CUE_LINE_CHARS or " " not in text:
        return text
    middle = len(text) / 2
    spaces = [i for i, ch in enumerate(text) if ch == " "]
    cut = min(spaces, key=lambda i: (abs(i - middle), i))
    return f"{text[:cut]}\n{text[cut + 1 :]}"


def _escape_vtt(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _cues(transcript: Transcript, sep: str, name: str) -> list[tuple[str, str, str | None]]:
    """(timing line, text, speaker label or None) per cue."""
    if transcript.timing == "none":
        raise RenderError(times_needed(name))
    labels = _labels(transcript) if _named(transcript) else {}
    out: list[tuple[str, str, str | None]] = []
    for seg in transcript.segments:
        if seg.start is None or seg.end is None or not seg.text.strip():
            continue  # an untimed segment gets no cue: times are never invented
        label = labels.get(seg.speaker) if seg.speaker is not None else None
        for start, end, words in _cues_of(seg):
            text = _one_line(" ".join(w.text for w in words)) if words else _one_line(seg.text)
            out.append((f"{_stamp(start, sep)} --> {_stamp(end, sep)}", text, label))
    return out


def _join(blocks: Sequence[str]) -> str:
    return "\n\n".join(blocks) + ("\n" if blocks else "")


def render_vtt(transcript: Transcript) -> str:
    blocks = []
    for when, text, label in _cues(transcript, ".", "vtt"):
        body = _lines(_escape_vtt(text)) if label is None else f"<v {_escape_vtt(label)}>{_lines(_escape_vtt(text))}"
        blocks.append(f"{when}\n{body}")
    return "WEBVTT\n\n" + _join(blocks)


def render_srt(transcript: Transcript) -> str:
    blocks = []
    for n, (when, text, label) in enumerate(_cues(transcript, ",", "srt"), start=1):
        blocks.append(f"{n}\n{when}\n{_lines(text if label is None else f'{label}: {text}')}")
    return _join(blocks)
