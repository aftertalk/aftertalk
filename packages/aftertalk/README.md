# aftertalk

The Python half of Aftertalk: one package that is a library, the `aftertalk`
command, and (with the `[server]` extra) the stateless HTTP engine the web app
calls. It has no database. Web sends a signed job (`POST /jobs`), the engine
reads the audio from the shared `/data` volume, runs the pipeline, and posts the
result back to web. See the root README for the split between web and engine.

## Install

```sh
pip install aftertalk               # library and CLI
pip install 'aftertalk[server]'     # + the HTTP server for web (FastAPI)
pip install 'aftertalk[audio]'      # + voice detection for two-channel calls (torch, Silero)
pip install 'aftertalk[pii]'        # + the name detector for redaction (GLiNER)
pip install 'aftertalk[all]'        # everything
```

`[local]` (faster-whisper) and `[youtube]` (yt-dlp) are declared and get
their packages in later milestones. Python 3.13 only: torch's TorchScript,
which Silero uses, is not supported on 3.14.

## Run, test, lint

From the repo root (every uv command uses `--project packages/aftertalk`):

```sh
uv sync --project packages/aftertalk --all-extras
uv run --project packages/aftertalk pytest packages/aftertalk
uv run --project packages/aftertalk ruff check packages/aftertalk
uv run --project packages/aftertalk ruff format packages/aftertalk

uv run --project packages/aftertalk aftertalk --version
# local server on :8000 (needs ENGINE_CALLBACK_SECRET)
ENGINE_CALLBACK_SECRET=dev uv run --project packages/aftertalk aftertalk serve
```

Or the whole stack: `docker compose -f docker-compose.dev.yml up -d --build`.

## Layout

```
src/aftertalk/
  cli.py        the `aftertalk` command (typer)
  api/          HTTP: app, job contract (OpenAPI), signing and callbacks
  pipeline/     step runner, transcript cache, turns
  steps/        audio, vad, transcribe, analyses/, quotes
  providers/    speech, diarization and LLM adapters
  pii/          pattern rules, name detector, redaction
  logging.py    JSON logs with a fixed set of fields
  settings.py   environment variables (pydantic-settings)
scripts/        export_openapi.py
tests/unit/     one test file per module
tests/contract/ the committed openapi.json must match the app
openapi.json    generated; web's client is built from it
```

Each folder's README says what goes in it and which spec items describe it.
The plan for the coworkers pivot (milestones M1-M9) is tracked as issues in
the private repo `aftertalk/aftertalk-spec`.

## Rules

- **Contract changes**: edit `api/contract.py`, run
  `uv run --project packages/aftertalk python packages/aftertalk/scripts/export_openapi.py`,
  commit `openapi.json` in the same PR. CI fails if they differ.
- **Logging**: only through `aftertalk.logging.log`, which accepts only
  `job_id`, `call_id`, `project_id`, `user_id`, `attempt`, `step`,
  `error_code`, `duration_ms`. Never log provider responses, transcript text
  or keys.
- **Providers**: settings and keys arrive in each job request; nothing is
  stored. Torch comes from the CPU-only index.
- **Heavy dependencies** (torch, GLiNER, Whisper) go in an extra, never in the
  base install; import them inside the module that needs them.
- **Spec**: `design_draft.md` and `decisions.json` in the private repo
  `aftertalk/aftertalk-spec`; engine items are 57-77.
