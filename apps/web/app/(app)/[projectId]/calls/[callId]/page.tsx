import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { CallDetailView } from '@/components/pages/calls/call-detail-view';
import type { TaskRow } from '@/components/pages/dashboard/calls/transcript-insights';
import { i18n } from '@/i18n/constants';
import { projectRoleAtLeast } from '@/lib/access';
import { listActionItems } from '@/lib/action/action-items';
import { getCallById } from '@/lib/action/transcription';
import { requireProjectPage } from '@/lib/page-access';
import { localizedPageMetadata } from '@/lib/utils/page-metadata';
import { isUuid } from '@/lib/utils/uuid';

import { type CallsSearchParams, getCallNeighbours, listQuery, parseCallsParams } from '../list-params';

export async function generateMetadata(): Promise<Metadata> {
  return localizedPageMetadata(i18n.meta.calls);
}

interface CallPageProps {
  params: Promise<{ projectId: string; callId: string }>;
  searchParams: Promise<CallsSearchParams>;
}

// /{projectId}/calls/{callId}?{list query}. The query is the list the call was opened from (range,
// dates, size, q, page): it is what "← Calls" returns to and what "3 of 41" counts in.
export default async function CallPage({ params, searchParams }: CallPageProps) {
  const [{ projectId, callId }, searchParamsResolved] = await Promise.all([params, searchParams]);
  const { role } = await requireProjectPage(projectId);
  // A hand-edited id: a 404 page, not the error screen.
  if (!isUuid(callId)) notFound();
  const list = parseCallsParams(searchParamsResolved);

  const [call, taskPage, neighbours] = await Promise.all([
    getCallById(projectId, callId),
    listActionItems(projectId, { transcriptId: callId, pageSize: 50 }).catch(() => null),
    getCallNeighbours(projectId, callId, list).catch(() => null),
  ]);

  // A deleted call, or one of another project.
  if (!call) notFound();

  // Tasks as the task list has them (live status, linkable); the copy on the call if that failed.
  const tasks: TaskRow[] = taskPage ? taskPage.items : (call.summary?.actionItems ?? []);

  const backQuery = listQuery(list, list.page);

  return (
    <CallDetailView
      // A new call is a new page: the "Show original" switch and the player start over.
      key={call.id}
      call={call}
      projectId={projectId}
      tasks={tasks}
      backHref={`/${projectId}/calls${backQuery ? `?${backQuery}` : ''}`}
      neighbours={neighbours}
      canConfigure={projectRoleAtLeast(role, 'ADMIN')}
    />
  );
}
