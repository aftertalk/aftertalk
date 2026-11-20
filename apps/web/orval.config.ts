import { defineConfig } from 'orval';

// The engine client, generated from the engine's OpenAPI schema: `pnpm --filter web generate`.
// CI fails when lib/engine/generated/ differs from what this writes.
export default defineConfig({
  engine: {
    input: { target: '../engine/openapi.json' },
    output: {
      mode: 'split',
      client: 'fetch',
      target: 'lib/engine/generated/client.ts',
      schemas: 'lib/engine/generated/model',
      clean: true,
    },
  },
});
