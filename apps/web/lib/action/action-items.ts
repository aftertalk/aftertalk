'use server';

import { and, eq, type SQL, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';

import { i18n } from '@/i18n/constants';
import { requireProjectAccess } from '@/lib/access';
import { ACTION_ITEM_COLUMNS, ACTION_ITEM_JOINS, type ActionItemRow, toActionItem } from '@/lib/calls/queries';
import { db } from '@/lib/db/client';
import { ACTION_ITEM_PRIORITIES, ACTION_ITEM_STATUSES, actionItems } from '@/lib/db/schema/app';
import type { ActionItem, ActionItemsPage, ListActionItemsParams, UpdateActionItemRequest } from '@/lib/types';
import { isUuid } from '@/lib/utils/uuid';

import { invalid, likeLiteral, oneOf, optionalText, requiredText, uuid } from './helpers';
import { type ActionResult, NotFoundError } from './result';
import { runAction } from './run';

// The "Tasks" page (item 34): action items the summary found, with a status a person keeps.
const MAX_PAGE_SIZE = 100;

const ORDER: Record<string, SQL> = {
  CREATED_AT: sql`ai.created_at`,
  CALL_DATE: sql`c.created_at`,
  PRIORITY: sql`array_position(array['LOW', 'MEDIUM', 'HIGH'], ai.priority)`,
  STATUS: sql`array_position(array['PENDING', 'IN_PROGRESS', 'DONE', 'CANCELLED'], ai.status)`,
};

// Drizzle spreads a JavaScript array into separate parameters, so a list is written as IN ($1, $2).
const inList = (values: string[]) =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`, `
  );

const validDate = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export async function listActionItems(projectId: string, params?: ListActionItemsParams): Promise<ActionItemsPage> {
  await requireProjectAccess(uuid(projectId), 'VIEWER');
  const p = params ?? {};
  // Everything but the status filter, so the counts per status describe the same list.
  const base: SQL[] = [sql`ai.project_id = ${projectId}`];
  const priorities = (Array.isArray(p.priority) ? p.priority : []).filter((v) => oneOf(v, ACTION_ITEM_PRIORITIES));
  if (priorities.length > 0) base.push(sql`ai.priority in (${inList(priorities)})`);
  if (typeof p.responsibleParty === 'string' && p.responsibleParty) {
    base.push(sql`ai.responsible_party = ${p.responsibleParty.slice(0, 100)}`);
  }
  if (typeof p.transcriptId === 'string' && p.transcriptId) {
    if (!isUuid(p.transcriptId)) throw new NotFoundError();
    base.push(sql`ai.call_id = ${p.transcriptId}`);
  }
  const from = validDate(p.from);
  const to = validDate(p.to);
  if (from) base.push(sql`c.created_at >= ${from}`);
  if (to) base.push(sql`c.created_at <= ${to}`);
  if (typeof p.search === 'string' && p.search.trim()) {
    base.push(sql`ai.description ilike ${`%${likeLiteral(p.search.trim().slice(0, 200))}%`}`);
  }
  const statuses = (Array.isArray(p.status) ? p.status : []).filter((v) => oneOf(v, ACTION_ITEM_STATUSES));
  const where = sql.join(statuses.length > 0 ? [...base, sql`ai.status in (${inList(statuses)})`] : base, sql` and `);

  const pageSize = Number.isInteger(p.pageSize) && p.pageSize! > 0 ? Math.min(p.pageSize!, MAX_PAGE_SIZE) : 50;
  const page = Number.isInteger(p.page) && p.page! >= 0 ? Math.min(p.page!, 100_000) : 0;
  // Own keys only: `sortBy` comes from the browser and must not reach Object.prototype.
  const order = typeof p.sortBy === 'string' && Object.hasOwn(ORDER, p.sortBy) ? ORDER[p.sortBy] : ORDER.CREATED_AT;
  const direction = p.sortDir === 'ASC' ? sql`asc` : sql`desc`;

  const [rows, [counts], [any]] = await Promise.all([
    db.execute<ActionItemRow>(sql`
      select ${ACTION_ITEM_COLUMNS} ${ACTION_ITEM_JOINS}
      where ${where}
      order by ${order} ${direction}, ai.call_id, ai.item_index
      limit ${pageSize} offset ${page * pageSize}`),
    db.execute<{ total: number; pending: number; in_progress: number; done: number; cancelled: number }>(sql`
      select count(*)::int as total,
             count(*) filter (where ai.status = 'PENDING')::int as pending,
             count(*) filter (where ai.status = 'IN_PROGRESS')::int as in_progress,
             count(*) filter (where ai.status = 'DONE')::int as done,
             count(*) filter (where ai.status = 'CANCELLED')::int as cancelled
      from app.action_items ai join app.calls c on c.id = ai.call_id
      where ${sql.join(base, sql` and `)}`),
    // Unfiltered, so a search that matches nothing is not mistaken for a project without tasks.
    db.execute<{ has: boolean }>(
      sql`select exists (select 1 from app.action_items where project_id = ${projectId}) as has`
    ),
  ]);
  return {
    items: rows.map(toActionItem),
    totalCount: counts.total,
    pendingCount: counts.pending,
    inProgressCount: counts.in_progress,
    doneCount: counts.done,
    cancelledCount: counts.cancelled,
    overdueCount: 0,
    projectHasTasks: any.has,
  };
}

export async function updateActionItem(
  projectId: string,
  actionItemId: string,
  request: UpdateActionItemRequest
): Promise<ActionResult<ActionItem>> {
  return runAction(() => updateItem(projectId, actionItemId, request));
}

async function updateItem(
  projectId: string,
  actionItemId: string,
  request: UpdateActionItemRequest
): Promise<ActionItem> {
  await requireProjectAccess(uuid(projectId), 'EDITOR');
  const id = uuid(actionItemId);
  const r = request ?? ({} as UpdateActionItemRequest);
  const patch: PgUpdateSetSource<typeof actionItems> = {};
  if (r.status !== undefined) {
    if (!oneOf(r.status, ACTION_ITEM_STATUSES)) await invalid(i18n.errors.invalidInput);
    patch.status = r.status;
    // Setting DONE again (a re-click, a retry) keeps the first completion time.
    patch.completedAt = r.status === 'DONE' ? sql`coalesce(${actionItems.completedAt}, now())` : null;
  }
  if (r.priority !== undefined) {
    if (!oneOf(r.priority, ACTION_ITEM_PRIORITIES)) await invalid(i18n.errors.invalidInput);
    patch.priority = r.priority;
  }
  if (r.clearNotes === true) patch.notes = null;
  else if (r.notes !== undefined) patch.notes = await optionalText(r.notes, 5000);
  if (r.description !== undefined) patch.description = await requiredText(r.description, 2000);
  if (r.responsibleParty !== undefined) patch.responsibleParty = await requiredText(r.responsibleParty, 100);
  if (r.clearDeadline === true) patch.deadlineMentioned = null;
  else if (r.deadlineMentioned !== undefined) patch.deadlineMentioned = await optionalText(r.deadlineMentioned, 200);

  const updated = await db
    .update(actionItems)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(actionItems.id, id), eq(actionItems.projectId, projectId)))
    .returning({ id: actionItems.id });
  if (updated.length === 0) throw new NotFoundError();
  const [row] = await db.execute<ActionItemRow>(
    sql`select ${ACTION_ITEM_COLUMNS} ${ACTION_ITEM_JOINS} where ai.id = ${id}`
  );
  return toActionItem(row);
}

export async function deleteActionItem(projectId: string, actionItemId: string): Promise<ActionResult> {
  return runAction(async () => {
    await requireProjectAccess(uuid(projectId), 'EDITOR');
    await db
      .delete(actionItems)
      .where(and(eq(actionItems.id, uuid(actionItemId)), eq(actionItems.projectId, projectId)));
  });
}

/** The distinct "who does it" values of the project, for the filter. */
export async function getResponsibleParties(projectId: string): Promise<string[]> {
  await requireProjectAccess(uuid(projectId), 'VIEWER');
  const rows = await db
    .selectDistinct({ party: actionItems.responsibleParty })
    .from(actionItems)
    .where(eq(actionItems.projectId, projectId))
    .orderBy(actionItems.responsibleParty);
  return rows.map((row) => row.party);
}
