import { randomBytes, timingSafeEqual } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { db } from '@/lib/db/client';
import { user } from '@/lib/db/schema/auth';

// The first-run token (#76): printed to the web log at start while no user exists, a new one on
// each start. Kept on globalThis so a development reload keeps the same one.
const g = globalThis as unknown as { __aftertalk?: { setupToken?: string | null } };
const state = (g.__aftertalk ??= {});

export async function hasAnyUser(): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(user)
    .limit(1);
  return (row?.n ?? 0) > 0;
}

/** Makes sure a token exists while no user does, logs it, and returns it (null once a user exists). */
export async function ensureSetupToken(): Promise<string | null> {
  if (await hasAnyUser()) {
    state.setupToken = null;
    return null;
  }
  if (!state.setupToken) state.setupToken = randomBytes(18).toString('base64url');
  // The token is meant for the operator's eyes in the log; it is not personal data.
  process.stdout.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      logger: 'web',
      msg: `No user exists yet. Open /setup and enter this setup token: ${state.setupToken}`,
    }) + '\n'
  );
  return state.setupToken;
}

export function checkSetupToken(candidate: unknown): boolean {
  const expected = state.setupToken;
  if (!expected || typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate.trim());
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function clearSetupToken(): void {
  state.setupToken = null;
}
