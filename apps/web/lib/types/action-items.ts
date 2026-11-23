import type { Quote } from './calls';

export const ActionItemStatus = {
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  DONE: 'DONE',
  CANCELLED: 'CANCELLED',
} as const;
export type ActionItemStatus = (typeof ActionItemStatus)[keyof typeof ActionItemStatus];

export const ActionItemPriority = { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' } as const;
export type ActionItemPriority = (typeof ActionItemPriority)[keyof typeof ActionItemPriority];

export const ListActionItemsStatusItem = ActionItemStatus;
export type ListActionItemsStatusItem = ActionItemStatus;
export const ListActionItemsPriorityItem = ActionItemPriority;
export type ListActionItemsPriorityItem = ActionItemPriority;

export const ListActionItemsSortBy = {
  CREATED_AT: 'CREATED_AT',
  CALL_DATE: 'CALL_DATE',
  PRIORITY: 'PRIORITY',
  STATUS: 'STATUS',
} as const;
export type ListActionItemsSortBy = (typeof ListActionItemsSortBy)[keyof typeof ListActionItemsSortBy];

export const ListActionItemsSortDir = { ASC: 'ASC', DESC: 'DESC' } as const;
export type ListActionItemsSortDir = (typeof ListActionItemsSortDir)[keyof typeof ListActionItemsSortDir];

export interface ActionItem {
  id: string;
  projectId: string;
  /** The id of the call; the name is kept from the cloud. */
  transcriptId: string;
  transcriptIndex: number;
  callDate: string;
  callFilename: string;
  description: string;
  responsibleParty: string;
  deadlineMentioned?: string;
  quote: Quote | null;
  status: ActionItemStatus;
  priority: ActionItemPriority;
  notes?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
  isOverdue: boolean;
}

export interface ActionItemsPage {
  items: ActionItem[];
  totalCount: number;
  pendingCount: number;
  inProgressCount: number;
  doneCount: number;
  cancelledCount: number;
  overdueCount: number;
}

export type ListActionItemsParams = {
  status?: ListActionItemsStatusItem[];
  priority?: ListActionItemsPriorityItem[];
  responsibleParty?: string;
  transcriptId?: string;
  from?: string;
  to?: string;
  search?: string;
  page?: number;
  pageSize?: number;
  sortBy?: ListActionItemsSortBy;
  sortDir?: ListActionItemsSortDir;
};

export interface UpdateActionItemRequest {
  status?: ActionItemStatus;
  priority?: ActionItemPriority;
  notes?: string;
  clearNotes: boolean;
  description?: string;
  responsibleParty?: string;
  deadlineMentioned?: string;
  clearDeadline: boolean;
}

export interface DashboardActionItem {
  id: string;
  callId: string;
  callDate: string;
  callFilename: string;
  description: string;
  responsibleParty: string;
  deadlineMentioned?: string;
  quote: Quote | null;
  isOverdue: boolean;
}
