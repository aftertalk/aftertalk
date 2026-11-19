import type { Config } from 'jest';
import postgres from 'postgres';

import { TEMPLATE_DB, TEST_DATABASE_URL, workerDbName } from './db-names';

// Builds the template database once, then one copy per worker.
// Migrations are applied to the template from phase 1 on (item 23).
export default async function globalSetup(globalConfig: Config & { maxWorkers: number }) {
  const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`drop database if exists ${TEMPLATE_DB} with (force)`);
    await admin.unsafe(`create database ${TEMPLATE_DB}`);
    for (let i = 1; i <= globalConfig.maxWorkers; i++) {
      const name = workerDbName(i);
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.unsafe(`create database ${name} template ${TEMPLATE_DB}`);
    }
  } finally {
    await admin.end();
  }
}
