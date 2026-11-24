'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Eye,
  ListChecks,
  Search,
  SearchX,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';

import { EmptyState } from '@/components/shared/empty-state';
import { PageContainer } from '@/components/shared/page-container';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { ConfirmModal } from '@/components/ui/confirm-modal';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Surface } from '@/components/ui/surface';
import { TAB_LIST_CLASS, TAB_TRIGGER_CLASS } from '@/components/ui/tabs';
import { i18n } from '@/i18n/constants';
import type {
  ActionItem,
  ActionItemPriority,
  ActionItemsPage,
  ActionItemStatus,
  ListActionItemsPriorityItem,
  ListActionItemsSortBy,
  ListActionItemsSortDir,
} from '@/lib/types';
import { backendMessage } from '@/lib/utils/backend-error';
import { cn } from '@/lib/utils/cn';

import { TaskDetail } from './task-detail';
import { TaskRow } from './task-row';
import { parseTaskTab, TAB_STATUSES, TASK_TABS, type TaskTab } from './task-tabs';
import { useTaskManager } from './use-task-manager';

const PAGE_SIZE = 50;

const TAB_LABEL_KEYS: Record<TaskTab, string> = {
  pending: i18n.dashboard.taskManager.status.pending,
  in_progress: i18n.dashboard.taskManager.status.inProgress,
  done: i18n.dashboard.taskManager.status.done,
  cancelled: i18n.dashboard.taskManager.status.cancelled,
  all: i18n.dashboard.taskManager.tabAll,
};

const SORT_OPTIONS: {
  value: string;
  sortBy: ListActionItemsSortBy;
  sortDir: ListActionItemsSortDir;
  labelKey: string;
}[] = [
  { value: 'CREATED_AT_DESC', sortBy: 'CREATED_AT', sortDir: 'DESC', labelKey: i18n.dashboard.taskManager.sortNewest },
  { value: 'CALL_DATE_DESC', sortBy: 'CALL_DATE', sortDir: 'DESC', labelKey: i18n.dashboard.taskManager.sortCallDate },
  { value: 'PRIORITY_DESC', sortBy: 'PRIORITY', sortDir: 'DESC', labelKey: i18n.dashboard.taskManager.sortPriority },
  { value: 'STATUS_ASC', sortBy: 'STATUS', sortDir: 'ASC', labelKey: i18n.dashboard.taskManager.sortStatus },
];

const PRIORITY_OPTIONS: { value: string; priorities: ListActionItemsPriorityItem[]; labelKey: string }[] = [
  { value: 'ALL', priorities: [], labelKey: i18n.dashboard.taskManager.priorityAll },
  { value: 'HIGH', priorities: ['HIGH'], labelKey: i18n.dashboard.taskManager.priority.high },
  { value: 'MEDIUM', priorities: ['MEDIUM'], labelKey: i18n.dashboard.taskManager.priority.medium },
  { value: 'LOW', priorities: ['LOW'], labelKey: i18n.dashboard.taskManager.priority.low },
];

const STATUS_LABEL_KEYS: Record<ActionItemStatus, string> = {
  PENDING: i18n.dashboard.taskManager.status.pending,
  IN_PROGRESS: i18n.dashboard.taskManager.status.inProgress,
  DONE: i18n.dashboard.taskManager.status.done,
  CANCELLED: i18n.dashboard.taskManager.status.cancelled,
};

const FIELD = 'h-9 border-black/[0.06] bg-white text-sm dark:border-white/8 dark:bg-white/[0.035]';

// The two-pane layout starts at lg. The server renders as desktop; React re-renders with the real value.
const DESKTOP_QUERY = '(min-width: 1024px)';
function subscribeDesktop(onChange: () => void) {
  const mql = window.matchMedia(DESKTOP_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}
const isDesktopNow = () => window.matchMedia(DESKTOP_QUERY).matches;

interface TasksPageProps {
  projectId: string;
  projectName?: string;
  initialData: ActionItemsPage;
  initialStatuses: ActionItemStatus[];
  canEdit: boolean;
}

export function TasksPageClient({ projectId, projectName, initialData, initialStatuses, canEdit }: TasksPageProps) {
  const t = useTranslations();
  const tm = useTaskManager(projectId, initialData, initialStatuses);
  const searchParams = useSearchParams();
  const activeTab = parseTaskTab(searchParams.get('tab'));
  // The opened task lives in the URL (?task=…), so links can point at a task and, on mobile, the
  // phone's back button closes the sheet instead of leaving the page.
  const taskParam = searchParams.get('task');
  const [searchValue, setSearchValue] = useState('');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [selectedItem, setSelectedItem] = useState<ActionItem | null>(null);
  // Whether the open task got its own history entry (mobile), so closing can step back over it.
  const pushedTask = useRef(false);
  // The row to hand focus back to when the mobile sheet closes.
  const lastOpenedId = useRef<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const isDesktop = useSyncExternalStore(subscribeDesktop, isDesktopNow, () => true);

  // Debounced server-side search
  useEffect(() => {
    if (searchValue === tm.filters.search) return;
    const handle = setTimeout(() => tm.applyFilters({ search: searchValue }), 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchValue]);

  // The URL (?tab=…) is the status tab's source of truth: the tab buttons write it, and back/forward
  // or an old link land here too.
  useEffect(() => {
    const next = TAB_STATUSES[activeTab];
    const cur = tm.filters.statuses;
    if (cur.length === next.length && cur.every((s, i) => s === next[i])) return;
    tm.applyFilters({ statuses: next });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  const selectTab = (tab: TaskTab) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', tab);
    params.delete('task');
    // Native history updates sync with useSearchParams without a server round trip.
    window.history.replaceState(null, '', `?${params.toString()}`);
    pushedTask.current = false;
    setSelectedItem(null);
  };

  // Native history updates sync with useSearchParams without a server round trip.
  const setTaskParam = (id: string | null, mode: 'push' | 'replace') => {
    const params = new URLSearchParams(window.location.search);
    // Keep the tab explicit: the server sends a tab-less ?task= link to "Wszystkie".
    params.set('tab', activeTab);
    if (id) params.set('task', id);
    else params.delete('task');
    const url = `?${params.toString()}`;
    if (mode === 'push') window.history.pushState(null, '', url);
    else window.history.replaceState(null, '', url);
  };

  const closeTask = () => {
    if (pushedTask.current && taskParam) {
      pushedTask.current = false;
      window.history.back();
    } else {
      setTaskParam(null, 'replace');
    }
  };

  const tabCounts: Record<TaskTab, number> = {
    pending: tm.stats.pending,
    in_progress: tm.stats.inProgress,
    done: tm.stats.done,
    cancelled: tm.stats.cancelled,
    all: tm.totalCount,
  };

  const currentSortValue = `${tm.filters.sortBy}_${tm.filters.sortDir}`;
  const currentPriorityValue = tm.filters.priorities.length === 1 ? tm.filters.priorities[0] : 'ALL';
  // Passed to SelectValue explicitly: Radix leaves it empty after a full page load until the first re-render.
  const sortOption = SORT_OPTIONS.find((o) => o.value === currentSortValue) ?? SORT_OPTIONS[0];
  const priorityOption = PRIORITY_OPTIONS.find((o) => o.value === currentPriorityValue) ?? PRIORITY_OPTIONS[0];

  // The backend's counts are per status, not per search, so the tab's count is the pager's upper bound.
  const listTotal = tabCounts[activeTab];
  const showPagination = listTotal > PAGE_SIZE && (tm.currentPage > 0 || tm.items.length === PAGE_SIZE);
  const rangeFrom = tm.currentPage * PAGE_SIZE + 1;
  const rangeTo = tm.currentPage * PAGE_SIZE + tm.items.length;
  const canGoPrev = tm.currentPage > 0;
  const canGoNext = tm.items.length === PAGE_SIZE && (tm.currentPage + 1) * PAGE_SIZE < listTotal;

  const visibleItems = overdueOnly ? tm.items.filter((i) => i.isOverdue) : tm.items;
  const isFiltering = tm.hasActiveFilters || overdueOnly;
  const projectHasNoTasks = tm.totalCount === 0;

  // The detail pane is driven by its own copy of the opened task — set when opened and patched on
  // every edit — so it stays open and current even when a status change filters the task out of the
  // list. With nothing opened, desktop shows the first task rather than an empty pane.
  const explicit = taskParam
    ? selectedItem?.id === taskParam
      ? selectedItem
      : (tm.items.find((i) => i.id === taskParam) ?? null)
    : null;
  // While a tab loads, the old list's first task would be stale, so the pane waits for the new list.
  const selected = explicit ?? (tm.isLoading ? null : visibleItems[0]) ?? null;

  const patchSelected = (patch: Partial<ActionItem>) => {
    if (!selected) return;
    // Editing the auto-shown first task opens it for real, so it stays put if it leaves the list.
    if (selected.id !== taskParam) setTaskParam(selected.id, 'replace');
    setSelectedItem({ ...selected, ...patch });
  };

  const handleSetStatus = async (id: string, status: ActionItemStatus) => {
    setSelectedItem((cur) => (cur && cur.id === id ? { ...cur, status } : cur));
    const result = await tm.markStatus(id, status);
    if (!result.ok) {
      toast.error(t(i18n.dashboard.taskManager.updateFailed));
    } else if (result.previousStatus && result.previousStatus !== status) {
      const prev = result.previousStatus;
      toast(t(i18n.dashboard.taskManager.statusUpdated, { status: t(STATUS_LABEL_KEYS[status]) }), {
        action: {
          label: t(i18n.dashboard.taskManager.undo),
          onClick: () => {
            setSelectedItem((cur) => (cur && cur.id === id ? { ...cur, status: prev } : cur));
            tm.markStatus(id, prev);
          },
        },
      });
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    if (deleteId === selected?.id) {
      setSelectedItem(null);
      closeTask();
    }
    try {
      await tm.removeItem(deleteId);
    } catch (e) {
      toast.error(backendMessage(e) ?? t(i18n.dashboard.taskManager.updateFailed));
    } finally {
      setDeleteId(null);
    }
  };

  const openTask = (task: ActionItem) => {
    setSelectedItem(task);
    lastOpenedId.current = task.id;
    if (task.id === taskParam) return;
    // Desktop just swaps the pane, so it replaces; on mobile the sheet is a step that back can undo.
    pushedTask.current = !isDesktop;
    setTaskParam(task.id, isDesktop ? 'replace' : 'push');
  };

  const clearFilters = () => {
    setSearchValue('');
    setOverdueOnly(false);
    tm.clearFilters();
  };

  const renderEmpty = () => {
    if (projectHasNoTasks) {
      return (
        <EmptyState
          icon={ListChecks}
          title={t(i18n.dashboard.taskManager.noItems)}
          description={t(i18n.dashboard.taskManager.emptyDescription)}
          action={
            canEdit && (
              <Button asChild>
                <Link href={`/${projectId}/upload`}>{t(i18n.dashboard.taskManager.uploadCall)}</Link>
              </Button>
            )
          }
        />
      );
    }
    if (isFiltering) {
      return (
        <EmptyState
          icon={SearchX}
          title={t(i18n.dashboard.taskManager.noMatch)}
          action={
            <Button variant="outline" onClick={clearFilters}>
              {t(i18n.dashboard.taskManager.clearFilters)}
            </Button>
          }
        />
      );
    }
    const statusText = t(i18n.dashboard.taskManager.emptyStatus, { status: t(TAB_LABEL_KEYS[activeTab]) });
    const nothingOpen = tm.stats.pending + tm.stats.inProgress === 0;
    if ((activeTab === 'pending' || activeTab === 'in_progress') && nothingOpen) {
      return (
        <EmptyState
          icon={CheckCircle2}
          title={t(i18n.dashboard.taskManager.allDone)}
          description={statusText}
          action={
            tm.stats.done > 0 && (
              <Button variant="outline" onClick={() => selectTab('done')}>
                {t(i18n.dashboard.taskManager.showDone, { count: tm.stats.done })}
              </Button>
            )
          }
        />
      );
    }
    return <EmptyState icon={ListChecks} title={statusText} />;
  };

  const detail = selected && (
    <TaskDetail
      key={selected.id}
      item={selected}
      projectId={projectId}
      canEdit={canEdit}
      onSetStatus={(status) => {
        patchSelected({ status });
        handleSetStatus(selected.id, status);
      }}
      onSetPriority={(priority: ActionItemPriority) => {
        patchSelected({ priority });
        tm.updateItem(selected.id, { priority, clearNotes: false, clearDeadline: false }).catch((e) =>
          toast.error(backendMessage(e) ?? t(i18n.dashboard.taskManager.updateFailed))
        );
      }}
      onSaveNotes={(notes) => {
        patchSelected({ notes: notes || undefined });
        return tm.updateItem(selected.id, {
          notes: notes || undefined,
          clearNotes: notes === '',
          clearDeadline: false,
        });
      }}
      onDelete={() => setDeleteId(selected.id)}
      onBack={closeTask}
    />
  );

  return (
    <PageContainer>
      <PageHeader
        eyebrow={projectName}
        title={t(i18n.navbar.tasks)}
        description={t(i18n.dashboard.taskManager.description)}
      >
        {!projectHasNoTasks && (
          <div className="flex gap-8">
            <Stat value={tm.stats.pending + tm.stats.inProgress} label={t(i18n.dashboard.taskManager.statOpen)} />
            {/* Deadlines are the caller's words, not dates, so this is 0 until something sets a date: no
                permanent "0 overdue" beside the open count. */}
            {tm.stats.overdue > 0 && (
              <Stat value={tm.stats.overdue} label={t(i18n.dashboard.taskManager.overdue)} alert />
            )}
          </div>
        )}
      </PageHeader>

      {!canEdit && (
        <Surface tone="muted" pad="none" className="flex items-center gap-2.5 px-4 py-3">
          <Eye className="text-muted-foreground size-4 shrink-0" aria-hidden />
          <p className="text-meta text-muted-foreground">{t(i18n.dashboard.taskManager.viewOnlyBanner)}</p>
        </Surface>
      )}

      {projectHasNoTasks ? (
        <Surface>{renderEmpty()}</Surface>
      ) : (
        <div className="space-y-4">
          {/* Toolbar: status tabs, then search / sort / priority */}
          {/* Wraps as two groups: when both don't fit on one line, the controls drop below the tabs together. */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* Five statuses don't fit a phone's width as tabs (the last ones were cut off), so there it's a picker. */}
            <Select value={activeTab} onValueChange={(v) => selectTab(v as TaskTab)}>
              <SelectTrigger className="w-full sm:hidden" aria-label={t(i18n.dashboard.taskManager.statusLabel)}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TASK_TABS.map((tab) => (
                  <SelectItem key={tab} value={tab}>
                    {t(TAB_LABEL_KEYS[tab])} · {tabCounts[tab]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div
              role="group"
              aria-label={t(i18n.dashboard.taskManager.statusLabel)}
              className={cn(TAB_LIST_CLASS, 'hidden w-full sm:flex')}
            >
              {TASK_TABS.map((tab) => {
                const active = tab === activeTab;
                return (
                  <button
                    key={tab}
                    type="button"
                    aria-pressed={active}
                    data-state={active ? 'active' : 'inactive'}
                    onClick={() => selectTab(tab)}
                    className={TAB_TRIGGER_CLASS}
                  >
                    {t(TAB_LABEL_KEYS[tab])}
                    <span className="text-muted-foreground tabular-nums">{tabCounts[tab]}</span>
                  </button>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-full sm:w-60">
                <Search className="text-muted-foreground absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2" />
                <Input
                  type="search"
                  aria-label={t(i18n.dashboard.taskManager.searchPlaceholder)}
                  placeholder={t(i18n.dashboard.taskManager.searchPlaceholder)}
                  value={searchValue}
                  onChange={(e) => setSearchValue(e.target.value)}
                  className={cn(FIELD, 'pl-8')}
                />
                {searchValue && (
                  <button
                    type="button"
                    onClick={() => setSearchValue('')}
                    className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2.5 -translate-y-1/2"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <Select
                value={currentSortValue}
                onValueChange={(value) => {
                  const option = SORT_OPTIONS.find((o) => o.value === value);
                  if (option) tm.applyFilters({ sortBy: option.sortBy, sortDir: option.sortDir });
                }}
              >
                <SelectTrigger className={cn(FIELD, 'w-auto min-w-[120px]')}>
                  <span className="text-muted-foreground">{t(i18n.dashboard.taskManager.sortLabel)}</span>
                  <SelectValue>{t(sortOption.labelKey)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {SORT_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={currentPriorityValue}
                onValueChange={(value) => {
                  const option = PRIORITY_OPTIONS.find((o) => o.value === value);
                  if (option) tm.applyFilters({ priorities: option.priorities });
                }}
              >
                <SelectTrigger className={cn(FIELD, 'w-auto min-w-[110px]')}>
                  <span className="text-muted-foreground">{t(i18n.dashboard.taskManager.priorityLabel)}</span>
                  <SelectValue>{t(priorityOption.labelKey)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {PRIORITY_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* Only offered when there is something overdue to narrow to. */}
              {(tm.stats.overdue > 0 || overdueOnly) && (
                <button
                  type="button"
                  aria-pressed={overdueOnly}
                  onClick={() => setOverdueOnly((v) => !v)}
                  className={cn(
                    'flex h-9 items-center gap-1.5 rounded-full px-3.5 text-xs font-medium whitespace-nowrap transition-colors',
                    overdueOnly
                      ? 'bg-negative/10 text-negative'
                      : 'text-muted-foreground hover:text-foreground bg-black/[0.045] dark:bg-white/[0.05]'
                  )}
                >
                  <AlertTriangle className="h-3 w-3" />
                  {t(i18n.dashboard.taskManager.overdue)}
                </button>
              )}
            </div>
          </div>

          {/* List | detail. With nothing opened, desktop shows the first task; below lg the detail is a sheet. */}
          <div
            className={cn(
              'grid items-start gap-4',
              (selected || tm.isLoading) && 'lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]'
            )}
          >
            <Surface pad="none" className="overflow-hidden">
              {tm.isLoading ? (
                <div className="space-y-1 p-3">
                  {Array.from({ length: 6 }, (_, i) => (
                    <div key={i} className="h-16 animate-pulse rounded-lg bg-black/[0.025] dark:bg-white/[0.03]" />
                  ))}
                </div>
              ) : visibleItems.length === 0 ? (
                renderEmpty()
              ) : (
                <div className="divide-y divide-black/[0.05] dark:divide-white/[0.06]">
                  {visibleItems.map((item) => (
                    <TaskRow
                      key={item.id}
                      item={item}
                      canEdit={canEdit}
                      isSelected={selected?.id === item.id}
                      onOpen={() => openTask(item)}
                      onSetStatus={(status) => handleSetStatus(item.id, status)}
                    />
                  ))}
                </div>
              )}

              {showPagination && (
                <div className="text-muted-foreground flex items-center justify-between border-t border-black/[0.05] px-4 py-3 text-xs dark:border-white/[0.06]">
                  <span>
                    {t(i18n.dashboard.taskManager.paginationRange, {
                      from: rangeFrom,
                      to: rangeTo,
                      total: listTotal,
                    })}
                  </span>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => tm.goToPage(tm.currentPage - 1)}
                      disabled={!canGoPrev}
                      className="hover:text-foreground flex items-center gap-1 rounded-md px-2 py-1 font-semibold disabled:opacity-40"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                      {t(i18n.dashboard.taskManager.prev)}
                    </button>
                    <button
                      type="button"
                      onClick={() => tm.goToPage(tm.currentPage + 1)}
                      disabled={!canGoNext}
                      className="hover:text-foreground flex items-center gap-1 rounded-md px-2 py-1 font-semibold disabled:opacity-40"
                    >
                      {t(i18n.dashboard.taskManager.next)}
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </Surface>

            {/* Desktop pane. Below lg the open task is a full-screen dialog sheet instead (further down). */}
            {detail && isDesktop && (
              <Surface
                pad="none"
                className="hidden lg:sticky lg:top-6 lg:block lg:max-h-[calc(100dvh-3rem)] lg:overflow-y-auto"
              >
                {detail}
              </Surface>
            )}
            {!selected && tm.isLoading && (
              <Surface className="hidden space-y-3 lg:block">
                <div className="h-6 w-2/3 animate-pulse rounded-md bg-black/[0.04] dark:bg-white/[0.05]" />
                <div className="h-40 animate-pulse rounded-xl bg-black/[0.025] dark:bg-white/[0.03]" />
              </Surface>
            )}
          </div>
        </div>
      )}

      {/* Mobile sheet: a Radix dialog gives Esc, a focus trap and scroll lock, and its portal escapes
          PageContainer's enter-animation transform, which would otherwise trap a `fixed` child. */}
      <DialogPrimitive.Root open={!isDesktop && !!explicit} onOpenChange={(open) => !open && closeTask()}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Content
            aria-describedby={undefined}
            onCloseAutoFocus={(e) => {
              const row = document.querySelector<HTMLElement>(`[data-task-id="${lastOpenedId.current}"]`);
              if (!row) return;
              e.preventDefault();
              row.focus();
            }}
            className="fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-[#F4F4F2] outline-none dark:bg-[#080808]"
          >
            <DialogPrimitive.Title className="sr-only">{explicit?.description}</DialogPrimitive.Title>
            <Surface pad="none" className="min-h-full rounded-none">
              {!isDesktop && explicit && detail}
            </Surface>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      <ConfirmModal
        open={deleteId !== null}
        onOpenChange={(open) => !open && setDeleteId(null)}
        onConfirm={handleDelete}
        title={t(i18n.dashboard.taskManager.deleteTitle)}
        description={t(i18n.dashboard.taskManager.deleteDescription)}
        confirmText={t(i18n.dashboard.taskManager.deleteConfirm)}
        cancelText={t(i18n.dashboard.taskManager.cancel)}
        variant="destructive"
      />
    </PageContainer>
  );
}

// Neutral unless it is an alert with something in it: a zero is never painted.
function Stat({ value, label, alert }: { value: number; label: string; alert?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className={`text-metric tabular-nums ${alert && value > 0 ? 'text-negative' : 'text-foreground'}`}>
        {value}
      </span>
      <span className="text-meta text-muted-foreground">{label}</span>
    </div>
  );
}
