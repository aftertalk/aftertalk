'use server';

import { and, asc, eq, inArray, ne } from 'drizzle-orm';

import { i18n } from '@/i18n/constants';
import { requireProjectAccess } from '@/lib/access';
import { db } from '@/lib/db/client';
import { analysisTemplateFields, analysisTemplates, ANSWER_TYPES, projects } from '@/lib/db/schema/app';
import type { AnalysisTemplate, CreateFieldRequest, CreateTemplateRequest, UpdateTemplateRequest } from '@/lib/types';

import { conflict, invalid, isUniqueViolation, oneOf, optionalText, requiredText, uuid } from './helpers';
import { type ActionResult, NotFoundError } from './result';
import { runAction } from './run';

// Scorecards (item 31). One template per project is active; its fields go to the engine with each job.
const MAX_FIELDS = 20;
const MAX_OPTIONS = 50;
const MAX_TEMPLATES = 100;

type TemplateRow = typeof analysisTemplates.$inferSelect;
type FieldRow = typeof analysisTemplateFields.$inferSelect;
type CleanField = Omit<typeof analysisTemplateFields.$inferInsert, 'templateId' | 'id'>;

const toTemplate = (row: TemplateRow, fields: FieldRow[]): AnalysisTemplate => ({
  id: row.id,
  name: row.name,
  description: row.description ?? undefined,
  isActive: row.isActive,
  fields: fields
    .filter((f) => f.templateId === row.id)
    .sort((a, b) => a.displayOrder - b.displayOrder)
    .map((f) => ({
      id: f.id,
      label: f.label,
      prompt: f.prompt,
      answerType: f.answerType,
      options: f.options ?? undefined,
      isRequired: f.isRequired,
      displayOrder: f.displayOrder,
    })),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

async function load(projectId: string, id?: string): Promise<AnalysisTemplate[]> {
  const rows = await db
    .select()
    .from(analysisTemplates)
    .where(and(eq(analysisTemplates.projectId, projectId), id ? eq(analysisTemplates.id, id) : undefined))
    .orderBy(asc(analysisTemplates.createdAt));
  if (rows.length === 0) return [];
  const fields = await db
    .select()
    .from(analysisTemplateFields)
    .where(
      inArray(
        analysisTemplateFields.templateId,
        rows.map((r) => r.id)
      )
    );
  return rows.map((r) => toTemplate(r, fields));
}

async function one(projectId: string, id: string): Promise<AnalysisTemplate> {
  const [template] = await load(projectId, uuid(id));
  if (!template) throw new NotFoundError();
  return template;
}

async function cleanFields(input: unknown): Promise<CleanField[]> {
  if (!Array.isArray(input) || input.length > MAX_FIELDS) await invalid(i18n.errors.tooMany, { max: MAX_FIELDS });
  const out: CleanField[] = [];
  for (const [i, raw] of (input as CreateFieldRequest[]).entries()) {
    const label = await requiredText(raw?.label, 200);
    const prompt = await requiredText(raw?.prompt, 2000);
    if (!oneOf(raw?.answerType, ANSWER_TYPES)) await invalid(i18n.errors.invalidInput);
    const answerType = raw.answerType as (typeof ANSWER_TYPES)[number];
    let options: string[] | null = null;
    if (answerType === 'CHOICE') {
      const list = Array.isArray(raw.options) ? raw.options : [];
      options = [...new Set(list.map((o) => (typeof o === 'string' ? o.trim() : '')).filter(Boolean))];
      if (options.length === 0 || options.length > MAX_OPTIONS || options.some((o) => o.length > 200)) {
        await invalid(i18n.templates.form.errors.options);
      }
    }
    out.push({ label, prompt, answerType, options, isRequired: raw.isRequired === true, displayOrder: i });
  }
  return out;
}

export async function getAnalysisTemplates(projectId: string): Promise<AnalysisTemplate[]> {
  await requireProjectAccess(uuid(projectId), 'VIEWER');
  return load(projectId);
}

export async function getAnalysisTemplate(projectId: string, id: string): Promise<AnalysisTemplate> {
  await requireProjectAccess(uuid(projectId), 'VIEWER');
  return one(projectId, id);
}

export async function createAnalysisTemplate(
  projectId: string,
  input: CreateTemplateRequest
): Promise<ActionResult<AnalysisTemplate>> {
  return runAction(async () => {
    const { user } = await requireProjectAccess(uuid(projectId), 'EDITOR');
    const name = await requiredText(input?.name, 200);
    const description = await optionalText(input?.description, 1000);
    const fields = await cleanFields(input?.fields ?? []);
    const existing = await db
      .select({ id: analysisTemplates.id, isActive: analysisTemplates.isActive })
      .from(analysisTemplates)
      .where(eq(analysisTemplates.projectId, projectId));
    if (existing.length >= MAX_TEMPLATES) await invalid(i18n.errors.tooMany, { max: MAX_TEMPLATES });
    try {
      const id = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(analysisTemplates)
          // With no active template the scorecard step has nothing to fill in, so the first
          // template of a project (or the first after the active one was deleted) is activated.
          .values({ projectId, userId: user.id, name, description, isActive: !existing.some((t) => t.isActive) })
          .returning({ id: analysisTemplates.id });
        if (fields.length > 0) {
          await tx.insert(analysisTemplateFields).values(fields.map((f) => ({ ...f, templateId: row.id })));
        }
        return row.id;
      });
      return one(projectId, id);
    } catch (e) {
      if (isUniqueViolation(e)) await conflict(i18n.errors.nameTaken);
      throw e;
    }
  });
}

export async function updateAnalysisTemplate(
  projectId: string,
  id: string,
  input: UpdateTemplateRequest
): Promise<ActionResult<AnalysisTemplate>> {
  return runAction(async () => {
    await requireProjectAccess(uuid(projectId), 'EDITOR');
    const current = await one(projectId, id);
    const patch: Partial<typeof analysisTemplates.$inferInsert> = {};
    if (input?.name !== undefined) patch.name = await requiredText(input.name, 200);
    if (input?.description !== undefined) patch.description = await optionalText(input.description, 1000);
    const fields = input?.fields !== undefined ? await cleanFields(input.fields) : null;
    try {
      await db.transaction(async (tx) => {
        await tx
          .update(analysisTemplates)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(analysisTemplates.id, current.id));
        if (!fields) return;
        // A field whose label, answer type and options did not change keeps its id, so stored
        // answers still find their question. Stored results name fields by id (the result is kept as
        // the engine sent it), so a field that now asks for another kind of answer gets a new id:
        // an old `true` must not show under a CHOICE of 'yes' / 'partly' / 'no'.
        const shape = (f: { label: string; answerType: string; options?: string[] | null }) =>
          JSON.stringify([f.label, f.answerType, f.answerType === 'CHOICE' ? (f.options ?? []) : null]);
        const byShape = new Map(current.fields.map((f) => [shape(f), f.id]));
        const kept = new Set<string>();
        for (const f of fields) {
          const keepId = byShape.get(shape(f));
          if (keepId && !kept.has(keepId)) {
            kept.add(keepId);
            await tx.update(analysisTemplateFields).set(f).where(eq(analysisTemplateFields.id, keepId));
          } else {
            await tx.insert(analysisTemplateFields).values({ ...f, templateId: current.id });
          }
        }
        const gone = current.fields.filter((f) => !kept.has(f.id)).map((f) => f.id);
        if (gone.length > 0) await tx.delete(analysisTemplateFields).where(inArray(analysisTemplateFields.id, gone));
      });
      return one(projectId, current.id);
    } catch (e) {
      if (isUniqueViolation(e)) await conflict(i18n.errors.nameTaken);
      throw e;
    }
  });
}

export async function deleteAnalysisTemplate(projectId: string, id: string): Promise<void> {
  await requireProjectAccess(uuid(projectId), 'EDITOR');
  await db
    .delete(analysisTemplates)
    .where(and(eq(analysisTemplates.projectId, projectId), eq(analysisTemplates.id, uuid(id))));
}

/** Makes this the project's one active template. */
export async function activateAnalysisTemplate(projectId: string, id: string): Promise<AnalysisTemplate> {
  await requireProjectAccess(uuid(projectId), 'EDITOR');
  const current = await one(projectId, id);
  await db.transaction(async (tx) => {
    // One at a time per project, so two activations at once do not trip the one-active index.
    await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for('update');
    await tx
      .update(analysisTemplates)
      .set({ isActive: false })
      .where(
        and(
          eq(analysisTemplates.projectId, projectId),
          eq(analysisTemplates.isActive, true),
          ne(analysisTemplates.id, current.id)
        )
      );
    await tx.update(analysisTemplates).set({ isActive: true }).where(eq(analysisTemplates.id, current.id));
  });
  return one(projectId, current.id);
}

export async function deactivateAnalysisTemplate(projectId: string, id: string): Promise<AnalysisTemplate> {
  await requireProjectAccess(uuid(projectId), 'EDITOR');
  const current = await one(projectId, id);
  await db.update(analysisTemplates).set({ isActive: false }).where(eq(analysisTemplates.id, current.id));
  return one(projectId, current.id);
}
