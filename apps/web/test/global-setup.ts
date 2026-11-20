import path from 'node:path';

import type { Config } from 'jest';
import postgres from 'postgres';

import { runMigrations } from '../lib/db/migrate';
import { TEMPLATE_DB, TEST_DATABASE_URL, urlForDb, workerDbName } from './db-names';

// Builds the template database once, then one copy per worker.
export default async function globalSetup(globalConfig: Config & { maxWorkers: number }) {
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists ${TEMPLATE_DB} with (force)`);
    await admin.unsafe(`create database ${TEMPLATE_DB}`);
    await runMigrations(urlForDb(TEMPLATE_DB), path.join(__dirname, '../lib/db/migrations'));
    for (let i = 1; i <= globalConfig.maxWorkers; i++) {
      const name = workerDbName(i);
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.unsafe(`create database ${name} template ${TEMPLATE_DB}`);
    }
  } finally {
    await admin.end();
  }
}
