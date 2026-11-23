'use client';

import { FileAudio } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { SentimentBadge, useCallLabels } from '@/components/pages/calls/call-labels';
import { CallStatusBadge, useCallStatusNote } from '@/components/pages/calls/call-status';
import { EmptyState } from '@/components/shared/empty-state';
import { i18n } from '@/i18n/constants';
import { useFormat } from '@/lib/format';
import type { Call } from '@/lib/types';

const LIMIT = 5;

interface DashboardRecentCallsProps {
  calls: Call[];
  projectId: string;
  /** What an empty list says, when it shows a subset of calls ("no negative calls"). */
  emptyTitle?: string;
}

/**
 * Recent calls body for the home page and the dashboard grid; the card, the title and the "all calls"
 * link belong to whatever wraps it. Rows read exactly like the calls list and open the call's page.
 */
export function DashboardRecentCalls({ calls, projectId, emptyTitle }: DashboardRecentCallsProps) {
  const t = useTranslations();
  const format = useFormat();
  const labels = useCallLabels();
  const statusNote = useCallStatusNote();

  if (calls.length === 0) {
    return <EmptyState icon={FileAudio} title={emptyTitle ?? t(i18n.calls.table.empty)} className="h-full py-8" />;
  }

  return (
    <ul className="-mx-2">
      {calls.slice(0, LIMIT).map((call) => (
        <li key={call.id}>
          <Link
            href={`/${projectId}/calls/${call.id}`}
            className="hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.05] flex items-center gap-3 rounded-xl px-2 py-2.5 transition-colors outline-none"
          >
            <div className="min-w-0 flex-1">
              <p className="text-body text-foreground truncate font-medium">{labels.titleParts(call).main}</p>
              <p className="text-meta text-muted-foreground truncate">
                {/* "Failed: {reason}" or the later-run note takes the place of the duration. */}
                {[labels.when(call.createdAt), statusNote(call) ?? format.clock(call.durationS)].join(' · ')}
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
  );
}

/** The "all calls" link for the header of a recent-calls panel. */
export function RecentCallsLink({ projectId }: { projectId: string }) {
  const t = useTranslations();
  return (
    <Link
      href={`/${projectId}/calls`}
      className="text-meta text-muted-foreground hover:text-foreground whitespace-nowrap transition-colors"
    >
      {t(i18n.calls.table.viewAll)}
    </Link>
  );
}
