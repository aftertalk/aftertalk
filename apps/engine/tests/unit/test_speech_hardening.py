import time
import traceback
from email.utils import formatdate
from typing import Any

import httpx2
import pytest
from fake_speech import FakeSpeech
from test_speech_openai import KEY, Waits, audio, conn, fails

from aftertalk.models.connections import SpeechConnection
from aftertalk.models.errors import EngineError
from aftertalk.providers.speech import openai_compatible
from aftertalk.providers.speech.errors import retry_after
from aftertalk.providers.speech.openai_compatible import OpenAICompatibleSpeech


class RaisingClient:
    """Stands in for the HTTP client: every post raises, with the request (and its key) attached as httpx2 does."""

    def __init__(self, make: Any) -> None:
        self.make = make
        self.posts = 0

    async def post(self, *args: Any, **kwargs: Any) -> Any:
        self.posts += 1
        raise self.make(httpx2.Request("POST", "http://x/v1", headers={"Authorization": f"Bearer {KEY}"}))


async def run_raising(make: Any) -> tuple[EngineError, RaisingClient, Waits]:
    client = RaisingClient(make)
    waits = Waits()
    provider = OpenAICompatibleSpeech(
        SpeechConnection(base_url="http://x/v1", model="m", api_key=KEY),
        client,  # type: ignore[arg-type]
        sleep=waits,
    )
    with pytest.raises(EngineError) as info:
        await provider.transcribe(audio(), language=None, prompt=None, deadline=None)
    return info.value, client, waits


def assert_clean(err: EngineError) -> None:
    assert err.__cause__ is None and err.__context__ is None
    text = "".join(traceback.format_exception(err)) + repr(err) + str(err) + repr(err.usage)
    assert KEY not in text and "Authorization" not in text


@pytest.mark.parametrize(
    ("make", "code", "tries"),
    [
        (lambda r: httpx2.DecodingError("bad gzip", request=r), "provider_bad_response", 1),
        (lambda r: httpx2.LocalProtocolError("Illegal header value", request=r), "provider_config_invalid", 1),
        (lambda r: UnicodeEncodeError("latin-1", "ł", 0, 1, "ordinal not in range"), "provider_config_invalid", 1),
        (lambda r: httpx2.ReadError("reset", request=r), "provider_unreachable", 3),
        (lambda r: httpx2.ConnectTimeout("slow", request=r), "provider_unreachable", 3),
        (lambda r: RuntimeError(f"surprise {KEY}"), "internal", 1),
    ],
)
async def test_client_failures_map_to_a_code_without_chaining(make: Any, code: str, tries: int) -> None:
    err, client, waits = await run_raising(make)
    assert err.code == code and client.posts == tries
    assert len(waits.calls) == tries - 1
    assert_clean(err)
    assert err.usage is not None and err.usage.attempts == tries


# ---- wall-clock limits ----


async def test_a_slow_drip_cannot_outlast_the_deadline(fake_speech: FakeSpeech) -> None:
    fake_speech.drip = True
    started = time.monotonic()
    err = await fails(fake_speech, deadline=time.monotonic() + 0.4)
    assert err.code == "limit_exceeded" and time.monotonic() - started < 3


async def test_a_slow_drip_hits_the_cap_without_a_deadline(
    fake_speech: FakeSpeech, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(openai_compatible, "MAX_REQUEST_SECONDS", 0.3)
    fake_speech.drip = True
    started = time.monotonic()
    waits = Waits()
    err = await fails(fake_speech, waits=waits)
    # Not retried: the provider may already have transcribed (and billed) the upload.
    assert err.code == "provider_unreachable" and len(fake_speech.seen) == 1 and waits.calls == []
    assert time.monotonic() - started < 5


# ---- language ----


async def test_forced_language_is_normalised_before_sending(fake_speech: FakeSpeech) -> None:
    from test_speech_openai import run

    await run(fake_speech, language="Polish")
    assert fake_speech.seen[0].values("language") == ["pl"]
    await run(fake_speech, language="zh-Hans-CN")
    assert fake_speech.seen[1].values("language") == ["zh"]


async def test_unknown_forced_language_sends_nothing(fake_speech: FakeSpeech) -> None:
    err = await fails(fake_speech, language="klingon")
    assert err.code == "provider_config_invalid" and fake_speech.seen == []


@pytest.mark.parametrize("reported", ["klingon", "zz", "xx-YY"])
async def test_a_language_we_cannot_map_fails_the_allowed_check(fake_speech: FakeSpeech, reported: str) -> None:
    fake_speech.language = reported
    err = await fails(fake_speech, allowed_languages=["pl", "en"])
    assert err.code == "language_not_allowed"


async def test_a_language_we_cannot_map_is_fine_without_an_allowed_list(fake_speech: FakeSpeech) -> None:
    from test_speech_openai import run

    fake_speech.language = "klingon"
    transcript, _ = await run(fake_speech)
    assert transcript.language is None


async def test_region_and_alias_forms_pass_the_allowed_check(fake_speech: FakeSpeech) -> None:
    from test_speech_openai import run

    fake_speech.language = "pl-PL"
    transcript, _ = await run(fake_speech, allowed_languages=["Polish"])
    assert transcript.language == "pl"


# ---- upload limit per connection ----


async def test_upload_limit_comes_from_the_connection(fake_speech: FakeSpeech) -> None:
    from test_speech_openai import run

    small = conn(fake_speech, max_upload_mb=1)
    err = await fails(fake_speech, connection=small, media=audio(size=2 * 1024 * 1024))
    assert err.code == "audio_too_long" and fake_speech.seen == []
    await run(fake_speech, connection=small, media=audio(size=512 * 1024))
    big = conn(fake_speech, max_upload_mb=100)
    await run(fake_speech, connection=big, media=audio(size=30 * 1024 * 1024))
    assert len(fake_speech.seen) == 2


# ---- Retry-After ----


def test_retry_after_http_date() -> None:
    soon = httpx2.Response(429, headers={"Retry-After": formatdate(time.time() + 30, usegmt=True)})
    assert retry_after(soon) == pytest.approx(30, abs=2)
    past = httpx2.Response(429, headers={"Retry-After": formatdate(time.time() - 30, usegmt=True)})
    assert retry_after(past) == 0.0
    far = httpx2.Response(429, headers={"Retry-After": formatdate(time.time() + 9999, usegmt=True)})
    assert retry_after(far) == 60.0


@pytest.mark.parametrize("raw", ["soon", "nan", "inf", ""])
def test_retry_after_junk_is_ignored(raw: str) -> None:
    assert retry_after(httpx2.Response(429, headers={"Retry-After": raw})) is None
