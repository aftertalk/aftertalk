<!-- Same content as CLAUDE.md, for tools that read AGENTS.md. Edit both together. -->
# Aftertalk: rules for AI assistants and contributors

Self-hosted call analysis. Monorepo with two projects:

- `apps/web/`: Next.js 16 (TypeScript, pnpm). UI, Better Auth, **the only code
  that reads or writes Postgres** (Drizzle), uploads, the job queue (a `jobs`
  table and a 10-second in-process tick). See `apps/web/README.md`.
- `apps/engine/`: Python 3.13 FastAPI (uv). **Stateless, no database.**
  Audio decoding, voice detection, transcription, diarization, redaction, LLM
  analysis, quote matching. See `apps/engine/README.md`.

They talk over signed HTTP (`POST /jobs` to the engine, result and progress
callbacks to web) and share the `/data` volume. The engine owns the contract:
`apps/engine/src/aftertalk/api/contract.py` → `apps/engine/openapi.json`
→ Orval client in `apps/web/lib/engine/`. Change all three in one PR.

## Spec

The design and the build plan are `design_draft.md` and `decisions.json`
in the private repo `aftertalk/aftertalk-spec` (clone it next to this one). The plan's numbered
items ("item 59") and decisions ("#36") are referenced in commits and PRs.
Read the relevant item before building it.

## Commands (run from the repo root)

```sh
pnpm install
pnpm --filter web lint && pnpm --filter web typecheck && pnpm --filter web test
pnpm --filter web format:check
uv run --project apps/engine ruff check apps/engine
uv run --project apps/engine ruff format --check apps/engine
uv run --project apps/engine pytest apps/engine
docker compose -f docker-compose.dev.yml up -d --build --wait   # all services
```

Web tests need the dev Postgres (`docker compose -f docker-compose.dev.yml up -d postgres`).

## Rules

- **Placement**: state and users in web; audio and AI in the engine. The engine
  never gets a database; web never processes audio.
- **Commercial code** lives in the private fork `aftertalk/aftertalk-ee`, only
  under `apps/web/ee/` and `apps/web/app/(ee)/`. In this repo the `ee/` stubs
  are never edited after they were created (CI checks it).
- **Logging**: only `apps/web/lib/log.ts` and `apps/engine/src/aftertalk/logging.py`,
  which accept a fixed set of fields. Never log transcript text, provider
  responses, keys or other personal data.
- **Provider keys** are stored encrypted in web and sent per job; the engine
  never stores them.
- **Name**: always "Aftertalk", never "AfterTalk".
- **Language**: English first, Polish second (spec #90). English is the UI
  default and the language of docs, examples and new copy; every new UI string
  also gets its Polish translation in `messages/pl.json`. The customers are
  Polish teams, so Polish stays fully supported.
- **Commits**: no `Co-Authored-By` lines for AI assistants, no "Generated with"
  footers in commits or PRs.
- **Merging**: work on a branch, open a PR. `main` is protected for everyone,
  admins included: CI green and one approval from the other maintainer (not
  the author, not the last pusher). An AI assistant never merges without an
  explicit yes.
- **Licence**: AGPL-3.0. No outside contributions until a CLA exists.
