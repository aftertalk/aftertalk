import { format, parseISO, startOfISOWeek, startOfMonth } from 'date-fns';

export type BucketUnit = 'day' | 'week' | 'month';

/**
 * How finely to plot a daily series. Day by day across months is noise, so past two months the
 * points become weeks and past half a year months: never more than about 30 points.
 */
export function bucketUnit(days: number): BucketUnit {
  return days > 180 ? 'month' : days > 60 ? 'week' : 'day';
}

/**
 * Groups daily rows (sorted by date, as the API returns them) into weeks or months, keyed by the
 * bucket's first day, and reduces each bucket to one value.
 */
export function toBuckets<T extends { date: string }>(rows: T[], unit: BucketUnit, reduce: (bucket: T[]) => number) {
  const start = unit === 'month' ? startOfMonth : unit === 'week' ? startOfISOWeek : (d: Date) => d;
  const buckets = new Map<string, T[]>();
  for (const row of rows) {
    const key = format(start(parseISO(row.date)), 'yyyy-MM-dd');
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }
  return [...buckets].map(([date, bucket]) => ({ date, value: reduce(bucket) }));
}
