from contextlib import asynccontextmanager

from fastapi import FastAPI

from aftertalk.settings import get_settings


@asynccontextmanager
async def lifespan(_: FastAPI):
    get_settings()  # fail at start, not on the first job, when a setting is missing
    yield


app = FastAPI(title="Aftertalk engine", lifespan=lifespan)


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}
