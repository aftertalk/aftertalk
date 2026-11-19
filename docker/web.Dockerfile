# Web: Next.js standalone build, plus two bundled scripts that run without node_modules:
# migrate.js (runs before the server on every start, item 23) and reset-owner.js (operator recovery).
FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/web/ee/package.json apps/web/ee/package.json
RUN pnpm install --frozen-lockfile --filter web...
COPY apps/web apps/web
ENV SKIP_ENV_VALIDATION=1 NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter web build && pnpm --filter web build:migrate \
 # The commercial fork keeps its migrations in ee/migrations; core has none, so make it exist.
 && mkdir -p apps/web/ee/migrations

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 \
    MIGRATIONS_DIR=/app/migrations EE_MIGRATIONS_DIR=/app/ee-migrations
# The node image's "node" user is UID/GID 1000, the same as the engine's user.
COPY --from=build --chown=1000:1000 /repo/apps/web/.next/standalone ./
COPY --from=build --chown=1000:1000 /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=1000:1000 /repo/apps/web/dist/migrate.js /repo/apps/web/dist/reset-owner.js ./
COPY --from=build --chown=1000:1000 /repo/apps/web/lib/db/migrations ./migrations
COPY --from=build --chown=1000:1000 /repo/apps/web/ee/migrations ./ee-migrations
USER 1000:1000
EXPOSE 3000
CMD ["sh", "-c", "node migrate.js && exec node apps/web/server.js"]
