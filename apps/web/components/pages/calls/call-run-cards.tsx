'use client';

import { ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { useJobErrorSentence } from '@/components/pages/calls/call-status';
import { Surface } from '@/components/ui/surface';
import { i18n } from '@/i18n/constants';
import { getPiiAccessLog } from '@/lib/action/transcription';
import { useFormat } from '@/lib/format';
import type { PiiAccessLogEntry, Step } from '@/lib/types';
import { cn } from '@/lib/utils/cn';

// Two folded cards at the foot of the call page: what the last run did, step by step (item 54), and
// who opened the original text or audio (item 36a, organisation owners and admins only).

const SUMMARY =
  'flex cursor-pointer list-none items-center justify-between gap-4 rounded-2xl p-5 [&::-webkit-details-marker]:hidden';

const STEP_NAMES = i18n.calls.steps.names as Record<string, string>;

export function StepsCard({ steps }: { steps: Step[] }) {
  const t = useTranslations();
  const format = useFormat();
  const errorSentence = useJobErrorSentence();
  if (steps.length === 0) return null;

  const statusLabel: Record<Step['status'], string> = {
    completed: t(i18n.calls.steps.completed),
    failed: t(i18n.calls.steps.failed),
    skipped: t(i18n.calls.steps.skipped),
  };

  return (
    <Surface as="section" pad="none">
      <details className="group">
        <summary className={SUMMARY}>
          <span className="text-title text-foreground font-medium">{t(i18n.calls.steps.title)}</span>
          <ChevronDown className="text-muted-foreground h-4 w-4 transition-transform group-open:rotate-180" />
        </summary>
        <ul className="space-y-3 px-5 pb-5">
          {steps.map((step, i) => {
            const tokens = step.tokensIn + step.tokensOut;
            const meta = [
              step.cached ? t(i18n.calls.steps.cached) : format.clock(step.durationMs / 1000),
              tokens > 0 &&
                t(i18n.calls.steps.tokens, {
                  input: format.number(step.tokensIn),
                  output: format.number(step.tokensOut),
                }),
            ].filter(Boolean);
            return (
              <li key={i}>
                <div className="flex items-baseline justify-between gap-4">
                  {/* A step this version has no name for is shown by its code. */}
                  <span className="text-meta text-foreground min-w-0 truncate">
                    {step.name in STEP_NAMES ? t(STEP_NAMES[step.name]) : step.name}
                  </span>
                  <span
                    className={cn(
                      'text-meta shrink-0',
                      step.status === 'failed' ? 'text-negative' : 'text-muted-foreground'
                    )}
                  >
                    {statusLabel[step.status]}
                  </span>
                </div>
                <p className="text-meta text-muted-foreground tabular-nums">{meta.join(' · ')}</p>
                {step.status === 'failed' && (
                  <p className="text-meta text-negative mt-0.5">{errorSentence(step.errorCode)}</p>
                )}
              </li>
            );
          })}
        </ul>
      </details>
    </Surface>
  );
}

/** Loaded when opened, and again after this user turns on "Show original" (`version` changes). */
export function AccessLogCard({ projectId, callId, version }: { projectId: string; callId: string; version: number }) {
  const t = useTranslations();
  const format = useFormat();
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<PiiAccessLogEntry[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    getPiiAccessLog(projectId, callId)
      .then((result) => {
        if (!live) return;
        setFailed(!result.ok);
        if (result.ok) setEntries(result.data);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [open, projectId, callId, version]);

  return (
    <Surface as="section" pad="none">
      <details className="group" onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary className={SUMMARY}>
          <span className="text-title text-foreground font-medium">{t(i18n.calls.accessLog.title)}</span>
          <ChevronDown className="text-muted-foreground h-4 w-4 transition-transform group-open:rotate-180" />
        </summary>
        <div className="px-5 pb-5">
          <p className="text-meta text-muted-foreground mb-3">{t(i18n.calls.accessLog.description)}</p>
          {failed ? (
            <p className="text-meta text-negative">{t(i18n.calls.accessLog.loadFailed)}</p>
          ) : entries === null ? (
            <p className="text-meta text-muted-foreground">{t(i18n.common.loading)}</p>
          ) : entries.length === 0 ? (
            <p className="text-meta text-muted-foreground">{t(i18n.calls.accessLog.empty)}</p>
          ) : (
            <ul className="space-y-1.5">
              {entries.map((entry, i) => (
                <li key={i} className="flex items-baseline justify-between gap-4">
                  <span className="text-meta text-foreground min-w-0 truncate">
                    {entry.userName ?? t(i18n.calls.accessLog.deletedUser)}
                    <span className="text-muted-foreground">
                      {' · '}
                      {t(entry.kind === 'audio' ? i18n.calls.accessLog.audio : i18n.calls.accessLog.text)}
                    </span>
                  </span>
                  <span className="text-meta text-muted-foreground shrink-0 tabular-nums">
                    {format.dateTime(entry.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
    </Surface>
  );
}
