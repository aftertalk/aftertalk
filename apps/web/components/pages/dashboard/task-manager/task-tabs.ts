import type { ActionItemStatus } from '@/lib/types';

// The status tabs on the Tasks page, kept in the URL as ?tab=…. Plain module (no 'use client') so the
// server page can fetch the default tab's tasks up front instead of loading everything and refiltering.
export const TASK_TABS = ['pending', 'in_progress', 'done', 'cancelled', 'all'] as const;
export type TaskTab = (typeof TASK_TABS)[number];

export const TAB_STATUSES: Record<TaskTab, ActionItemStatus[]> = {
  pending: ['PENDING'],
  in_progress: ['IN_PROGRESS'],
  done: ['DONE'],
  cancelled: ['CANCELLED'],
  all: [],
};

export function parseTaskTab(value: string | null | undefined): TaskTab {
  return TASK_TABS.find((tab) => tab === value) ?? 'pending';
}
