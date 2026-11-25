"""`aftertalk transcribe` with a `diarization:` connection (both fakes; nothing calls pyannote.ai)."""

import json
from pathlib import Path

import pytest
from audio_tools import make_tone
from fake_pyannote import MARKER, FakePyannote, segments
from fake_speech import FakeSpeech, reply
from typer.testing import CliRunner

from aftertalk.cli import app

KEY = "sk-cli-diarize-KEY-1"
PKEY = "pyannote-cli-KEY-2"


def setup(tmp_path: Path, speech: FakeSpeech, pyannote: FakePyannote | None) -> dict[str, str]:
    text = f'speech: {{base_url: "{speech.base_url}", api_key: "${{K}}", model: whisper-1}}\n'
    if pyannote is not None:
        text += f'diarization: {{base_url: "{pyannote.base_url}", api_key: "${{P}}"}}\n'
    (tmp_path / "connections.yaml").write_text(text, encoding="utf-8")
    return {"AFTERTALK_HOME": str(tmp_path), "K": KEY, "P": PKEY}


def invoke(env: dict[str, str], *args: str):
    return CliRunner().invoke(app, [*args], env=env)


@pytest.fixture
def audio(tmp_path: Path) -> Path:
    return make_tone(tmp_path / "talk.wav", seconds=3.0, rate=16000, channels=1)


@pytest.fixture
def pyannote(fake_pyannote: FakePyannote) -> FakePyannote:
    fake_pyannote.statuses = ["succeeded"]  # no 2 s poll wait in the CLI
    fake_pyannote.output = segments((0.0, 0.95, "X"), (0.95, 3.0, "Y"))
    return fake_pyannote


def test_automatic_with_a_connection(
    fake_speech: FakeSpeech, pyannote: FakePyannote, tmp_path: Path, audio: Path
) -> None:
    fake_speech.forced = [reply(["hi", "there", "hello", "back"])]
    result = invoke(setup(tmp_path, fake_speech, pyannote), "transcribe", str(audio), "--format", "json")
    assert result.exit_code == 0, result.output
    data = json.loads(result.stdout)
    assert data["transcript"]["source"]["diarized"] is True
    assert [s["label"] for s in data["transcript"]["speakers"]] == ["Speaker 1", "Speaker 2"]
    assert [u["step"] for u in data["usage"]] == ["decode", "transcribe", "diarize"]
    assert "identifying speakers (uploading the recording to 127.0.0.1)" in result.stderr
    assert PKEY not in result.output and MARKER not in result.output


def test_text_output_names_the_speakers(
    fake_speech: FakeSpeech, pyannote: FakePyannote, tmp_path: Path, audio: Path
) -> None:
    fake_speech.forced = [reply(["hi", "there", "hello", "back"])]
    result = invoke(setup(tmp_path, fake_speech, pyannote), "transcribe", str(audio))
    assert result.stdout.splitlines() == ["Speaker 1: hi there", "Speaker 2: hello back"]


def test_no_diarize(fake_speech: FakeSpeech, pyannote: FakePyannote, tmp_path: Path, audio: Path) -> None:
    fake_speech.forced = [reply(["hi", "there"])]
    result = invoke(setup(tmp_path, fake_speech, pyannote), "transcribe", str(audio), "--no-diarize", "-f", "json")
    assert result.exit_code == 0
    assert pyannote.seen == []
    assert json.loads(result.stdout)["transcript"]["source"]["diarized"] is False


def test_diarize_without_a_connection_exits_2(fake_speech: FakeSpeech, tmp_path: Path, audio: Path) -> None:
    result = invoke(setup(tmp_path, fake_speech, None), "transcribe", str(audio), "--diarize")
    assert result.exit_code == 2 and "diarization connection" in result.stderr
    assert fake_speech.seen == []


def test_without_a_connection_nothing_changes(fake_speech: FakeSpeech, tmp_path: Path, audio: Path) -> None:
    fake_speech.forced = [reply(["hi", "there"])]
    result = invoke(setup(tmp_path, fake_speech, None), "transcribe", str(audio))
    assert result.exit_code == 0 and result.stdout == "hi there\n"
    assert "identifying speakers" not in result.stderr


def test_a_skip_is_explained(fake_speech: FakeSpeech, pyannote: FakePyannote, tmp_path: Path, audio: Path) -> None:
    fake_speech.forced = [reply(["plain", "text"], shape="text")]
    result = invoke(setup(tmp_path, fake_speech, pyannote), "transcribe", str(audio))
    assert result.exit_code == 0
    assert "speakers were not identified: the speech provider returned no timestamps" in result.stderr


def test_a_bad_diarization_key_fails_with_its_code(
    fake_speech: FakeSpeech, pyannote: FakePyannote, tmp_path: Path, audio: Path
) -> None:
    from fake_pyannote import Forced

    pyannote.forced["media"] = [Forced(401, MARKER)]
    result = invoke(setup(tmp_path, fake_speech, pyannote), "--json", "transcribe", str(audio))
    assert result.exit_code == 1
    assert json.loads(result.stdout) == {"ok": False, "code": "provider_auth"}
    assert fake_speech.seen == [] and MARKER not in result.output


def test_a_two_channel_file_mixed_and_diarized_gets_a_hint(
    fake_speech: FakeSpeech, pyannote: FakePyannote, tmp_path: Path
) -> None:
    stereo = make_tone(tmp_path / "call.wav", seconds=3.0, rate=16000, channels=2)
    fake_speech.forced = [reply(["hi", "there", "hello", "back"])]
    result = invoke(setup(tmp_path, fake_speech, pyannote), "transcribe", str(stereo))
    assert "--channels split gives one speaker per channel" in result.stderr


def test_config_show_masks_the_diarization_key(pyannote: FakePyannote, fake_speech: FakeSpeech, tmp_path: Path) -> None:
    result = invoke(setup(tmp_path, fake_speech, pyannote), "config", "show")
    assert result.exit_code == 0 and PKEY not in result.output and "diarization" in result.output
