'use client';

import { SearchX } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { EmptyState } from '@/components/shared/empty-state';
import { PageContainer } from '@/components/shared/page-container';
import { Button } from '@/components/ui/button';
import { i18n } from '@/i18n/constants';

/** "Not found" inside the app shell, so a dead link keeps the sidebar instead of dropping to the marketing 404. */
export function InAppNotFound({ projectId }: { projectId: string }) {
  const t = useTranslations();
  return (
    <PageContainer>
      <EmptyState
        icon={SearchX}
        title={t(i18n.appNotFound.title)}
        description={t(i18n.appNotFound.description)}
        action={
          <Button asChild variant="outline">
            <Link href={`/${projectId}/calls`}>{t(i18n.appNotFound.back)}</Link>
          </Button>
        }
        className="py-24"
      />
    </PageContainer>
  );
}
