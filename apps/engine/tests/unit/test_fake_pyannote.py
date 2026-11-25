import httpx2
from fake_pyannote import MARKER, SIG, FakePyannote, Forced, segments


def test_happy_flow_of_four_requests(fake_pyannote: FakePyannote) -> None:
    fake_pyannote.exclusive = segments((0.0, 0.5, "SPEAKER_01"))
    with httpx2.Client() as client:
        media = client.post(f"{fake_pyannote.base_url}/media/input", json={"url": "media://x"})
        assert media.status_code == 201
        url = media.json()["url"]
        assert url == f"{fake_pyannote.origin}/upload/1?sig={SIG}"
        assert client.put(url, content=b"audio").status_code == 200
        job = client.post(f"{fake_pyannote.base_url}/diarize", json={"url": "media://x"})
        assert job.json() == {"jobId": "job-1", "status": "created"}
        first = client.get(f"{fake_pyannote.base_url}/jobs/job-1").json()
        second = client.get(f"{fake_pyannote.base_url}/jobs/job-1").json()
    assert first["status"] == "running"
    assert "output" not in first
    assert second["output"]["diarization"] == segments((0.0, 1.0, "SPEAKER_00"))
    assert second["output"]["exclusiveDiarization"] == segments((0.0, 0.5, "SPEAKER_01"))
    assert fake_pyannote.uploads == {"/upload/1": b"audio"}
    assert fake_pyannote.jobs == [{"url": "media://x"}]
    assert [len(fake_pyannote.requests(r)) for r in ("media", "upload", "diarize", "job")] == [1, 1, 1, 2]


def test_forced_answer_replaces_the_normal_one_once(fake_pyannote: FakePyannote) -> None:
    fake_pyannote.forced["media"].append(Forced(401, "nope", {"X-Test": "1"}))
    url = f"{fake_pyannote.base_url}/media/input"
    first = httpx2.post(url, json={})
    second = httpx2.post(url, json={})
    assert (first.status_code, first.text, first.headers["x-test"]) == (401, "nope", "1")
    assert second.status_code == 201
    assert len(fake_pyannote.requests("media")) == 2


def test_status_queue_repeats_the_last_and_failure_has_marker(fake_pyannote: FakePyannote) -> None:
    fake_pyannote.statuses = ["running", "failed"]
    url = f"{fake_pyannote.base_url}/jobs/abc"
    statuses = [httpx2.get(url).json()["status"] for _ in range(3)]
    assert statuses == ["running", "failed", "failed"]
    assert MARKER in httpx2.get(url).text


def test_unknown_route_is_404_with_marker(fake_pyannote: FakePyannote) -> None:
    response = httpx2.get(f"{fake_pyannote.origin}/elsewhere")
    assert response.status_code == 404
    assert MARKER in response.text


def test_chunked_put_is_decoded(fake_pyannote: FakePyannote) -> None:
    def body():
        yield b"abc"
        yield b"defgh"

    response = httpx2.put(f"{fake_pyannote.origin}/upload/9?sig={SIG}", content=body())
    assert response.status_code == 200
    assert fake_pyannote.uploads == {"/upload/9": b"abcdefgh"}
    seen = fake_pyannote.requests("upload")[0]
    assert seen.chunked is True
    assert seen.path.endswith(f"?sig={SIG}")
