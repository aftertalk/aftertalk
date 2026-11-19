# Aftertalk

Self-hosted call analysis for support and contact-centre teams: upload a
recording, get a transcript with personal data redacted, a summary, a call
reason and a scorecard, with every quote located in the transcript.

Status: pre-release. The services start and answer health checks; no
features yet.

## Quickstart

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

See `docs/` for self-hosting, providers and privacy.

## Layout (monorepo)

```
apps/web/         Next.js app: UI, login, all database work, job queue
packages/engine/  Python engine: stateless processing over HTTP
docker/           Dockerfiles and compose examples
docs/             Self-hosting and privacy docs
samples/          Consented sample calls
tests/            End-to-end tests and fake providers
```

Commercial features live in a separate private repository that merges this
one. Code for them goes only under `apps/web/ee/` and `apps/web/app/(ee)/`.

## License

AGPL-3.0. Outside pull requests are not accepted until a contributor licence
agreement is in place.
