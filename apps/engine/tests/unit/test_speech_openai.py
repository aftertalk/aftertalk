import json
import time
from pathlib import Path

import httpx2
import pytest
from fake_speech import FakeSpeech, Forced, error_body

from aftertalk.audio.encode import EncodedAudio
from aftertalk.models.connections import SpeechConnection
from aftertalk.models.errors import EngineError
from aftertalk.providers.net import make_client
from aftertalk.providers.speech.openai_compatible import OpenAICompatibleSpeech

KEY = "sk-speech-key-XYZ789"
MARKER = "SPEECH-BODY-MARKER-55"


def audio(fmt: str = "flac", size: int = 2048) -> EncodedAudio:
    return EncodedAudio(
        filename=f"audio.{fmt}",
        content_type=f"audio/{fmt}",
        duration_seconds=2.6,
        size_bytes=size,
        data=b"x" * size,
    )


class Waits:
    """An injectable sleep that records instead of sleeping."""

    def __init__(self) -> None:
        self.calls: list[float] = []

    async def __call__(self, seconds: float) -> None:
        self.calls.append(seconds)


def conn(fake: FakeSpeech, **extra: object) -> SpeechConnection:
    return SpeechConnection.model_validate({"base_url": fake.base_url, "model": "whisper-1", **extra})


async def run(
    fake: FakeSpeech,
    *,
    waits: Waits | None = None,
    connection: SpeechConnection | None = None,
    max_upload_bytes: int | None = None,
    media: EncodedAudio | None = None,
    **kwargs: object,
):
    options: dict = {"language": None, "prompt": None, "deadline": None, **kwargs}
    extra = {} if max_upload_bytes is None else {"max_upload_bytes": max_upload_bytes}
    async with make_client(block_private=False) as client:
        provider = OpenAICompatibleSpeech(connection or conn(fake), client, sleep=waits or Waits(), **extra)
        return await provider.transcribe(media or audio(), **options)


async def fails(fake: FakeSpeech, **kwargs: object) -> EngineError:
    with pytest.raises(EngineError) as info:
        await run(fake, **kwargs)
    err = info.value
    assert err.__cause__ is None and err.__context__ is None
    return err


# ---- response shapes and timing levels ----


async def test_openai_shape_gives_word_timing(fake_speech: FakeSpeech) -> None:
    transcript, usage = await run(fake_speech)
    assert transcript.timing == "word"
    assert transcript.language == "pl"
    assert transcript.duration_seconds == 2.6
    assert [s.text for s in transcript.segments] == ["Hello there.", "General Kenobi."]
    assert [[w.text for w in s.words] for s in transcript.segments] == [["Hello", "there."], ["General", "Kenobi."]]
    assert transcript.segments[0].avg_logprob == -0.2 and transcript.segments[1].no_speech_prob == 0.02
    assert usage.step == "transcribe" and usage.provider == "openai-compatible" and usage.model == "whisper-1"
    assert usage.audio_seconds == 2.6 and usage.requests == 1 and usage.attempts == 1 and usage.cost_usd is None
    assert usage.duration_ms >= 0


async def test_segments_only_gives_segment_timing(fake_speech: FakeSpeech) -> None:
    fake_speech.shape = "segments"
    transcript, _ = await run(fake_speech)
    assert transcript.timing == "segment"
    # No word list: each segment gets its text split into untimed words.
    for s in transcript.segments:
        assert s.words and all(w.start is None and w.end is None for w in s.words)
        assert [w.text for w in s.words] == s.text.split()


async def test_words_without_segments_make_one_segment(fake_speech: FakeSpeech) -> None:
    fake_speech.shape = "words_only"
    transcript, _ = await run(fake_speech)
    assert transcript.timing == "word"
    assert len(transcript.segments) == 1 and len(transcript.segments[0].words) == 4
    assert (transcript.segments[0].start, transcript.segments[0].end) == (0.0, 2.6)


async def test_whispercpp_nested_words(fake_speech: FakeSpeech) -> None:
    fake_speech.shape = "whispercpp"
    transcript, _ = await run(fake_speech)
    assert transcript.timing == "word"
    assert [w.text for w in transcript.segments[1].words] == ["General", "Kenobi."]


async def test_text_only_json(fake_speech: FakeSpeech) -> None:
    fake_speech.shape = "text"
    transcript, usage = await run(fake_speech)
    assert transcript.timing == "none" and len(transcript.segments) == 1
    only = transcript.segments[0]
    assert (only.start, only.end) == (None, None) and only.text == transcript.text
    assert [w.text for w in only.words] == ["Hello", "there.", "General", "Kenobi."]
    assert all(w.start is None for w in only.words)
    assert transcript.text == "Hello there. General Kenobi."
    assert transcript.language is None
    assert transcript.duration_seconds == 2.6  # from the audio we sent
    assert usage.requests == 1


async def test_languages_list_from_gpt_transcribe(fake_speech: FakeSpeech) -> None:
    fake_speech.shape = "languages"
    transcript, _ = await run(fake_speech)
    assert transcript.language == "pl"


async def test_forced_language_is_kept_when_the_provider_says_nothing(fake_speech: FakeSpeech) -> None:
    fake_speech.shape = "text"
    transcript, _ = await run(fake_speech, language="de")
    assert transcript.language == "de"


# ---- request shape ----


async def test_multipart_request_shape(fake_speech: FakeSpeech) -> None:
    await run(fake_speech, language="pl", prompt="Kenobi")
    seen = fake_speech.seen[0]
    assert seen.path == "/v1/audio/transcriptions"
    assert seen.values("model") == ["whisper-1"]
    assert seen.values("response_format") == ["verbose_json"]
    assert seen.values("timestamp_granularities[]") == ["word", "segment"]  # literal name, repeated
    assert not seen.values("timestamp_granularities")
    assert seen.values("language") == ["pl"] and seen.values("prompt") == ["Kenobi"]
    assert seen.file is not None and seen.file.size == 2048


async def test_language_and_prompt_are_left_out_when_unset(fake_speech: FakeSpeech) -> None:
    await run(fake_speech)
    seen = fake_speech.seen[0]
    assert not seen.values("language") and not seen.values("prompt")


@pytest.mark.parametrize("fmt", ["flac", "wav"])
async def test_filename_and_content_type(fake_speech: FakeSpeech, fmt: str) -> None:
    await run(fake_speech, media=audio(fmt))
    upload = fake_speech.seen[0].file
    assert upload is not None
    assert (upload.filename, upload.content_type) == (f"audio.{fmt}", f"audio/{fmt}")


async def test_keyless_sends_no_authorization(fake_speech: FakeSpeech) -> None:
    await run(fake_speech)
    assert "authorization" not in fake_speech.seen[0].headers


async def test_key_and_extra_headers_are_sent(fake_speech: FakeSpeech) -> None:
    connection = conn(fake_speech, api_key=KEY, extra_headers={"X-Tenant": "acme"})
    await run(fake_speech, connection=connection)
    headers = fake_speech.seen[0].headers
    assert headers["authorization"] == f"Bearer {KEY}" and headers["x-tenant"] == "acme"


async def test_environment_never_reaches_the_wire(fake_speech: FakeSpeech, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-env-key")
    monkeypatch.setenv("OPENAI_BASE_URL", "http://127.0.0.1:1/v1")
    monkeypatch.setenv("OPENAI_ORG_ID", "org-env")
    monkeypatch.setenv("OPENAI_ORGANIZATION", "org-env")
    await run(fake_speech)
    seen = fake_speech.seen[0]
    assert "authorization" not in seen.headers and "openai-organization" not in seen.headers
    assert "sk-env-key" not in json.dumps(seen.headers) and "org-env" not in json.dumps(seen.headers)


# ---- the format ladder: all timestamps, segments only, plain json ----


def formats(fake: FakeSpeech) -> list[tuple[list[str], bool]]:
    return [(s.values("response_format"), bool(s.values("timestamp_granularities[]"))) for s in fake.seen]


async def test_first_rung_is_used_when_the_server_accepts_it(fake_speech: FakeSpeech) -> None:
    _, usage = await run(fake_speech)
    assert usage.speech_format == "verbose_json" and len(fake_speech.seen) == 1


async def test_granularities_rejected_goes_to_verbose_json_without_them(fake_speech: FakeSpeech) -> None:
    fake_speech.reject_granularities = True
    transcript, usage = await run(fake_speech)
    assert formats(fake_speech) == [(["verbose_json"], True), (["verbose_json"], False)]
    assert transcript.timing == "segment" and usage.speech_format == "verbose_json_segments"
    assert usage.attempts == 2 and usage.requests == 2


@pytest.mark.parametrize("param", ["response_format", "verbose_json"])
async def test_response_format_rejected_goes_to_plain_json(fake_speech: FakeSpeech, param: str) -> None:
    fake_speech.reject_verbose = True
    fake_speech.reject_param = param
    transcript, usage = await run(fake_speech)
    assert formats(fake_speech) == [(["verbose_json"], True), (["json"], False)]
    assert transcript.timing == "none" and usage.speech_format == "json"


async def test_all_three_rungs(fake_speech: FakeSpeech) -> None:
    fake_speech.forced = [
        Forced(400, error_body("x", param="timestamp_granularities[]")),
        Forced(422, error_body("verbose_json is not supported")),
    ]
    transcript, usage = await run(fake_speech)
    assert formats(fake_speech) == [(["verbose_json"], True), (["verbose_json"], False), (["json"], False)]
    assert usage.speech_format == "json" and transcript.timing == "none"


@pytest.mark.parametrize(
    "body",
    [
        error_body("nope"),  # no param
        error_body("nope", param="file"),
        error_body("nope", param="model"),
        "<html><body>Bad Request</body></html>",
        json.dumps({"detail": "Unprocessable: response_format"}),  # FastAPI shape: not read
        "",
    ],
)
async def test_other_400s_stop_without_a_fallback(fake_speech: FakeSpeech, body: str) -> None:
    fake_speech.always = Forced(400, body)
    err = await fails(fake_speech)
    assert err.code == "provider_bad_response" and len(fake_speech.seen) == 1


async def test_a_failing_last_rung_reports_its_error(fake_speech: FakeSpeech) -> None:
    fake_speech.forced = [Forced(400, error_body("x", param="response_format")), Forced(401, MARKER)]
    err = await fails(fake_speech)
    assert err.code == "provider_auth"
    assert err.usage is not None and err.usage.attempts == 2 and err.usage.speech_format == "json"


async def test_retry_budget_is_shared_between_rungs(fake_speech: FakeSpeech) -> None:
    fake_speech.forced = [
        Forced(503, "x"),
        Forced(400, error_body("x", param="timestamp_granularities")),
        Forced(503, "x"),
        Forced(503, "x"),
    ]
    waits = Waits()
    err = await fails(fake_speech, waits=waits)
    assert err.code == "provider_unreachable"
    assert len(fake_speech.seen) == 4 and waits.calls == [2.0, 10.0]  # three failures in all, not three per rung


# ---- retries ----


async def test_rate_limit_then_success_waits_two_seconds(fake_speech: FakeSpeech) -> None:
    fake_speech.forced = [Forced(429, error_body("slow down", code="rate_limit_exceeded"))]
    waits = Waits()
    transcript, usage = await run(fake_speech, waits=waits)
    assert transcript.timing == "word" and waits.calls == [2.0]
    assert usage.requests == 2 and usage.attempts == 2


async def test_waits_are_two_then_ten_and_three_attempts_in_all(fake_speech: FakeSpeech) -> None:
    fake_speech.always = Forced(503, MARKER)
    waits = Waits()
    err = await fails(fake_speech, waits=waits)
    assert err.code == "provider_unreachable" and err.retryable
    assert waits.calls == [2.0, 10.0] and len(fake_speech.seen) == 3
    assert err.usage is not None and err.usage.attempts == 3 and err.usage.requests == 3


async def test_retry_after_is_honoured_and_capped(fake_speech: FakeSpeech) -> None:
    fake_speech.forced = [Forced(429, "{}", {"Retry-After": "7"}), Forced(429, "{}", {"Retry-After": "500"})]
    waits = Waits()
    await run(fake_speech, waits=waits)
    assert waits.calls == [7.0, 60.0]


async def test_rate_limit_that_never_clears(fake_speech: FakeSpeech) -> None:
    fake_speech.always = Forced(429, "{}")
    assert (await fails(fake_speech)).code == "provider_rate_limited"


async def test_quota_error_is_not_retried(fake_speech: FakeSpeech) -> None:
    fake_speech.always = Forced(429, error_body("You exceeded your quota", code="insufficient_quota"))
    waits = Waits()
    err = await fails(fake_speech, waits=waits)
    assert err.code == "provider_quota_exceeded" and not waits.calls and len(fake_speech.seen) == 1


async def test_dropped_connection_is_retried_then_unreachable(allow_requests: None) -> None:
    fake = FakeSpeech()  # only its type is needed; the connection points at a closed port
    waits = Waits()
    closed = SpeechConnection(base_url="http://127.0.0.1:1/v1", model="m")
    err = await fails(fake, waits=waits, connection=closed)
    assert err.code == "provider_unreachable" and waits.calls == [2.0, 10.0]


async def test_deadline_in_the_past_sends_nothing(fake_speech: FakeSpeech) -> None:
    err = await fails(fake_speech, deadline=time.monotonic() - 1)
    assert err.code == "limit_exceeded" and fake_speech.seen == []


async def test_a_wait_that_passes_the_deadline_stops_the_retries(fake_speech: FakeSpeech) -> None:
    fake_speech.always = Forced(503, "x")
    waits = Waits()
    err = await fails(fake_speech, waits=waits, deadline=time.monotonic() + 1.0)
    assert err.code == "limit_exceeded" and waits.calls == [] and len(fake_speech.seen) == 1
    assert err.usage is not None and err.usage.requests == 1


# ---- errors ----


async def test_auth_failure_leaks_neither_key_nor_body(
    fake_speech: FakeSpeech, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level("DEBUG")
    fake_speech.always = Forced(401, error_body(f"Incorrect API key {KEY} {MARKER}"))
    err = await fails(fake_speech, connection=conn(fake_speech, api_key=KEY))
    assert err.code == "provider_auth" and len(fake_speech.seen) == 1
    for text in (str(err), repr(err), caplog.text, repr(err.usage)):
        assert KEY not in text and MARKER not in text


@pytest.mark.parametrize(
    ("forced", "code"),
    [
        (Forced(403, "{}"), "provider_auth"),
        (Forced(404, error_body("The model `x` does not exist", code="model_not_found")), "provider_model_not_found"),
        (Forced(404, "not found"), "provider_bad_response"),
        (Forced(413, MARKER), "audio_too_long"),
        (Forced(422, error_body("bad", param="file")), "provider_bad_response"),
        (Forced(418, "x"), "provider_bad_response"),
        (Forced(200, MARKER), "provider_bad_response"),
        (Forced(200, "[]"), "provider_bad_response"),
        (Forced(200, json.dumps({"no": "text"})), "provider_bad_response"),
        (Forced(200, json.dumps({"text": 5})), "provider_bad_response"),
        (Forced(408, "x"), "provider_unreachable"),
    ],
)
async def test_status_mapping(fake_speech: FakeSpeech, forced: Forced, code: str) -> None:
    fake_speech.always = forced
    err = await fails(fake_speech, waits=Waits())
    assert err.code == code
    assert MARKER not in str(err) and MARKER not in repr(err.usage)


async def test_413_is_not_retried(fake_speech: FakeSpeech) -> None:
    fake_speech.always = Forced(413, "x")
    waits = Waits()
    err = await fails(fake_speech, waits=waits)
    assert err.code == "audio_too_long" and not waits.calls and len(fake_speech.seen) == 1
    assert not err.retryable


async def test_redirect_is_not_followed(fake_speech: FakeSpeech, allow_requests: None) -> None:
    target = FakeSpeech()
    target.start()
    try:
        fake_speech.redirect_to = f"{target.base_url}/audio/transcriptions"
        err = await fails(fake_speech, connection=conn(fake_speech, api_key=KEY))
        assert err.code == "provider_bad_response"
        assert target.seen == []
    finally:
        target.stop()


async def test_upload_too_big_is_refused_without_a_request(fake_speech: FakeSpeech) -> None:
    err = await fails(fake_speech, media=audio(size=26 * 1024 * 1024))
    assert err.code == "audio_too_long" and fake_speech.seen == []
    assert err.usage is not None and err.usage.requests == 0


async def test_upload_limit_can_be_overridden(fake_speech: FakeSpeech) -> None:
    await run(fake_speech, media=audio(size=26 * 1024 * 1024), max_upload_bytes=100 * 1024 * 1024)
    assert len(fake_speech.seen) == 1
    err = await fails(fake_speech, media=audio(size=2000), max_upload_bytes=1000)
    assert err.code == "audio_too_long"


async def test_private_address_refused_when_blocking(fake_speech: FakeSpeech) -> None:
    async with make_client(block_private=True) as client:
        provider = OpenAICompatibleSpeech(conn(fake_speech), client, sleep=Waits())
        with pytest.raises(EngineError) as info:
            await provider.transcribe(audio(), language=None, prompt=None, deadline=None)
    assert info.value.code == "provider_unreachable" and fake_speech.seen == []
    assert info.value.__cause__ is None and info.value.__context__ is None


async def test_file_from_disk_is_uploaded(fake_speech: FakeSpeech, tmp_path: Path) -> None:
    path = tmp_path / "a.flac"
    path.write_bytes(b"y" * 500)
    media = EncodedAudio(
        filename="audio.flac", content_type="audio/flac", duration_seconds=1, size_bytes=500, path=path
    )
    await run(fake_speech, media=media)
    assert fake_speech.seen[0].file is not None and fake_speech.seen[0].file.size == 500


# ---- language rule ----


async def test_language_not_in_allowed_list(fake_speech: FakeSpeech) -> None:
    err = await fails(fake_speech, allowed_languages=["en", "de"])
    assert err.code == "language_not_allowed" and not err.retryable
    assert err.usage is not None and err.usage.requests == 1


async def test_language_in_allowed_list(fake_speech: FakeSpeech) -> None:
    transcript, _ = await run(fake_speech, allowed_languages=["EN", "pl"])
    assert transcript.language == "pl"


async def test_forced_language_skips_the_check(fake_speech: FakeSpeech) -> None:
    transcript, _ = await run(fake_speech, language="pl", allowed_languages=["en"])
    assert transcript.language == "pl"


async def test_no_reported_language_with_several_allowed_fails(fake_speech: FakeSpeech) -> None:
    fake_speech.shape = "text"
    err = await fails(fake_speech, allowed_languages=["en", "pl"])
    assert err.code == "language_not_allowed" and err.detected_language is None and not err.retryable
    assert err.to_model().detected_language is None
    assert err.usage is not None and err.usage.requests >= 1


async def test_no_reported_language_with_one_allowed_uses_it(fake_speech: FakeSpeech) -> None:
    fake_speech.shape = "text"
    transcript, _ = await run(fake_speech, allowed_languages=["Polish"])
    assert transcript.language == "pl"


async def test_no_reported_language_with_a_forced_one_is_accepted(fake_speech: FakeSpeech) -> None:
    fake_speech.shape = "text"
    transcript, _ = await run(fake_speech, language="pl", allowed_languages=["en", "pl"])
    assert transcript.language == "pl"


async def test_no_reported_language_without_an_allowed_list_is_accepted(fake_speech: FakeSpeech) -> None:
    fake_speech.shape = "text"
    transcript, _ = await run(fake_speech)
    assert transcript.language is None


# ---- the connection's own HTTP client is closed by the caller; the provider never builds one ----


def test_capabilities() -> None:
    caps = OpenAICompatibleSpeech.capabilities
    assert caps.word_times and caps.segment_times and not caps.speakers and not caps.channels
    assert caps.max_upload_bytes == 25 * 1024 * 1024


def test_provider_takes_an_httpx2_client() -> None:
    client = make_client(block_private=False)
    provider = OpenAICompatibleSpeech(SpeechConnection(base_url="http://h/v1", model="m"), client)
    assert isinstance(client, httpx2.AsyncClient) and provider.capabilities.max_upload_bytes == 25 * 1024 * 1024


# ---- temperature 0, resent once without it when refused ----


async def test_temperature_zero_is_sent(fake_speech: FakeSpeech) -> None:
    await run(fake_speech)
    assert fake_speech.seen[0].values("temperature") == ["0"]


async def test_a_server_that_refuses_temperature_gets_one_resend_without_it(fake_speech: FakeSpeech) -> None:
    fake_speech.reject_temperature = True
    waits = Waits()
    transcript, usage = await run(fake_speech, waits=waits)
    assert transcript.timing == "word" and usage.requests == 2 and waits.calls == []
    assert fake_speech.seen[0].values("temperature") == ["0"] and fake_speech.seen[1].values("temperature") == []
    assert fake_speech.seen[1].values("response_format") == ["verbose_json"]  # the same rung


# ---- no second request after a timeout once the upload was sent ----


async def test_a_read_timeout_after_the_upload_is_not_retried(
    fake_speech: FakeSpeech, monkeypatch: pytest.MonkeyPatch
) -> None:
    from aftertalk.providers.speech import openai_compatible

    monkeypatch.setattr(openai_compatible, "REQUEST_TIMEOUT", 0.3)
    fake_speech.stall = 5.0
    waits = Waits()
    err = await fails(fake_speech, waits=waits)
    assert err.code == "provider_unreachable" and len(fake_speech.seen) == 1 and waits.calls == []
    assert fake_speech.seen[0].file is not None and fake_speech.seen[0].file.size == 2048


# ---- the detected language travels with language_not_allowed ----


async def test_language_not_allowed_names_the_detected_language(fake_speech: FakeSpeech) -> None:
    fake_speech.language = "ukrainian"
    err = await fails(fake_speech, allowed_languages=["pl"])
    assert err.code == "language_not_allowed" and err.detected_language == "uk"
    assert err.to_model().detected_language == "uk"


async def test_an_unmapped_language_is_refused_without_a_name(fake_speech: FakeSpeech) -> None:
    fake_speech.language = "klingon"
    err = await fails(fake_speech, allowed_languages=["pl"])
    assert err.code == "language_not_allowed" and err.detected_language is None


async def test_a_languages_list_counts_as_reported(fake_speech: FakeSpeech) -> None:
    fake_speech.shape = "languages"
    fake_speech.language = "polish"
    transcript, _ = await run(fake_speech, allowed_languages=["pl", "en"])
    assert transcript.language == "pl"
