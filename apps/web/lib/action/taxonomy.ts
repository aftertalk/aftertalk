'use server';

import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import { i18n } from '@/i18n/constants';
import { requireProjectAccess, type SessionUser } from '@/lib/access';
import { db } from '@/lib/db/client';
import { categories, taxonomies } from '@/lib/db/schema/app';
import type { Category } from '@/lib/types';
import type { TaxonomyCategory } from '@/lib/types/classification';

import { conflict, invalid, isUniqueViolation, optionalText, requiredText, uuid } from './helpers';
import { type ActionResult, NotFoundError } from './result';
import { runAction } from './run';

// Call reasons: one taxonomy per project, a tree of at most three levels (item 31).
const MAX_LEVELS = 3;
const MAX_CATEGORIES = 200;

type Row = typeof categories.$inferSelect;

const toCategory = (row: Row): Category => ({
  id: row.id,
  taxonomyId: row.taxonomyId,
  name: row.name,
  description: row.description ?? undefined,
  parentId: row.parentId ?? undefined,
  displayOrder: row.displayOrder,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

async function rowsOf(projectId: string): Promise<Row[]> {
  const rows = await db
    .select({ category: categories })
    .from(categories)
    .innerJoin(taxonomies, eq(taxonomies.id, categories.taxonomyId))
    .where(eq(taxonomies.projectId, projectId))
    .orderBy(asc(categories.displayOrder), asc(categories.createdAt));
  return rows.map((r) => r.category);
}

async function taxonomyId(projectId: string, user: SessionUser): Promise<string> {
  const [existing] = await db.select({ id: taxonomies.id }).from(taxonomies).where(eq(taxonomies.projectId, projectId));
  if (existing) return existing.id;
  const [created] = await db
    .insert(taxonomies)
    .values({ projectId, userId: user.id })
    .onConflictDoUpdate({ target: taxonomies.projectId, set: { updatedAt: new Date() } })
    .returning({ id: taxonomies.id });
  return created.id;
}

/** 1 for a top-level category. */
function levelOf(rows: Row[], id: string | null): number {
  let level = 0;
  for (let cur = id; cur; level++) {
    cur = rows.find((r) => r.id === cur)?.parentId ?? null;
    if (level > MAX_LEVELS) break;
  }
  return level;
}

/** 1 for a category with no children. */
function heightOf(rows: Row[], id: string, guard = 0): number {
  if (guard > MAX_LEVELS) return guard;
  const children = rows.filter((r) => r.parentId === id);
  return 1 + Math.max(0, ...children.map((c) => heightOf(rows, c.id, guard + 1)));
}

export async function getTaxonomy(projectId: string): Promise<TaxonomyCategory[]> {
  await requireProjectAccess(uuid(projectId), 'VIEWER');
  const [rows, counts] = await Promise.all([
    rowsOf(projectId),
    // The reason a call is shown with: the one set by hand, else the model's primary.
    db.execute<{ id: string; n: number }>(sql`
      select coalesce(c.manual_category_id::text, a.result #>> '{primary,category_path,-1}') as id, count(*)::int as n
      from app.calls c
      left join app.analyses a on a.call_id = c.id and a.kind = 'call_reason' and a.status = 'completed'
      where c.project_id = ${projectId}
      group by 1`),
  ]);
  const callCount = new Map(counts.map((c) => [c.id, c.n]));
  const build = (parentId: string | null): TaxonomyCategory[] =>
    rows
      .filter((r) => r.parentId === parentId)
      .map((r) => {
        const children = build(r.id);
        return {
          id: r.id,
          name: r.name,
          description: r.description ?? undefined,
          callCount: callCount.get(r.id) ?? 0,
          ...(children.length > 0 ? { children } : {}),
        };
      });
  return build(null);
}

export async function createCategory(
  projectId: string,
  input: { name: string; description: string; parentId?: string | null }
): Promise<ActionResult<Category>> {
  return runAction(async () => {
    const { user } = await requireProjectAccess(uuid(projectId), 'EDITOR');
    const name = await requiredText(input?.name, 100);
    const description = await optionalText(input?.description, 500);
    const parentId = input?.parentId ? uuid(input.parentId) : null;
    const rows = await rowsOf(projectId);
    if (rows.length >= MAX_CATEGORIES) await invalid(i18n.errors.tooMany, { max: MAX_CATEGORIES });
    if (parentId) {
      if (!rows.some((r) => r.id === parentId)) throw new NotFoundError();
      if (levelOf(rows, parentId) + 1 > MAX_LEVELS) await invalid(i18n.errors.categoryDepth);
    }
    const siblings = rows.filter((r) => r.parentId === parentId);
    try {
      const [row] = await db
        .insert(categories)
        .values({
          taxonomyId: await taxonomyId(projectId, user),
          parentId,
          name,
          description,
          displayOrder: Math.max(-1, ...siblings.map((s) => s.displayOrder)) + 1,
        })
        .returning();
      return toCategory(row);
    } catch (e) {
      if (isUniqueViolation(e)) await conflict(i18n.errors.nameTaken);
      throw e;
    }
  });
}

export async function updateCategory(
  projectId: string,
  input: { id: string; name?: string; description?: string }
): Promise<ActionResult<Category>> {
  return runAction(async () => {
    await requireProjectAccess(uuid(projectId), 'EDITOR');
    const id = uuid(input?.id);
    const rows = await rowsOf(projectId);
    if (!rows.some((r) => r.id === id)) throw new NotFoundError();
    const patch: Partial<typeof categories.$inferInsert> = {};
    if (input.name !== undefined) patch.name = await requiredText(input.name, 100);
    if (input.description !== undefined) patch.description = await optionalText(input.description, 500);
    try {
      const [row] = await db
        .update(categories)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(categories.id, id))
        .returning();
      return toCategory(row);
    } catch (e) {
      if (isUniqueViolation(e)) await conflict(i18n.errors.nameTaken);
      throw e;
    }
  });
}

/** Deletes the category and everything under it. */
export async function deleteCategory(projectId: string, id: string): Promise<ActionResult> {
  return runAction(async () => {
    await requireProjectAccess(uuid(projectId), 'EDITOR');
    const rows = await rowsOf(projectId);
    if (!rows.some((r) => r.id === uuid(id))) throw new NotFoundError();
    await db.delete(categories).where(eq(categories.id, id));
  });
}

export async function moveCategory(
  projectId: string,
  input: { id: string; newParentId?: string | null; newDisplayOrder?: number }
): Promise<ActionResult<Category>> {
  return runAction(async () => {
    await requireProjectAccess(uuid(projectId), 'EDITOR');
    const id = uuid(input?.id);
    const rows = await rowsOf(projectId);
    const row = rows.find((r) => r.id === id);
    if (!row) throw new NotFoundError();
    const parentId =
      input.newParentId === undefined ? row.parentId : input.newParentId ? uuid(input.newParentId) : null;
    if (parentId) {
      if (!rows.some((r) => r.id === parentId)) throw new NotFoundError();
      // Not under itself or one of its own descendants.
      for (let cur: string | null = parentId, i = 0; cur && i <= MAX_LEVELS; i++) {
        if (cur === id) await invalid(i18n.errors.categoryDepth);
        cur = rows.find((r) => r.id === cur)?.parentId ?? null;
      }
      if (levelOf(rows, parentId) + heightOf(rows, id) > MAX_LEVELS) await invalid(i18n.errors.categoryDepth);
    }
    const order = input.newDisplayOrder;
    if (order !== undefined && (!Number.isInteger(order) || order < 0 || order > MAX_CATEGORIES)) {
      await invalid(i18n.errors.invalidInput);
    }
    try {
      const moved = await db.transaction(async (tx) => {
        const siblings = rows.filter((r) => r.parentId === parentId && r.id !== id);
        const at = Math.min(order ?? siblings.length, siblings.length);
        const ordered = [...siblings.slice(0, at), row, ...siblings.slice(at)];
        let result = row;
        for (const [i, s] of ordered.entries()) {
          if (s.id !== id && s.displayOrder === i) continue;
          const [updated] = await tx
            .update(categories)
            .set(s.id === id ? { parentId, displayOrder: i, updatedAt: new Date() } : { displayOrder: i })
            .where(eq(categories.id, s.id))
            .returning();
          if (s.id === id) result = updated;
        }
        return result;
      });
      return toCategory(moved);
    } catch (e) {
      if (isUniqueViolation(e)) await conflict(i18n.errors.nameTaken);
      throw e;
    }
  });
}

/** Removes every call reason of the project. */
export async function clearTaxonomy(projectId: string): Promise<void> {
  await requireProjectAccess(uuid(projectId), 'EDITOR');
  const [taxonomy] = await db.select({ id: taxonomies.id }).from(taxonomies).where(eq(taxonomies.projectId, projectId));
  if (!taxonomy) return;
  // Top level first; the cascade takes the rest.
  await db.delete(categories).where(and(eq(categories.taxonomyId, taxonomy.id), isNull(categories.parentId)));
}
