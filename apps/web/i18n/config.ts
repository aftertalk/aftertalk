export const SUPPORTED_LOCALES = ['en', 'pl'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = 'en';

// Dates render in the signed-in user's zone (their account setting, mirrored into TIME_ZONE_COOKIE so
// every request knows it without a backend call), and in Warsaw time otherwise: the market is Polish and
// the backend buckets days in it. Either way the zone is fixed per request, so the server (Vercel = UTC)
// and the browser render the same text and a timestamp doesn't shift when the page hydrates.
export const APP_TIME_ZONE = 'Europe/Warsaw';
export const TIME_ZONE_COOKIE = 'NEXT_TZ';

export function isValidTimeZone(value: string | undefined): value is string {
  if (!value) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function isSupportedLocale(value: string | undefined): value is SupportedLocale {
  return !!value && SUPPORTED_LOCALES.includes(value as SupportedLocale);
}
