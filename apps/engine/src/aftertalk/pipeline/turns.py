"""Turns for one speaker: provider segments regrouped into the segments of the canonical transcript.

The input is the provider's segments in order, with times already on the file's timeline. Each segment gives units:

- one unit per word when at least one of its words has times. A word without times is not a unit: it stays with the
  word before it (or, at the very start of a turn, with the word after it) and never starts a turn by a gap;
- else, when the segment has a start and end, the whole segment is one unit, its words untimed as they are;
- else (no times at all) it is untimed. It joins the open turn, its words untimed on the turn's last unit, only when
  the turn would have continued anyway: a timed turn is open and the next timed unit starts less than
  `TURN_GAP_SECONDS` after that turn's last unit ended, so the turn's span provably contains those words. Otherwise
  (no turn open, the next unit 1.5 s or more away, or no timed unit after it) it is a turn by itself, without times.
  Untimed segments in a row are decided together by the same test, and are one turn each when they do not join; an
  untimed word that comes while they wait waits with them, so the order holds either way (when they do not join, it
  leads the next unit). A plain-text window is one such segment, with up to minutes of speech: glued to a turn it
  would hide inside a span of a few seconds. An untimed turn sits in transcript order between its neighbours; its
  position in time is unknown.

A new turn starts when a unit begins `TURN_GAP_SECONDS` or more after the previous unit ended. A turn longer than
`MAX_TURN_SECONDS` is split at its largest gap between consecutive units (ties: the gap nearest the middle of the turn,
then the earlier one), repeatedly, until no part is longer; a turn of one unit is never split. A turn spans its units,
its words are theirs in order, and its text is those words joined with spaces, so the words spell it. Every word lands
in exactly one turn, in the input order. Times are never estimated or copied onto a word.
"""

from collections.abc import Sequence
from dataclasses import dataclass, field

from aftertalk.models.transcript import Segment, Word, split_words

TURN_GAP_SECONDS = 1.5
MAX_TURN_SECONDS = 60.0

_TIE = 1e-9  # gaps this close count as equal, so float noise does not pick the split


@dataclass
class _Unit:
    start: float
    end: float
    words: list[Word] = field(default_factory=list)


# Timed units (a turn before long turns are split), or the words of an untimed segment that is a turn by itself.
_Group = list[_Unit] | list[Word]


def _groups(segments: Sequence[Segment]) -> list[_Group]:
    """The input cut into groups at gaps and at untimed segments that do not join a turn, in order."""
    groups: list[_Group] = []
    current: list[_Unit] = []
    leading: list[Word] = []  # untimed words with no word before them in this turn: they go to the next unit
    pending: list[list[Word]] = []  # untimed segments after the open turn, until the next unit decides where they go
    waiting: list[Word] = []  # untimed words that came after the pending segments, kept behind them

    def close() -> None:
        nonlocal current
        if current:
            groups.append(current)
        current = []

    def add(unit: _Unit) -> None:
        nonlocal leading, pending, waiting
        if pending:  # only with a turn open
            if unit.start - current[-1].end < TURN_GAP_SECONDS:  # the turn goes on, so its span holds them
                current[-1].words.extend([w for words in pending for w in words] + waiting)
            else:
                close()
                groups.extend(pending)
                leading = waiting
            pending, waiting = [], []
        if current and unit.start - current[-1].end >= TURN_GAP_SECONDS:
            close()
        unit.words[:0] = leading
        leading = []
        current.append(unit)

    for seg in segments:
        if not seg.text.strip():
            continue
        words = list(seg.words) or split_words(seg.text)
        if any(w.start is not None for w in words):
            for w in words:
                if w.start is not None and w.end is not None:
                    add(_Unit(w.start, w.end, [w]))
                elif pending:  # behind the pending segments, wherever they go
                    waiting.append(w)
                elif current:  # stays with the word before it
                    current[-1].words.append(w)
                else:
                    leading.append(w)
        elif seg.start is not None and seg.end is not None:
            add(_Unit(seg.start, seg.end, words))
        elif current:  # the next unit decides whether it joins this turn
            pending.append(words)
        else:
            groups.append(words)
    # A segment with a timed word always places its leading and waiting untimed words on that word: none are left.
    assert not leading and not waiting
    close()
    groups.extend(pending)  # no timed unit after them: each is a turn by itself
    return groups


def _split(units: list[_Unit]) -> list[list[_Unit]]:
    """The turn split at its largest gaps until no part is longer than `MAX_TURN_SECONDS` (or it is one unit)."""
    parts: list[list[_Unit]] = []
    todo = [units]
    while todo:
        part = todo.pop()
        start, end = min(u.start for u in part), max(u.end for u in part)
        if len(part) < 2 or end - start <= MAX_TURN_SECONDS:
            parts.append(part)
            continue
        middle = (start + end) / 2
        best, best_gap, best_distance = 0, 0.0, 0.0
        for i in range(len(part) - 1):
            gap = part[i + 1].start - part[i].end
            distance = abs((part[i].end + part[i + 1].start) / 2 - middle)
            if i == 0 or gap > best_gap + _TIE or (gap >= best_gap - _TIE and distance < best_distance - _TIE):
                best, best_gap, best_distance = i, gap, distance
        todo.append(part[best + 1 :])  # popped after the first half, so the parts come out in order
        todo.append(part[: best + 1])
    return parts


def build_turns(segments: Sequence[Segment], *, speaker: str | None = None) -> list[Segment]:
    """The turns of one speaker, with ids "t1", "t2"... in order and `speaker` on each. Pure: the input is not changed.

    Provider scores (`avg_logprob` and the like) are not carried over: a turn can span several provider segments.
    """
    spans: list[tuple[list[Word], float | None, float | None]] = []
    for group in _groups(segments):
        if not isinstance(group[0], _Unit):
            spans.append((group, None, None))
            continue
        for part in _split(group):
            spans.append(([w for u in part for w in u.words], min(u.start for u in part), max(u.end for u in part)))
    return [
        Segment(id=f"t{i}", speaker=speaker, text=" ".join(w.text for w in words), start=start, end=end, words=words)
        for i, (words, start, end) in enumerate(spans, start=1)
    ]
