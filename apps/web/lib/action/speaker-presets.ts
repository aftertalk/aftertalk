'use server';

import { and, asc, eq, ne } from 'drizzle-orm';

import { i18n } from '@/i18n/constants';
import { requireProjectAccess } from '@/lib/access';
import { db } from '@/lib/db/client';
import { projects, speakerPresets } from '@/lib/db/schema/app';
import type { SpeakerPreset } from '@/lib/types';

import { invalid, isUniqueViolation, requiredText, uuid } from './helpers';
import { type ActionResult, NotFoundError } from './result';
import { runAction } from './run';

// Channel labels a person can pick at upload (item 31): the first is channel 0, the second channel 1.
const MAX_PRESETS = 50;
const MAX_SPEAKERS = 10;
const MAX_LABEL = 40;

type Row = typeof speakerPresets.$inferSelect;

const toPreset = (row: Row): SpeakerPreset => ({
  id: row.id,
  name: row.name,
  speakers: row.speakers,
  isDefault: row.isDefault,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

async function cleanSpeakers(input: unknown): Promise<string[]> {
  const labels = (Array.isArray(input) ? input : [])
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean);
  const distinct = new Set(labels.map((l) => l.toLowerCase())).size === labels.length;
  if (labels.length < 2 || labels.length > MAX_SPEAKERS || !distinct || labels.some((l) => l.length > MAX_LABEL)) {
    await invalid(i18n.errors.speakerLabels, { max: MAX_LABEL });
  }
  return labels;
}

async function find(projectId: string, id: string): Promise<Row> {
  const [row] = await db
    .select()
    .from(speakerPresets)
    .where(and(eq(speakerPresets.projectId, projectId), eq(speakerPresets.id, uuid(id))));
  if (!row) throw new NotFoundError();
  return row;
}

async function makeDefault(projectId: string, id: string): Promise<Row> {
  return db.transaction(async (tx) => {
    // One at a time per project: two requests at once would otherwise both leave their preset default.
    await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for('update');
    await tx
      .update(speakerPresets)
      .set({ isDefault: false })
      .where(
        and(eq(speakerPresets.projectId, projectId), eq(speakerPresets.isDefault, true), ne(speakerPresets.id, id))
      );
    const [row] = await tx.update(speakerPresets).set({ isDefault: true }).where(eq(speakerPresets.id, id)).returning();
    return row;
  });
}

async function nameTaken(): Promise<never> {
  return invalid(i18n.errors.nameTaken);
}

export async function getSpeakerPresets(projectId: string): Promise<SpeakerPreset[]> {
  await requireProjectAccess(uuid(projectId), 'VIEWER');
  const rows = await db
    .select()
    .from(speakerPresets)
    .where(eq(speakerPresets.projectId, projectId))
    .orderBy(asc(speakerPresets.createdAt));
  return rows.map(toPreset);
}

export async function createSpeakerPreset(
  projectId: string,
  input: { name: string; speakers: string[]; isDefault?: boolean }
): Promise<ActionResult<SpeakerPreset>> {
  return runAction(() => createPreset(projectId, input));
}

async function createPreset(
  projectId: string,
  input: { name: string; speakers: string[]; isDefault?: boolean }
): Promise<SpeakerPreset> {
  const { user } = await requireProjectAccess(uuid(projectId), 'EDITOR');
  const name = await requiredText(input?.name, 100);
  const speakers = await cleanSpeakers(input?.speakers);
  const existing = await db
    .select({ id: speakerPresets.id })
    .from(speakerPresets)
    .where(eq(speakerPresets.projectId, projectId));
  if (existing.length >= MAX_PRESETS) await invalid(i18n.errors.tooMany, { max: MAX_PRESETS });
  let row: Row;
  try {
    [row] = await db.insert(speakerPresets).values({ projectId, userId: user.id, name, speakers }).returning();
  } catch (e) {
    if (isUniqueViolation(e)) return nameTaken();
    throw e;
  }
  // The first preset of a project is its default, so the upload page always has one preselected.
  if (input.isDefault === true || existing.length === 0) row = await makeDefault(projectId, row.id);
  return toPreset(row);
}

export async function updateSpeakerPreset(
  projectId: string,
  input: { id: string; name?: string; speakers?: string[]; isDefault?: boolean }
): Promise<ActionResult<SpeakerPreset>> {
  return runAction(() => updatePreset(projectId, input));
}

async function updatePreset(
  projectId: string,
  input: { id: string; name?: string; speakers?: string[]; isDefault?: boolean }
): Promise<SpeakerPreset> {
  await requireProjectAccess(uuid(projectId), 'EDITOR');
  const current = await find(projectId, input?.id);
  const patch: Partial<typeof speakerPresets.$inferInsert> = {};
  if (input.name !== undefined) patch.name = await requiredText(input.name, 100);
  if (input.speakers !== undefined) patch.speakers = await cleanSpeakers(input.speakers);
  let row: Row;
  try {
    [row] = await db
      .update(speakerPresets)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(speakerPresets.id, current.id))
      .returning();
  } catch (e) {
    if (isUniqueViolation(e)) return nameTaken();
    throw e;
  }
  if (input.isDefault === true) row = await makeDefault(projectId, current.id);
  return toPreset(row);
}

export async function deleteSpeakerPreset(projectId: string, id: string): Promise<ActionResult> {
  return runAction(async () => {
    await requireProjectAccess(uuid(projectId), 'EDITOR');
    const current = await find(projectId, id);
    await db.delete(speakerPresets).where(eq(speakerPresets.id, current.id));
  });
}

export async function setDefaultSpeakerPreset(projectId: string, id: string): Promise<ActionResult<SpeakerPreset>> {
  return runAction(async () => {
    await requireProjectAccess(uuid(projectId), 'EDITOR');
    const current = await find(projectId, id);
    return toPreset(await makeDefault(projectId, current.id));
  });
}
