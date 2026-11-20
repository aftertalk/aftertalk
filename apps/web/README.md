# web

The Next.js half of Aftertalk: every page, login, access control, all database
work and the job queue. See the root README for the split between web and engine.

## Run, test, lint

From the repo root:

```sh
corepack enable && pnpm install
docker compose -f docker-compose.dev.yml up -d postgres   # Postgres on 127.0.0.1:5433
pnpm --filter web dev          # http://localhost:3000 (needs the env vars of .env.example)
pnpm --filter web test         # Jest; each worker gets its own copy of the test database
pnpm --filter web lint
pnpm --filter web typecheck
pnpm --filter web format       # prettier
```

## Layout

```
app/              routes (App Router); app/(ee)/ is reserved for the commercial fork
app/api/          route handlers (health now; upload, auth and internal job routes later)
components/ui/    shared UI components, copied from the cloud app unchanged
i18n/             next-intl config; constants.ts holds every message key
messages/         pl.json and en.json (Polish is the default)
ee/               extension stubs the commercial fork replaces; never edit them here
lib/db/           Postgres pool and Drizzle; schema and migrations from phase 1
lib/log.ts        JSON logs with a fixed set of fields
lib/format.ts     number, date and duration formatting in the app's language
env.ts            validated environment variables
test/             Jest database setup
```

## Rules

- **All database access goes through Drizzle in `lib/db/`.** The engine never
  touches Postgres.
- **Every server action and route checks access** with `lib/access.ts`
  (phase 1). The proxy only checks that a session cookie exists.
- **User-facing text** goes in both `messages/pl.json` and `messages/en.json`,
  referenced through `i18n/constants.ts`.
- **Logging** only through `lib/log.ts`; never log transcript text, provider
  responses or keys.
- **The engine client** in `lib/engine/generated/` is generated with Orval from
  `apps/engine/openapi.json` (`pnpm --filter web generate`, config in
  `orval.config.ts`); never edit it by hand. It includes the engine's provider
  connection, usage and transcript types. CI fails when it is out of date.
- **Commercial code** goes only in the private fork, under `ee/` and `app/(ee)/`.
