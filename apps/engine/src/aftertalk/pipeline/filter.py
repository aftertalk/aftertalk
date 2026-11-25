"""The hallucination filter for `channels=split` (ported from the old service's `_filter_hallucinations`).

Per-segment requests on short speech produce filler ("Dziękuję.", "Thank you for watching"). Its unit is the provider
segment: a segment that fails a rule is dropped with all its words. Thresholds are the spec's Constants. A provider
segment is dropped when

1. it is shorter than 1 s and its `avg_logprob` is under -0.45;
2. its `avg_logprob` is under -0.7;
3. it is shorter than 2 s and its `compression_ratio` is under 0.5;
4. its speaker has the same text (stripped, compared exactly) in 3 or more provider segments of the call.

A rule whose score the provider did not send is skipped, so without scores only the repetition rule runs. A rule
that needs the length is skipped for a segment without times. Mixed audio is never filtered (decision #10).
"""

from collections import Counter
from collections.abc import Sequence

from aftertalk.models.transcript import Segment

SHORT_SECONDS = 1.0
SHORT_MIN_AVG_LOGPROB = -0.45
MIN_AVG_LOGPROB = -0.7
LOW_COMPRESSION_SECONDS = 2.0
LOW_COMPRESSION_RATIO = 0.5
REPETITIONS = 3

__all__ = ["filter_hallucinations", "fails_scores"]


def fails_scores(seg: Segment) -> bool:
    """Whether a provider segment fails one of the score rules (1-3): what one window can tell on its own."""
    duration = seg.end - seg.start if seg.start is not None and seg.end is not None else None
    logprob, ratio = seg.avg_logprob, seg.compression_ratio
    if logprob is not None:
        if duration is not None and duration < SHORT_SECONDS and logprob < SHORT_MIN_AVG_LOGPROB:
            return True
        if logprob < MIN_AVG_LOGPROB:
            return True
    if (
        ratio is not None
        and duration is not None
        and duration < LOW_COMPRESSION_SECONDS
        and ratio < LOW_COMPRESSION_RATIO
    ):
        return True
    return False


def filter_hallucinations(segments: Sequence[Segment]) -> tuple[list[Segment], int]:
    """The segments that pass all four rules, in order, and how many segments with text were dropped.

    `Segment.speaker` is the speaker the repetition rule counts by. Segments without text are kept as they are.
    """
    repeats = Counter((seg.speaker, seg.text.strip()) for seg in segments if seg.text.strip())
    kept: list[Segment] = []
    dropped = 0
    for seg in segments:
        text = seg.text.strip()
        if text and (fails_scores(seg) or repeats[(seg.speaker, text)] >= REPETITIONS):
            dropped += 1
            continue
        kept.append(seg)
    return kept, dropped
