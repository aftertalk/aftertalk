'use client';

import { Download } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { DashboardDateRangePicker } from '@/components/pages/dashboard/dashboard-date-range-picker';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { i18n } from '@/i18n/constants';

interface CallsHeaderProps {
  projectId: string;
  projectName?: string;
  /** Project editors and above may export (the route checks again). */
  canExport: boolean;
}

export function CallsHeader({ projectId, projectName, canExport }: CallsHeaderProps) {
  const t = useTranslations();
  const searchParams = useSearchParams();

  // The export takes the filters of the list on screen: the date range and the search text.
  const exportQuery = new URLSearchParams();
  for (const key of ['range', 'from', 'to', 'q']) {
    const value = searchParams.get(key);
    if (value) exportQuery.set(key, value);
  }
  const query = exportQuery.toString();
  const exportHref = `/api/projects/${projectId}/export${query ? `?${query}` : ''}`;

  return (
    <PageHeader eyebrow={projectName} title={t(i18n.calls.header.title)} description={t(i18n.calls.header.description)}>
      <DashboardDateRangePicker
        basePath={`/${projectId}/calls`}
        defaultPreset="allTime"
        storageKey="aftertalk_date_range_calls"
      />
      {canExport && (
        <Button variant="outline" asChild>
          {/* A plain download link: the browser saves the JSON as it streams. */}
          <a href={exportHref} download title={t(i18n.calls.header.exportHint)}>
            <Download />
            {t(i18n.calls.header.export)}
          </a>
        </Button>
      )}
    </PageHeader>
  );
}
