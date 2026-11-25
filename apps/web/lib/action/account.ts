'use server';

import { eq } from 'drizzle-orm';
import { cookies } from 'next/headers';

import { isValidTimeZone, TIME_ZONE_COOKIE } from '@/i18n/config';
import { i18n } from '@/i18n/constants';
import { requireUser } from '@/lib/access';
import { db } from '@/lib/db/client';
import { user as userTable } from '@/lib/db/schema/auth';
import type { AccountDto } from '@/lib/types';

import { invalid, optionalText } from './helpers';
import { type ActionResult } from './result';
import { runAction } from './run';

// Profile only (item 35). Password, 2FA and sessions are Better Auth client calls in
// settings-security.tsx (item 47c); an email cannot be changed in the first release.

async function load(userId: string): Promise<AccountDto> {
  const [row] = await db.select().from(userTable).where(eq(userTable.id, userId));
  return {
    id: row.id,
    email: row.email,
    twoFactorEnabled: !!row.twoFactorEnabled,
    created: row.createdAt.toISOString(),
    updated: row.updatedAt.toISOString(),
    displayName: row.displayName ?? (row.name || undefined),
    timeZone: row.timeZone,
  };
}

export async function getAccount(): Promise<AccountDto> {
  const user = await requireUser();
  return load(user.id);
}

/** Saves the zone dates render in, and mirrors it into the cookie requests read it from (i18n/request.ts). */
export async function updateTimeZone(timeZone: string): Promise<ActionResult<AccountDto>> {
  return runAction(async () => {
    const user = await requireUser();
    if (typeof timeZone !== 'string' || timeZone.length > 64 || !isValidTimeZone(timeZone)) {
      await invalid(i18n.errors.invalidInput);
    }
    await db.update(userTable).set({ timeZone }).where(eq(userTable.id, user.id));
    (await cookies()).set(TIME_ZONE_COOKIE, timeZone, { path: '/', maxAge: 60 * 60 * 24 * 365, sameSite: 'lax' });
    return load(user.id);
  });
}

export async function updateDisplayName(displayName: string): Promise<ActionResult<AccountDto>> {
  return runAction(async () => {
    const user = await requireUser();
    const name = await optionalText(displayName, 80);
    await db.update(userTable).set({ displayName: name }).where(eq(userTable.id, user.id));
    return load(user.id);
  });
}
