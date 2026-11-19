# Aftertalk

Self-hosted call analysis for support and contact-centre teams: upload a
recording, get a transcript with personal data redacted, a summary, a call
reason and a scorecard, with every quote located in the transcript.

Status: pre-release. The services start and answer health checks; no
features yet.

## Quickstart

> **No release yet.** The prebuilt images that `docker-compose.yml` uses are
> published with the first release. Until then, run from source with
> `docker-compose.dev.yml` (see Development below).

Once released:

```sh
cp .env.example .env   # replace every change-me
docker compose up -d
```

Open http://localhost:3000. You need Docker and nothing else: the web app
and the engine run from prebuilt images.

## Development

Needs Node 22 with corepack, Python 3.13 and uv, and Docker.

```sh
corepack enable && pnpm install
docker compose -f docker-compose.dev.yml up -d --build   # all services from source
pnpm --filter web test        # Jest, against the dev Postgres on 127.0.0.1:5433
uv run --project packages/engine pytest packages/engine
```

## Open source and commercial

Everything needed to process and review calls is here: upload, transcription,
redaction of personal data, summaries, call reasons, scorecards, users and
projects. The commercial version adds a public API, webhooks, phone-system
integrations and cross-call insights.

Self-hosting, provider and privacy guides will live in `docs/` (not written
yet).

## How it works: web and engine

Aftertalk is two services and a database. The rule that decides where code
goes: **web owns all state, the engine owns all audio and AI work.** The
engine has no database and keeps nothing it cannot rebuild.

```text
                 browser
                    │  HTTPS (Caddy or another proxy in front)
                    ▼
┌───────────────────────────────────────────┐
│ web  (Next.js, Node)                      │
│  • pages and server actions               │
│  • Better Auth (login, 2FA, sessions)     │
│  • Drizzle: the only DB reader and writer │
│  • tick every 10 s: stall check, dispatch │
│  • upload: streams audio to /data/audio   │
│  • /internal/jobs/:id/result, /progress   │
└──────┬──────────────▲──────────┬──────────┘
       │ SQL          │ result   │ POST /jobs (202)
       ▼              │ (HMAC)   ▼ POST /providers/test
┌──────────────┐   ┌──┴───────────────────┐
│ postgres     │   │ engine (FastAPI)     │───► speech, diarization and
│  auth, app   │   │ no DB; file cache    │     LLM providers (own keys)
└──────────────┘   └──────────┬───────────┘
                              │
        web ── rw ──►  volume /data  ◄── rw ── engine
                       audio/  cache/
```

### Web (`apps/web`, Next.js)

Everything a user sees and everything that is stored.

- **UI**: all pages, in Polish and English.
- **Accounts and access**: Better Auth (password, 2FA, sessions); organisations,
  projects, roles and the personal-data access level. Every server action
  and route checks access in `lib/access.ts`.
- **Database**: the only reader and writer of Postgres (Drizzle). Calls,
  transcripts, analyses, quotes, templates, taxonomies and the log of who
  opened original (unredacted) text or audio live here.
- **Uploads**: streams the audio file to `/data/audio/{call_id}` and hashes it.
- **Job queue**: a `jobs` table and an in-process timer that runs every
  10 seconds. It sends queued jobs to the engine (at most
  `ENGINE_MAX_CONCURRENT_JOBS` at once), marks jobs that stopped sending
  progress as stalled, retries failed attempts (3 attempts, waits of 1 and
  10 minutes), and once an hour deletes data past its retention period.
- **Providers**: organisation admins add provider connections in the UI.
  API keys are stored encrypted with `SECRETS_KEY`; web decrypts a key only
  to put it in a job request.
- **Results**: receives the engine's signed result callback, checks it, and
  writes the whole result in one transaction.

### Engine (`packages/engine`, Python)

Stateless processing: one job in, one result out. Python because the audio
and model libraries (PyAV, torch, Silero, GLiNER) live there.

- **API**: `POST /jobs` (signed; answers 202 and works in the background),
  `POST /providers/test`, `GET /healthz`.
- **Pipeline**: decode the audio → detect speech (Silero) → transcribe and
  separate speakers (the project's speech and diarization providers) → build
  turns → redact personal data (pattern rules plus the GLiNER name detector)
  → analyse with the project's LLM (summary, call reason, scorecard, action
  items) → find every quoted claim in the transcript.
- **Cache**: transcripts are cached on `/data/cache`, per organisation, so
  "Process again" does not pay for transcription twice.
- **Reporting**: posts progress every 30 seconds and the final result to
  web, signed with `ENGINE_CALLBACK_SECRET`. Provider keys arrive in each
  job request and are never stored or logged.

### The contract between them

The engine owns the HTTP contract: its OpenAPI schema is exported and web's
client is generated from it with Orval, so a mismatch fails CI. Both
services share the `/data` volume and run as UID 1000, so they must run on
the same host. Only web is published on a port; the engine and Postgres are
on the internal Docker network.

## Layout (monorepo)

```
apps/web/         Next.js app: UI, login, all database work, job queue
apps/web/ee/      Extension stubs the commercial fork replaces
packages/engine/  Python engine: stateless processing over HTTP
docker/           Dockerfiles and the Caddy example
docs/             Self-hosting, provider and privacy guides
samples/          Consented sample calls
tests/            End-to-end tests and fake providers
```

Commercial features live in a separate private repository that merges this
one. Code for them goes only under `apps/web/ee/` and `apps/web/app/(ee)/`.

## Security

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## License

AGPL-3.0. Outside pull requests are not accepted until a contributor licence
agreement is in place.
