'use client';

import { AudioLines, SearchX } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { useCallsNavigation } from '@/components/pages/calls/calls-navigation';
import { callsSearchHref } from '@/components/pages/calls/calls-search';
import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { Surface } from '@/components/ui/surface';
import { i18n } from '@/i18n/constants';

export function CallsEmpty({ projectId }: { projectId: string }) {
  const t = useTranslations();

  return (
    <Surface pad="lg">
      <EmptyState
        icon={AudioLines}
        title={t(i18n.calls.empty.title)}
        description={t(i18n.calls.empty.description)}
        action={
          <Button asChild>
            <Link href={`/${projectId}/upload`}>{t(i18n.calls.empty.uploadButton)}</Link>
          </Button>
        }
      />
    </Surface>
  );
}

export function CallsNoResults({ projectId, q, baseParams }: { projectId: string; q: string; baseParams: string }) {
  const t = useTranslations();
  const { navigate } = useCallsNavigation();

  return (
    <Surface pad="lg">
      <EmptyState
        icon={SearchX}
        title={t(i18n.calls.search.noResults, { q })}
        description={t(i18n.calls.search.noResultsHint)}
        action={
          <Button variant="outline" onClick={() => navigate(callsSearchHref(projectId, baseParams, ''))}>
            {t(i18n.calls.search.clear)}
          </Button>
        }
      />
    </Surface>
  );
}
