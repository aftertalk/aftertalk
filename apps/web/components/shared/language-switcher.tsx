'use client';

import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';

import type { SupportedLocale } from '@/i18n/config';

const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function useLocaleSwitch() {
  const locale = useLocale() as SupportedLocale;
  const router = useRouter();

  const setLocale = (next: SupportedLocale) => {
    document.cookie = `NEXT_LOCALE=${next}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax`;
    router.refresh();
  };

  return { locale, setLocale };
}
