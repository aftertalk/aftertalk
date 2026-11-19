import json
from pathlib import Path

import pytest
from audio_tools import make_tone
from fake_speech import FakeSpeech, Forced, error_body
from typer.testing import CliRunner

from aftertalk.cli import app

KEY = "sk-cli-speech-KEY-123"
MARKER = "CLI-SPEECH-MARKER-9"


def setup(tmp_path: Path, base_url: str, extra: str = "") -> dict[str, str]:
    (tmp_path / "connections.yaml").write_text(
        f'speech: {{base_url: "{base_url}", api_key: "${{K}}", model: whisper-1{extra}}}\n', encoding="utf-8"
    )
    return {"AFTERTALK_HOME": str(tmp_path), "K": KEY}


def invoke(env: dict[str, str], *args: str):
    return CliRunner().invoke(app, [*args], env=env)


@pytest.fixture
def audio_file(tmp_path: Path) -> Path:
    return make_tone(tmp_path / "call.wav", seconds=1.5)


# ---- aftertalk transcribe ----


def test_json_output_has_transcript_and_usage(fake_speech: FakeSpeech, tmp_path: Path, audio_file: Path) -> None:
    env = setup(tmp_path, fake_speech.base_url)
    result = invoke(env, "transcribe", str(audio_file), "--format", "json")
    assert result.exit_code == 0, result.output
    data = json.loads(result.stdout)
    assert set(data) == {"transcript", "usage"}
    assert data["transcript"]["timing"] == "word" and data["transcript"]["language"] == "pl"
    assert data["usage"]["step"] == "transcribe" and data["usage"]["requests"] == 1
    assert fake_speech.seen[0].headers["authorization"] == f"Bearer {KEY}"
    upload = fake_speech.seen[0].file
    assert upload is not None and (upload.filename, upload.content_type) == ("audio.flac", "audio/flac")


def test_default_format_is_text(fake_speech: FakeSpeech, tmp_path: Path, audio_file: Path) -> None:
    result = invoke(setup(tmp_path, fake_speech.base_url), "transcribe", str(audio_file))
    assert result.exit_code == 0
    assert result.stdout == "Hello there. General Kenobi.\n"


def test_vtt_and_srt(fake_speech: FakeSpeech, tmp_path: Path, audio_file: Path) -> None:
    env = setup(tmp_path, fake_speech.base_url)
    vtt = invoke(env, "transcribe", str(audio_file), "--format", "vtt")
    assert vtt.exit_code == 0 and vtt.stdout.startswith("WEBVTT\n\n00:00:00.000 --> 00:00:01.200\nHello there.")
    srt = invoke(env, "transcribe", str(audio_file), "--format", "srt")
    assert srt.exit_code == 0 and srt.stdout.startswith("1\n00:00:00,000 --> 00:00:01,200\nHello there.")


def test_output_file(fake_speech: FakeSpeech, tmp_path: Path, audio_file: Path) -> None:
    target = tmp_path / "out" / "call.vtt"
    target.parent.mkdir()
    result = invoke(
        setup(tmp_path, fake_speech.base_url), "transcribe", str(audio_file), "-f", "vtt", "--output", str(target)
    )
    assert result.exit_code == 0 and result.stdout == ""
    assert target.read_text(encoding="utf-8").startswith("WEBVTT")


def test_progress_goes_to_stderr_without_transcript_text(
    fake_speech: FakeSpeech, tmp_path: Path, audio_file: Path
) -> None:
    result = invoke(setup(tmp_path, fake_speech.base_url), "transcribe", str(audio_file))
    for word in ("decoding", "uploading", "transcribing"):
        assert word in result.stderr.lower()
    assert "Kenobi" not in result.stderr and KEY not in result.output


def test_language_and_prompt_are_sent(fake_speech: FakeSpeech, tmp_path: Path, audio_file: Path) -> None:
    env = setup(tmp_path, fake_speech.base_url)
    result = invoke(env, "transcribe", str(audio_file), "--language", "pl", "--prompt", "Kenobi, Skywalker")
    assert result.exit_code == 0
    seen = fake_speech.seen[0]
    assert seen.values("language") == ["pl"] and seen.values("prompt") == ["Kenobi, Skywalker"]


def test_wav_connection(fake_speech: FakeSpeech, tmp_path: Path, audio_file: Path) -> None:
    env = setup(tmp_path, fake_speech.base_url, ", audio_format: wav")
    assert invoke(env, "transcribe", str(audio_file)).exit_code == 0
    upload = fake_speech.seen[0].file
    assert upload is not None and (upload.filename, upload.content_type) == ("audio.wav", "audio/wav")


def test_fallback_is_reported_on_stderr(fake_speech: FakeSpeech, tmp_path: Path, audio_file: Path) -> None:
    fake_speech.reject_verbose = True
    result = invoke(setup(tmp_path, fake_speech.base_url), "transcribe", str(audio_file), "-f", "json")
    assert result.exit_code == 0
    assert json.loads(result.stdout)["transcript"]["timing"] == "none"
    assert "timestamps" in result.stderr.lower()


def test_vtt_for_text_only_provider_fails_clearly(fake_speech: FakeSpeech, tmp_path: Path, audio_file: Path) -> None:
    fake_speech.shape = "text"
    target = tmp_path / "x.vtt"
    result = invoke(
        setup(tmp_path, fake_speech.base_url), "transcribe", str(audio_file), "-f", "vtt", "--output", str(target)
    )
    assert result.exit_code == 1
    assert "timestamps" in result.output and result.stdout == ""
    assert not target.exists()
    assert invoke(setup(tmp_path, fake_speech.base_url), "transcribe", str(audio_file), "-f", "text").exit_code == 0


def test_provider_failure_prints_only_the_code(
    fake_speech: FakeSpeech, tmp_path: Path, audio_file: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level("DEBUG")
    fake_speech.always = Forced(401, error_body(f"bad key {KEY} {MARKER}"))
    env = setup(tmp_path, fake_speech.base_url)
    human = invoke(env, "transcribe", str(audio_file))
    assert human.exit_code == 1 and "provider_auth" in human.stderr and human.stdout == ""
    machine = invoke(env, "--json", "transcribe", str(audio_file))
    assert machine.exit_code == 1
    assert json.loads(machine.stdout) == {"ok": False, "code": "provider_auth"}
    for text in (human.output, machine.output, caplog.text):
        assert KEY not in text and MARKER not in text


def test_413_is_audio_too_long(fake_speech: FakeSpeech, tmp_path: Path, audio_file: Path) -> None:
    fake_speech.always = Forced(413, MARKER)
    result = invoke(setup(tmp_path, fake_speech.base_url), "--json", "transcribe", str(audio_file))
    assert result.exit_code == 1 and json.loads(result.stdout)["code"] == "audio_too_long"


def test_unreadable_audio_exits_1(fake_speech: FakeSpeech, tmp_path: Path) -> None:
    junk = tmp_path / "junk.mp3"
    junk.write_bytes(b"not audio" * 100)
    result = invoke(setup(tmp_path, fake_speech.base_url), "--json", "transcribe", str(junk))
    assert result.exit_code == 1 and json.loads(result.stdout)["code"] == "audio_unreadable"
    assert fake_speech.seen == []


def test_missing_file_is_a_usage_error(fake_speech: FakeSpeech, tmp_path: Path) -> None:
    result = invoke(setup(tmp_path, fake_speech.base_url), "transcribe", str(tmp_path / "nope.wav"))
    assert result.exit_code == 2


def test_unknown_format_is_a_usage_error(fake_speech: FakeSpeech, tmp_path: Path, audio_file: Path) -> None:
    result = invoke(setup(tmp_path, fake_speech.base_url), "transcribe", str(audio_file), "-f", "docx")
    assert result.exit_code == 2


def test_no_speech_connection_exits_2(tmp_path: Path, audio_file: Path) -> None:
    (tmp_path / "connections.yaml").write_text(
        "llm: {default: {adapter: openai-compatible, base_url: 'http://x/v1', model: m}}\n"
    )
    result = invoke({"AFTERTALK_HOME": str(tmp_path)}, "transcribe", str(audio_file))
    assert result.exit_code == 2 and "speech" in result.output


def test_private_address_blocked(fake_speech: FakeSpeech, tmp_path: Path, audio_file: Path) -> None:
    env = {**setup(tmp_path, fake_speech.base_url), "BLOCK_PRIVATE_ADDRESSES": "true"}
    result = invoke(env, "--json", "transcribe", str(audio_file))
    assert result.exit_code == 1 and json.loads(result.stdout)["code"] == "provider_unreachable"
    assert fake_speech.seen == []


def test_temp_files_are_removed(
    fake_speech: FakeSpeech, tmp_path: Path, audio_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TMPDIR", str(tmp_path / "tmp"))
    (tmp_path / "tmp").mkdir()
    import tempfile

    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path / "tmp"))
    invoke(setup(tmp_path, fake_speech.base_url), "transcribe", str(audio_file))
    assert list((tmp_path / "tmp").iterdir()) == []


# ---- aftertalk providers test --kind speech ----


def test_providers_test_speech_ok(fake_speech: FakeSpeech, tmp_path: Path) -> None:
    env = setup(tmp_path, fake_speech.base_url)
    result = invoke(env, "--json", "providers", "test", "--kind", "speech")
    assert result.exit_code == 0, result.output
    data = json.loads(result.stdout)
    assert data["ok"] is True and data["timing"] == "word" and data["latency_ms"] >= 0
    upload = fake_speech.seen[0].file
    assert upload is not None and upload.filename == "audio.flac" and upload.size > 1000


def test_providers_test_speech_wav_and_text_only(fake_speech: FakeSpeech, tmp_path: Path) -> None:
    fake_speech.shape = "text"
    env = setup(tmp_path, fake_speech.base_url, ", audio_format: wav")
    data = json.loads(invoke(env, "--json", "providers", "test", "--kind", "speech").stdout)
    assert data["ok"] and data["timing"] == "none"
    upload = fake_speech.seen[0].file
    assert upload is not None and upload.filename == "audio.wav"


def test_providers_test_speech_human_line(fake_speech: FakeSpeech, tmp_path: Path) -> None:
    result = invoke(setup(tmp_path, fake_speech.base_url), "providers", "test", "--kind", "speech")
    assert result.exit_code == 0 and "word" in result.stdout and KEY not in result.output


def test_providers_test_speech_failure(fake_speech: FakeSpeech, tmp_path: Path) -> None:
    fake_speech.always = Forced(401, error_body(f"{KEY} {MARKER}"))
    env = setup(tmp_path, fake_speech.base_url)
    result = invoke(env, "--json", "providers", "test", "--kind", "speech")
    assert result.exit_code == 1 and json.loads(result.stdout) == {"ok": False, "code": "provider_auth"}
    human = invoke(env, "providers", "test", "--kind", "speech")
    assert human.exit_code == 1 and "provider_auth" in human.output
    assert KEY not in human.output and MARKER not in human.output


def test_providers_test_speech_unreachable(
    tmp_path: Path, allow_requests: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("aftertalk.providers.speech.openai_compatible.RETRY_WAITS", (0.0, 0.0))
    env = setup(tmp_path, "http://127.0.0.1:1/v1")
    result = invoke(env, "--json", "providers", "test", "--kind", "speech")
    assert result.exit_code == 1 and json.loads(result.stdout)["code"] == "provider_unreachable"


def test_providers_test_speech_not_configured(tmp_path: Path) -> None:
    result = invoke({"AFTERTALK_HOME": str(tmp_path)}, "providers", "test", "--kind", "speech")
    assert result.exit_code == 2 and "speech" in result.output


def test_bundled_test_audio_is_a_two_second_mono_16k_wav() -> None:
    from importlib import resources

    import av

    asset = resources.files("aftertalk") / "assets" / "test-2s.wav"
    with resources.as_file(asset) as path, av.open(str(path)) as container:
        stream = container.streams.audio[0]
        assert (stream.rate, len(stream.layout.channels), stream.codec_context.name) == (16000, 1, "pcm_s16le")
        assert 1.2 < container.duration / 1_000_000 < 2.5
