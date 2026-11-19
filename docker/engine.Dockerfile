# syntax=docker/dockerfile:1
# Engine: the `aftertalk` package served over HTTP for web. Phase 0 has no GLiNER download yet.
FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.12.24 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/venv PYTHONUNBUFFERED=1
ENV PATH=/opt/venv/bin:$PATH
WORKDIR /app
COPY apps/engine/pyproject.toml apps/engine/uv.lock apps/engine/.python-version ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project --extra server --extra audio --extra pii
COPY apps/engine/src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --extra server --extra audio --extra pii
RUN groupadd -g 1000 aftertalk && useradd -u 1000 -g 1000 -M aftertalk && mkdir -p /data && chown 1000:1000 /data
USER 1000:1000
EXPOSE 8000
CMD ["/opt/venv/bin/aftertalk", "serve"]
