from fastapi.testclient import TestClient

from aftertalk.api.app import app


def test_healthz() -> None:
    with TestClient(app) as client:
        res = client.get("/healthz")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}
