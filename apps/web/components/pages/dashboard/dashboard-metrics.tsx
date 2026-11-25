'use client';

import { ArrowDown, ArrowUp } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type MouseEvent, useId, useState } from 'react';

import { Surface } from '@/components/ui/surface';
import { i18n } from '@/i18n/constants';
import type { DashboardMetrics } from '@/lib/action/dashboard';
import { useFormat } from '@/lib/format';
import { cn } from '@/lib/utils/cn';

import { bucketUnit, toBuckets } from './charts/buckets';

interface DashboardMetricsCardsProps {
  metrics: DashboardMetrics;
  callVolume: { date: string; count: number }[];
  sentimentTrend: { date: string; positivePercent: number }[];
}

// Area sparkline along the bottom of a metric card; hovering reveals the value at that point.
// Neutral on purpose: the number above it is the point, the line only shows its shape.
function Sparkline({ values, format }: { values: number[]; format: (v: number) => string }) {
  const id = `spark-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [hover, setHover] = useState<number | null>(null);
  if (values.length < 2) return null;
  const W = 120;
  const H = 40;
  const pad = 2;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const step = (W - pad * 2) / (values.length - 1);
  const pts = values.map((v, i) => [pad + i * step, H - 4 - ((v - min) / range) * (H - 10)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ');
  const last = pts[pts.length - 1];
  const area = `${line} L${last[0]},${H} L${pts[0][0]},${H} Z`;

  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    setHover(Math.max(0, Math.min(values.length - 1, Math.round(frac * (values.length - 1)))));
  };
  const point = hover !== null ? { x: pts[hover][0], y: pts[hover][1], v: values[hover] } : null;

  return (
    <div
      className="text-foreground/30 absolute inset-x-0 bottom-0 h-10"
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      <div className="absolute inset-0 overflow-hidden rounded-b-2xl">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" preserveAspectRatio="none" aria-hidden>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="currentColor" stopOpacity="0.25" />
              <stop offset="1" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${id})`} />
          <path
            d={line}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
      {point && (
        <>
          <span
            className="bg-foreground ring-background absolute h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2"
            style={{ left: `${(point.x / W) * 100}%`, top: `${(point.y / H) * 100}%` }}
          />
          <span
            className="bg-foreground text-background pointer-events-none absolute -translate-x-1/2 -translate-y-[150%] rounded px-1.5 py-0.5 text-xs font-medium whitespace-nowrap tabular-nums"
            style={{ left: `${(point.x / W) * 100}%`, top: `${(point.y / H) * 100}%` }}
          >
            {format(point.v)}
          </span>
        </>
      )}
    </div>
  );
}

export function DashboardMetricsCards({ metrics, callVolume, sentimentTrend }: DashboardMetricsCardsProps) {
  const t = useTranslations();
  const format = useFormat();

  // Daily points over a long range are noise; both lines move to weekly or monthly buckets. Bucketed
  // sentiment is weighted by each day's call count, so a one-call day can't swing the week.
  const unit = bucketUnit(callVolume.length);
  const callsByDate = new Map(callVolume.map((d) => [d.date, d.count]));
  const callSpark = toBuckets(callVolume, unit, (b) => b.reduce((sum, d) => sum + d.count, 0)).map((b) => b.value);
  const sentimentSpark = toBuckets(sentimentTrend, unit, (b) => {
    const weights = b.map((d) => callsByDate.get(d.date) ?? 1);
    const total = weights.reduce((sum, w) => sum + w, 0);
    return b.reduce((sum, d, i) => sum + d.positivePercent * weights[i], 0) / total;
  }).map((b) => b.value);

  // Trends are the API's comparison with the previous period of the same length. It sends 0 both for
  // "no change" and for "nothing to compare with", so a zero shows no chip rather than a false claim.
  // With no calls an average or a share has no value at all: "—", not "0 s" or "0%", and no "↓100%".
  const hasCalls = metrics.totalCalls > 0;
  const cards = [
    {
      title: t(i18n.dashboard.metrics.totalCalls),
      value: format.integer(metrics.totalCalls),
      trend: hasCalls ? metrics.totalCallsTrend : null,
      spark: callSpark,
      sparkFormat: format.integer,
    },
    {
      title: t(i18n.dashboard.metrics.avgDuration),
      value: hasCalls ? format.clock(metrics.avgDurationSeconds) : '—',
      trend: hasCalls ? metrics.avgDurationTrend : null,
      spark: [] as number[],
      sparkFormat: format.integer,
    },
    {
      title: t(i18n.dashboard.metrics.positiveSentiment),
      value: hasCalls ? format.percent(metrics.positiveSentimentPercent) : '—',
      trend: null,
      spark: sentimentSpark,
      sparkFormat: format.percent,
    },
  ];

  return (
    // Two to a row on a phone (the third takes the whole row), so the stats don't fill the first screen.
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 [&>*:nth-child(3)]:col-span-2 sm:[&>*:nth-child(3)]:col-span-1">
      {cards.map((card) => (
        <Surface
          key={card.title}
          className={cn('relative min-h-28 overflow-hidden sm:min-h-36', card.spark.length >= 2 && 'pb-12')}
        >
          <p className="text-body text-muted-foreground line-clamp-2">{card.title}</p>
          <p className="text-metric text-foreground mt-2 tabular-nums">{card.value}</p>
          {card.trend !== null && Math.round(Math.abs(card.trend)) >= 1 && (
            <p className="text-meta text-muted-foreground mt-1.5 flex items-center gap-1">
              <span className="text-foreground/80 inline-flex items-center gap-0.5 font-medium tabular-nums">
                {card.trend > 0 ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" />}
                {format.percent(Math.abs(card.trend))}
              </span>
              {t(i18n.dashboard.metrics.vsPrevPeriod)}
            </p>
          )}
          <Sparkline values={card.spark} format={card.sparkFormat} />
        </Surface>
      ))}
    </div>
  );
}
