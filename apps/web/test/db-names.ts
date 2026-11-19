// Every Jest worker gets its own copy of one migrated template database,
// because the `auth` and `app` schema names are fixed.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://aftertalk:aftertalk@127.0.0.1:5433/postgres';

export const TEMPLATE_DB = 'aftertalk_test_template';

export function workerDbName(workerId: string | number) {
  return `aftertalk_test_${workerId}`;
}

export function urlForDb(name: string) {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}
