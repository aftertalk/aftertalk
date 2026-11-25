'use client';

import { useCallback, useOptimistic, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';

import { deleteActionItem, listActionItems, updateActionItem } from '@/lib/action/action-items';
import type { ActionItem } from '@/lib/types';
import type { ActionItemPriority } from '@/lib/types';
import type { ActionItemsPage } from '@/lib/types';
import type { ActionItemStatus } from '@/lib/types';
import type { ListActionItemsParams } from '@/lib/types';
import type { ListActionItemsPriorityItem } from '@/lib/types';
import type { ListActionItemsSortBy as ActionItemSortBy } from '@/lib/types';
import type { ListActionItemsSortDir as ActionItemSortDir } from '@/lib/types';
import type { ListActionItemsStatusItem } from '@/lib/types';
import { backendMessage, unwrap } from '@/lib/utils/backend-error';

export type { ActionItem, ActionItemPriority, ActionItemSortBy, ActionItemSortDir, ActionItemStatus };

export interface TaskManagerFilters {
  search: string;
  statuses: ListActionItemsStatusItem[];
  priorities: ListActionItemsPriorityItem[];
  sortBy: ActionItemSortBy;
  sortDir: ActionItemSortDir;
}

const DEFAULT_FILTERS: TaskManagerFilters = {
  search: '',
  statuses: [],
  priorities: [],
  sortBy: 'CREATED_AT',
  sortDir: 'DESC',
};

export function useTaskManager(
  projectId: string,
  initialData: ActionItemsPage,
  initialStatuses: ListActionItemsStatusItem[] = []
) {
  const [page, setPage] = useState<ActionItemsPage>(initialData);
  const [filters, setFilters] = useState<TaskManagerFilters>({ ...DEFAULT_FILTERS, statuses: initialStatuses });
  const [currentPage, setCurrentPage] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [, startTransition] = useTransition();
  const reloadSeq = useRef(0);

  // A refused write comes back with the server's own sentence (no permission, a bad value); say it.
  // A request that failed on the way stays quiet here: the caller shows its own generic message.
  const notifyIfDenied = useCallback((e: unknown) => {
    const message = backendMessage(e);
    if (message) toast.error(message);
  }, []);

  const [optimisticItems, updateOptimistic] = useOptimistic(
    page.items,
    (items: ActionItem[], update: { id: string; patch: Partial<ActionItem> }) =>
      items.map((item) => (item.id === update.id ? { ...item, ...update.patch } : item))
  );

  const reload = useCallback(
    // `silent` refreshes in place (after an edit) instead of swapping the list for a skeleton.
    async (newFilters?: TaskManagerFilters, newPage?: number, silent = false) => {
      const f = newFilters ?? filters;
      const p = newPage ?? currentPage;
      const seq = ++reloadSeq.current;
      if (!silent) setIsLoading(true);
      try {
        const params: ListActionItemsParams = {
          status: f.statuses.length ? f.statuses : undefined,
          priority: f.priorities.length ? f.priorities : undefined,
          search: f.search || undefined,
          page: p,
          pageSize: 50,
          sortBy: f.sortBy,
          sortDir: f.sortDir,
        };
        const data = await listActionItems(projectId, params);
        if (seq !== reloadSeq.current) return;
        setPage(data);
        setCurrentPage(p);
      } catch {
        // keep showing current data on error
      } finally {
        if (seq === reloadSeq.current) setIsLoading(false);
      }
    },
    [projectId, filters, currentPage]
  );

  // Every write goes through one queue, so rapid edits of one task reach the server in order.
  const writeQueue = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = useCallback(<T>(task: () => Promise<T>): Promise<T> => {
    const result = writeQueue.current.then(task, task);
    writeQueue.current = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }, []);

  // Coalesce the post-write refetch: one reload after a burst of edits settles, not one per edit.
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleReload = useCallback(() => {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = null;
      reload(undefined, undefined, true);
    }, 300);
  }, [reload]);

  const applyFilters = useCallback(
    (newFilters: Partial<TaskManagerFilters>) => {
      const merged = { ...filters, ...newFilters };
      setFilters(merged);
      setCurrentPage(0);
      reload(merged, 0);
    },
    [filters, reload]
  );

  // The status tab is a view, not a filter, so clearing keeps it.
  const clearFilters = useCallback(() => {
    applyFilters({ search: DEFAULT_FILTERS.search, priorities: DEFAULT_FILTERS.priorities });
  }, [applyFilters]);

  const markStatus = useCallback(
    async (id: string, status: ActionItemStatus): Promise<{ ok: boolean; previousStatus?: ActionItemStatus }> => {
      const previousStatus = page.items.find((i) => i.id === id)?.status;
      const completedAt = status === 'DONE' ? new Date().toISOString() : undefined;
      const write = enqueue(async () =>
        unwrap(await updateActionItem(projectId, id, { status, clearNotes: false, clearDeadline: false }))
      );
      // useOptimistic only holds its value while the transition is pending, so the transition has to span the
      // write; committing the status to `page` at the end keeps it from flashing back before the reload lands.
      startTransition(async () => {
        updateOptimistic({ id, patch: { status, completedAt } });
        try {
          await write;
          startTransition(() => {
            setPage((prev) => ({
              ...prev,
              items: prev.items.map((item) => (item.id === id ? { ...item, status, completedAt } : item)),
            }));
          });
        } catch {
          // handled below; the optimistic value is dropped when the transition ends
        }
      });
      try {
        await write;
        scheduleReload();
        return { ok: true, previousStatus };
      } catch (e) {
        notifyIfDenied(e);
        scheduleReload();
        return { ok: false };
      }
    },
    [projectId, enqueue, scheduleReload, updateOptimistic, page.items, notifyIfDenied]
  );

  const updateItem = useCallback(
    async (id: string, patch: Parameters<typeof updateActionItem>[2]) => {
      try {
        await enqueue(async () => unwrap(await updateActionItem(projectId, id, patch)));
      } finally {
        // Also after a failure, so the list drops what the page showed ahead of the answer.
        scheduleReload();
      }
    },
    [projectId, enqueue, scheduleReload]
  );

  const removeItem = useCallback(
    async (id: string) => {
      try {
        await enqueue(async () => unwrap(await deleteActionItem(projectId, id)));
      } finally {
        scheduleReload();
      }
    },
    [projectId, enqueue, scheduleReload]
  );

  // Statuses are the page's tabs, not filters: an empty tab must not read as "nothing matches".
  const hasActiveFilters = filters.search !== '' || filters.priorities.length > 0;

  return {
    items: optimisticItems,
    stats: {
      pending: page.pendingCount,
      inProgress: page.inProgressCount,
      done: page.doneCount,
      cancelled: page.cancelledCount,
      overdue: page.overdueCount,
    },
    filters,
    currentPage,
    totalCount: page.totalCount,
    projectHasTasks: page.projectHasTasks,
    // Not tied to the status transition's pending state: that spans the write and would blank the list.
    isLoading,
    hasActiveFilters,
    applyFilters,
    clearFilters,
    markStatus,
    updateItem,
    removeItem,
    goToPage: (p: number) => reload(filters, p),
  };
}
