import json
import sys
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


def step(data: dict, name: str) -> dict:
    """The usage entry of one step, looked up by name: only the order test relies on positions."""
    (entry,) = [u for u in data["usage"] if u["step"] == name]
    return entry


@pytest.fixture
def audio_file(tmp_path: Path) -> Path:
    return make_tone(tmp_path / "call.wav", seconds=3.0)  # the fake's answer runs to 2.6 s: all of it inside


# ---- aftertalk transcribe ----


def test_json_output_has_transcript_and_usage(fake_speech: FakeSpeech, tmp_path: Path, audio_file: Path) -> None:
    env = setup(tmp_path, fake_speech.base_url)
    result = invoke(env, "transcribe", str(audio_file), "--format", "json")
    assert result.exit_code == 0, result.output
    data = json.loads(result.stdout)
    assert set(data) == {"transcript", "usage", "dropped_segments"} and data["dropped_segments"] == 0
    assert data["transcript"]["timing"] == "word" and data["transcript"]["language"] == "pl"
    assert [u["step"] for u in data["usage"]] == ["decode", "transcribe"]
    assert step(data, "transcribe")["requests"] == 1 and step(data, "transcribe")["audio_seconds"] == pytest.approx(
        3.0, abs=0.05
    )
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
    # The fake's two segments are 0.2 s apart, so they are one turn; its first sentence lasts 1.2 s and ends a cue.
    assert vtt.exit_code == 0 and vtt.stdout == (
        "WEBVTT\n\n00:00:00.000 --> 00:00:01.200\nHello there.\n\n00:00:01.400 --> 00:00:02.600\nGeneral Kenobi.\n"
    )
    srt = invoke(env, "transcribe", str(audio_file), "--format", "srt")
    assert srt.exit_code == 0 and srt.stdout == (
        "1\n00:00:00,000 --> 00:00:01,200\nHello there.\n\n2\n00:00:01,400 --> 00:00:02,600\nGeneral Kenobi.\n"
    )


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
    for line in ("decoding audio", "audio length 0:03", "transcribing window 1/1"):
        assert line in result.stderr
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
    fake_speech.reject_param = "response_format"
    result = invoke(setup(tmp_path, fake_speech.base_url), "transcribe", str(audio_file), "-f", "json")
    assert result.exit_code == 0
    data = json.loads(result.stdout)
    assert data["transcript"]["timing"] == "none" and step(data, "transcribe")["speech_format"] == "json"
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
    assert [p for p in (tmp_path / "tmp").rglob("*") if p.is_file()] == []


# ---- aftertalk providers test --kind speech ----


def test_providers_test_speech_ok(fake_speech: FakeSpeech, tmp_path: Path) -> None:
    env = setup(tmp_path, fake_speech.base_url)
    result = invoke(env, "--json", "providers", "test", "--kind", "speech")
    assert result.exit_code == 0, result.output
    data = json.loads(result.stdout)
    assert data["ok"] is True and data["timing"] == "word" and data["latency_ms"] >= 0
    assert data["language_reported"] is True
    upload = fake_speech.seen[0].file
    assert upload is not None and upload.filename == "audio.flac" and upload.size > 1000


def test_providers_test_speech_wav_and_text_only(fake_speech: FakeSpeech, tmp_path: Path) -> None:
    fake_speech.shape = "text"
    env = setup(tmp_path, fake_speech.base_url, ", audio_format: wav")
    data = json.loads(invoke(env, "--json", "providers", "test", "--kind", "speech").stdout)
    assert data["ok"] and data["timing"] == "none" and data["language_reported"] is False
    human = invoke(env, "providers", "test", "--kind", "speech")
    assert human.exit_code == 0 and "language reported: no" in human.stdout
    upload = fake_speech.seen[0].file
    assert upload is not None and upload.filename == "audio.wav"


def test_providers_test_speech_human_line(fake_speech: FakeSpeech, tmp_path: Path) -> None:
    result = invoke(setup(tmp_path, fake_speech.base_url), "providers", "test", "--kind", "speech")
    assert result.exit_code == 0 and "word" in result.stdout and KEY not in result.output
    assert "language reported: yes" in result.stdout


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


def test_unknown_language_is_a_usage_error(fake_speech: FakeSpeech, tmp_path: Path, audio_file: Path) -> None:
    result = invoke(setup(tmp_path, fake_speech.base_url), "transcribe", str(audio_file), "--language", "klingon")
    assert result.exit_code == 2 and "unknown language" in result.output and fake_speech.seen == []


def test_language_names_are_normalised(fake_speech: FakeSpeech, tmp_path: Path, audio_file: Path) -> None:
    result = invoke(setup(tmp_path, fake_speech.base_url), "transcribe", str(audio_file), "--language", "Polish")
    assert result.exit_code == 0 and fake_speech.seen[0].values("language") == ["pl"]


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX file modes")
def test_output_file_is_private(fake_speech: FakeSpeech, tmp_path: Path, audio_file: Path) -> None:
    import stat

    target = tmp_path / "call.txt"
    result = invoke(setup(tmp_path, fake_speech.base_url), "transcribe", str(audio_file), "-o", str(target))
    assert result.exit_code == 0 and stat.S_IMODE(target.stat().st_mode) == 0o600


def test_audio_over_the_upload_limit_goes_in_windows(fake_speech: FakeSpeech, tmp_path: Path) -> None:
    big = make_tone(tmp_path / "big.wav", seconds=60.0, rate=16000, channels=1)
    env = setup(tmp_path, fake_speech.base_url, ", audio_format: wav, max_upload_mb: 1")
    result = invoke(env, "transcribe", str(big), "-f", "json")  # 60 s of 16 kHz s16 is 1.9 MB; 1 MiB is ~32 s
    assert result.exit_code == 0, result.output
    assert "transcribing window 1/2" in result.stderr and "transcribing window 2/2" in result.stderr
    assert len(fake_speech.seen) == 2
    assert all(seen.file is not None and seen.file.size <= 1024 * 1024 for seen in fake_speech.seen)
    data = json.loads(result.stdout)
    usage = step(data, "transcribe")
    assert usage["requests"] == 2 and usage["attempts"] == 2 and usage["audio_seconds"] == pytest.approx(60.0)
    starts = [seg["start"] for seg in data["transcript"]["segments"]]
    assert (
        starts[0] == 0.0
        and starts[1] > 30.0
        and [seg["id"] for seg in data["transcript"]["segments"]]
        == [
            "t1",
            "t2",
        ]
    )
    assert "Kenobi" not in result.stderr


@pytest.mark.parametrize("fmt", ["vtt", "srt"])
def test_subtitles_skip_untimed_segments_and_say_so(fake_speech: FakeSpeech, tmp_path: Path, fmt: str) -> None:
    fake_speech.shape = "untimed"  # segments up to 28 s: the audio covers them, so no time is past the audio sent
    audio_file = make_tone(tmp_path / "call.wav", seconds=30.0)
    result = invoke(setup(tmp_path, fake_speech.base_url), "transcribe", str(audio_file), "-f", fmt)
    assert result.exit_code == 0
    assert "no times here" not in result.stdout and result.stdout.count("-->") == 9
    assert "skipped 1 segment" in result.stderr
    data = json.loads(invoke(setup(tmp_path, fake_speech.base_url), "transcribe", str(audio_file), "-f", "json").stdout)
    untimed = data["transcript"]["segments"][4]
    assert untimed["text"] == "no times here" and untimed["start"] is None and untimed["end"] is None


# ---- time limits ----


def test_providers_test_speech_has_a_time_limit(
    fake_speech: FakeSpeech, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import time

    monkeypatch.setattr("aftertalk.cli.PROBE_TIMEOUT_SECONDS", 0.3)
    fake_speech.stall = 5.0
    started = time.monotonic()
    result = invoke(setup(tmp_path, fake_speech.base_url), "--json", "providers", "test", "--kind", "speech")
    assert result.exit_code == 1 and json.loads(result.stdout)["code"] == "provider_unreachable"
    assert time.monotonic() - started < 4


def test_transcribe_timeout_is_limit_exceeded_and_leaves_nothing(
    fake_speech: FakeSpeech, tmp_path: Path, audio_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import tempfile
    import time

    (tmp_path / "tmp").mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path / "tmp"))
    fake_speech.stall = 5.0
    started = time.monotonic()
    result = invoke(setup(tmp_path, fake_speech.base_url), "--json", "transcribe", str(audio_file), "--timeout", "1")
    assert result.exit_code == 1 and json.loads(result.stdout)["code"] == "limit_exceeded"
    assert len(fake_speech.seen) == 1 and time.monotonic() - started < 4
    assert [p for p in (tmp_path / "tmp").rglob("*") if p.is_file()] == []


def test_transcribe_timeout_must_be_positive(fake_speech: FakeSpeech, tmp_path: Path, audio_file: Path) -> None:
    result = invoke(setup(tmp_path, fake_speech.base_url), "transcribe", str(audio_file), "--timeout", "0")
    assert result.exit_code == 2 and fake_speech.seen == []


# ---- settings spelled with the prefix ----


@pytest.mark.parametrize("command", [["transcribe", "AUDIO"], ["providers", "test", "--kind", "speech"]])
def test_prefixed_setting_exits_2(
    fake_speech: FakeSpeech, tmp_path: Path, audio_file: Path, command: list[str]
) -> None:
    env = {**setup(tmp_path, fake_speech.base_url), "AFTERTALK_BLOCK_PRIVATE_ADDRESSES": "1"}
    result = invoke(env, *[str(audio_file) if part == "AUDIO" else part for part in command])
    assert result.exit_code == 2 and "AFTERTALK_BLOCK_PRIVATE_ADDRESSES is not read" in result.output
    assert fake_speech.seen == []


# ---- the detected language is shown ----


def test_language_not_allowed_shows_the_detected_language(
    tmp_path: Path, audio_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from aftertalk.models.errors import EngineError
    from aftertalk.providers.speech.openai_compatible import OpenAICompatibleSpeech

    async def refuse(self: object, *args: object, **kwargs: object) -> None:
        raise EngineError("language_not_allowed", detected_language="uk")

    monkeypatch.setattr(OpenAICompatibleSpeech, "transcribe", refuse)
    env = setup(tmp_path, "http://127.0.0.1:1/v1")
    data = json.loads(invoke(env, "--json", "transcribe", str(audio_file)).stdout)
    assert data == {"ok": False, "code": "language_not_allowed", "detected_language": "uk"}
    text = invoke(env, "transcribe", str(audio_file))
    assert text.exit_code == 1 and "language_not_allowed" in text.stderr and "(detected: uk)" in text.stderr


# ---- the default timeout follows the file's duration ----


def test_default_timeout_rule() -> None:
    from aftertalk.cli import default_timeout

    assert default_timeout(None) == 3600
    assert default_timeout(60.0) == 3600
    assert default_timeout(1800.0) == 3600
    assert default_timeout(1800.4) == 3601
    assert default_timeout(3 * 3600.0) == 6 * 3600


def test_probe_duration(tmp_path: Path) -> None:
    from aftertalk.audio.decode import probe_duration

    assert probe_duration(make_tone(tmp_path / "a.wav", seconds=2.0)) == pytest.approx(2.0, abs=0.05)
    junk = tmp_path / "junk.mp3"
    junk.write_bytes(b"not audio" * 100)
    assert probe_duration(junk) is None
    assert probe_duration(tmp_path / "missing.wav") is None
    make_tone(tmp_path / "secret.mp3", seconds=1.0, codec="mp3")
    playlist = tmp_path / "list.m3u8"
    playlist.write_text("#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:1.0,\nsecret.mp3\n#EXT-X-ENDLIST\n")
    assert probe_duration(playlist) is None


@pytest.mark.parametrize(
    ("given", "probed", "expected"), [(None, 4000.0, 8000), (None, None, 3600), ("90", 4000.0, 90)]
)
def test_timeout_reaches_the_pipeline(
    tmp_path: Path,
    audio_file: Path,
    monkeypatch: pytest.MonkeyPatch,
    given: str | None,
    probed: float | None,
    expected: int,
) -> None:
    import aftertalk.pipeline
    from aftertalk.models.errors import EngineError

    seen: list[object] = []

    async def capture(path: object, speech: object, options: object, limits: object, on_event: object) -> None:
        seen.append(limits)
        raise EngineError("internal")

    monkeypatch.setattr(aftertalk.pipeline, "transcribe_file", capture)
    monkeypatch.setattr("aftertalk.audio.decode.probe_duration", lambda path: probed)
    args = ["transcribe", str(audio_file), *(["--timeout", given] if given else [])]
    invoke(setup(tmp_path, "http://127.0.0.1:1/v1"), *args)
    assert [getattr(limits, "timeout_seconds") for limits in seen] == [expected]


def test_timeout_help_states_the_rule(tmp_path: Path) -> None:
    result = invoke({"AFTERTALK_HOME": str(tmp_path), "COLUMNS": "200"}, "transcribe", "--help")
    assert "3600, or twice the file's duration" in result.stdout and '"usage": [...]' in result.stdout


def test_logs_and_stderr_hold_no_transcript_text(
    fake_speech: FakeSpeech, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level("DEBUG")
    long = make_tone(tmp_path / "long.wav", seconds=40.0, rate=16000, channels=1)
    env = setup(tmp_path, fake_speech.base_url, ", max_upload_mb: 1")
    result = invoke(env, "transcribe", str(long), "--prompt", "Skywalker", "-f", "json")
    assert result.exit_code == 0 and "Kenobi" in result.stdout
    assert "transcribing window 2/2" in result.stderr
    for text in ("Hello", "Kenobi", "Skywalker", "long.wav", "polish", KEY):
        assert text not in result.stderr and text not in caplog.text
