// Shared by the overview queries (item 34): the access check, the resolved date range and the zone
// days are counted in (the signed-in user's, as dates are shown).
import 'server-only';

import { eq } from 'drizzle-orm';

import { isValidTimeZone } from '@/i18n/config';
import { requireProjectAccess } from '@/lib/access';
import { db } from '@/lib/db/client';
import { user as userTable } from '@/lib/db/schema/auth';
import type { DateRangeInput } from '@/lib/utils/date-range';
import { resolveDateRange } from '@/lib/utils/date-range';

import { uuid } from '../helpers';

export async function dashboardScope(projectId: string, input?: DateRangeInput) {
  const { user } = await requireProjectAccess(uuid(projectId), 'VIEWER');
  const range = resolveDateRange(input);
  const [row] = await db.select({ timeZone: userTable.timeZone }).from(userTable).where(eq(userTable.id, user.id));
  const timeZone = isValidTimeZone(row?.timeZone) ? row.timeZone : 'Europe/Warsaw';
  return { from: range.from.toISOString(), to: range.to.toISOString(), range, timeZone };
}
