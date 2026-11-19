import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

import { APP_TIME_ZONE, DEFAULT_LOCALE, isSupportedLocale, isValidTimeZone, TIME_ZONE_COOKIE } from './config';

type Messages = Record<string, unknown>;

// The commercial fork's messages (ee/messages) are merged over core's, key by key.
function merge(base: Messages, over: Messages): Messages {
  const out: Messages = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const current = out[key];
    out[key] =
      value && typeof value === 'object' && current && typeof current === 'object'
        ? merge(current as Messages, value as Messages)
        : value;
  }
  return out;
}

export default getRequestConfig(async ({ locale: requestedLocale }) => {
  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get('NEXT_LOCALE')?.value;
  const cookieTimeZone = cookieStore.get(TIME_ZONE_COOKIE)?.value;
  const locale = isSupportedLocale(requestedLocale)
    ? requestedLocale
    : isSupportedLocale(cookieLocale)
      ? cookieLocale
      : DEFAULT_LOCALE;

  const core = (await import(`@/messages/${locale}.json`)).default as Messages;
  const ee = (await import(`@ee/messages/${locale}.json`)).default as Messages;

  return {
    locale,
    timeZone: isValidTimeZone(cookieTimeZone) ? cookieTimeZone : APP_TIME_ZONE,
    messages: merge(core, ee),
  };
});
