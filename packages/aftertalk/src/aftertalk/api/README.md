# api

HTTP surface of the engine. `app.py` (FastAPI: `POST /jobs`, `POST /providers/test`,
`GET /healthz`), `contract.py` (Pydantic models of the job request and the result
callback; the OpenAPI schema web's client is generated from), `callback.py` (HMAC
signing and checking, heartbeat, result sender with its resend schedule).
Spec: items 58-60.
