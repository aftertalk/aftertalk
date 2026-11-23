'use server';

import { sql } from 'drizzle-orm';

import { db } from '@/lib/db/client';
import type { CallVolume } from '@/lib/types';
import type { DateRangeInput } from '@/lib/utils/date-range';

import { dashboardScope } from './range';

/** Calls per day, in the time zone of the user, with a zero for each day without calls. */
export async function getDashboardCallVolume(projectId: string, input?: DateRangeInput): Promise<CallVolume> {
  const { from, to, timeZone } = await dashboardScope(projectId, input);
  const rows = await db.execute<{ date: string; count: number }>(sql`
    with days as (
      select (c.created_at at time zone ${timeZone})::date as day, count(*)::int as n
      from app.calls c
      where c.project_id = ${projectId} and c.created_at >= ${from} and c.created_at <= ${to}
      group by 1
    ), span as (
      -- From the first day with a call, so "all time" does not start in 1970.
      select greatest((${from}::timestamptz at time zone ${timeZone})::date, (select min(day) from days)) as first,
             (${to}::timestamptz at time zone ${timeZone})::date as last
    )
    select to_char(d::date, 'YYYY-MM-DD') as date, coalesce(days.n, 0) as count
    from span
    cross join lateral generate_series(span.first::timestamp, span.last::timestamp, interval '1 day') d
    left join days on days.day = d::date
    order by 1`);
  return { data: rows.map((r) => ({ date: r.date, count: r.count })), granularity: 'daily' };
}
