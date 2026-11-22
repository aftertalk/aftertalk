import { createHash, randomUUID } from 'node:crypto';

import { sql } from '@/lib/db/client';

// Failed sign-ins per account, independent of the client IP. Better Auth's own limit is per IP, and
// without a trusted proxy the IP comes from a header the client can forge, so this is the limit that
// holds against password guessing on one account. Only failures count; a successful sign-in or a
// password reset clears the count, so a user who knows their password is locked out only while
// someone keeps failing on their account (at most 10 wrong tries per 10 minutes). Shares Better
// Auth's rate_limit table; scripts/reset-owner.ts builds the same key.
export const SIGN_IN_WINDOW_SECONDS = 10 * 60;
export const SIGN_IN_MAX_FAILURES = 10;

export const signInKey = (email: string) =>
  `signin-email|${createHash('sha256').update(email.trim().toLowerCase()).digest('hex')}`;

/** True while the account has had too many failures in the current window. */
export async function isSignInBlocked(email: string, now = Date.now()): Promise<boolean> {
  const [row] = await sql<{ count: number; last_request: string }[]>`
    select count, last_request from auth.rate_limit where key = ${signInKey(email)}`;
  if (!row) return false;
  return Number(row.last_request) >= now - SIGN_IN_WINDOW_SECONDS * 1000 && row.count >= SIGN_IN_MAX_FAILURES;
}

/** Counts one failed sign-in. A window starts at the first failure and lasts SIGN_IN_WINDOW_SECONDS. */
export async function recordSignInFailure(email: string, now = Date.now()): Promise<void> {
  const windowStart = now - SIGN_IN_WINDOW_SECONDS * 1000;
  await sql`
    insert into auth.rate_limit (id, key, count, last_request)
    values (${randomUUID()}, ${signInKey(email)}, 1, ${now})
    on conflict (key) do update set
      count = case when auth.rate_limit.last_request < ${windowStart} then 1 else auth.rate_limit.count + 1 end,
      last_request = case when auth.rate_limit.last_request < ${windowStart} then ${now} else auth.rate_limit.last_request end`;
  // Old counters (one row per email ever tried) are swept now and then, so the table stays small.
  if (Math.random() < 0.02) {
    await sql`delete from auth.rate_limit where key like 'signin-email|%' and last_request < ${windowStart}`;
  }
}

export async function clearSignInFailures(email: string): Promise<void> {
  await sql`delete from auth.rate_limit where key = ${signInKey(email)}`;
}
