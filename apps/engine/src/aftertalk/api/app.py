from contextlib import asynccontextmanager

from fastapi import FastAPI

from aftertalk.api.shared_models import add_shared_models
from aftertalk.settings import get_settings


@asynccontextmanager
async def lifespan(_: FastAPI):
    get_settings()  # fail at start, not on the first job, when a setting is missing
    yield


app = FastAPI(title="Aftertalk engine", lifespan=lifespan)


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


def _openapi() -> dict:
    if app.openapi_schema is None:
        app.openapi_schema = add_shared_models(FastAPI.openapi(app))
    return app.openapi_schema


app.openapi = _openapi
