// The zone a signed-in user's dates are shown in (their account setting), for queries that count or
// filter by day.
import 'server-only';

import { eq } from 'drizzle-orm';

import { APP_TIME_ZONE, isValidTimeZone } from '@/i18n/config';
import { BackendError } from '@/lib/action/result';
import { db } from '@/lib/db/client';
import { user as userTable } from '@/lib/db/schema/auth';
import type { DateRange, DateRangeInput } from '@/lib/utils/date-range';
import { resolveDateRangeInZone } from '@/lib/utils/zoned-range';

export async function userTimeZone(userId: string): Promise<string> {
  const [row] = await db.select({ timeZone: userTable.timeZone }).from(userTable).where(eq(userTable.id, userId));
  return isValidTimeZone(row?.timeZone) ? row.timeZone : APP_TIME_ZONE;
}

/** A date range the browser sent, on the user's day lines; a bad one is a 400, not a crash. */
export function zonedRange(input: DateRangeInput | undefined, timeZone: string): DateRange {
  try {
    return resolveDateRangeInZone(input, timeZone);
  } catch {
    throw new BackendError(400, 'Invalid date range');
  }
}
