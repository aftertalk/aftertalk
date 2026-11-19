# aftertalk-engine

The Python half of Aftertalk: stateless call processing over HTTP. It has no
database. Web sends a signed job (`POST /jobs`), the engine reads the audio
from the shared `/data` volume, runs the pipeline, and posts the result back
to web. See the root README for the split between web and engine.

## Run, test, lint

From the repo root (every uv command uses `--project packages/engine`):

```sh
uv sync --project packages/engine
uv run --project packages/engine pytest packages/engine
uv run --project packages/engine ruff check packages/engine
uv run --project packages/engine ruff format packages/engine

# local server on :8000 (needs ENGINE_CALLBACK_SECRET)
ENGINE_CALLBACK_SECRET=dev uv run --project packages/engine python -m aftertalk_engine
```

Or the whole stack: `docker compose -f docker-compose.dev.yml up -d --build`.

## Layout

```
aftertalk_engine/
  api/         HTTP: app, job contract (OpenAPI), signing and callbacks
  pipeline/    step runner, transcript cache, turns
  steps/       audio, vad, transcribe, analyses/, quotes
  providers/   speech, diarization and LLM adapters
  pii/         pattern rules, name detector, redaction
  logging.py   JSON logs with a fixed set of fields
  settings.py  environment variables (pydantic-settings)
scripts/       export_openapi.py
tests/unit/    one test file per module
tests/contract/ the committed openapi.json must match the app
openapi.json   generated; web's client is built from it
```

Each folder's README says what goes in it and which spec items describe it.

## Rules

- **Contract changes**: edit `api/contract.py`, run
  `uv run --project packages/engine python packages/engine/scripts/export_openapi.py`,
  commit `openapi.json` in the same PR. CI fails if they differ.
- **Logging**: only through `aftertalk_engine.logging.log`, which accepts only
  `job_id`, `call_id`, `project_id`, `user_id`, `attempt`, `step`,
  `error_code`, `duration_ms`. Never log provider responses, transcript text
  or keys.
- **Providers**: settings and keys arrive in each job request; nothing is
  stored. Torch comes from the CPU-only index.
- **Spec**: `design_draft.md` and `decisions.json` in the private repo
  `aftertalk/aftertalk-spec`; engine items are 57-77.
