// Shared by the overview queries (item 34): the access check, the resolved date range and the zone
// days are counted in (the signed-in user's, as dates are shown).
import 'server-only';

import { requireProjectAccess } from '@/lib/access';
import { userTimeZone, zonedRange } from '@/lib/time-zone';
import type { DateRangeInput } from '@/lib/utils/date-range';

import { uuid } from '../helpers';

export async function dashboardScope(projectId: string, input?: DateRangeInput) {
  const { user } = await requireProjectAccess(uuid(projectId), 'VIEWER');
  const timeZone = await userTimeZone(user.id);
  // The range starts and ends on the same day lines the queries count by.
  const range = zonedRange(input, timeZone);
  return { from: range.from.toISOString(), to: range.to.toISOString(), range, timeZone };
}
