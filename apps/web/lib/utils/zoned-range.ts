// Date ranges in the reader's time zone. "Last 7 days" means seven whole days as the reader's
// calendar has them, whatever zone the server runs in (the image runs in UTC): the overview counts
// calls per day in the reader's zone, so the range has to start and end on the same day lines.
import { type DateRange, type DateRangeInput, ISO_DATE_RE, validateDateRange } from './date-range';

const DAY = 24 * 60 * 60 * 1000;

/** Minutes the zone is ahead of UTC at that instant. */
function offsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
}

/** The calendar day (year, month 1-12, day) an instant falls on in the zone. */
export function zonedDay(instant: Date, timeZone: string): [number, number, number] {
  const shifted = new Date(instant.getTime() + offsetMinutes(instant, timeZone) * 60000);
  return [shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate()];
}

/** The instant a calendar day starts in the zone. Days may be out of range (0, 32): they roll over. */
export function zonedDayStart(year: number, month: number, day: number, timeZone: string): Date {
  const wall = Date.UTC(year, month - 1, day);
  // The offset at the guess, then once more at the result, which settles days when clocks change.
  let instant = new Date(wall - offsetMinutes(new Date(wall), timeZone) * 60000);
  instant = new Date(wall - offsetMinutes(instant, timeZone) * 60000);
  return instant;
}

/**
 * The same presets as resolveDateRange, with day lines in `timeZone`. No input means the last 7
 * days. Throws on a custom range that is missing, malformed, reversed or longer than a year.
 */
export function resolveDateRangeInZone(
  input: DateRangeInput | undefined,
  timeZone: string,
  now = new Date()
): DateRange {
  const preset = input?.preset ?? 'last7days';
  const [y, m, d] = zonedDay(now, timeZone);
  const endOfToday = new Date(zonedDayStart(y, m, d + 1, timeZone).getTime() - 1);
  const daysBack = (n: number) => zonedDayStart(y, m, d - n, timeZone);

  let range: DateRange;
  switch (preset) {
    case 'allTime':
      // An explicit ask for everything, so the one-year limit below does not apply.
      return { from: new Date(0), to: endOfToday };
    case 'last7days':
      range = { from: daysBack(6), to: endOfToday };
      break;
    case 'last30days':
      range = { from: daysBack(29), to: endOfToday };
      break;
    case 'thisMonth':
      range = { from: zonedDayStart(y, m, 1, timeZone), to: endOfToday };
      break;
    case 'last3months':
      range = { from: zonedDayStart(y, m - 2, 1, timeZone), to: endOfToday };
      break;
    case 'custom': {
      if (!input?.from || !input?.to || !ISO_DATE_RE.test(input.from) || !ISO_DATE_RE.test(input.to)) {
        throw new Error('Custom date range requires "from" and "to" as YYYY-MM-DD');
      }
      const [fy, fm, fd] = input.from.split('-').map(Number);
      const [ty, tm, td] = input.to.split('-').map(Number);
      range = {
        from: zonedDayStart(fy, fm, fd, timeZone),
        to: new Date(zonedDayStart(ty, tm, td + 1, timeZone).getTime() - 1),
      };
      break;
    }
    default:
      throw new Error('Unknown date range preset');
  }
  validateDateRange(range);
  return range;
}

/** Whole days in the range, for tests and for "how many points will the chart have". */
export const daysIn = (range: DateRange) => Math.round((range.to.getTime() + 1 - range.from.getTime()) / DAY);
