'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { SentimentBadge, stripExtension, useCallLabels } from '@/components/pages/calls/call-labels';
import { CallStatusBadge, CallStatusLine } from '@/components/pages/calls/call-status';
import { Surface, SurfaceHeader } from '@/components/ui/surface';
import { i18n } from '@/i18n/constants';
import { useFormat } from '@/lib/format';
import type { Call, CallSearchResult } from '@/lib/types';
import { cn } from '@/lib/utils/cn';

type CallRow = Call | CallSearchResult;

const COMPACT_LIMIT = 5;

interface CallsTableProps {
  calls: CallRow[];
  variant: 'compact' | 'full';
  title?: string;
  snippetMap?: Record<string, string>;
  projectId: string;
  /** The list's query string; the call page keeps it so "back" returns to this page of this list. */
  listQuery?: string;
}

export function CallsTable({ calls, variant, title, snippetMap, projectId, listQuery }: CallsTableProps) {
  const callHref = (id: string) => `/${projectId}/calls/${id}${listQuery ? `?${listQuery}` : ''}`;

  return variant === 'compact' ? (
    <CompactList calls={calls} title={title} projectId={projectId} callHref={callHref} />
  ) : (
    <FullList calls={calls} snippetMap={snippetMap} callHref={callHref} />
  );
}

const EYEBROW = 'text-muted-foreground font-mono text-xs tracking-[0.18em] uppercase';

// One template shared by the header row and every call row so the columns always line up.
const FULL_GRID = 'md:grid md:grid-cols-[minmax(0,1fr)_7rem_7.5rem_8.5rem] md:items-center md:gap-6';

// ─── Full list (Calls page) ─────────────────────────────────────────────────

interface FullListProps {
  calls: CallRow[];
  snippetMap?: Record<string, string>;
  callHref: (id: string) => string;
}

function FullList({ calls, snippetMap, callHref }: FullListProps) {
  const t = useTranslations();
  const labels = useCallLabels();
  const format = useFormat();
  // A call that never got a result has no known length.
  const callLength = (seconds: number) => (seconds > 0 ? format.clock(seconds) : null);

  return (
    <Surface pad="none" className="overflow-hidden">
      {/* Column header — desktop only; on mobile the columns collapse into each row's meta line */}
      <div className={cn('hidden px-5 pt-4 pb-3 whitespace-nowrap', FULL_GRID, EYEBROW)} aria-hidden>
        <span>{t(i18n.calls.table.call)}</span>
        <span>{t(i18n.calls.table.sentiment)}</span>
        <span>{t(i18n.calls.table.duration)}</span>
        <span className="text-right">{t(i18n.calls.table.date)}</span>
      </div>

      <ul className="divide-y divide-black/[0.05] dark:divide-white/[0.05]">
        {calls.map((call) => {
          const snippet = snippetMap?.[call.id];
          const { main, day } = labels.titleParts(call);
          const tasks =
            call.actionItemsCount > 0 ? t(i18n.calls.table.tasksCount, { count: call.actionItemsCount }) : null;
          // Untitled calls already carry the day in their title, so the mobile line gives the hour instead.
          const mobileMeta = day
            ? [labels.time(call.createdAt), callLength(call.durationS), tasks]
            : [labels.day(call.createdAt), callLength(call.durationS), call.primaryCategory, tasks];
          return (
            <li key={call.id}>
              <Link
                href={callHref(call.id)}
                className={cn(
                  'block px-5 py-3.5 transition-colors outline-none',
                  'hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.05]',
                  FULL_GRID
                )}
              >
                <div className="min-w-0">
                  <p className="text-body text-foreground truncate font-medium">
                    {main}
                    {/* The date column has it on desktop */}
                    {day && <span className="md:hidden"> · {day}</span>}
                  </p>

                  {/* Desktop meta: what the row can't fit in a column */}
                  <p className="text-meta text-muted-foreground mt-0.5 hidden min-w-0 items-center gap-1.5 md:flex">
                    <span className="truncate font-mono">{stripExtension(call.filename)}</span>
                    {call.title && call.primaryCategory && <Meta>{call.primaryCategory}</Meta>}
                    {tasks && <Meta>{tasks}</Meta>}
                  </p>

                  {/* Mobile meta: one line in place of the columns */}
                  <p className="text-meta text-muted-foreground mt-1 flex min-w-0 items-center gap-1.5 md:hidden">
                    {/* The word, not only a coloured dot: colour alone doesn't reach everyone. */}
                    {call.sentimentLevel && <SentimentBadge level={call.sentimentLevel} className="shrink-0" />}
                    <span className="truncate">{mobileMeta.filter(Boolean).join(' · ')}</span>
                  </p>

                  {/* Queued, processing, failed (with the reason) or a later run: a finished call adds nothing. */}
                  <CallStatusLine call={call} className="mt-1" />

                  {snippet && (
                    <p className="text-meta text-muted-foreground mt-1 line-clamp-1 [&_mark]:rounded-sm [&_mark]:bg-yellow-200 [&_mark]:px-0.5 dark:[&_mark]:bg-yellow-800">
                      <SearchSnippet snippet={snippet} />
                    </p>
                  )}
                </div>

                <div className="hidden md:block">
                  <SentimentBadge level={call.sentimentLevel} />
                </div>
                <span className="text-meta text-muted-foreground hidden tabular-nums md:block">
                  {callLength(call.durationS) ?? '—'}
                </span>
                <span className="text-meta text-muted-foreground hidden text-right whitespace-nowrap tabular-nums md:block">
                  {labels.when(call.createdAt)}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </Surface>
  );
}

function Meta({ children }: { children: React.ReactNode }) {
  return (
    <>
      <span className="text-muted-foreground/40" aria-hidden>
        ·
      </span>
      <span className="shrink-0 whitespace-nowrap">{children}</span>
    </>
  );
}

// ─── Compact list (dashboard, analytics widget) ─────────────────────────────

interface CompactListProps {
  calls: CallRow[];
  title?: string;
  projectId: string;
  callHref: (id: string) => string;
}

function CompactList({ calls, title, projectId, callHref }: CompactListProps) {
  const t = useTranslations();
  const labels = useCallLabels();
  const format = useFormat();
  // A call that never got a result has no known length.
  const callLength = (seconds: number) => (seconds > 0 ? format.clock(seconds) : null);
  const shown = calls.slice(0, COMPACT_LIMIT);

  return (
    <Surface pad="md">
      {title && <SurfaceHeader title={title} />}
      {shown.length === 0 ? (
        <p className="text-meta text-muted-foreground py-10 text-center">{t(i18n.calls.table.empty)}</p>
      ) : (
        <ul className="-mx-2">
          {shown.map((call) => (
            <li key={call.id}>
              <Link
                href={callHref(call.id)}
                className="hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.05] flex items-center gap-3 rounded-xl px-2 py-2.5 transition-colors outline-none"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-body text-foreground truncate font-medium">{labels.title(call)}</p>
                  <p className="text-meta text-muted-foreground truncate">
                    {[labels.when(call.createdAt), callLength(call.durationS)].filter(Boolean).join(' · ')}
                  </p>
                </div>
                {call.status === 'completed' ? (
                  <SentimentBadge level={call.sentimentLevel} className="shrink-0" />
                ) : (
                  <CallStatusBadge call={call} />
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {calls.length > COMPACT_LIMIT && (
        <Link
          href={`/${projectId}/calls`}
          className="text-meta text-muted-foreground hover:text-foreground mt-3 inline-block transition-colors"
        >
          {t(i18n.calls.table.viewAll)}
        </Link>
      )}
    </Surface>
  );
}

// The search marks its hit with <mark> but the transcript text around it is not escaped, so the
// snippet must never go through innerHTML. Render everything as text and rebuild only the marks.
function SearchSnippet({ snippet }: { snippet: string }) {
  return snippet
    .split(/(<mark>[\s\S]*?<\/mark>)/)
    .map((part, i) =>
      part.startsWith('<mark>') && part.endsWith('</mark>') ? <mark key={i}>{part.slice(6, -7)}</mark> : part
    );
}
