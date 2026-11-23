import { CalendarSearch, CloudUpload } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { DashboardActionItems } from '@/components/pages/dashboard/dashboard-action-items';
import { DashboardDateRangePicker } from '@/components/pages/dashboard/dashboard-date-range-picker';
import { DashboardMetricsCards } from '@/components/pages/dashboard/dashboard-metrics';
import { DashboardRecentCalls, RecentCallsLink } from '@/components/pages/dashboard/dashboard-recent-calls';
import { ProjectChecklist } from '@/components/pages/dashboard/project-checklist';
import { EmptyState } from '@/components/shared/empty-state';
import { PageContainer } from '@/components/shared/page-container';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Surface, SurfaceHeader } from '@/components/ui/surface';
import { i18n } from '@/i18n/constants';
import { projectRoleAtLeast } from '@/lib/access';
import {
  getDashboardActionItems,
  getDashboardCallVolume,
  getDashboardMetrics,
  getDashboardSentiment,
} from '@/lib/action/dashboard';
import { getProject } from '@/lib/action/projects';
import { getCallsFiltered } from '@/lib/action/transcription';
import { requireProjectPage } from '@/lib/page-access';
import { projectReadiness } from '@/lib/project-readiness';
import { buildDateRangeInput } from '@/lib/utils/date-range';
import { localizedPageMetadata } from '@/lib/utils/page-metadata';

export async function generateMetadata(): Promise<Metadata> {
  return localizedPageMetadata(i18n.meta.dashboard);
}

interface DashboardPageProps {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ range?: string; from?: string; to?: string }>;
}

export default async function DashboardPage({ params, searchParams }: DashboardPageProps) {
  const [{ projectId }, searchParamsResolved, t] = await Promise.all([params, searchParams, getTranslations()]);
  const { role } = await requireProjectPage(projectId);
  const dateRangeInput = buildDateRangeInput(searchParamsResolved);

  const [project, readiness] = await Promise.all([getProject(projectId), projectReadiness(projectId)]);
  // Missing settings, with a link to the page that fixes each (item 54a); nothing when all is set.
  const checklist = (
    <ProjectChecklist projectId={projectId} readiness={readiness} canConfigure={projectRoleAtLeast(role, 'ADMIN')} />
  );

  // The page says which project it covers rather than greeting anyone: the numbers below are the point,
  // and a name guessed from an email address read wrong. The organisation's legal name is left out; set
  // in capitals it reads mangled ("SP. Z O.O.").
  const header = (
    <PageHeader
      eyebrow={project.name}
      title={t(i18n.dashboard.header.overview)}
      description={t(i18n.dashboard.header.description)}
    >
      <DashboardDateRangePicker basePath={`/${projectId}/home`} />
    </PageHeader>
  );

  // No calls in the range: one panel with the next step instead of a grid of empty widgets. A project
  // with no calls at all is asked for its first upload; otherwise the range is just too narrow.
  const inRange = await getDashboardMetrics(projectId, dateRangeInput).catch(() => null);
  if (inRange?.totalCalls === 0) {
    const allTime = await getDashboardMetrics(projectId, { preset: 'allTime' }).catch(() => null);
    const firstUpload = !allTime?.totalCalls;
    return (
      <PageContainer>
        {header}
        {checklist}
        <Surface>
          <EmptyState
            className="min-h-[50vh]"
            icon={firstUpload ? CloudUpload : CalendarSearch}
            title={t(firstUpload ? i18n.dashboard.emptyRange.noCallsTitle : i18n.dashboard.emptyRange.noRangeTitle)}
            description={t(
              firstUpload ? i18n.dashboard.emptyRange.noCallsDescription : i18n.dashboard.emptyRange.noRangeDescription
            )}
            action={
              <Button asChild>
                <Link href={firstUpload ? `/${projectId}/upload` : `/${projectId}/home?range=allTime`}>
                  {t(firstUpload ? i18n.dashboard.emptyRange.upload : i18n.dashboard.emptyRange.showAll)}
                </Link>
              </Button>
            }
          />
        </Surface>
      </PageContainer>
    );
  }

  // Home is about what needs doing. Calls come in a larger page so the negative ones can be picked
  // out here.
  const [metrics, sentimentData, { data: calls }, callVolume, actionItems] = await Promise.all([
    getDashboardMetrics(projectId, dateRangeInput),
    getDashboardSentiment(projectId, dateRangeInput),
    getCallsFiltered(projectId, { page: 1, pageSize: 50, dateRange: dateRangeInput }),
    getDashboardCallVolume(projectId, dateRangeInput),
    getDashboardActionItems(projectId, dateRangeInput),
  ]);
  // The list has no sentiment filter, so this looks at the 50 newest calls in the range.
  const toReview = calls.filter((c) => c.sentimentLevel?.toLowerCase().endsWith('negative'));

  return (
    <PageContainer>
      {header}
      {checklist}

      <div className="space-y-4">
        {/* What changed: each number against the previous period of the same length. */}
        <DashboardMetricsCards metrics={metrics} callVolume={callVolume.data} sentimentTrend={sentimentData.trend} />

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Surface>
            <SurfaceHeader
              title={t(i18n.dashboard.toReview.title)}
              description={t(i18n.dashboard.toReview.description)}
              action={<RecentCallsLink projectId={projectId} />}
            />
            {/* The list only sees the newest calls, so "none in this period" is said only when the period's
                sentiment count agrees; otherwise the older ones are pointed to. */}
            <DashboardRecentCalls
              calls={toReview}
              projectId={projectId}
              emptyTitle={t(
                sentimentData.distribution.negative === 0
                  ? i18n.dashboard.toReview.empty
                  : i18n.dashboard.toReview.olderOnly
              )}
            />
          </Surface>
          <Surface>
            <SurfaceHeader title={t(i18n.dashboard.actionItems.title)} />
            <DashboardActionItems data={actionItems} projectId={projectId} />
          </Surface>
        </div>
      </div>
    </PageContainer>
  );
}
