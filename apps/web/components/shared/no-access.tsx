'use client';

import { Lock } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { EmptyState } from '@/components/shared/empty-state';
import { PageContainer } from '@/components/shared/page-container';
import { Button } from '@/components/ui/button';
import { Surface } from '@/components/ui/surface';
import { i18n } from '@/i18n/constants';

/** Said in place, instead of quietly redirecting someone who opened a page their role can't see. */
export function OrgManagersOnly({ organizationId }: { organizationId: string }) {
  const t = useTranslations();
  return (
    <PageContainer>
      <Surface>
        <EmptyState
          icon={Lock}
          title={t(i18n.noAccess.title)}
          description={t(i18n.noAccess.orgManagersOnly)}
          action={
            <Button asChild variant="outline">
              <Link href={`/organization/${organizationId}`}>{t(i18n.noAccess.backToProjects)}</Link>
            </Button>
          }
          className="py-20"
        />
      </Surface>
    </PageContainer>
  );
}
