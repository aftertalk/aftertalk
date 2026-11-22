import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { env } from '@/env';

import * as schema from './schema';

// One pool per process. Kept on globalThis so a development reload does not open a second one.
const g = globalThis as unknown as { __aftertalkSql?: postgres.Sql };

export const sql = (g.__aftertalkSql ??= postgres(env.DATABASE_URL, { max: 10, onnotice: () => {} }));
export const db = drizzle(sql, { schema });
export type Db = typeof db;
