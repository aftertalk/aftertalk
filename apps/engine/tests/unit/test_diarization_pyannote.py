"""The pyannote.ai adapter against the local fake (`fake_pyannote.py`); nothing calls the real service."""

import asyncio
import json

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
