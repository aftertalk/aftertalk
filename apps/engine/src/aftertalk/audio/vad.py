"""Voice detection with Silero (the `[audio]` extra): the speech segments of one channel, as sample ranges.

Ported from the old service's `providers/vad.py`: the same `silero-vad` calls, with the settings as arguments
(defaults: the spec's Constants) and the PCM arrays of `audio/decode.py` instead of pydub. The model is loaded once
per process and runs on one channel at a time (a lock), so its memory is about 230 MB per hour of audio at most.

The base install has no torch: `silero_available()` says whether the extra is installed, and `load_detector()`
raises `AudioExtraMissing` without it.
"""

import threading
from collections.abc import Callable
from functools import lru_cache
from importlib.util import find_spec
from typing import Any

import numpy as np

from aftertalk.audio.decode import SAMPLE_RATE

__all__ = [
    "INSTALL_HINT",
    "AudioExtraMissing",
    "DetectionStopped",
    "SpeechDetector",
    "detect_speech",
    "load_detector",
    "silero_available",
]

THRESHOLD = 0.4
MIN_SPEECH_MS = 250
MIN_SILENCE_MS = 800
MAX_SPEECH_SECONDS = 300.0

INSTALL_HINT = "pip install 'aftertalk[audio]'"

# int16 mono samples at 16 kHz, the longest segment in seconds and a stop event (set: give up soon, raising
# `DetectionStopped`) -> [(start, stop)] sample ranges, in order.
SpeechDetector = Callable[[np.ndarray, float, threading.Event], list[tuple[int, int]]]

_LOCK = threading.Lock()


class AudioExtraMissing(ImportError):
    """Voice detection needs the `[audio]` extra (torch and silero-vad)."""


class DetectionStopped(Exception):
    """The caller stopped waiting; raised from Silero's progress callback so the thread does not run on."""


def silero_available() -> bool:
    return find_spec("silero_vad") is not None and find_spec("torch") is not None


@lru_cache(maxsize=1)
def _model() -> Any:
    from silero_vad import load_silero_vad

    return load_silero_vad()


def detect_speech(
    samples: np.ndarray,
    *,
    max_speech_seconds: float = MAX_SPEECH_SECONDS,
    threshold: float = THRESHOLD,
    min_speech_ms: int = MIN_SPEECH_MS,
    min_silence_ms: int = MIN_SILENCE_MS,
    stop: threading.Event | None = None,
) -> list[tuple[int, int]]:
    """Speech segments of `samples` (int16 mono, 16 kHz) as (start, stop) sample ranges, in order, not overlapping.

    Silero cuts a segment longer than `max_speech_seconds`; a segment it leaves a little longer (its padding) is cut
    hard into equal pieces of at most that length, so every range fits one upload and none is a sliver. Setting
    `stop` makes Silero give up at its next progress report with `DetectionStopped`.
    """

    def progress(_: float) -> None:
        if stop is not None and stop.is_set():
            raise DetectionStopped

    if not silero_available():
        raise AudioExtraMissing(INSTALL_HINT)
    import torch
    from silero_vad import get_speech_timestamps

    longest = max(1, int(max_speech_seconds * SAMPLE_RATE))
    with _LOCK:
        scaled = np.asarray(samples).astype(np.float32)  # one copy of the channel: 4 bytes a sample
        scaled /= 32768.0
        wav = torch.from_numpy(scaled)
        del scaled
        found = get_speech_timestamps(
            wav,
            _model(),
            threshold=threshold,
            sampling_rate=SAMPLE_RATE,
            min_speech_duration_ms=min_speech_ms,
            min_silence_duration_ms=min_silence_ms,
            max_speech_duration_s=max_speech_seconds,
            return_seconds=False,
            progress_tracking_callback=progress,
        )
        del wav
    ranges: list[tuple[int, int]] = []
    total = len(samples)
    for item in found:
        start, end = max(0, int(item["start"])), min(total, int(item["end"]))
        if ranges and start < ranges[-1][1]:
            start = ranges[-1][1]  # padding never makes two segments share samples
        if end <= start:
            continue
        pieces = -(-(end - start) // longest)  # ceil
        for k in range(pieces):
            ranges.append((start + (end - start) * k // pieces, start + (end - start) * (k + 1) // pieces))
    return ranges


def load_detector() -> SpeechDetector:
    """The Silero detector with the spec's settings; raises `AudioExtraMissing` without the extra."""
    if not silero_available():
        raise AudioExtraMissing(INSTALL_HINT)

    def detector(samples: np.ndarray, max_speech_seconds: float, stop: threading.Event) -> list[tuple[int, int]]:
        return detect_speech(samples, max_speech_seconds=max_speech_seconds, stop=stop)

    return detector
