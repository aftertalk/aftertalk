import { randomBytes, randomUUID } from 'node:crypto';

import { hashPassword } from 'better-auth/crypto';
import { and, eq, like, sql } from 'drizzle-orm';

import { env } from '@/env';
import type { Db } from '@/lib/db/client';
import { account, verification } from '@/lib/db/schema/auth';

// Password reset tokens in the shape Better Auth's /reset-password reads ("reset-password:<token>",
// value = user id). Written here instead of through requestPasswordReset so the token, the session
// cut-off and the notice land in one transaction, and earlier links for the user stop working.
// scripts/reset-owner.ts writes the same rows with plain SQL.

export const RESET_LINK_TTL_SECONDS = 60 * 60;

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** 32 alphanumeric characters (~190 bits), unbiased. */
export function newResetToken(length = 32): string {
  let out = '';
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < 248 && out.length < length) out += ALPHANUMERIC[b % 62];
    }
  }
  return out;
}

/** Replaces any open reset link of the user with a new one and returns its URL. */
export async function issueResetToken(tx: Tx, userId: string): Promise<string> {
  await tx
    .delete(verification)
    .where(and(eq(verification.value, userId), like(verification.identifier, 'reset-password:%')));
  const token = newResetToken();
  await tx.insert(verification).values({
    id: randomUUID(),
    identifier: `reset-password:${token}`,
    value: userId,
    expiresAt: sql`now() + make_interval(secs => ${RESET_LINK_TTL_SECONDS})`,
  });
  return new URL(`/reset-password?token=${token}`, env.PUBLIC_URL).toString();
}

/**
 * Replaces the user's password with a random one nobody knows, so after a reset only the link signs
 * them in: someone holding the old password cannot get in first and, say, enrol their own 2FA.
 */
export async function scramblePassword(tx: Tx, userId: string): Promise<void> {
  await tx
    .update(account)
    .set({ password: await hashPassword(randomBytes(32).toString('base64url')) })
    .where(and(eq(account.userId, userId), eq(account.providerId, 'credential')));
}
