import threading

"""Voice detection (`audio/vad.py`): the post-processing of Silero's ranges, the missing extra, and one real run."""

from typing import Any

import numpy as np
import pytest

from aftertalk.audio import vad
from aftertalk.audio.decode import SAMPLE_RATE


def fake_silero(monkeypatch: pytest.MonkeyPatch, found: list[dict[str, int]]) -> list[dict[str, Any]]:
    """Silero's `get_speech_timestamps` answers `found`; the model is never loaded. Returns the calls' arguments."""
    silero_vad = pytest.importorskip("silero_vad")
    calls: list[dict[str, Any]] = []

    def get_speech_timestamps(wav: Any, model: Any, **kwargs: Any) -> list[dict[str, int]]:
        calls.append({"wav": wav, **kwargs})
        return found

    monkeypatch.setattr(silero_vad, "get_speech_timestamps", get_speech_timestamps)
    monkeypatch.setattr(vad, "_model", lambda: None)
    return calls


def test_settings_are_the_spec_and_are_passed(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = fake_silero(monkeypatch, [{"start": 100, "end": 5000}])
    samples = np.full(SAMPLE_RATE, 16384, dtype=np.int16)
    assert vad.detect_speech(samples) == [(100, 5000)]
    (call,) = calls
    assert call["threshold"] == 0.4 and call["sampling_rate"] == SAMPLE_RATE
    assert call["min_speech_duration_ms"] == 250 and call["min_silence_duration_ms"] == 800
    assert call["max_speech_duration_s"] == 300.0 and call["return_seconds"] is False
    assert float(call["wav"][0]) == pytest.approx(0.5)  # int16 scaled to [-1, 1)


def test_overlapping_ranges_are_made_disjoint(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_silero(
        monkeypatch,
        [
            {"start": 0, "end": 1000},
            {"start": 800, "end": 2000},
            {"start": 1500, "end": 1900},
            {"start": 3000, "end": 4000},
        ],
    )
    ranges = vad.detect_speech(np.zeros(SAMPLE_RATE, dtype=np.int16))
    assert ranges == [(0, 1000), (1000, 2000), (3000, 4000)]  # one inside the previous range is gone
    assert all(a[1] <= b[0] for a, b in zip(ranges, ranges[1:], strict=False))


def test_long_ranges_are_cut_into_pieces(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_silero(monkeypatch, [{"start": 0, "end": 40000}, {"start": 50000, "end": 66000}])
    ranges = vad.detect_speech(np.zeros(5 * SAMPLE_RATE, dtype=np.int16), max_speech_seconds=1.0)
    # 2.5 s is cut into three equal pieces, never into two long ones and a sliver
    assert ranges == [(0, 13333), (13333, 26666), (26666, 40000), (50000, 66000)]
    assert all(stop - start <= SAMPLE_RATE for start, stop in ranges)


def test_ranges_are_clamped_to_the_array(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_silero(monkeypatch, [{"start": -50, "end": 400}, {"start": 900, "end": 5000}, {"start": 7000, "end": 8000}])
    assert vad.detect_speech(np.zeros(1000, dtype=np.int16)) == [(0, 400), (900, 1000)]


def test_without_the_extra_the_detector_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(vad, "find_spec", lambda name: None)
    assert vad.silero_available() is False
    with pytest.raises(vad.AudioExtraMissing) as info:
        vad.load_detector()
    assert str(info.value) == "pip install 'aftertalk[audio]'" == vad.INSTALL_HINT
    with pytest.raises(vad.AudioExtraMissing):
        vad.detect_speech(np.zeros(10, dtype=np.int16))


def test_torch_alone_is_not_enough(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(vad, "find_spec", lambda name: object() if name == "torch" else None)
    assert vad.silero_available() is False


def test_the_detector_passes_the_longest_segment(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = fake_silero(monkeypatch, [{"start": 0, "end": 3 * SAMPLE_RATE}])
    detector = vad.load_detector()
    zeros = np.zeros(3 * SAMPLE_RATE, dtype=np.int16)
    assert detector(zeros, 2.0, threading.Event()) == [(0, 24000), (24000, 48000)]
    assert calls[0]["max_speech_duration_s"] == 2.0


# ---- the real model ----


def _voiced(seconds: float, rng: np.random.Generator) -> np.ndarray:
    """Something Silero takes for a voice: harmonics of a 120-180 Hz glottal pitch through moving formants, in
    syllables at 4 Hz. Peak 0.5 of full scale (Silero's speech probability stays above 0.9 inside, 0.4 is the bar)."""
    n = int(seconds * SAMPLE_RATE)
    t = np.arange(n) / SAMPLE_RATE
    f0 = 150 + 30 * np.sin(2 * np.pi * 0.7 * t + rng.uniform(0, 6)) + 10 * np.sin(2 * np.pi * 3.1 * t)
    phase = 2 * np.pi * np.cumsum(f0) / SAMPLE_RATE
    out = np.zeros(n)
    for k in range(1, 40):
        amp = np.full(n, 0.02)
        for i, (centre, width) in enumerate([(700, 130), (1200, 150), (2600, 200)]):
            moving = centre * (1 + 0.25 * np.sin(2 * np.pi * 2.0 * t + i))
            amp += np.exp(-((k * f0 - moving) ** 2) / (2 * width**2))
        out += amp / np.sqrt(k) * np.sin(k * phase)
    syllables = (0.5 * (1 - np.cos(2 * np.pi * 4.0 * t))) ** 0.7
    edges = np.minimum(1, np.minimum(t, t[-1] - t) / 0.05)
    out = out * syllables * edges + rng.normal(0, 0.01, n)
    return out / np.abs(out).max() * 0.5


@pytest.mark.audio_extra
def test_silero_finds_two_stretches_of_speech() -> None:
    pytest.importorskip("silero_vad")
    pytest.importorskip("torch")
    rng = np.random.default_rng(7)
    silence = lambda seconds: np.zeros(int(seconds * SAMPLE_RATE))  # noqa: E731
    signal = np.concatenate([silence(1), _voiced(1.5, rng), silence(2), _voiced(1.5, rng), silence(1)])
    signal += rng.normal(0, 0.001, len(signal))
    samples = (signal * 32767).astype(np.int16)

    ranges = vad.detect_speech(samples)

    assert len(ranges) == 2, ranges
    expected = [(1.0, 2.5), (4.5, 6.0)]
    for (start, stop), (want_start, want_stop) in zip(ranges, expected, strict=True):
        assert start / SAMPLE_RATE == pytest.approx(want_start, abs=0.3)
        assert stop / SAMPLE_RATE == pytest.approx(want_stop, abs=0.3)
    assert vad.detect_speech(np.zeros(5 * SAMPLE_RATE, dtype=np.int16)) == []


def _reporting_silero(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    """A `get_speech_timestamps` that reports its progress after every chunk, as Silero does; returns the reports."""
    silero_vad = pytest.importorskip("silero_vad")
    reports: list[int] = []

    def get_speech_timestamps(wav: Any, model: Any, **kwargs: Any) -> list[dict[str, int]]:
        for percent in (25, 50, 75, 100):
            kwargs["progress_tracking_callback"](float(percent))
            reports.append(percent)
        return [{"start": 0, "end": 800}]

    monkeypatch.setattr(silero_vad, "get_speech_timestamps", get_speech_timestamps)
    monkeypatch.setattr(vad, "_model", lambda: None)
    return reports


def test_a_set_stop_event_stops_detection_at_the_next_progress_report(monkeypatch: pytest.MonkeyPatch) -> None:
    reports = _reporting_silero(monkeypatch)
    stop = threading.Event()
    stop.set()
    with pytest.raises(vad.DetectionStopped):
        vad.detect_speech(np.zeros(SAMPLE_RATE, dtype=np.int16), stop=stop)
    assert reports == []  # it gave up at the first report


def test_detection_runs_on_while_the_stop_event_is_clear(monkeypatch: pytest.MonkeyPatch) -> None:
    reports = _reporting_silero(monkeypatch)
    samples = np.zeros(SAMPLE_RATE, dtype=np.int16)
    assert vad.detect_speech(samples, stop=threading.Event()) == [(0, 800)]
    assert vad.detect_speech(samples) == [(0, 800)]  # no event: never stopped
    assert reports == [25, 50, 75, 100] * 2


def test_the_loaded_detector_passes_its_stop_event(monkeypatch: pytest.MonkeyPatch) -> None:
    _reporting_silero(monkeypatch)
    stop = threading.Event()
    stop.set()
    with pytest.raises(vad.DetectionStopped):
        vad.load_detector()(np.zeros(SAMPLE_RATE, dtype=np.int16), 300.0, stop)
