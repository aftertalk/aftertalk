# Web: Next.js standalone build. Phase 0 has no migrate step yet (item 6 adds it in phase 1).
FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/web/ee/package.json apps/web/ee/package.json
RUN pnpm install --frozen-lockfile --filter web...
COPY apps/web apps/web
ENV SKIP_ENV_VALIDATION=1 NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter web build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
# The node image's "node" user is UID/GID 1000, the same as the engine's user.
COPY --from=build --chown=1000:1000 /repo/apps/web/.next/standalone ./
COPY --from=build --chown=1000:1000 /repo/apps/web/.next/static ./apps/web/.next/static
USER 1000:1000
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
