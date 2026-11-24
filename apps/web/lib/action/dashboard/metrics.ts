'use server';

import { sql } from 'drizzle-orm';

import { db } from '@/lib/db/client';
import type { DashboardMetrics } from '@/lib/types';
import type { DateRangeInput } from '@/lib/utils/date-range';
import { calculateTrend, getPreviousPeriod } from '@/lib/utils/date-range';

import { dashboardScope } from './range';

type Row = { calls: number; avg_ms: number | null; with_sentiment: number; positive: number };

async function period(projectId: string, from: string, to: string): Promise<Row> {
  const [row] = await db.execute<Row>(sql`
    select count(*)::int as calls,
           avg(c.duration_ms)::float as avg_ms,
           count(s.id)::int as with_sentiment,
           count(*) filter (
             where s.result #>> '{sentiment,overall_sentiment}' in ('positive', 'very_positive'))::int as positive
    from app.calls c
    left join app.analyses s on s.call_id = c.id and s.kind = 'summary' and s.status = 'completed'
    where c.project_id = ${projectId} and c.created_at >= ${from} and c.created_at <= ${to}`);
  return row;
}

export async function getDashboardMetrics(projectId: string, input?: DateRangeInput): Promise<DashboardMetrics> {
  const { from, to, range } = await dashboardScope(projectId, input);
  // "All time" has no period before it to compare with, and nor has a period before the first call:
  // growth from nothing is not "+100%". The page shows no chip for 0.
  const allTime = range.from.getTime() === 0;
  const previous = getPreviousPeriod(range);
  const [current, before, [pending]] = await Promise.all([
    period(projectId, from, to),
    allTime ? null : period(projectId, previous.from.toISOString(), previous.to.toISOString()),
    db.execute<{ n: number }>(sql`
      select count(*)::int as n
      from app.action_items ai join app.calls c on c.id = ai.call_id
      where ai.project_id = ${projectId} and ai.status = 'PENDING'
        and c.created_at >= ${from} and c.created_at <= ${to}`),
  ]);
  const seconds = (row: Row | null) => Math.round((row?.avg_ms ?? 0) / 1000);
  return {
    totalCalls: current.calls,
    totalCallsTrend: before?.calls ? calculateTrend(current.calls, before.calls) : 0,
    avgDurationSeconds: seconds(current),
    avgDurationTrend: before?.calls ? calculateTrend(seconds(current), seconds(before)) : 0,
    positiveSentimentPercent:
      current.with_sentiment > 0 ? Math.round((current.positive / current.with_sentiment) * 100) : 0,
    pendingActionItems: pending.n,
  };
}
