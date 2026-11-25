import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { CallsEmpty, CallsEmptyPeriod, CallsNoResults } from '@/components/pages/calls/calls-empty';
import { CallsHeader } from '@/components/pages/calls/calls-header';
import { CallsNavigation, CallsResults } from '@/components/pages/calls/calls-navigation';
import { CallsPagination } from '@/components/pages/calls/calls-pagination';
import { CallsSearch } from '@/components/pages/calls/calls-search';
import { CallsTable } from '@/components/shared/calls-table';
import { PageContainer } from '@/components/shared/page-container';
import { i18n } from '@/i18n/constants';
import { projectRoleAtLeast } from '@/lib/access';
import { getProject } from '@/lib/action/projects';
import { requireProjectPage } from '@/lib/page-access';
import { localizedPageMetadata } from '@/lib/utils/page-metadata';

import { type CallsSearchParams, fetchCallsPage, listQuery, parseCallsParams } from './list-params';

export async function generateMetadata(): Promise<Metadata> {
  return localizedPageMetadata(i18n.meta.calls);
}

interface CallsPageProps {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<CallsSearchParams>;
}

export default async function CallsPage({ params, searchParams }: CallsPageProps) {
  const [{ projectId }, searchParamsResolved] = await Promise.all([params, searchParams]);
  const { role } = await requireProjectPage(projectId);
  const list = parseCallsParams(searchParamsResolved);

  const [result, project] = await Promise.all([
    fetchCallsPage(projectId, list, list.page),
    getProject(projectId).catch(() => null),
  ]);

  // Redirect to last valid page if requested page exceeds available pages
  if (list.page > result.totalPages && result.totalPages > 0) {
    redirect(`/${projectId}/calls?${listQuery(list, result.totalPages)}`);
  }

  const baseParams = list.baseQuery.toString();

  return (
    <PageContainer>
      <CallsHeader projectId={projectId} projectName={project?.name} canExport={projectRoleAtLeast(role, 'EDITOR')} />
      <CallsNavigation>
        <div className="space-y-4">
          <CallsSearch projectId={projectId} initialQuery={list.q} baseParams={baseParams} />
          <CallsResults>
            {list.q && result.total === 0 ? (
              <CallsNoResults projectId={projectId} q={list.q} baseParams={baseParams} />
            ) : result.total > 0 ? (
              <>
                <CallsTable
                  calls={result.calls}
                  variant="full"
                  snippetMap={result.snippets}
                  projectId={projectId}
                  listQuery={listQuery(list, list.page)}
                />
                <CallsPagination
                  projectId={projectId}
                  currentPage={list.page}
                  totalPages={result.totalPages}
                  total={result.total}
                  pageSize={result.pageSize}
                  filterQuery={list.filterQuery.toString()}
                />
              </>
            ) : list.dateRange.preset !== 'allTime' ? (
              <CallsEmptyPeriod />
            ) : (
              <CallsEmpty projectId={projectId} />
            )}
          </CallsResults>
        </div>
      </CallsNavigation>
    </PageContainer>
  );
}
