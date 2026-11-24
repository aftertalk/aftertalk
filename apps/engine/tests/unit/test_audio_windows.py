import numpy as np
import pytest

from aftertalk.audio.decode import SAMPLE_RATE, DecodedAudio
from aftertalk.audio.encode import encode_pcm
from aftertalk.audio.windows import Window, plan_mix_windows
from aftertalk.models.errors import EngineError

S = SAMPLE_RATE


def track(signal: np.ndarray) -> DecodedAudio:
    samples = signal.reshape(len(signal), -1).astype(np.int16)
    return DecodedAudio(
        samples=samples, channels=samples.shape[1], container="wav", has_video=False,
        duration_seconds=len(samples) / S, start_offset_seconds=0.0,
    )  # fmt: skip


def noise(seconds: float, seed: int = 0, level: int = 32767) -> np.ndarray:
    return np.random.default_rng(seed).integers(-level, level + 1, int(seconds * S), dtype=np.int16)


def steady_tone(seconds: float) -> np.ndarray:
    return (np.sin(2 * np.pi * 440 * np.arange(int(seconds * S)) / S) * 8000).astype(np.int16)


def assert_tiles(windows: list[Window], total: int) -> None:
    assert windows[0].start == 0 and windows[-1].stop == total
    for before, after in zip(windows, windows[1:], strict=False):
        assert before.stop == after.start
    assert all(w.stop > w.start for w in windows)


def test_short_file_is_one_window() -> None:
    assert plan_mix_windows(track(noise(0.3)), max_bytes=25 * 1024 * 1024) == [Window(0, int(0.3 * S))]


def test_exactly_one_window_long() -> None:
    assert plan_mix_windows(track(noise(10)), max_bytes=None, max_seconds=10) == [Window(0, 10 * S)]


def test_default_budget_is_600_seconds() -> None:
    signal = np.zeros(601 * S, dtype=np.int16)
    windows = plan_mix_windows(track(signal), max_bytes=25 * 1024 * 1024)
    assert len(windows) == 2 and windows[0].stop - windows[0].start <= 600 * S


def test_cut_lands_in_silence_near_the_end() -> None:
    signal = noise(25, level=8000)
    signal[int(8.2 * S) : int(8.6 * S)] = 0  # a pause near the end of a 10 s window
    windows = plan_mix_windows(track(signal), max_bytes=None, max_seconds=10)
    assert_tiles(windows, len(signal))
    assert 8.2 * S <= windows[0].stop <= 8.6 * S


def test_quiet_but_not_silent_pause_counts_relative_to_the_region() -> None:
    signal = noise(25, level=20000)
    signal[int(7 * S) : int(7.5 * S)] = noise(0.5, seed=1, level=500)  # RMS ~290: over 30, but under a tenth
    windows = plan_mix_windows(track(signal), max_bytes=None, max_seconds=10)
    assert 7 * S <= windows[0].stop <= 7.5 * S


def test_latest_of_equally_quiet_points() -> None:
    signal = noise(25, level=8000)
    signal[int(6 * S) : int(6.5 * S)] = 0
    signal[int(8 * S) : int(8.5 * S)] = 0
    windows = plan_mix_windows(track(signal), max_bytes=None, max_seconds=10)
    assert 8 * S <= windows[0].stop <= 8.5 * S


def test_silence_before_the_search_region_is_not_used() -> None:
    signal = noise(25, level=8000)
    signal[int(2 * S) : int(3 * S)] = 0  # the search region of a 10 s window is its last 5 s
    windows = plan_mix_windows(track(signal), max_bytes=None, max_seconds=10)
    assert windows[0].stop == 10 * S


@pytest.mark.parametrize("make", [steady_tone, noise])
def test_hard_cut_without_silence(make) -> None:  # type: ignore[no-untyped-def]
    signal = make(25)
    windows = plan_mix_windows(track(signal), max_bytes=None, max_seconds=10)
    assert windows == [Window(0, 10 * S), Window(10 * S, 20 * S), Window(20 * S, 25 * S)]


def test_tail_is_never_under_a_second() -> None:
    signal = steady_tone(20.4)
    windows = plan_mix_windows(track(signal), max_bytes=None, max_seconds=10)
    assert_tiles(windows, len(signal))
    assert all(w.stop - w.start >= S for w in windows)
    assert windows[-1].stop - windows[-1].start == S


def test_tail_rule_also_holds_with_a_silent_cut() -> None:
    signal = noise(10.5, level=8000)
    signal[int(9.6 * S) :] = 0  # the quietest point would leave under a second
    windows = plan_mix_windows(track(signal), max_bytes=None, max_seconds=10)
    assert_tiles(windows, len(signal))
    assert windows[-1].stop - windows[-1].start >= S


def test_stereo_is_planned_on_the_mix() -> None:
    left = noise(25, level=8000)
    right = noise(25, seed=3, level=8000)
    left[int(8 * S) : int(8.5 * S)] = 0
    right[int(8 * S) : int(8.5 * S)] = 0
    windows = plan_mix_windows(track(np.stack([left, right], axis=1)), max_bytes=None, max_seconds=10)
    assert 8 * S <= windows[0].stop <= 8.5 * S


@pytest.mark.parametrize("max_bytes", [72_000, 100_000, 333_333, 1_000_000])
def test_windows_never_exceed_the_byte_limit(max_bytes: int) -> None:
    signal = noise(70)
    audio = track(signal)
    windows = plan_mix_windows(audio, max_bytes=max_bytes)
    assert_tiles(windows, len(signal))
    assert len(windows) > 1
    for window in windows:
        assert window.stop - window.start >= S  # no window under a second, however small the budget
        for fmt in ("wav", "flac"):
            assert encode_pcm(audio.mono(window.start, window.stop), fmt).size_bytes <= max_bytes  # type: ignore[arg-type]


def test_default_limit_leaves_600_seconds() -> None:
    signal = np.zeros(2 * S, dtype=np.int16)
    # 25 MiB / 1.01 - 4096 header bytes is more than 600 s of 16-bit samples, so the time cap decides.
    assert (int(25 * 1024 * 1024 / 1.01) - 4096) // 2 > 600 * S
    assert plan_mix_windows(track(signal), max_bytes=25 * 1024 * 1024) == [Window(0, 2 * S)]


def test_tiny_byte_limit_is_audio_too_long() -> None:
    with pytest.raises(EngineError) as info:
        plan_mix_windows(track(noise(5)), max_bytes=30_000)
    assert info.value.code == "audio_too_long"


def test_byte_limit_under_two_seconds_is_audio_too_long() -> None:
    # About 1.1 s of budget: a cut could not keep a second on each side.
    with pytest.raises(EngineError) as info:
        plan_mix_windows(track(noise(5)), max_bytes=40_000)
    assert info.value.code == "audio_too_long"


def test_a_track_that_fits_a_budget_under_two_seconds_is_one_window() -> None:
    # About 1.7 s of budget: too little to cut, but a 0.5 s clip needs no cut.
    audio = track(noise(0.5))
    assert plan_mix_windows(audio, max_bytes=60_000) == [Window(0, S // 2)]
    for fmt in ("wav", "flac"):
        assert encode_pcm(audio.mono(), fmt).size_bytes <= 60_000  # type: ignore[arg-type]


def test_max_seconds_under_two_seconds_is_a_bug() -> None:
    with pytest.raises(ValueError):
        plan_mix_windows(track(noise(5)), max_bytes=None, max_seconds=1.5)
