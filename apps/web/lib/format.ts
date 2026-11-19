import { useLocale, useTimeZone } from 'next-intl';
import { useMemo } from 'react';

import { APP_TIME_ZONE } from '@/i18n/config';

// Number, percent, duration, money and date formatting in the app's language (not the browser's).
// The one formatting module: components call useFormat(), server code createFormat(await getLocale(),
// await getTimeZone()). Avoid .toFixed / .toLocaleString in components: they give "3.0%" and "1.2 MB" in Polish UI.

export function createFormat(locale: string, timeZone: string = APP_TIME_ZONE) {
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const integer = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
  const signedPercent = new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 0,
    signDisplay: 'exceptZero',
  });
  const pln = new Intl.NumberFormat(locale, { style: 'currency', currency: 'PLN' });
  const hours = new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'hour',
    unitDisplay: 'short',
    maximumFractionDigits: 1,
  });
  const minutes = new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'minute',
    unitDisplay: 'short',
    maximumFractionDigits: 0,
  });
  const bytes = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });

  // Dates in the request's zone (the account's, else Warsaw), so the server and the browser render the
  // same text and a timestamp doesn't shift on hydration.
  const zoned = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone, ...options });
  const dayMonth = zoned({ day: 'numeric', month: 'short' });
  const dayMonthYear = zoned({ day: 'numeric', month: 'short', year: 'numeric' });
  const dayMonthTime = zoned({ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const dayMonthYearTime = zoned({
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const weekday = zoned({ weekday: 'short' });
  const time = zoned({ hour: '2-digit', minute: '2-digit' });
  const year = zoned({ year: 'numeric' });
  const thisYear = year.format(new Date());
  const isThisYear = (date: Date) => year.format(date) === thisYear;

  return {
    /** 1234.56 → "1 234,6" */
    number: (v: number) => number.format(v),
    integer: (v: number) => integer.format(Math.round(v)),
    compact: (v: number) => compact.format(v),
    /** Takes 0–100 (what the backend sends): 33.333 → "33%". */
    percent: (v: number) => percent.format(v / 100),
    /** Change in percent points, signed: 12 → "+12%". */
    delta: (v: number) => signedPercent.format(v / 100),
    /** 66.3 → "66,30 zł" */
    money: (v: number) => pln.format(v),
    /** Seconds → "2:15" (or "1:02:15"), for call lengths. */
    clock: (seconds: number) => {
      const s = Math.max(0, Math.round(seconds));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const r = String(s % 60).padStart(2, '0');
      return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
    },
    /** Seconds → "3 min" under an hour, "1,5 godz." above (allowances, usage). */
    audio: (seconds: number) => (seconds < 3600 ? minutes.format(seconds / 60) : hours.format(seconds / 3600)),
    fileSize: (b: number) =>
      b < 1024 * 1024 ? `${bytes.format(b / 1024)} KB` : `${bytes.format(b / (1024 * 1024))} MB`,
    /** "30 wrz" this year, "30 wrz 2025" otherwise. */
    date: (d: Date | string) => {
      const date = new Date(d);
      return (isThisYear(date) ? dayMonth : dayMonthYear).format(date);
    },
    /** "30 wrz, 23:41" this year, with the year otherwise. */
    dateTime: (d: Date | string) => {
      const date = new Date(d);
      return (isThisYear(date) ? dayMonthTime : dayMonthYearTime).format(date);
    },
    /** "30 wrz" whatever the year, for chart ticks where the axis already says when. */
    dayMonth: (d: Date | string) => dayMonth.format(new Date(d)),
    /** "pon." */
    weekday: (d: Date | string) => weekday.format(new Date(d)),
    /** "23:41" */
    time: (d: Date | string) => time.format(new Date(d)),
  };
}

export type Format = ReturnType<typeof createFormat>;

export function useFormat(): Format {
  const locale = useLocale();
  const timeZone = useTimeZone() ?? APP_TIME_ZONE;
  return useMemo(() => createFormat(locale, timeZone), [locale, timeZone]);
}
