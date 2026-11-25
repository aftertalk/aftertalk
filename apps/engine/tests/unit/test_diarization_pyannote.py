"""The pyannote.ai adapter against the local fake (`fake_pyannote.py`); nothing calls the real service."""

import asyncio
import json
import time

import numpy as np
import pytest
from fake_pyannote import MARKER, SIG, FakePyannote, Forced, segments

from aftertalk.audio.decode import to_mono
from aftertalk.audio.encode import MonoWav, encode_pcm
from aftertalk.models.connections import DiarizationConnection
from aftertalk.models.errors import EngineError
from aftertalk.providers.diarization.pyannote import MODEL, PollingTimeout, PyannoteDiarization
from aftertalk.providers.net import make_client

KEY = "pyannote-secret-key-123"


def conn(fake: FakePyannote) -> DiarizationConnection:
    return DiarizationConnection.model_validate({"base_url": fake.base_url, "api_key": KEY})


def wav(seconds: float = 1.0, channels: int = 1) -> MonoWav:
    rng = np.random.default_rng(7)
    return MonoWav(rng.integers(-2000, 2000, size=(int(seconds * 16000), channels), dtype=np.int16))


class Clock:
    """A fake monotonic clock that the fake sleep moves forward."""

    def __init__(self) -> None:
        self.now = 1000.0
        self.slept: list[float] = []

    def __call__(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds


async def diarize(fake: FakePyannote, audio: MonoWav | None = None, *, deadline: float | None = None, **kwargs):
    async with make_client(block_private=False) as client:
        options = {"poll_interval": 0.0, "retry_waits": (0.0, 0.0), **kwargs}
        provider = PyannoteDiarization(conn(fake), client, **options)
        return await provider.diarize(audio or wav(), deadline=deadline)


async def fails(fake: FakePyannote, audio: MonoWav | None = None, **kwargs) -> EngineError:
    with pytest.raises(EngineError) as info:
        await diarize(fake, audio, **kwargs)
    err = info.value
    assert err.__cause__ is None and err.__context__ is None
    assert MARKER not in str(err) and SIG not in str(err) and KEY not in str(err)
    assert err.usage is not None and err.usage.step == "diarize"
    return err


def test_success_the_four_requests_in_order(fake_pyannote: FakePyannote) -> None:
    fake_pyannote.output = segments((0.0, 0.5, "SPEAKER_00"), (0.5, 1.0, "SPEAKER_01"))
    audio = wav(1.0, channels=2)
    output, usage = asyncio.run(diarize(fake_pyannote, audio))
    assert [(s.start, s.end, s.speaker) for s in output.segments] == [
        (0.0, 0.5, "SPEAKER_00"),
        (0.5, 1.0, "SPEAKER_01"),
    ]
    routes = [(s.method, s.path.split("?")[0]) for s in fake_pyannote.seen]
    assert routes == [
        ("POST", "/v1/media/input"),
        ("PUT", "/upload/1"),
        ("POST", "/v1/diarize"),
        ("GET", "/v1/jobs/job-1"),
        ("GET", "/v1/jobs/job-1"),
    ]
    media = fake_pyannote.requests("media")[0].json["url"]
    assert media.startswith("media://aftertalk-") and media.endswith(".wav")
    assert fake_pyannote.jobs == [{"url": media, "model": MODEL, "exclusive": True}]
    assert usage.step == "diarize" and usage.provider == "pyannote-ai" and usage.model == "community-1"
    assert (usage.requests, usage.attempts, usage.audio_seconds) == (5, 5, 1.0)


def test_upload_is_the_mono_wav_with_a_length_and_no_key(fake_pyannote: FakePyannote) -> None:
    samples = np.random.default_rng(3).integers(-3000, 3000, size=(20000, 2), dtype=np.int16)
    asyncio.run(diarize(fake_pyannote, MonoWav(samples)))
    put = fake_pyannote.requests("upload")[0]
    assert put.body == encode_pcm(to_mono(samples), "wav").data
    assert not put.chunked and put.headers["content-length"] == str(len(put.body))
    assert "authorization" not in put.headers
    for route in ("media", "diarize", "job"):
        assert all(s.headers["authorization"] == f"Bearer {KEY}" for s in fake_pyannote.requests(route))


def test_exclusive_output_is_preferred(fake_pyannote: FakePyannote) -> None:
    fake_pyannote.output = segments((0.0, 1.0, "A"), (0.5, 0.8, "B"))
    fake_pyannote.exclusive = segments((0.0, 0.5, "A"), (0.5, 0.8, "B"), (0.8, 1.0, "A"))
    output, _ = asyncio.run(diarize(fake_pyannote))
    assert len(output.segments) == 3


def test_empty_exclusive_falls_back_to_diarization(fake_pyannote: FakePyannote) -> None:
    fake_pyannote.output = segments((0.0, 1.0, "A"))
    fake_pyannote.exclusive = []
    output, _ = asyncio.run(diarize(fake_pyannote))
    assert [s.speaker for s in output.segments] == ["A"]


def test_zero_length_segments_are_dropped_and_none_is_fine(fake_pyannote: FakePyannote) -> None:
    fake_pyannote.output = segments((0.5, 0.5, "A"), (0.2, 0.4, "B"))
    output, _ = asyncio.run(diarize(fake_pyannote))
    assert [s.speaker for s in output.segments] == ["B"]
    fake_pyannote.output = []
    output, _ = asyncio.run(diarize(fake_pyannote))
    assert output.segments == ()


@pytest.mark.parametrize("status", ["failed", "canceled"])
def test_a_failed_job(fake_pyannote: FakePyannote, status: str) -> None:
    fake_pyannote.statuses = ["running", status]
    err = asyncio.run(fails(fake_pyannote))
    assert err.code == "provider_bad_response"
    assert err.usage is not None and err.usage.audio_seconds == 1.0


def test_an_unknown_status_keeps_polling(fake_pyannote: FakePyannote) -> None:
    fake_pyannote.statuses = ["pending", "created", "queued-new", "running", "succeeded"]
    asyncio.run(diarize(fake_pyannote))
    assert len(fake_pyannote.requests("job")) == 5


def test_polling_cap_is_limit_exceeded(fake_pyannote: FakePyannote) -> None:
    fake_pyannote.statuses = ["running"]
    clock = Clock()
    with pytest.raises(PollingTimeout) as info:
        asyncio.run(diarize(fake_pyannote, clock=clock, sleep=clock.sleep, poll_interval=2.0))
    assert info.value.code == "limit_exceeded"
    assert sum(clock.slept) == pytest.approx(300.0)  # a 1 s file: the 300 s floor
    assert all(pause <= 2.0 for pause in clock.slept)


def test_polling_cap_scales_with_long_audio(fake_pyannote: FakePyannote) -> None:
    fake_pyannote.statuses = ["running"]
    clock = Clock()

    short = wav(0.01)

    class Long:
        content_type = "audio/wav"
        size_bytes = short.size_bytes
        duration_seconds = 2000.0

        def chunks(self):
            return short.chunks()

    with pytest.raises(PollingTimeout):
        asyncio.run(diarize(fake_pyannote, Long(), clock=clock, sleep=clock.sleep, poll_interval=50.0))  # type: ignore[arg-type]
    assert sum(clock.slept) == pytest.approx(1000.0)


def test_the_deadline_before_the_cap(fake_pyannote: FakePyannote) -> None:
    fake_pyannote.statuses = ["running"]
    clock = Clock()
    with pytest.raises(EngineError) as info:
        asyncio.run(diarize(fake_pyannote, clock=clock, sleep=clock.sleep, poll_interval=2.0, deadline=clock.now + 30))
    assert info.value.code == "limit_exceeded" and not isinstance(info.value, PollingTimeout)
    assert sum(clock.slept) <= 30.0


def test_a_past_deadline_sends_nothing(fake_pyannote: FakePyannote) -> None:
    clock = Clock()
    err = asyncio.run(fails(fake_pyannote, clock=clock, sleep=clock.sleep, deadline=clock.now - 1))
    assert err.code == "limit_exceeded" and fake_pyannote.seen == []


@pytest.mark.parametrize(
    ("route", "status", "code"),
    [
        ("media", 401, "provider_auth"),
        ("media", 403, "provider_auth"),
        ("media", 402, "provider_quota_exceeded"),
        ("media", 404, "provider_bad_response"),
        ("media", 400, "provider_bad_response"),
        ("media", 302, "provider_bad_response"),
        ("upload", 403, "provider_bad_response"),
        ("upload", 413, "audio_too_long"),
        ("diarize", 401, "provider_auth"),
        ("diarize", 402, "provider_quota_exceeded"),
        ("job", 404, "provider_bad_response"),
    ],
)
def test_status_codes(fake_pyannote: FakePyannote, route: str, status: int, code: str) -> None:
    fake_pyannote.forced[route] = [Forced(status, json.dumps({"message": MARKER}), {"Location": "http://10.0.0.1/"})]
    err = asyncio.run(fails(fake_pyannote))
    assert err.code == code
    assert len(fake_pyannote.requests(route)) == 1  # not retried


@pytest.mark.parametrize("route", ["media", "upload", "diarize", "job"])
def test_5xx_is_retried_then_succeeds(fake_pyannote: FakePyannote, route: str) -> None:
    fake_pyannote.forced[route] = [Forced(503, MARKER), Forced(500, MARKER)]
    asyncio.run(diarize(fake_pyannote))
    assert len(fake_pyannote.requests(route)) >= 3


def test_5xx_three_times_fails(fake_pyannote: FakePyannote) -> None:
    fake_pyannote.forced["diarize"] = [Forced(502, MARKER)] * 3
    err = asyncio.run(fails(fake_pyannote))
    assert err.code == "provider_unreachable" and len(fake_pyannote.requests("diarize")) == 3


def test_429_honours_retry_after(fake_pyannote: FakePyannote) -> None:
    fake_pyannote.forced["media"] = [Forced(429, MARKER, {"Retry-After": "7"})]
    clock = Clock()
    asyncio.run(diarize(fake_pyannote, clock=clock, sleep=clock.sleep))
    assert clock.slept[0] == 7.0


def test_429_three_times_is_rate_limited(fake_pyannote: FakePyannote) -> None:
    fake_pyannote.forced["job"] = [Forced(429, MARKER)] * 3
    err = asyncio.run(fails(fake_pyannote))
    assert err.code == "provider_rate_limited"


def test_a_retried_upload_sends_the_whole_body_again(fake_pyannote: FakePyannote) -> None:
    fake_pyannote.forced["upload"] = [Forced(503, MARKER)]
    audio = wav(0.5)
    asyncio.run(diarize(fake_pyannote, audio))
    puts = fake_pyannote.requests("upload")
    assert len(puts) == 2 and puts[0].body == puts[1].body and len(puts[1].body) == audio.size_bytes


def test_a_timed_out_job_creation_is_never_sent_again(fake_pyannote: FakePyannote, monkeypatch) -> None:
    from aftertalk.providers.diarization import pyannote

    monkeypatch.setattr(pyannote, "PHASE_TIMEOUT", 0.2)
    fake_pyannote.stall["diarize"] = 1.0
    err = asyncio.run(fails(fake_pyannote))
    assert err.code == "provider_unreachable"
    assert len(fake_pyannote.requests("diarize")) == 1
    assert err.usage is not None and err.usage.audio_seconds == 1.0  # it may exist and be billed


def test_a_timed_out_poll_is_retried(fake_pyannote: FakePyannote, monkeypatch) -> None:
    from aftertalk.providers.diarization import pyannote

    monkeypatch.setattr(pyannote, "PHASE_TIMEOUT", 0.2)
    fake_pyannote.stall["job"] = 0.5
    fake_pyannote.statuses = ["succeeded"]
    err = asyncio.run(fails(fake_pyannote))
    assert err.code == "provider_unreachable"
    assert len(fake_pyannote.requests("job")) == 3


@pytest.mark.parametrize(
    ("route", "body"),
    [
        ("media", "not json"),
        ("media", json.dumps({"nope": 1})),
        ("media", json.dumps({"url": 5})),
        ("media", json.dumps({"url": ""})),
        ("diarize", json.dumps({"status": "created"})),
        ("diarize", json.dumps({"jobId": "../../admin"})),
        ("diarize", json.dumps({"jobId": "a" * 129})),
        ("job", json.dumps({"output": {}})),
        ("job", json.dumps({"status": "succeeded"})),
        ("job", json.dumps({"status": "succeeded", "output": {"diarization": "x"}})),
        ("job", json.dumps({"status": "succeeded", "output": {"diarization": [{"start": 0, "end": 1}]}})),
        (
            "job",
            json.dumps({"status": "succeeded", "output": {"diarization": [{"start": -1, "end": 1, "speaker": "A"}]}}),
        ),
        (
            "job",
            json.dumps({"status": "succeeded", "output": {"diarization": [{"start": True, "end": 1, "speaker": "A"}]}}),
        ),
        ("job", '{"status": "succeeded", "output": {"diarization": [{"start": NaN, "end": 1, "speaker": "A"}]}}'),
        (
            "job",
            json.dumps({"status": "succeeded", "output": {"diarization": [{"start": 0, "end": 1, "speaker": " "}]}}),
        ),
    ],
)
def test_bad_answers(fake_pyannote: FakePyannote, route: str, body: str) -> None:
    fake_pyannote.forced[route] = [Forced(200, body)]
    err = asyncio.run(fails(fake_pyannote))
    assert err.code == "provider_bad_response"


@pytest.mark.parametrize(
    "url",
    [
        "ftp://example.com/upload",
        "https://user:pass@example.com/upload",
        "https:///nohost",
        "https://exa mple.com/x",
        "https://example.com/" + "a" * 5000,
    ],
)
def test_bad_upload_addresses(fake_pyannote: FakePyannote, url: str) -> None:
    fake_pyannote.presigned_url = url
    err = asyncio.run(fails(fake_pyannote))
    assert err.code == "provider_bad_response"
    assert fake_pyannote.requests("upload") == []


def test_http_upload_refused_under_an_https_base() -> None:
    from aftertalk.providers.diarization.pyannote import PyannoteDiarization

    https = DiarizationConnection.model_validate({"api_key": KEY})
    provider = PyannoteDiarization(https, None)  # type: ignore[arg-type]
    assert provider._upload_url_ok("https://storage.example.com/x?sig=1")
    assert not provider._upload_url_ok("http://storage.example.com/x?sig=1")


def test_a_blocked_upload_host_is_unreachable_and_not_retried(fake_pyannote: FakePyannote) -> None:
    async def resolver(host: str, port: int) -> list[str]:
        return ["10.1.2.3"] if host == "storage.internal-looking.example" else ["127.0.0.1"]

    fake_pyannote.presigned_url = "http://storage.internal-looking.example/upload/1?sig=x"

    async def run() -> EngineError:
        async with make_client(block_private=True, resolver=resolver) as client:
            provider = PyannoteDiarization(conn(fake_pyannote), client, poll_interval=0.0, retry_waits=(0.0, 0.0))
            try:
                await provider.diarize(wav(), deadline=None)
            except EngineError as err:
                return err
        raise AssertionError("no error")

    # The fake is on 127.0.0.1, which the guard blocks too: the first request already fails, as it must.
    err = asyncio.run(run())
    assert err.code == "provider_unreachable"
    assert err.usage is not None and err.usage.attempts == 1


def test_too_large_is_refused_before_any_request(fake_pyannote: FakePyannote) -> None:
    class Huge:
        content_type = "audio/wav"
        size_bytes = 1024**3 + 1
        duration_seconds = 1.0

        def chunks(self):
            raise AssertionError("never read")

    err = asyncio.run(fails(fake_pyannote, Huge()))  # type: ignore[arg-type]
    assert err.code == "audio_too_long" and fake_pyannote.seen == []


def test_check_sends_no_audio_and_finds_a_bad_key(fake_pyannote: FakePyannote) -> None:
    fake_pyannote.forced["media"] = [Forced(401, MARKER)]

    async def run() -> EngineError:
        async with make_client(block_private=False) as client:
            provider = PyannoteDiarization(conn(fake_pyannote), client, retry_waits=(0.0, 0.0))
            with pytest.raises(EngineError) as info:
                await provider.check(deadline=None)
            return info.value

    err = asyncio.run(run())
    assert err.code == "provider_auth" and err.usage is not None and err.usage.audio_seconds is None
    assert [s.method for s in fake_pyannote.seen] == ["POST"]


def test_check_then_diarize_asks_for_a_fresh_address_and_counts_both(fake_pyannote: FakePyannote) -> None:
    async def run():
        async with make_client(block_private=False) as client:
            provider = PyannoteDiarization(conn(fake_pyannote), client, poll_interval=0.0)
            await provider.check(deadline=None)
            return await provider.diarize(wav(), deadline=None)

    _, usage = asyncio.run(run())
    media = fake_pyannote.requests("media")
    assert len(media) == 2 and media[0].json["url"] != media[1].json["url"]
    assert fake_pyannote.requests("upload")[0].path.startswith("/upload/2")
    assert usage.requests == 6


def test_no_provider_text_or_key_in_logs(fake_pyannote: FakePyannote, capsys: pytest.CaptureFixture[str]) -> None:
    fake_pyannote.statuses = ["failed"]
    asyncio.run(fails(fake_pyannote))
    out = capsys.readouterr()
    for text in (MARKER, SIG, KEY):
        assert text not in out.out and text not in out.err


# ---- from the adversarial review ----


def test_the_upload_may_take_all_the_time_left_not_a_fixed_cap(fake_pyannote: FakePyannote, monkeypatch) -> None:
    from aftertalk.providers.diarization import pyannote

    monkeypatch.setattr(pyannote, "MAX_UPLOAD_SECONDS", 0.3)
    fake_pyannote.stall["upload"] = 0.6
    asyncio.run(diarize(fake_pyannote, deadline=time.monotonic() + 60))
    assert len(fake_pyannote.requests("upload")) == 1


def test_an_upload_that_used_its_whole_time_is_not_sent_again(fake_pyannote: FakePyannote, monkeypatch) -> None:
    from aftertalk.providers.diarization import pyannote

    monkeypatch.setattr(pyannote, "MAX_UPLOAD_SECONDS", 0.3)  # no deadline: this is the cap
    fake_pyannote.stall["upload"] = 0.6
    err = asyncio.run(fails(fake_pyannote))
    assert err.code == "provider_unreachable" and len(fake_pyannote.requests("upload")) == 1


def test_the_deadline_during_a_request_is_limit_exceeded(fake_pyannote: FakePyannote) -> None:
    fake_pyannote.stall["media"] = 1.0
    err = asyncio.run(fails(fake_pyannote, deadline=time.monotonic() + 0.3))
    assert err.code == "limit_exceeded" and len(fake_pyannote.requests("media")) == 1


def test_a_retry_wait_past_the_deadline_is_limit_exceeded_without_waiting(fake_pyannote: FakePyannote) -> None:
    fake_pyannote.forced["media"] = [Forced(429, MARKER, {"Retry-After": "7"})]
    clock = Clock()
    err = asyncio.run(fails(fake_pyannote, clock=clock, sleep=clock.sleep, deadline=clock.now + 3))
    assert err.code == "limit_exceeded" and clock.slept == []


def test_408_is_retried(fake_pyannote: FakePyannote) -> None:
    fake_pyannote.forced["job"] = [Forced(408, MARKER)]
    asyncio.run(diarize(fake_pyannote))
    assert len(fake_pyannote.requests("job")) == 3  # 408, running, succeeded


def test_413_outside_the_upload_is_a_bad_response(fake_pyannote: FakePyannote) -> None:
    fake_pyannote.forced["media"] = [Forced(413, MARKER)]
    assert asyncio.run(fails(fake_pyannote)).code == "provider_bad_response"


def _mock(handler) -> object:
    import httpx2

    return httpx2.MockTransport(handler)


@pytest.mark.parametrize("error", ["ReadError", "RemoteProtocolError", "WriteError", "WriteTimeout"])
def test_job_creation_is_not_sent_again_after_a_dropped_connection(error: str) -> None:
    import httpx2

    sent: list[str] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        sent.append(request.url.path)
        if request.url.path == "/v1/media/input":
            return httpx2.Response(201, json={"url": "https://storage.example.com/up?sig=1"})
        if request.url.path == "/v1/diarize":
            raise getattr(httpx2, error)("dropped", request=request)
        return httpx2.Response(200)

    async def run() -> EngineError:
        conn_ = DiarizationConnection.model_validate({"base_url": "https://api.example.com/v1", "api_key": KEY})
        async with make_client(block_private=False, inner=_mock(handler)) as client:
            provider = PyannoteDiarization(conn_, client, retry_waits=(0.0, 0.0))
            with pytest.raises(EngineError) as info:
                await provider.diarize(wav(), deadline=None)
            return info.value

    err = asyncio.run(run())
    assert err.code == "provider_unreachable" and sent.count("/v1/diarize") == 1
    assert err.usage is not None and err.usage.audio_seconds == 1.0


def test_a_failed_connect_on_job_creation_is_tried_again() -> None:
    import httpx2

    sent: list[str] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        sent.append(request.url.path)
        if request.url.path == "/v1/media/input":
            return httpx2.Response(201, json={"url": "https://storage.example.com/up?sig=1"})
        if request.url.path == "/v1/diarize" and sent.count("/v1/diarize") == 1:
            raise httpx2.ConnectError("refused", request=request)
        if request.url.path == "/v1/diarize":
            return httpx2.Response(200, json={"jobId": "j1"})
        if request.url.path.startswith("/v1/jobs/"):
            return httpx2.Response(200, json={"status": "succeeded", "output": {"diarization": []}})
        return httpx2.Response(200)

    async def run() -> None:
        conn_ = DiarizationConnection.model_validate({"base_url": "https://api.example.com/v1", "api_key": KEY})
        async with make_client(block_private=False, inner=_mock(handler)) as client:
            await PyannoteDiarization(conn_, client, retry_waits=(0.0, 0.0)).diarize(wav(), deadline=None)

    asyncio.run(run())
    assert sent.count("/v1/diarize") == 2


def test_the_upload_host_is_checked_by_the_guard() -> None:
    import httpx2

    sent: list[str] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        sent.append(request.url.path)
        return httpx2.Response(201, json={"url": "https://storage.internal.example.com/up?sig=1"})

    async def resolver(host: str, port: int) -> list[str]:
        return ["10.0.0.7"] if host.startswith("storage.") else ["93.184.215.14"]

    async def run() -> EngineError:
        conn_ = DiarizationConnection.model_validate({"base_url": "https://api.example.com/v1", "api_key": KEY})
        async with make_client(block_private=True, resolver=resolver, inner=_mock(handler)) as client:
            provider = PyannoteDiarization(conn_, client, retry_waits=(0.0, 0.0))
            with pytest.raises(EngineError) as info:
                await provider.diarize(wav(), deadline=None)
            return info.value

    err = asyncio.run(run())
    assert err.code == "provider_unreachable"
    assert sent == ["/v1/media/input"]  # the PUT never left
    assert err.usage is not None and err.usage.attempts == 2  # one address request, one blocked upload, not retried


@pytest.mark.parametrize("url", ["http://127.0.0.1:99999/x", "https://example.com/a\x00b", "https://example.com/\x7f"])
def test_upload_addresses_the_client_cannot_send_are_bad_responses(fake_pyannote: FakePyannote, url: str) -> None:
    fake_pyannote.presigned_url = url
    err = asyncio.run(fails(fake_pyannote))
    assert err.code == "provider_bad_response" and err.usage is not None and err.usage.attempts == 1


def test_an_oversized_number_or_deep_json_is_a_bad_response(fake_pyannote: FakePyannote) -> None:
    huge = "1" + "0" * 400
    fake_pyannote.forced["job"] = [
        Forced(
            200,
            '{"status": "succeeded", "output": {"diarization": [{"start": ' + huge + ', "end": 1, "speaker": "A"}]}}',
        )
    ]
    assert asyncio.run(fails(fake_pyannote)).code == "provider_bad_response"
    fake_pyannote.forced["job"] = [Forced(200, "[" * 100000 + "]" * 100000)]
    assert asyncio.run(fails(fake_pyannote)).code == "provider_bad_response"


def test_duration_counts_only_time_in_the_adapter(fake_pyannote: FakePyannote) -> None:
    clock = Clock()

    async def run():
        async with make_client(block_private=False) as client:
            provider = PyannoteDiarization(
                conn(fake_pyannote), client, poll_interval=0.0, clock=clock, sleep=clock.sleep
            )
            await provider.check(deadline=None)
            clock.now += 500.0  # the speech windows run meanwhile
            return await provider.diarize(wav(), deadline=None)

    _, usage = asyncio.run(run())
    assert usage.duration_ms < 500_000


def test_bad_upload_addresses_send_one_request_only(fake_pyannote: FakePyannote) -> None:
    fake_pyannote.presigned_url = "https://user:pass@example.invalid/upload"
    err = asyncio.run(fails(fake_pyannote))
    assert err.usage is not None and err.usage.attempts == 1
    fake_pyannote.presigned_url = "https://example.invalid/" + "a" * 5000
    err = asyncio.run(fails(fake_pyannote))
    assert err.usage is not None and err.usage.attempts == 1


# ---- from the second review ----


@pytest.mark.parametrize("route", ["media", "job"])
def test_a_try_that_used_its_wall_time_is_retried_when_safe(
    fake_pyannote: FakePyannote, monkeypatch, route: str
) -> None:
    from aftertalk.providers.diarization import pyannote

    monkeypatch.setattr(pyannote, "JSON_REQUEST_SECONDS", 0.3)
    fake_pyannote.statuses = ["succeeded"]
    real = fake_pyannote._answer
    slow = {"left": 1}

    def answer(r, seen):  # the first request of the route answers after the try's wall time, the next at once
        if r == route and slow["left"]:
            slow["left"] -= 1
            time.sleep(0.8)
        return real(r, seen)

    monkeypatch.setattr(fake_pyannote, "_answer", answer)
    asyncio.run(diarize(fake_pyannote))
    assert len(fake_pyannote.requests(route)) == 2


def _handler_for_diarize(fail: Exception | None, sent: list[str], times: int = 3):
    import httpx2

    def handler(request: httpx2.Request) -> httpx2.Response:
        sent.append(request.url.path)
        if request.url.path == "/v1/media/input":
            return httpx2.Response(201, json={"url": "https://storage.example.com/up?sig=1"})
        if request.url.path == "/v1/diarize":
            if sent.count("/v1/diarize") <= times and fail is not None:
                raise type(fail)("no", request=request)  # type: ignore[call-arg]
            return httpx2.Response(200, json={"jobId": "j1"})
        if request.url.path.startswith("/v1/jobs/"):
            return httpx2.Response(200, json={"status": "succeeded", "output": {"diarization": []}})
        return httpx2.Response(200)

    return handler


@pytest.mark.parametrize("error", ["ConnectError", "ConnectTimeout"])
def test_job_creation_that_never_connected_bills_nothing(error: str) -> None:
    import httpx2

    sent: list[str] = []

    async def run() -> EngineError:
        conn_ = DiarizationConnection.model_validate({"base_url": "https://api.example.com/v1", "api_key": KEY})
        handler = _handler_for_diarize(getattr(httpx2, error)("x"), sent)
        async with make_client(block_private=False, inner=_mock(handler)) as client:
            with pytest.raises(EngineError) as info:
                await PyannoteDiarization(conn_, client, retry_waits=(0.0, 0.0)).diarize(wav(), deadline=None)
            return info.value

    err = asyncio.run(run())
    assert err.code == "provider_unreachable" and sent.count("/v1/diarize") == 3  # tried again: it never left
    assert err.usage is not None and err.usage.audio_seconds is None


def test_connect_timeout_on_job_creation_is_tried_again() -> None:
    import httpx2

    sent: list[str] = []

    async def run() -> None:
        conn_ = DiarizationConnection.model_validate({"base_url": "https://api.example.com/v1", "api_key": KEY})
        handler = _handler_for_diarize(httpx2.ConnectTimeout("x"), sent, times=1)
        async with make_client(block_private=False, inner=_mock(handler)) as client:
            await PyannoteDiarization(conn_, client, retry_waits=(0.0, 0.0)).diarize(wav(), deadline=None)

    asyncio.run(run())
    assert sent.count("/v1/diarize") == 2


def test_duration_sums_check_and_diarize_including_waits(fake_pyannote: FakePyannote) -> None:
    fake_pyannote.forced["media"] = [Forced(429, MARKER, {"Retry-After": "7"})]
    fake_pyannote.statuses = ["running", "running", "succeeded"]
    clock = Clock()

    async def run():
        async with make_client(block_private=False) as client:
            provider = PyannoteDiarization(
                conn(fake_pyannote), client, poll_interval=2.0, clock=clock, sleep=clock.sleep
            )
            await provider.check(deadline=None)  # waits 7 s on the 429
            mid = provider.usage().duration_ms
            clock.now += 1000.0  # outside the adapter
            _, usage = await provider.diarize(wav(), deadline=None)
            return mid, usage

    mid, usage = asyncio.run(run())
    assert mid == 7000
    assert usage.duration_ms == 11000  # 7 s in check, 2 x 2 s of polling in diarize


def test_the_poll_pause_stops_at_the_deadline(fake_pyannote: FakePyannote) -> None:
    fake_pyannote.statuses = ["running"]
    clock = Clock()
    with pytest.raises(EngineError):
        asyncio.run(diarize(fake_pyannote, clock=clock, sleep=clock.sleep, poll_interval=50.0, deadline=clock.now + 30))
    assert sum(clock.slept) == pytest.approx(30.0)


def test_the_poll_pause_stops_at_the_cap(fake_pyannote: FakePyannote) -> None:
    fake_pyannote.statuses = ["running"]
    clock = Clock()
    with pytest.raises(PollingTimeout):
        asyncio.run(diarize(fake_pyannote, clock=clock, sleep=clock.sleep, poll_interval=70.0))
    assert sum(clock.slept) == pytest.approx(300.0)  # 70 + 70 + 70 + 70 + 20


def test_the_cap_and_the_deadline_at_once_is_the_deadline(fake_pyannote: FakePyannote) -> None:
    fake_pyannote.statuses = ["running"]
    clock = Clock()
    with pytest.raises(EngineError) as info:
        asyncio.run(diarize(fake_pyannote, clock=clock, sleep=clock.sleep, poll_interval=2.0, deadline=clock.now + 300))
    assert info.value.code == "limit_exceeded" and not isinstance(info.value, PollingTimeout)
