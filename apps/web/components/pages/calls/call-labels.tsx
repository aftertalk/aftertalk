'use client';

import { useTranslations } from 'next-intl';
import { useMemo } from 'react';

import { i18n } from '@/i18n/constants';
import { useFormat } from '@/lib/format';
import { sentimentLabel } from '@/lib/utils/analysis-labels';
import { cn } from '@/lib/utils/cn';

/** "sprzedaz_retencja_50.wav" → "sprzedaz_retencja_50": the extension says nothing about the call. */
export function stripExtension(filename: string): string {
  return filename.replace(/\.[^./\\]+$/, '');
}

/**
 * How a call is named and dated across the list and the call page. A call is named by its title, or
 * by what it was about and when ("Retencja · 30 wrz"), never by its filename. Dates carry the year
 * only when it isn't this one, in the reader's time zone (useFormat), so server and browser agree.
 */
export function useCallLabels() {
  const t = useTranslations();
  const f = useFormat();

  return useMemo(() => {
    const day = (d: string) => f.date(d);
    const when = (d: string) => f.dateTime(d);
    const time = (d: string) => f.time(d);
    /** The title in two parts, so a list that shows the date in its own column can leave `day` out. */
    const titleParts = (call: { title?: string | null; primaryCategory?: string; createdAt: string }) =>
      call.title
        ? { main: call.title, day: null }
        : { main: call.primaryCategory || t(i18n.calls.table.call), day: day(call.createdAt) };
    const title = (call: { title?: string | null; primaryCategory?: string; createdAt: string }) => {
      const parts = titleParts(call);
      return parts.day ? `${parts.main} · ${parts.day}` : parts.main;
    };
    return { day, when, time, title, titleParts };
  }, [t, f]);
}

type Tone = 'positive' | 'negative' | 'neutral';

function sentimentTone(level: string): Tone {
  const normalized = level.toLowerCase();
  if (normalized.endsWith('positive')) return 'positive';
  if (normalized.endsWith('negative')) return 'negative';
  return 'neutral';
}

const BADGE_TONES: Record<Tone, string> = {
  positive: 'bg-positive/10 text-positive-ink',
  negative: 'bg-negative/10 text-negative-ink',
  neutral: 'bg-foreground/[0.06] text-foreground/70',
};

const DOT_TONES: Record<Tone, string> = {
  positive: 'bg-positive',
  negative: 'bg-negative',
  neutral: 'bg-neutral-tone',
};

export function SentimentBadge({ level, className }: { level?: string | null; className?: string }) {
  const t = useTranslations();
  if (!level) return <span className="text-meta text-muted-foreground/60">—</span>;

  return (
    <span
      className={cn(
        'text-meta inline-flex items-center rounded-full px-2 py-0.5 whitespace-nowrap',
        BADGE_TONES[sentimentTone(level)],
        className
      )}
    >
      {sentimentLabel(level, t)}
    </span>
  );
}

export function SentimentDot({ level }: { level?: string | null }) {
  const t = useTranslations();
  if (!level) return null;
  return (
    <span
      className={cn('h-2 w-2 shrink-0 rounded-full', DOT_TONES[sentimentTone(level)])}
      role="img"
      aria-label={sentimentLabel(level, t)}
    />
  );
}
