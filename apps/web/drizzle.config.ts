import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: ['./lib/db/schema/auth.ts', './lib/db/schema/app.ts'],
  out: './lib/db/migrations',
  schemaFilter: ['auth', 'app'],
  dbCredentials: { url: process.env.DATABASE_URL! },
});
