// Permanent deletion (items 38a, 38b). The row goes first and commits; the cascade removes jobs,
// transcript, ranges, analyses, quotes, action items and access-log rows. The audio file goes after.
// A crash between the two leaves a file with no call, which the hourly sweep removes
// (lib/jobs/retention.ts). Access is checked by the callers.
import 'server-only';

import { eq, inArray } from 'drizzle-orm';

import { db } from '@/lib/db/client';
import { calls, organizations, projects } from '@/lib/db/schema/app';
import { log } from '@/lib/log';
import { audioPath, remove } from '@/lib/storage';

async function removeAudio(callId: string) {
  try {
    await remove(audioPath(callId));
  } catch {
    log('warn', 'audio file not removed, left to the sweep', { call_id: callId });
  }
}

/** False when the call was already gone. */
export async function deleteCall(callId: string): Promise<boolean> {
  const deleted = await db.delete(calls).where(eq(calls.id, callId)).returning({ id: calls.id });
  await removeAudio(callId);
  return deleted.length > 0;
}

export async function deleteProject(projectId: string): Promise<void> {
  const ids = await db.select({ id: calls.id }).from(calls).where(eq(calls.projectId, projectId));
  await db.delete(projects).where(eq(projects.id, projectId));
  for (const { id } of ids) await removeAudio(id);
  log('info', 'project deleted', { project_id: projectId });
}

export async function deleteOrganization(organizationId: string): Promise<void> {
  const ids = await db
    .select({ id: calls.id })
    .from(calls)
    .where(
      inArray(
        calls.projectId,
        db.select({ id: projects.id }).from(projects).where(eq(projects.organizationId, organizationId))
      )
    );
  await db.delete(organizations).where(eq(organizations.id, organizationId));
  for (const { id } of ids) await removeAudio(id);
  // The transcript cache of the organisation.
  await remove(`cache/${organizationId}`).catch(() => {});
}
