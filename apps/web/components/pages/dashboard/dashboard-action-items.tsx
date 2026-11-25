'use client';

import { ListChecks } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { stripExtension, useCallLabels } from '@/components/pages/calls/call-labels';
import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { i18n } from '@/i18n/constants';
import type { DashboardActionItemsResult } from '@/lib/action/dashboard';
import { useFormat } from '@/lib/format';

interface DashboardActionItemsProps {
  data: DashboardActionItemsResult;
  projectId: string;
}

/** Open tasks body only: the page or grid cell around it owns the card and the title. */
export function DashboardActionItems({ data, projectId }: DashboardActionItemsProps) {
  const t = useTranslations();
  const callLabels = useCallLabels();
  const format = useFormat();

  // Nothing open in this period: the way forward is what got done.
  if (data.items.length === 0) {
    return (
      <EmptyState
        icon={ListChecks}
        title={t(i18n.dashboard.actionItems.empty)}
        action={
          <Button asChild variant="outline">
            <Link href={`/${projectId}/tasks?tab=done`}>{t(i18n.dashboard.actionItems.seeDone)}</Link>
          </Button>
        }
        className="h-full py-8"
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      {data.totalPending > 0 && (
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <p className="text-meta text-muted-foreground">
            <span className="text-foreground font-medium tabular-nums">{format.integer(data.totalPending)}</span>{' '}
            {t(i18n.dashboard.actionItems.openCountLabel, { count: data.totalPending })}
          </p>
          <Link
            href={`/${projectId}/tasks`}
            className="text-meta text-muted-foreground hover:text-foreground shrink-0 transition-colors"
          >
            {t(i18n.dashboard.actionItems.seeAll)}
          </Link>
        </div>
      )}
      <ul className="-mx-2 space-y-0.5">
        {data.items.slice(0, 3).map((item) => (
          <li key={item.id}>
            <Link
              href={`/${projectId}/tasks?task=${item.id}`}
              className="hover:bg-foreground/[0.04] flex gap-3 rounded-xl px-2 py-2.5 transition-colors"
            >
              <span className="border-foreground/30 mt-[0.45em] size-2 shrink-0 rounded-full border-[1.5px]" />
              <div className="min-w-0 flex-1">
                <p className="text-body text-foreground line-clamp-2 leading-snug">{item.description}</p>
                <p className="text-meta text-muted-foreground mt-1 truncate">
                  {stripExtension(item.callFilename)} · {callLabels.day(item.callDate)}
                </p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
