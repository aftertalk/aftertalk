"""Turns for one speaker: provider segments regrouped into the segments of the canonical transcript.

The input is the provider's segments in order, with times already on the file's timeline. Each segment gives units:

- one unit per word when at least one of its words has times. A word without times is not a unit: it stays with the
  word before it (or, at the very start of a turn, with the word after it) and never starts a turn by a gap. When
  the segment also has its own start and end, it keeps its edge words: untimed words before its first timed word go
  onto that word's unit, which then starts at the earlier of the segment's start and its earliest word start, and
  untimed words after its last timed word stay on that word's unit, which then ends at the later of the segment's end
  and its latest word end. A span only ever widens, and only at an edge that has untimed words;
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
in exactly one turn, in the input order. Times are never estimated or copied onto a word: a word keeps its own times
or none, and only a unit's span takes its segment's edge.
"""

import heapq
from collections.abc import Sequence
from dataclasses import dataclass, field

from aftertalk.models.transcript import Segment, Word, split_words

TURN_GAP_SECONDS = 1.5
MAX_TURN_SECONDS = 60.0

_TIE = 1e-9  # gaps this close count as equal, so float noise neither picks the split nor hides a 1.5 s gap


@dataclass
class _Unit:
    start: float
    end: float
    words: list[Word] = field(default_factory=list)
    window: int | None = None  # the speech segment it came from (`split`); None for mixed audio


@dataclass
class _Untimed:
    """The words of an untimed segment that is a turn by itself, and the speech segment it came from."""

    words: list[Word]
    window: int | None = None


def _is_gap(end: float, start: float) -> bool:
    """A new turn: `start` is `TURN_GAP_SECONDS` or more after `end` (2.002 - 0.502 is 1.4999999999999998)."""
    return start - end >= TURN_GAP_SECONDS - _TIE


def _breaks(prev: _Unit, unit: _Unit) -> bool:
    """Whether `unit` starts a new turn after `prev`: a gap, and for `split` only where a speech segment ends."""
    if prev.window is not None and prev.window == unit.window:
        return False
    return _is_gap(prev.end, unit.start)


# Timed units (a turn before long turns are split), or an untimed segment that is a turn by itself.
_Group = list[_Unit] | _Untimed


def _groups(segments: Sequence[Segment], windows: Sequence[int] | None = None) -> list[_Group]:
    """The input cut into groups at gaps and at untimed segments that do not join a turn, in order.

    `windows`, one per segment, names the speech segment each came from (`split`): a gap then only ends a turn where
    one speech segment ends and the next begins.
    """
    groups: list[_Group] = []
    current: list[_Unit] = []
    leading: list[Word] = []  # untimed words with no word before them in this turn: they go to the next unit
    pending: list[_Untimed] = []  # untimed segments after the open turn, until the next unit decides where they go
    waiting: list[Word] = []  # untimed words that came after the pending segments, kept behind them

    def close() -> None:
        nonlocal current
        if current:
            groups.append(current)
        current = []

    def add(unit: _Unit) -> None:
        nonlocal leading, pending, waiting
        if pending:  # only with a turn open
            if not _breaks(current[-1], unit):  # the turn goes on, so its span holds them
                current[-1].words.extend([w for item in pending for w in item.words] + waiting)
            else:
                close()
                groups.extend(pending)
                leading = waiting
            pending, waiting = [], []
        if current and _breaks(current[-1], unit):
            close()
        unit.words[:0] = leading
        leading = []
        current.append(unit)

    for index, seg in enumerate(segments):
        window = None if windows is None else windows[index]
        if not seg.text.strip():
            continue
        words = list(seg.words) or split_words(seg.text)
        timed = [(i, w.start, w.end) for i, w in enumerate(words) if w.start is not None and w.end is not None]
        if timed:
            # With its own times the segment holds its edge words: they widen the first and last timed word's unit.
            own = seg.start is not None and seg.end is not None
            first, last = timed[0][0], timed[-1][0]
            for i, w in enumerate(words):
                if w.start is not None and w.end is not None:
                    unit = _Unit(w.start, w.end, [w], window)
                    if own and seg.start is not None and i == first and first > 0:
                        unit.start = min(min(start for _, start, _ in timed), seg.start)
                        unit.words[:0] = words[:first]  # before `add`, so they never wait behind pending segments
                    if own and seg.end is not None and i == last and last < len(words) - 1:
                        unit.end = max(max(end for _, _, end in timed), seg.end)
                    add(unit)
                elif own and i < first:  # already on the first timed word's unit
                    continue
                elif pending:  # behind the pending segments, wherever they go
                    waiting.append(w)
                elif current:  # stays with the word before it
                    current[-1].words.append(w)
                else:
                    leading.append(w)
        elif seg.start is not None and seg.end is not None:
            add(_Unit(seg.start, seg.end, words, window))
        elif current:  # the next unit decides whether it joins this turn
            pending.append(_Untimed(words, window))
        else:
            groups.append(_Untimed(words, window))
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
        if isinstance(group, _Untimed):
            spans.append((group.words, None, None))
            continue
        for part in _split(group):
            spans.append(([w for u in part for w in u.words], min(u.start for u in part), max(u.end for u in part)))
    return [
        Segment(id=f"t{i}", speaker=speaker, text=" ".join(w.text for w in words), start=start, end=end, words=words)
        for i, (words, start, end) in enumerate(spans, start=1)
    ]


@dataclass(frozen=True)
class ChannelPart:
    """One speech segment's answer on one channel (`split`), times already on the file's timeline."""

    speaker: str  # the channel's `Speaker.id`
    channel: int
    window: int  # the speech segment's index within its channel
    start: float  # where the speech segment starts: orders an untimed answer among the other channel's turns
    segments: Sequence[Segment]


def build_channel_turns(parts: Sequence[ChannelPart]) -> list[Segment]:
    """The turns of several speakers, one per channel (spec: Turns). Pure: the input is not changed.

    Each channel is grouped as for one speaker (`build_turns`), except that a gap ends a turn only where one speech
    segment ends and the next begins: within a speech segment the turn goes on. The channels are then merged by
    start time (ties: the lower channel first), each channel keeping its own order, and a turn is a run of
    consecutive units of one channel's group: when two speakers overlap, their speech splits into alternating turns.
    An untimed answer that is a turn by itself is placed by its speech segment's start. A turn longer than
    `MAX_TURN_SECONDS` is split as for one speaker. Ids are "t1", "t2"... in the merged order.
    """
    by_channel: dict[int, list[ChannelPart]] = {}
    for part in parts:
        by_channel.setdefault(part.channel, []).append(part)
    # (sort start, channel, group key, item): each channel's items in that channel's order.
    streams: list[list[tuple[float, int, int, _Unit | _Untimed]]] = []
    speakers: dict[int, str] = {}
    for channel in sorted(by_channel):
        chan = sorted(by_channel[channel], key=lambda p: p.window)
        speakers[channel] = chan[0].speaker
        starts = {p.window: p.start for p in chan}
        segments = [seg for p in chan for seg in p.segments]
        windows = [p.window for p in chan for _ in p.segments]
        items: list[tuple[float, int, int, _Unit | _Untimed]] = []
        for key, group in enumerate(_groups(segments, windows)):
            if isinstance(group, _Untimed):
                assert group.window is not None
                items.append((starts[group.window], channel, key, group))
            else:
                items.extend((unit.start, channel, key, unit) for unit in group)
        streams.append(items)
    merged = heapq.merge(*streams, key=lambda item: (item[0], item[1]))

    spans: list[tuple[str, list[Word], float | None, float | None]] = []
    run: list[_Unit] = []
    run_key: tuple[int, int] | None = None

    def flush() -> None:
        nonlocal run
        if run and run_key is not None:
            for part in _split(run):
                words = [w for u in part for w in u.words]
                start, end = min(u.start for u in part), max(u.end for u in part)
                spans.append((speakers[run_key[0]], words, start, end))
        run = []

    for _, channel, key, item in merged:
        if isinstance(item, _Untimed):
            flush()
            run_key = None
            spans.append((speakers[channel], item.words, None, None))
            continue
        if run_key != (channel, key):
            flush()
            run_key = (channel, key)
        run.append(item)
    flush()
    return [
        Segment(id=f"t{i}", speaker=speaker, text=" ".join(w.text for w in words), start=start, end=end, words=words)
        for i, (speaker, words, start, end) in enumerate(spans, start=1)
    ]
