'use server';

import { sql } from 'drizzle-orm';

import { db } from '@/lib/db/client';
import type { SentimentOverview } from '@/lib/types';
import type { DateRangeInput } from '@/lib/utils/date-range';

import { dashboardScope } from './range';

type Row = {
  date: string;
  positive: number;
  neutral: number;
  negative: number;
  unknown: number;
  confidence: number | null;
};

/** Sentiment of the calls in the range that have a stored result; "very" levels count with their side. */
export async function getDashboardSentiment(projectId: string, input?: DateRangeInput): Promise<SentimentOverview> {
  const { from, to, timeZone } = await dashboardScope(projectId, input);
  const rows = await db.execute<Row>(sql`
    select to_char((c.created_at at time zone ${timeZone})::date, 'YYYY-MM-DD') as date,
           count(*) filter (where lvl in ('positive', 'very_positive'))::int as positive,
           count(*) filter (where lvl = 'neutral')::int as neutral,
           count(*) filter (where lvl in ('negative', 'very_negative'))::int as negative,
           count(*) filter (
             where lvl is null or lvl not in ('positive', 'very_positive', 'neutral', 'negative', 'very_negative')
           )::int as unknown,
           sum((s.result #>> '{sentiment,confidence}')::float) filter (
             where jsonb_typeof(s.result #> '{sentiment,confidence}') = 'number') as confidence
    from app.calls c
    left join app.analyses s on s.call_id = c.id and s.kind = 'summary' and s.status = 'completed'
    left join lateral (select s.result #>> '{sentiment,overall_sentiment}' as lvl) l on true
    where c.project_id = ${projectId} and c.status <> 'pending'
      and c.created_at >= ${from} and c.created_at <= ${to}
    group by 1
    order by 1`);
  const sum = (key: 'positive' | 'neutral' | 'negative' | 'unknown') => rows.reduce((n, r) => n + r[key], 0);
  const distribution = {
    positive: sum('positive'),
    neutral: sum('neutral'),
    negative: sum('negative'),
    unknown: sum('unknown'),
    total: 0,
  };
  distribution.total = distribution.positive + distribution.neutral + distribution.negative + distribution.unknown;
  const known = distribution.total - distribution.unknown;
  const percent = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) : 0);
  return {
    distribution,
    trend: rows
      .filter((r) => r.positive + r.neutral + r.negative > 0)
      .map((r) => {
        const day = r.positive + r.neutral + r.negative;
        return {
          date: r.date,
          positivePercent: percent(r.positive, day),
          neutralPercent: percent(r.neutral, day),
          negativePercent: percent(r.negative, day),
        };
      }),
    averageConfidence: known > 0 ? rows.reduce((n, r) => n + (r.confidence ?? 0), 0) / known : 0,
  };
}
