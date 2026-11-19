"""Turn a transcription response into a `Transcript`.

Providers differ: OpenAI and Groq put `words` at the top level, whisper.cpp nests them in the segments, some
servers return only `text`. The transcript's `timing` is set from what survived parsing, so a malformed time
downgrades the level instead of failing the job, and no segment text is ever dropped (except blank segments).

Rules:
- Times may be numbers or numeric strings; anything else, negative, infinite or reversed is "no time".
- A word without a usable time is dropped; a segment without one keeps its text.
- `segment` timing needs usable times on at least 90% of the segments; the others get the gap between their
  neighbours (start of the gap = end of the previous timed segment, end = start of the next one).
- `word` timing needs, on top of that, timed words on at least 90% of the segments. Segments without words keep their
  segment times. Words are kept wherever they exist.
"""

import bisect
import math
from typing import Any

from aftertalk.models.errors import EngineError
from aftertalk.models.transcript import Segment, TimingLevel, Transcript, Word
from aftertalk.providers.speech.languages import normalize_language

COVERAGE = 0.9


def _time(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        try:
            value = float(value.strip())
        except ValueError:
            return None
    if not isinstance(value, int | float):
        return None
    return float(value) if math.isfinite(value) and value >= 0 else None


def _span(raw: dict[str, Any]) -> tuple[float | None, float | None]:
    start, end = _time(raw.get("start")), _time(raw.get("end"))
    if start is None or end is None or end < start:
        return None, None
    return start, end


def _word(raw: Any) -> Word | None:
    if not isinstance(raw, dict):
        return None
    text = raw.get("word", raw.get("text"))
    start, end = _span(raw)
    if not isinstance(text, str) or not text.strip() or start is None or end is None:
        return None
    return Word(text=text.strip(), start=start, end=end, probability=_number(raw.get("probability")))


def _words(raw: Any) -> list[Word]:
    if not isinstance(raw, list):
        return []
    return [word for item in raw if (word := _word(item)) is not None]


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float) or not math.isfinite(value):
        return None
    return float(value)


def _duration(value: Any) -> float | None:
    return _time(value)


def reported_language(data: Any) -> Any:
    """What the provider says the language is: `language`, else the first of `languages`; None when it says nothing."""
    if not isinstance(data, dict):
        return None
    language = data.get("language")
    if isinstance(language, str) and language.strip():
        return language
    languages = data.get("languages")
    if isinstance(languages, list) and languages and isinstance(languages[0], str) and languages[0].strip():
        return languages[0]
    return None


def _language(data: dict[str, Any], forced: str | None) -> str | None:
    return normalize_language(reported_language(data)) or normalize_language(forced)


def _fill_gaps(segments: list[Segment]) -> list[Segment]:
    """Give each untimed segment the gap between its timed neighbours."""
    out: list[Segment] = []
    for index, seg in enumerate(segments):
        if seg.start is not None:
            out.append(seg)
            continue
        before = next((s.end for s in reversed(segments[:index]) if s.end is not None), 0.0) or 0.0
        after = next((s.start for s in segments[index + 1 :] if s.start is not None), None)
        end = max(after if after is not None else before, before)
        out.append(seg.model_copy(update={"start": before, "end": end}))
    return out


def _assign(words: list[Word], segments: list[Segment]) -> list[list[Word]]:
    """Give each top-level word to the segment it overlaps most; a word in a gap goes to the nearest one."""
    buckets: list[list[Word]] = [[] for _ in segments]
    order = sorted(range(len(segments)), key=lambda i: (segments[i].start or 0.0, segments[i].end or 0.0))
    spans = [(segments[i].start or 0.0, segments[i].end or 0.0) for i in order]
    starts = [start for start, _ in spans]
    for word in sorted(words, key=lambda w: (w.start or 0.0, w.end or 0.0)):
        assert word.start is not None and word.end is not None
        middle = (word.start + word.end) / 2
        at = bisect.bisect_right(starts, middle)
        best, best_score = 0, (-1.0, -math.inf)
        for position in range(max(at - 3, 0), min(at + 3, len(segments))):
            start, end = spans[position]
            overlap = max(0.0, min(word.end, end) - max(word.start, start))
            gap = max(start - middle, middle - end, 0.0)
            if (overlap, -gap) > best_score:
                best, best_score = position, (overlap, -gap)
        buckets[order[best]].append(word)
    return buckets


def parse_transcription(data: Any, *, audio_seconds: float | None, forced_language: str | None) -> Transcript:
    """Raises `provider_bad_response` when the response has no usable `text`."""
    text = data.get("text") if isinstance(data, dict) else None
    segments_raw = data.get("segments") if isinstance(data, dict) else None
    if not isinstance(text, str) or not (segments_raw is None or isinstance(segments_raw, list)):
        raise EngineError("provider_bad_response")
    assert isinstance(data, dict)

    segments: list[Segment] = []
    nested = False
    for raw in segments_raw or []:
        if not isinstance(raw, dict) or not isinstance(raw.get("text"), str) or not raw["text"].strip():
            continue
        start, end = _span(raw)
        words = _words(raw.get("words"))
        nested = nested or bool(words)
        segments.append(
            Segment(
                text=raw["text"].strip(),
                start=start,
                end=end,
                words=words,
                avg_logprob=_number(raw.get("avg_logprob")),
                compression_ratio=_number(raw.get("compression_ratio")),
                no_speech_prob=_number(raw.get("no_speech_prob")),
            )
        )

    top_words = [] if nested else _words(data.get("words"))
    if top_words and not segments and text.strip():
        # Words but no segments (some servers): one segment that spans the words.
        first, last = min(w.start or 0.0 for w in top_words), max(w.end or 0.0 for w in top_words)
        segments = [Segment(text=text.strip(), start=first, end=last)]

    timing: TimingLevel = "none"
    if segments:
        timed = sum(1 for seg in segments if seg.start is not None)
        if timed / len(segments) >= COVERAGE:
            segments = _fill_gaps(segments)
            timing = "segment"
            if top_words:
                buckets = _assign(top_words, segments)
                segments = [
                    seg.model_copy(update={"words": words}) for seg, words in zip(segments, buckets, strict=True)
                ]
            with_words = sum(1 for seg in segments if seg.words)
            if with_words and with_words / len(segments) >= COVERAGE:
                timing = "word"
    elif segments_raw == [] and not text.strip():
        timing = "segment"  # silence: the provider answered with segments, and there are none

    duration = _duration(data.get("duration"))
    return Transcript(
        text=text.strip(),
        language=_language(data, forced_language),
        duration_seconds=duration if duration is not None else audio_seconds,
        timing=timing,
        segments=segments,
    )
