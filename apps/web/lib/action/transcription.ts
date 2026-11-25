'use server';

import { and, desc, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

import { orgRoleAtLeast, projectRoleAtLeast, requireProjectAccess } from '@/lib/access';
import { mayUsePersonalData } from '@/lib/calls/personal-data';
import { type CallListFilter, listCalls, loadCallDetail, loadTranscript } from '@/lib/calls/queries';
import { db } from '@/lib/db/client';
import { calls, categories, piiAccessLog, taxonomies } from '@/lib/db/schema/app';
import { user as userTable } from '@/lib/db/schema/auth';
import { deleteCall } from '@/lib/deletion';
import { log } from '@/lib/log';
import { userTimeZone, zonedRange } from '@/lib/time-zone';
import type { CallDetail, PagedResultCall, PagedResultCallSearchResult, PiiAccessLogEntry, Turn } from '@/lib/types';
import type { DateRangeInput } from '@/lib/utils/date-range';

import { uuid } from './helpers';
import { type ActionResult, ForbiddenError, NotFoundError } from './result';
import { runAction } from './run';

const MAX_PAGE_SIZE = 100;
const MAX_QUERY = 200;

export interface CallFilterOptions {
  page: number;
  pageSize: number;
  dateRange?: DateRangeInput;
}

function paging(page: unknown, pageSize: unknown): [number, number] {
  const p = Number.isInteger(page) && (page as number) > 0 ? Math.min(page as number, 100_000) : 1;
  const size =
    Number.isInteger(pageSize) && (pageSize as number) > 0 ? Math.min(pageSize as number, MAX_PAGE_SIZE) : 25;
  return [p, size];
}

function hasDateFilter(input?: DateRangeInput): boolean {
  if (!input) return false;
  return input.preset !== undefined || input.from !== undefined || input.to !== undefined;
}

export async function getCallsFiltered(projectId: string, options: CallFilterOptions): Promise<PagedResultCall> {
  const { user } = await requireProjectAccess(uuid(projectId), 'VIEWER');
  const [page, pageSize] = paging(options?.page, options?.pageSize);
  const filter: CallListFilter = hasDateFilter(options?.dateRange)
    ? zonedRange(options.dateRange, await userTimeZone(user.id))
    : {};
  return listCalls(projectId, filter, page, pageSize);
}

/** null when the call does not exist in this project. */
export async function getCallById(projectId: string, callId: string): Promise<CallDetail | null> {
  const { role, orgRole } = await requireProjectAccess(uuid(projectId), 'VIEWER');
  return loadCallDetail(projectId, uuid(callId), {
    mayUsePersonalData: await mayUsePersonalData(projectId, orgRole),
    canDelete: projectRoleAtLeast(role, 'ADMIN'),
    canSeeAccessLog: orgRoleAtLeast(orgRole, 'ADMIN'),
  });
}

/**
 * The turns with their original words, for the "Show original" switch (item 36a). Organisation
 * owners and admins always; other members only in a project whose member_pii_access is `full`.
 * Each use writes a pii_access_log row. Original words are never part of a page's first response.
 */
export async function getOriginalTranscript(projectId: string, callId: string): Promise<ActionResult<Turn[]>> {
  return runAction(async () => {
    const { user, orgRole } = await requireProjectAccess(uuid(projectId), 'VIEWER');
    if (!(await mayUsePersonalData(projectId, orgRole))) throw new ForbiddenError();
    const [call] = await db
      .select({ id: calls.id })
      .from(calls)
      .where(and(eq(calls.id, uuid(callId)), eq(calls.projectId, projectId)));
    if (!call) throw new NotFoundError();
    const transcript = await loadTranscript(callId, 'original');
    if (!transcript) throw new NotFoundError();
    // The log row is written before the words are returned: no original text leaves without one.
    await db.insert(piiAccessLog).values({ callId, userId: user.id, kind: 'text' });
    log('info', 'original text shown', { call_id: callId, user_id: user.id });
    return transcript.turns;
  });
}

/** Who opened the original text or audio of a call, newest first. Organisation owners and admins. */
export async function getPiiAccessLog(projectId: string, callId: string): Promise<ActionResult<PiiAccessLogEntry[]>> {
  return runAction(async () => {
    const { orgRole } = await requireProjectAccess(uuid(projectId), 'VIEWER');
    if (!orgRoleAtLeast(orgRole, 'ADMIN')) throw new ForbiddenError();
    const rows = await db
      .select({
        name: userTable.name,
        email: userTable.email,
        kind: piiAccessLog.kind,
        createdAt: piiAccessLog.createdAt,
      })
      .from(piiAccessLog)
      .innerJoin(calls, eq(calls.id, piiAccessLog.callId))
      .leftJoin(userTable, eq(userTable.id, piiAccessLog.userId))
      .where(and(eq(piiAccessLog.callId, uuid(callId)), eq(calls.projectId, projectId)))
      .orderBy(desc(piiAccessLog.createdAt))
      .limit(100);
    return rows.map((row) => ({
      userName: row.name || row.email || null,
      kind: row.kind,
      createdAt: row.createdAt.toISOString(),
    }));
  });
}

/**
 * Deletes the whole call for good: the row, its results and the audio file (items 38a, 38b). The
 * name is kept from the cloud. Needs a project admin (#46).
 */
export async function deleteTranscript(projectId: string, callId: string): Promise<void> {
  const { user } = await requireProjectAccess(uuid(projectId), 'ADMIN');
  const [call] = await db
    .select({ id: calls.id })
    .from(calls)
    .where(and(eq(calls.id, uuid(callId)), eq(calls.projectId, projectId)));
  if (!call) throw new NotFoundError();
  await deleteCall(callId);
  log('info', 'call deleted', { call_id: callId, project_id: projectId, user_id: user.id });
  revalidatePath(`/${projectId}`, 'layout');
}

/**
 * Sets the call reason by hand; null goes back to the model's. Stored in calls.manual_category_id,
 * shown in place of the model's primary reason, and not changed by a later run.
 */
export async function setCallCategory(
  projectId: string,
  callId: string,
  categoryId: string | null
): Promise<ActionResult> {
  return runAction(async () => {
    await requireProjectAccess(uuid(projectId), 'EDITOR');
    if (categoryId !== null) {
      const [category] = await db
        .select({ id: categories.id })
        .from(categories)
        .innerJoin(taxonomies, eq(taxonomies.id, categories.taxonomyId))
        .where(and(eq(categories.id, uuid(categoryId)), eq(taxonomies.projectId, projectId)));
      if (!category) throw new NotFoundError();
    }
    const updated = await db
      .update(calls)
      .set({ manualCategoryId: categoryId })
      .where(and(eq(calls.id, uuid(callId)), eq(calls.projectId, projectId)))
      .returning({ id: calls.id });
    if (updated.length === 0) throw new NotFoundError();
    revalidatePath(`/${projectId}/calls/${callId}`);
  });
}

export interface CallSearchOptions {
  page: number;
  pageSize: number;
  q: string;
  /** The same range input as the list without a search, resolved in the user's time zone. */
  dateRange?: DateRangeInput;
}

/** A substring search over redacted text only (item 33). */
export async function searchCalls(projectId: string, options: CallSearchOptions): Promise<PagedResultCallSearchResult> {
  const { user } = await requireProjectAccess(uuid(projectId), 'VIEWER');
  const [page, pageSize] = paging(options?.page, options?.pageSize);
  const range = hasDateFilter(options?.dateRange) ? zonedRange(options.dateRange, await userTimeZone(user.id)) : {};
  const q = typeof options?.q === 'string' ? options.q.trim().slice(0, MAX_QUERY) : '';
  return listCalls(projectId, { ...range, q }, page, pageSize);
}
