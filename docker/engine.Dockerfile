# syntax=docker/dockerfile:1
# Engine: FastAPI app. Phase 0 has no GLiNER download yet (item 7 adds it with the name detector).
FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.12.24 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/venv PYTHONUNBUFFERED=1
WORKDIR /app
COPY packages/engine/pyproject.toml packages/engine/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev --no-install-project
COPY packages/engine/aftertalk_engine ./aftertalk_engine
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev
RUN groupadd -g 1000 aftertalk && useradd -u 1000 -g 1000 -M aftertalk && mkdir -p /data && chown 1000:1000 /data
USER 1000:1000
EXPOSE 8000
CMD ["/opt/venv/bin/python", "-m", "aftertalk_engine"]
