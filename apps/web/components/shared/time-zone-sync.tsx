'use client';

import { useRouter } from 'next/navigation';
import { useTimeZone } from 'next-intl';
import { useEffect } from 'react';

import { TIME_ZONE_COOKIE } from '@/i18n/config';

// The account's zone lives in the backend; requests read it from a cookie so rendering needs no extra call.
// When they disagree (first visit, a change made on another device) the cookie is corrected and the page
// re-rendered once in the right zone.
export function TimeZoneSync({ timeZone }: { timeZone: string }) {
  const current = useTimeZone();
  const router = useRouter();

  useEffect(() => {
    if (timeZone === current) return;
    document.cookie = `${TIME_ZONE_COOKIE}=${encodeURIComponent(timeZone)}; path=/; max-age=${60 * 60 * 24 * 365}; SameSite=Lax`;
    router.refresh();
  }, [timeZone, current, router]);

  return null;
}
