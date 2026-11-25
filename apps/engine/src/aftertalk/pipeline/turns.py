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

import bisect
import heapq
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field

from aftertalk.models.transcript import Segment, Speaker, Word, split_words

TURN_GAP_SECONDS = 1.5
MAX_TURN_SECONDS = 60.0

_TIE = 1e-9  # gaps this close count as equal, so float noise neither picks the split nor hides a 1.5 s gap


@dataclass
class _Unit:
    start: float
    end: float
    words: list[Word] = field(default_factory=list)
    window: int | None = None  # the speech segment it came from (`split`); None for mixed audio
    speaker: str | None = None  # the diarization speaker (`build_speaker_turns`); None otherwise


@dataclass
class _Untimed:
    """The words of an untimed segment that is a turn by itself, and the speech segment it came from."""

    words: list[Word]
    window: int | None = None


def _is_gap(end: float, start: float) -> bool:
    """A new turn: `start` is `TURN_GAP_SECONDS` or more after `end` (2.002 - 0.502 is 1.4999999999999998)."""
    return start - end >= TURN_GAP_SECONDS - _TIE


def _breaks(prev: _Unit, unit: _Unit) -> bool:
    """Whether `unit` starts a new turn after `prev`: another diarization speaker, or a gap (for `split` only where a
    speech segment ends)."""
    if prev.speaker != unit.speaker:
        return True
    if prev.window is not None and prev.window == unit.window:
        return False
    return _is_gap(prev.end, unit.start)


# Timed units (a turn before long turns are split), or an untimed segment that is a turn by itself.
_Group = list[_Unit] | _Untimed


SpeakerOf = Callable[[float, float], str]


def _groups(
    segments: Sequence[Segment], windows: Sequence[int] | None = None, speaker_of: SpeakerOf | None = None
) -> list[_Group]:
    """The input cut into groups at gaps and at untimed segments that do not join a turn, in order.

    `windows`, one per segment, names the speech segment each came from (`split`): a gap then only ends a turn where
    one speech segment ends and the next begins. `speaker_of` (diarized mixed audio) names the speaker of each unit
    from its own times when it is made (a word's, or a segment-only unit's segment), before any edge widening; a
    change of speaker ends a turn.
    """

    def unit_of(start: float, end: float, words: list[Word], window: int | None) -> _Unit:
        return _Unit(start, end, words, window, None if speaker_of is None else speaker_of(start, end))

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
                    unit = unit_of(w.start, w.end, [w], window)
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
            add(unit_of(seg.start, seg.end, words, window))
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


@dataclass(frozen=True)
class SpeakerSpan:
    """One diarization segment on the file's timeline: `speaker` is the provider's label, only a grouping key."""

    start: float
    end: float
    speaker: str


class _SpeakerIndex:
    """Which span a unit belongs to, in whole milliseconds (as the pipeline compares times).

    The span that covers the unit's midpoint, a span being [start, end): a midpoint on a shared edge belongs to the
    span that starts there. Several cover it (pyannote's spans can overlap): the one that overlaps the unit most, then
    the shorter, then the earlier start, then the earlier in the input. None covers it: the nearest by the distance from
    the midpoint to its edge, a tie going to the earlier one (spec item 68), with no limit.
    """

    def __init__(self, spans: Sequence[SpeakerSpan]) -> None:
        items = sorted(
            ((round(s.start * 1000), round(s.end * 1000), i, s.speaker) for i, s in enumerate(spans)),
            key=lambda item: (item[0], item[2]),
        )
        self._items = items
        self._starts = [item[0] for item in items]
        # The latest end among items[:i + 1], and the first item that has it: stops the backward scan, and is the
        # nearest span before a midpoint that nothing covers.
        self._reach: list[tuple[int, int]] = []
        best = (-1, -1)
        for k, item in enumerate(items):
            if item[1] > best[0]:
                best = (item[1], k)
            self._reach.append(best)

    def __call__(self, start: float, end: float) -> str:
        lo, hi = round(start * 1000), round(end * 1000)
        mid = (lo + hi) / 2
        k = bisect.bisect_right(self._starts, mid)  # items[:k] start at or before the midpoint
        best: tuple[int, int, int, int] | None = None  # (-overlap, length, start, index)
        choice = ""
        i = k - 1
        while i >= 0 and self._reach[i][0] > mid:
            s, e, index, speaker = self._items[i]
            if e > mid:
                key = (-(min(e, hi) - max(s, lo)), e - s, s, index)
                if best is None or key < best:
                    best, choice = key, speaker
            i -= 1
        if best is not None:
            return choice
        before = self._items[self._reach[k - 1][1]] if k > 0 else None
        after = self._items[k] if k < len(self._items) else None
        if after is None or (before is not None and mid - before[1] <= after[0] - mid):
            assert before is not None
            return before[3]
        return after[3]


def build_speaker_turns(
    segments: Sequence[Segment], spans: Sequence[SpeakerSpan]
) -> tuple[list[Segment], list[Speaker], bool]:
    """The turns of mixed audio with diarization: `(turns, speakers, diarized)`. Pure: the input is not changed.

    Grouped as for one speaker (`build_turns`: a gap of `TURN_GAP_SECONDS` ends a turn, a turn over `MAX_TURN_SECONDS`
    is split), and each unit takes its speaker from `spans` (`_SpeakerIndex`): a timed word by its own times, a segment
    without word times by the segment's, as one unit. A change of speaker ends a turn. An untimed word stays on the unit
    beside it and takes its speaker. An untimed segment joins the open turn only when the next unit has the same speaker
    and follows within the gap; a turn by itself takes the speaker of the turn before it, else of the one after.

    Speakers are "s1", "s2"... labelled "Speaker 1", "Speaker 2"... in order of first speech in the turns; a span
    speaker who got no word is not listed. With no span, or no timed unit to place, it is one speaker as without
    diarization, and `diarized` is False.
    """
    groups = _groups(segments, speaker_of=_SpeakerIndex(spans)) if spans else []
    if not any(not isinstance(group, _Untimed) for group in groups):
        speaker = Speaker(id="s1", label="Speaker 1")
        return build_turns(segments, speaker=speaker.id), [speaker], False
    timed = [group[0].speaker if not isinstance(group, _Untimed) else None for group in groups]
    spans_out: list[tuple[str, list[Word], float | None, float | None]] = []
    previous: str | None = None
    for index, group in enumerate(groups):
        if isinstance(group, _Untimed):
            label = previous or next(s for s in timed[index + 1 :] if s is not None)
            spans_out.append((label, group.words, None, None))
            continue
        assert group[0].speaker is not None
        previous = group[0].speaker
        for part in _split(group):
            words = [w for u in part for w in u.words]
            spans_out.append((previous, words, min(u.start for u in part), max(u.end for u in part)))
    ids: dict[str, str] = {}
    for label, _, _, _ in spans_out:
        ids.setdefault(label, f"s{len(ids) + 1}")
    speakers = [Speaker(id=sid, label=f"Speaker {sid[1:]}") for sid in ids.values()]
    turns = [
        Segment(id=f"t{i}", speaker=ids[label], text=" ".join(w.text for w in words), start=start, end=end, words=words)
        for i, (label, words, start, end) in enumerate(spans_out, start=1)
    ]
    return turns, speakers, True
