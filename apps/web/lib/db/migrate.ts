// Runs at container start, before the server (item 23). Uses Drizzle's runtime migrator, not
// drizzle-kit (a dev tool, absent from the image). Bundled to dist/migrate.js with esbuild so it runs
// without node_modules. Core migrations first, then the commercial fork's folder when it sets one;
// separate journal tables, so a fork migration older than the newest core one is never skipped.
import path from 'node:path';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

import ee from '../../ee/index';

export async function runMigrations(databaseUrl: string, migrationsDir: string, eeMigrationsDir?: string | null) {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await sql`create schema if not exists auth`;
    await sql`create schema if not exists app`;
    const db = drizzle(sql);
    await migrate(db, { migrationsFolder: migrationsDir, migrationsSchema: 'app', migrationsTable: '__migrations' });
    if (eeMigrationsDir) {
      await migrate(db, {
        migrationsFolder: eeMigrationsDir,
        migrationsSchema: 'app',
        migrationsTable: '__migrations_ee',
      });
    }
  } finally {
    await sql.end();
  }
}

// Paths: in the image migrate.js sits next to `migrations/` and `ee-migrations/`; in the repo the
// folders are lib/db/migrations and the fork's own.
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const here = process.env.MIGRATIONS_DIR ?? path.join(process.cwd(), 'lib/db/migrations');
  const eeDir = ee.migrationsFolder
    ? (process.env.EE_MIGRATIONS_DIR ?? path.join(process.cwd(), ee.migrationsFolder))
    : null;
  await runMigrations(url, here, eeDir);
  process.stdout.write(
    JSON.stringify({ ts: new Date().toISOString(), level: 'info', logger: 'migrate', msg: 'migrations applied' }) + '\n'
  );
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        logger: 'migrate',
        msg: 'migration failed',
        error_code: e?.code ?? e?.name,
      }) + '\n'
    );
    process.exit(1);
  });
}
