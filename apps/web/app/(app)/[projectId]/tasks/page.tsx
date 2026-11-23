import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { parseTaskTab, TAB_STATUSES, type TaskTab } from '@/components/pages/dashboard/task-manager/task-tabs';
import { TasksPageClient } from '@/components/pages/dashboard/task-manager/tasks-page';
import { i18n } from '@/i18n/constants';
import { projectRoleAtLeast } from '@/lib/access';
import { listActionItems } from '@/lib/action/action-items';
import { getProject } from '@/lib/action/projects';
import { requireProjectPage } from '@/lib/page-access';
import type { ActionItemsPage } from '@/lib/types';
import { localizedPageMetadata } from '@/lib/utils/page-metadata';

export async function generateMetadata(): Promise<Metadata> {
  return localizedPageMetadata(i18n.meta.tasks);
}

const EMPTY_PAGE: ActionItemsPage = {
  items: [],
  totalCount: 0,
  pendingCount: 0,
  inProgressCount: 0,
  doneCount: 0,
  cancelledCount: 0,
  overdueCount: 0,
};

interface TasksPageProps {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ task?: string; tab?: string }>;
}

async function firstNonEmptyTab(projectId: string): Promise<TaskTab> {
  for (const tab of ['pending', 'in_progress'] as const) {
    const page = await listActionItems(projectId, { pageSize: 1, status: TAB_STATUSES[tab] }).catch(() => null);
    // On a failed lookup stay on the default tab; the page itself will show the error state.
    if (!page || page.totalCount > 0) return tab;
  }
  return 'all';
}

export default async function TasksPage({ params, searchParams }: TasksPageProps) {
  const [{ projectId }, { task, tab }] = await Promise.all([params, searchParams]);
  const { role } = await requireProjectPage(projectId);
  // A link to one task (from a call, the dashboard) may point at any status, so show it among all.
  if (task && !tab) redirect(`/${projectId}/tasks?tab=all&task=${encodeURIComponent(task)}`);
  // With no tab chosen, open on the first one that has something in it rather than an empty "Do zrobienia".
  if (!tab) {
    const firstWithTasks = await firstNonEmptyTab(projectId);
    if (firstWithTasks !== 'pending') redirect(`/${projectId}/tasks?tab=${firstWithTasks}`);
  }
  const statuses = TAB_STATUSES[parseTaskTab(tab)];

  const [initialData, project] = await Promise.all([
    listActionItems(projectId, { pageSize: 50, status: statuses.length ? statuses : undefined }).catch(
      () => EMPTY_PAGE
    ),
    getProject(projectId).catch(() => null),
  ]);

  return (
    <TasksPageClient
      projectId={projectId}
      projectName={project?.name}
      initialData={initialData}
      initialStatuses={statuses}
      canEdit={projectRoleAtLeast(role, 'EDITOR')}
    />
  );
}
