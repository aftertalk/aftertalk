'use client';

import { format, subMonths } from 'date-fns';
import { Check, ChevronDown, ChevronLeft } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import type { DateRange } from 'react-day-picker';
import { enUS, pl } from 'react-day-picker/locale';

import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { i18n } from '@/i18n/constants';
import type { DateRangePreset } from '@/lib/utils/date-range';
import { buildDateRangeInput, isValidDateRangeInput, isWithinMaxRange } from '@/lib/utils/date-range';

const PRESETS: DateRangePreset[] = ['allTime', 'last7days', 'last30days', 'thisMonth', 'last3months', 'custom'];
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const STORAGE_KEY = 'aftertalk_date_range';

type StoredRange = { range: string; from?: string; to?: string };

function readStoredRange(storageKey: string): StoredRange | null {
  try {
    const stored = localStorage.getItem(storageKey);
    return stored ? (JSON.parse(stored) as StoredRange) : null;
  } catch {
    return null;
  }
}

function writeStoredRange(storageKey: string, data: StoredRange) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(data));
  } catch {
    // storage unavailable, ignore
  }
}

function parseDate(value: string | null): Date | undefined {
  if (!value || !ISO_DATE_RE.test(value)) return undefined;
  const date = new Date(value);
  return isNaN(date.getTime()) ? undefined : date;
}

const PRESET_KEYS: Record<DateRangePreset, string> = {
  allTime: i18n.dashboard.dateRange.presets.allTime,
  last7days: i18n.dashboard.dateRange.presets.last7days,
  last30days: i18n.dashboard.dateRange.presets.last30days,
  thisMonth: i18n.dashboard.dateRange.presets.thisMonth,
  last3months: i18n.dashboard.dateRange.presets.last3months,
  custom: i18n.dashboard.dateRange.presets.custom,
};

interface DashboardDateRangePickerProps {
  basePath?: string;
  defaultPreset?: DateRangePreset;
  /** Surfaces with different default ranges must not restore each other's last-used choice. */
  storageKey?: string;
}

export function DashboardDateRangePicker({
  basePath = '/home',
  defaultPreset = 'last7days',
  storageKey = STORAGE_KEY,
}: DashboardDateRangePickerProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useTranslations();
  const locale = useLocale();

  const currentRange = searchParams.get('range') as DateRangePreset | null;
  const currentFrom = searchParams.get('from');
  const currentTo = searchParams.get('to');

  // Mirror what the server applies: a custom range it rejects (over a year, malformed) falls back to
  // last 7 days there, so the button must say so too instead of showing dates that aren't in effect.
  const activePreset: DateRangePreset =
    currentRange && PRESETS.includes(currentRange)
      ? (buildDateRangeInput({ range: currentRange, from: currentFrom ?? undefined, to: currentTo ?? undefined })
          .preset ?? defaultPreset)
      : defaultPreset;

  const [customRange, setCustomRange] = useState<DateRange | undefined>(() => {
    const from = parseDate(currentFrom);
    return from ? { from, to: parseDate(currentTo) } : undefined;
  });
  const customFrom = customRange?.from;
  const customTo = customRange?.to;
  const tooLong = !!customFrom && !!customTo && !isWithinMaxRange(customFrom, customTo);
  const [open, setOpen] = useState(false);
  const [showCalendars, setShowCalendars] = useState(activePreset === 'custom');

  // Build a URLSearchParams that carries through any non-date params (e.g. ?project=)
  const baseParams = () => {
    const p = new URLSearchParams();
    searchParams.forEach((value, key) => {
      if (!['range', 'from', 'to', 'page'].includes(key)) p.set(key, value);
    });
    return p;
  };

  // Restore the last-used range when landing with no URL params
  useEffect(() => {
    if (currentRange) return;
    const stored = readStoredRange(storageKey);
    // A stale or tampered entry (unknown preset, range over the max) must not be pushed into the URL.
    if (
      !stored ||
      !PRESETS.includes(stored.range as DateRangePreset) ||
      !isValidDateRangeInput({ preset: stored.range as DateRangePreset, from: stored.from, to: stored.to })
    )
      return;
    const params = baseParams();
    params.set('range', stored.range);
    if (stored.from) params.set('from', stored.from);
    if (stored.to) params.set('to', stored.to);
    router.replace(`${basePath}?${params.toString()}`);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePresetClick = (preset: DateRangePreset) => {
    if (preset === 'custom') {
      setShowCalendars(true);
      return;
    }

    setOpen(false);
    writeStoredRange(storageKey, { range: preset });
    const params = baseParams();
    params.set('range', preset);
    router.push(`${basePath}?${params.toString()}`);
  };

  const handleCustomApply = () => {
    if (!customFrom || !customTo || tooLong) return;

    setOpen(false);
    const fromStr = format(customFrom, 'yyyy-MM-dd');
    const toStr = format(customTo, 'yyyy-MM-dd');
    writeStoredRange(storageKey, { range: 'custom', from: fromStr, to: toStr });
    const params = baseParams();
    params.set('range', 'custom');
    params.set('from', fromStr);
    params.set('to', toStr);
    router.push(`${basePath}?${params.toString()}`);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setShowCalendars(activePreset === 'custom');
    }
  };

  const displayValue =
    activePreset === 'custom' && currentFrom && currentTo
      ? `${format(parseDate(currentFrom)!, 'dd.MM.yy')} \u2013 ${format(parseDate(currentTo)!, 'dd.MM.yy')}`
      : t(PRESET_KEYS[activePreset]);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="w-auto max-w-[180px] min-w-0 justify-start gap-2">
          <span className="truncate">{displayValue}</span>
          <ChevronDown className="ml-auto h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent className="w-auto max-w-[calc(100vw-2rem)] p-0" align="end">
        {!showCalendars ? (
          <div className="flex flex-col gap-0 p-1">
            {PRESETS.map((preset) => (
              <button
                key={preset}
                onClick={() => handlePresetClick(preset)}
                className="hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none"
              >
                <Check className={`h-4 w-4 shrink-0 ${preset === activePreset ? 'opacity-100' : 'opacity-0'}`} />
                {t(PRESET_KEYS[preset])}
              </button>
            ))}
          </div>
        ) : (
          <>
            <Calendar
              mode="range"
              numberOfMonths={2}
              locale={locale === 'pl' ? pl : enUS}
              weekStartsOn={1}
              defaultMonth={subMonths(customRange?.to ?? new Date(), 1)}
              selected={customRange}
              onSelect={setCustomRange}
              disabled={{ after: new Date() }}
              className="p-4"
            />
            <div className="bg-background border-t p-4 pt-2">
              <div className="flex items-center justify-between gap-4">
                <button
                  onClick={() => setShowCalendars(false)}
                  className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-sm transition-colors"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  {t(i18n.onboarding.back)}
                </button>
                <span className={`text-meta ${tooLong ? 'text-negative' : 'text-muted-foreground'}`}>
                  {tooLong
                    ? t(i18n.dashboard.dateRange.customRange.tooLong)
                    : customFrom && customTo
                      ? `${format(customFrom, 'dd.MM.yy')} \u2013 ${format(customTo, 'dd.MM.yy')}`
                      : t(i18n.dashboard.dateRange.customRange.hint)}
                </span>
                <Button onClick={handleCustomApply} disabled={!customFrom || !customTo || tooLong} size="sm">
                  {t(i18n.dashboard.dateRange.customRange.apply)}
                </Button>
              </div>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
