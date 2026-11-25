"""`aftertalk transcribe --channels split`, `--speakers`, `--roles` and `--format md` (the CLI runner of
test_cli_speech.py). Voice detection is a stub: the tests never load Silero."""

import json
from pathlib import Path

import numpy as np
import pytest
from audio_tools import make_tone
from fake_speech import FakeSpeech, reply
from typer.testing import CliRunner

from aftertalk.audio.decode import SAMPLE_RATE
from aftertalk.cli import app
from aftertalk.render import times_needed

KEY = "sk-cli-split-KEY-456"


def setup(tmp_path: Path, base_url: str, extra: str = "") -> dict[str, str]:
    (tmp_path / "connections.yaml").write_text(
        f'speech: {{base_url: "{base_url}", api_key: "${{K}}", model: whisper-1{extra}}}\n', encoding="utf-8"
    )
    return {"AFTERTALK_HOME": str(tmp_path), "K": KEY}


def invoke(env: dict[str, str], *args: str):
    return CliRunner().invoke(app, [*args], env=env)


class StubDetector:
    """Answers the queued ranges (in seconds), one list per call: channel 0 is asked first, then channel 1."""

    def __init__(self, *per_channel: list[tuple[float, float]]) -> None:
        self.per_channel = list(per_channel)
        self.calls = 0

    def __call__(self, samples: np.ndarray, max_speech_seconds: float, stop: object = None) -> list[tuple[int, int]]:
        ranges = self.per_channel[self.calls] if self.calls < len(self.per_channel) else []
        self.calls += 1
        return [(int(a * SAMPLE_RATE), int(b * SAMPLE_RATE)) for a, b in ranges]


@pytest.fixture
def detector(monkeypatch: pytest.MonkeyPatch) -> StubDetector:
    """Channel 0 speaks 0-1 s, channel 1 1.5-3 s. The probe sends the longer one (channel 1) first."""
    stub = StubDetector([(0.0, 1.0)], [(1.5, 3.0)])
    monkeypatch.setattr("aftertalk.audio.vad.silero_available", lambda: True)
    monkeypatch.setattr("aftertalk.pipeline.transcribe.load_detector", lambda: stub)
    return stub


@pytest.fixture
def stereo(tmp_path: Path) -> Path:
    return make_tone(tmp_path / "call.wav", seconds=3.0, channels=2)


# ---- usage errors: exit 2, nothing sent ----


@pytest.mark.parametrize(
    ("args", "message"),
    [
        (["--roles", "customer,agent"], "need --channels split"),
        (["--speakers", "Ann,Bob"], "need --channels split"),
        (["--channels", "mix", "--roles", "customer,agent"], "need --channels split"),
        (["--channels", "split", "--roles", "agent,agent"], "at most one speaker per role"),
        (["--channels", "split", "--roles", "customer,customer"], "at most one speaker per role"),
        (["--channels", "split", "--roles", "agent"], "--roles takes two values"),
        (["--channels", "split", "--roles", "agent,customer,agent"], "--roles takes two values"),
        (["--channels", "split", "--roles", "agent,"], "--roles takes two values"),
        (["--channels", "split", "--roles", "boss,agent"], "--roles takes agent or customer"),
        (["--channels", "split", "--speakers", "Ann"], "--speakers takes two values"),
        (["--channels", "split", "--speakers", "Ann,Bob,Cy"], "--speakers takes two values"),
        (["--channels", "split", "--speakers", " ,Bob"], "--speakers takes two values"),
    ],
)
def test_bad_options_exit_2(
    fake_speech: FakeSpeech, tmp_path: Path, stereo: Path, detector: StubDetector, args: list[str], message: str
) -> None:
    result = invoke(setup(tmp_path, fake_speech.base_url), "transcribe", str(stereo), *args)
    assert result.exit_code == 2, result.output
    assert message in result.stderr
    assert fake_speech.seen == [] and detector.calls == 0


def test_split_without_the_audio_extra_exits_2(
    fake_speech: FakeSpeech, tmp_path: Path, stereo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("aftertalk.audio.vad.silero_available", lambda: False)
    result = invoke(setup(tmp_path, fake_speech.base_url), "transcribe", str(stereo), "--channels", "split")
    assert result.exit_code == 2
    assert "pip install 'aftertalk[audio]'" in result.stderr
    assert fake_speech.seen == []


# ---- a real split run ----


def test_split_md_output(fake_speech: FakeSpeech, tmp_path: Path, stereo: Path, detector: StubDetector) -> None:
    fake_speech.forced = [reply(["Agent", "speaking."]), reply(["Customer", "here."])]  # probe (ch 1), then ch 0
    result = invoke(setup(tmp_path, fake_speech.base_url), "transcribe", str(stereo), "--channels", "split", "-f", "md")
    assert result.exit_code == 0, result.output
    assert result.stdout == (
        "# Transcript\n\n"
        "Speakers: Customer (customer), Agent (agent)\n\n"
        "[t1 00:00:00] Customer: Customer here.\n"
        "[t2 00:00:01] Agent: Agent speaking.\n"
    )
    assert len(fake_speech.seen) == 2 and detector.calls == 2
    assert "transcribed as one mixed track" not in result.stderr


def test_split_with_speakers_and_roles(
    fake_speech: FakeSpeech, tmp_path: Path, stereo: Path, detector: StubDetector
) -> None:
    fake_speech.forced = [reply(["Agent", "speaking."]), reply(["Customer", "here."])]
    env = setup(tmp_path, fake_speech.base_url)
    args = ["--channels", "split", "--speakers", "Ann, Bob", "--roles", "agent,customer"]
    result = invoke(env, "transcribe", str(stereo), *args, "-f", "json")
    assert result.exit_code == 0, result.output
    data = json.loads(result.stdout)
    transcript = data["transcript"]
    assert [(s["id"], s["label"], s["role"], s["channel"]) for s in transcript["speakers"]] == [
        ("s1", "Ann", "agent", 0),
        ("s2", "Bob", "customer", 1),
    ]
    assert transcript["source"]["channel_mode"] == "split" and data["dropped_segments"] == 0
    assert [(t["speaker"], t["text"]) for t in transcript["segments"]] == [
        ("s1", "Customer here."),
        ("s2", "Agent speaking."),
    ]
    assert [u["step"] for u in data["usage"]] == ["decode", "vad", "transcribe"]
    fake_speech.forced = [reply(["Agent", "speaking."]), reply(["Customer", "here."])]
    detector.calls = 0  # the stub answers per call: start again at channel 0
    text = invoke(env, "transcribe", str(stereo), *args)
    assert text.exit_code == 0 and text.stdout == "Ann: Customer here.\nBob: Agent speaking.\n"


def test_split_text_names_the_speakers(
    fake_speech: FakeSpeech, tmp_path: Path, stereo: Path, detector: StubDetector
) -> None:
    fake_speech.forced = [reply(["Agent", "speaking."]), reply(["Customer", "here."])]
    result = invoke(setup(tmp_path, fake_speech.base_url), "transcribe", str(stereo), "--channels", "split")
    assert result.exit_code == 0, result.output
    assert result.stdout == "Customer: Customer here.\nAgent: Agent speaking.\n"


def test_split_reports_dropped_segments(
    fake_speech: FakeSpeech, tmp_path: Path, stereo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    stub = StubDetector([(0.0, 0.5), (1.0, 1.5), (2.0, 2.5)], [])
    monkeypatch.setattr("aftertalk.audio.vad.silero_available", lambda: True)
    monkeypatch.setattr("aftertalk.pipeline.transcribe.load_detector", lambda: stub)
    fake_speech.forced = [reply(["Dziękuję."], step=0.4) for _ in range(3)]  # the same text three times: dropped
    result = invoke(
        setup(tmp_path, fake_speech.base_url), "transcribe", str(stereo), "--channels", "split", "-f", "json"
    )
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["dropped_segments"] == 3
    assert json.loads(result.stdout)["transcript"]["segments"] == []
    assert "dropped 3 segment(s) as likely hallucinations" in result.stderr
    assert "Dziękuję" not in result.stderr


def test_split_on_a_mono_file_is_mixed_with_a_warning(
    fake_speech: FakeSpeech, tmp_path: Path, detector: StubDetector
) -> None:
    mono = make_tone(tmp_path / "mono.wav", seconds=3.0, channels=1)
    result = invoke(setup(tmp_path, fake_speech.base_url), "transcribe", str(mono), "--channels", "split", "-f", "json")
    assert result.exit_code == 0, result.output
    assert "the file does not have two channels; it was transcribed as one mixed track" in result.stderr
    transcript = json.loads(result.stdout)["transcript"]
    assert transcript["source"]["channel_mode"] == "mix" and detector.calls == 0
    assert [s["id"] for s in transcript["speakers"]] == ["s1"]


# ---- subtitles from a provider without times: refused at the first answer ----


def test_split_vtt_with_a_text_only_provider_stops_after_one_request(
    fake_speech: FakeSpeech, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    stub = StubDetector([(0.0, 1.0), (2.0, 3.0), (4.0, 5.0)], [(1.0, 1.8), (3.0, 3.8), (5.0, 5.8)])
    monkeypatch.setattr("aftertalk.audio.vad.silero_available", lambda: True)
    monkeypatch.setattr("aftertalk.pipeline.transcribe.load_detector", lambda: stub)
    fake_speech.shape = "text"
    stereo = make_tone(tmp_path / "call.wav", seconds=6.0, channels=2)
    target = tmp_path / "call.vtt"
    env = setup(tmp_path, fake_speech.base_url)
    result = invoke(env, "transcribe", str(stereo), "--channels", "split", "-f", "vtt", "-o", str(target))
    assert result.exit_code == 1
    assert times_needed("vtt") in result.stderr and "speech provider returned none" in result.stderr
    assert result.stdout == "" and not target.exists()
    assert len(fake_speech.seen) == 1


def test_mix_vtt_with_a_text_only_provider_stops_after_one_window(fake_speech: FakeSpeech, tmp_path: Path) -> None:
    fake_speech.shape = "text"
    big = make_tone(tmp_path / "big.wav", seconds=60.0, rate=16000, channels=1)  # two windows at 1 MiB
    env = setup(tmp_path, fake_speech.base_url, ", audio_format: wav, max_upload_mb: 1")
    result = invoke(env, "transcribe", str(big), "-f", "srt")
    assert result.exit_code == 1
    assert times_needed("srt") in result.stderr and result.stdout == ""
    assert len(fake_speech.seen) == 1
