"""Plan the windows of a mixed (`channels=mix`) track: slices sent to the speech service one request each.

Rules:
- Windows tile the whole track in order: no overlap, no holes.
- A window is at most `max_seconds` long and fits `max_bytes` as 16-bit mono WAV with a margin, as FLAC of noise
  can be slightly larger than WAV. A track that fits the budget is one window, however small the budget; a budget
  under two seconds of audio for a track that does not fit is `audio_too_long`.
- What does not fit one window is cut at the quietest point near the window's end, when that point is silence;
  otherwise (music, crosstalk, a steady tone) it is cut hard at the longest length.
- No window is shorter than `_MIN_SECONDS` unless the whole track is: providers reject very short uploads. A cut
  keeps that much on each side of it.
- Only the search region before each cut is read, never the whole track.
"""

from dataclasses import dataclass

import numpy as np

from aftertalk.audio.decode import SAMPLE_RATE, DecodedAudio
from aftertalk.models.errors import EngineError

_FLAC_MARGIN = 1.01  # FLAC of noise can be about 1% larger than the same samples as WAV
_HEADER_BYTES = 4096  # allowance for container headers
_SEARCH_SECONDS = 30.0  # how far before the longest cut to look for a quiet point (at most half the window)
_FRAME = SAMPLE_RATE // 5  # 200 ms energy frames...
_HOP = SAMPLE_RATE // 10  # ...every 100 ms
_SILENCE_RMS = 30.0  # about -60 dBFS: silence whatever the rest sounds like
_RELATIVE_SILENCE = 0.1  # or at most a tenth of the region's median frame energy (RMS)
_MIN_SECONDS = 1.0


@dataclass(frozen=True)
class Window:
    start: int  # sample index, inclusive
    stop: int  # sample index, exclusive


def _budget(max_bytes: int) -> int:
    """How many 16-bit mono samples fit `max_bytes` as WAV, with the FLAC margin and room for headers."""
    return (int(max_bytes / _FLAC_MARGIN) - _HEADER_BYTES) // 2


def max_window_seconds(max_bytes: int | None) -> float:
    """The longest mono window, in seconds, that fits `max_bytes` (infinite without a limit)."""
    return float("inf") if max_bytes is None else max(0, _budget(max_bytes)) / SAMPLE_RATE


def plan_mix_windows(audio: DecodedAudio, *, max_bytes: int | None, max_seconds: float = 600.0) -> list[Window]:
    """Windows over `audio.mono()` that each fit one upload."""
    # Two seconds at least: a cut keeps a second on each side of it.
    if max_seconds < 2 * _MIN_SECONDS:
        raise ValueError("max_seconds must be at least two seconds")
    longest = int(max_seconds * SAMPLE_RATE)
    total = audio.samples.shape[0]
    if max_bytes is not None:
        budget = _budget(max_bytes)
        if budget < 2 * _MIN_SECONDS * SAMPLE_RATE and total > budget:  # a track that fits needs no cut
            raise EngineError("audio_too_long")
        longest = min(longest, budget)
    windows: list[Window] = []
    start = 0
    while total - start > longest:
        stop = _cut(audio, start, longest, total)
        windows.append(Window(start, stop))
        start = stop
    if total > start:
        windows.append(Window(start, total))
    return windows


def _cut(audio: DecodedAudio, start: int, longest: int, total: int) -> int:
    """Where the window that starts at `start` ends, when the rest does not fit in one window."""
    min_tail = int(_MIN_SECONDS * SAMPLE_RATE)
    hi = min(start + longest, total - min_tail)  # leave a tail of at least a second
    # The search never reaches into the window's first second, so the window is at least that long too.
    lo = max(start + min_tail, hi - int(min(_SEARCH_SECONDS * SAMPLE_RATE, longest / 2)))
    region = audio.mono(lo, hi).astype(np.float64)
    if len(region) < _FRAME:
        return hi
    count = 1 + (len(region) - _FRAME) // _HOP
    energy = np.concatenate(([0.0], np.cumsum(region * region)))
    begins = np.arange(count) * _HOP
    rms = np.sqrt(np.maximum(energy[begins + _FRAME] - energy[begins], 0.0) / _FRAME)
    quietest = count - 1 - int(np.argmin(rms[::-1]))  # the latest of equally quiet frames
    level = rms[quietest]
    if level < _SILENCE_RMS or level <= _RELATIVE_SILENCE * float(np.median(rms)):
        return lo + int(begins[quietest]) + _FRAME // 2
    return hi
