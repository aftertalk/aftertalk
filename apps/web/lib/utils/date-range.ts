import { endOfDay, startOfDay, startOfMonth, subDays, subMonths } from 'date-fns';

export interface DateRange {
  from: Date;
  to: Date;
}

export type DateRangePreset = 'allTime' | 'last7days' | 'last30days' | 'thisMonth' | 'last3months' | 'custom';

export const VALID_PRESETS: DateRangePreset[] = [
  'allTime',
  'last7days',
  'last30days',
  'thisMonth',
  'last3months',
  'custom',
];
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Whole days from now until the given ISO date, clamped to 0. */
export function daysUntil(isoDate: string): number {
  const diff = new Date(isoDate).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

export interface DateRangeInput {
  preset?: DateRangePreset;
  from?: string; // ISO 8601 date string (e.g., '2025-01-15')
  to?: string; // ISO 8601 date string (e.g., '2025-01-21')
}

/**
 * Calculate the previous period of equal length for trend comparison.
 * Example: If current is Jan 8-14 (7 days), previous is Jan 1-7.
 */
export function getPreviousPeriod(dateRange: DateRange): DateRange {
  // Period length includes both endpoints, so we add 1ms
  const periodLengthMs = dateRange.to.getTime() - dateRange.from.getTime() + 1;
  return {
    from: new Date(dateRange.from.getTime() - periodLengthMs),
    to: new Date(dateRange.from.getTime() - 1),
  };
}

/**
 * Calculate percentage change between two values.
 * Handles edge cases: 0→0 = 0%, 0→N = 100%, N→0 = -100%
 */
export function calculateTrend(current: number, previous: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) {
    return 0;
  }
  if (previous === 0) {
    return current === 0 ? 0 : 100;
  }
  const trend = ((current - previous) / previous) * 100;
  if (!Number.isFinite(trend)) {
    return 0;
  }
  return Math.round(trend);
}

/**
 * Get default date range (last 7 days) when none provided.
 * External callers should prefer resolveDateRange() for preset support.
 */
export function getDefaultDateRange(): DateRange {
  const now = new Date();
  return {
    from: startOfDay(subDays(now, 6)),
    to: endOfDay(now),
  };
}

/**
 * Resolve a DateRangeInput into a validated DateRange.
 * - No input / empty object / undefined preset defaults to 'last7days'.
 * - Preset values compute their range from the current timestamp.
 * - 'custom' requires both from and to ISO strings; throws otherwise.
 */
export function resolveDateRange(input?: DateRangeInput): DateRange {
  const preset = input?.preset ?? 'last7days';
  const now = new Date();

  let range: DateRange;

  switch (preset) {
    case 'allTime':
      // Returns early on purpose: the 1-year guard below exists to stop accidental huge
      // custom ranges, but "all time" is an explicit ask for everything.
      return { from: new Date(0), to: endOfDay(now) };
    case 'last7days':
      range = { from: startOfDay(subDays(now, 6)), to: endOfDay(now) };
      break;
    case 'last30days':
      range = { from: startOfDay(subDays(now, 29)), to: endOfDay(now) };
      break;
    case 'thisMonth':
      range = { from: startOfMonth(now), to: endOfDay(now) };
      break;
    case 'last3months':
      range = { from: startOfMonth(subMonths(now, 2)), to: endOfDay(now) };
      break;
    case 'custom': {
      if (!input?.from || !input?.to) {
        throw new Error('Custom date range requires both "from" and "to" dates');
      }
      const from = new Date(input.from);
      const to = new Date(input.to);
      if (isNaN(from.getTime())) {
        throw new Error('Invalid "from" date string');
      }
      if (isNaN(to.getTime())) {
        throw new Error('Invalid "to" date string');
      }
      range = { from: startOfDay(from), to: endOfDay(to) };
      break;
    }
    default: {
      const _exhaustive: never = preset;
      throw new Error(`Unknown date range preset: ${_exhaustive}`);
    }
  }

  validateDateRange(range);
  return range;
}

/**
 * Parse URL search params (range/from/to) into a validated DateRangeInput.
 * Falls back to 'last7days' for a missing/invalid preset or an incomplete/invalid custom range
 * (e.g. over the 1-year limit), so a bad URL can't throw inside a server component.
 */
export function buildDateRangeInput(params: { range?: string; from?: string; to?: string }): DateRangeInput {
  const { range, from, to } = params;
  const preset = range && VALID_PRESETS.includes(range as DateRangePreset) ? (range as DateRangePreset) : 'last7days';

  if (preset === 'custom') {
    const validFrom = from && ISO_DATE_RE.test(from) ? from : undefined;
    const validTo = to && ISO_DATE_RE.test(to) ? to : undefined;
    if (!validFrom || !validTo) return { preset: 'last7days' };
    const input: DateRangeInput = { preset: 'custom', from: validFrom, to: validTo };
    return isValidDateRangeInput(input) ? input : { preset: 'last7days' };
  }

  return { preset };
}

/** Whether resolveDateRange() accepts the input (e.g. a custom range within the 1-year limit). */
export function isValidDateRangeInput(input: DateRangeInput): boolean {
  try {
    resolveDateRange(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a DateRangeInput into ISO 8601 strings, ready for API calls.
 */
export function resolveDateRangeISO(input?: DateRangeInput): { from: string; to: string } {
  const { from, to } = resolveDateRange(input);
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * Validate a date range for use in queries.
 * Throws an error if the range is invalid.
 */
// Limit range to 1 year to prevent expensive queries
const MAX_RANGE_MS = 365 * 24 * 60 * 60 * 1000;

/** Cheap form of the 1-year check validateDateRange() applies to a custom range, for per-day UI checks. */
export function isWithinMaxRange(from: Date, to: Date): boolean {
  return endOfDay(to).getTime() - startOfDay(from).getTime() <= MAX_RANGE_MS;
}

export function validateDateRange(range: DateRange): void {
  if (!(range.from instanceof Date) || isNaN(range.from.getTime())) {
    throw new Error('Invalid "from" date');
  }
  if (!(range.to instanceof Date) || isNaN(range.to.getTime())) {
    throw new Error('Invalid "to" date');
  }
  if (range.from >= range.to) {
    throw new Error('"from" date must be before "to" date');
  }
  if (range.to.getTime() - range.from.getTime() > MAX_RANGE_MS) {
    throw new Error('Date range cannot exceed 1 year');
  }
}
