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

/**
 * The best supported locale for an Accept-Language header ("pl-PL,pl;q=0.9,en;q=0.8"), or null.
 * Used when no NEXT_LOCALE cookie is set, so a Polish browser gets Polish without a switcher (#90).
 */
export function negotiateLocale(acceptLanguage: string | null | undefined): SupportedLocale | null {
  if (!acceptLanguage) return null;
  const ranked = acceptLanguage
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const weight = q ? Number(q.slice(2)) : 1;
      return { lang: tag.trim().toLowerCase().split('-')[0], weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((x) => x.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  return ranked.map((x) => x.lang).find(isSupportedLocale) ?? null;
}
