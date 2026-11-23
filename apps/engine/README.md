# aftertalk

The Python half of Aftertalk: a library, the `aftertalk` command, and the
HTTP server web calls. It has no database. Web sends a signed job (`POST /jobs`), the engine reads the audio
from the shared `/data` volume, runs the pipeline, and posts the result back
to web. See the root README for the split between web and engine.

## Run, test, lint

From the repo root (every uv command uses `--project apps/engine`):

```sh
uv sync --project apps/engine
uv run --project apps/engine pytest apps/engine
uv run --project apps/engine ruff check apps/engine
uv run --project apps/engine ruff format apps/engine

# local server on :8000 (needs ENGINE_CALLBACK_SECRET)
ENGINE_CALLBACK_SECRET=dev uv run --project apps/engine --extra server aftertalk serve
```

Or the whole stack: `docker compose -f docker-compose.dev.yml up -d --build`.

## Layout

```
src/aftertalk/
  cli.py       the `aftertalk` command (Typer)
  audio/       decode and re-encode audio for providers (PyAV)
  assets/      bundled test clip (test-2s.wav)
  render.py    a transcript as text, WebVTT or SRT
  models/      data models and error codes shared with web (through openapi.json)
  config/      the CLI connections file (~/.aftertalk/connections.yaml)
  api/         HTTP: app, job contract (OpenAPI), signing and callbacks
  pipeline/    step runner, transcript cache, turns
  steps/       audio, vad, transcribe, analyses/, quotes
  providers/   speech, diarization and LLM adapters
  pii/         pattern rules, name detector, redaction
  logging.py   JSON logs with a fixed set of fields
  settings.py  environment variables (pydantic-settings)
scripts/       export_openapi.py, make_test_audio.py
docs/          providers.md: which speech and LLM servers work
tests/unit/    one test file per module
tests/contract/ committed openapi.json must match the code
openapi.json   generated; web's client is built from it
```

Each folder's README says what goes in it and which spec items describe it.

## Rules

- **Contract changes**: edit `api/contract.py`, run
  `uv run --project apps/engine python apps/engine/scripts/export_openapi.py`,
  commit `openapi.json` in the same PR. CI fails if they differ.
- **Model changes**: models web needs before an endpoint uses them are listed in
  `api/shared_models.py`. After changing `models/` or `api/`, run `export_openapi.py`
  and `pnpm --filter web generate`, and commit `openapi.json` and `apps/web/lib/engine/generated/`.
- **Logging**: only through `aftertalk.logging.log`, which accepts only
  `job_id`, `call_id`, `project_id`, `user_id`, `attempt`, `step`,
  `error_code`, `duration_ms`. Never log provider responses, transcript text
  or keys.
- **Providers**: settings and keys arrive in each job request (or, for the
  CLI, from the connections file); nothing is stored. Torch comes from the CPU-only index.
- **Extras**: the base install has no torch. `[server]` FastAPI, `[audio]`
  voice detection, `[pii]` name detection, `[anthropic]` and `[google]` LLM
  SDKs, `[local]` and `[youtube]` are placeholders for M2 and M7, `[all]`.
- **Spec**: `design_draft.md` and `decisions.json` in the private repo
  `aftertalk/aftertalk-spec`; engine items are 57-77.
