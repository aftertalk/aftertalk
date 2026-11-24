'use server';

import { and, asc, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

import { i18n } from '@/i18n/constants';
import { projectRoleAtLeast, requireProjectAccess } from '@/lib/access';
import { db } from '@/lib/db/client';
import { projectProviderChoice, PROVIDER_SLOTS, providerConnections } from '@/lib/db/schema/app';
import { log } from '@/lib/log';
import { projectReadiness } from '@/lib/project-readiness';
import { fetchModelNames } from '@/lib/providers';
import { decryptSecret } from '@/lib/secrets';
import type { ProjectProviders, ProjectReadiness, ProviderKind } from '@/lib/types';

import { invalid, oneOf, requiredText, uuid } from './helpers';
import { type ActionResult, NotFoundError } from './result';
import { runAction } from './run';

// Which connection and model a project uses for speech, diarization and the LLM (item 37f).

export async function getProjectProviders(projectId: string): Promise<ProjectProviders> {
  const { organizationId, role } = await requireProjectAccess(uuid(projectId), 'VIEWER');
  // Everyone sees what the project uses; the organisation's other connections are for those who choose.
  const mayChoose = projectRoleAtLeast(role, 'ADMIN');
  const [choices, all] = await Promise.all([
    db
      .select({
        slot: projectProviderChoice.slot,
        connectionId: projectProviderChoice.connectionId,
        model: projectProviderChoice.model,
      })
      .from(projectProviderChoice)
      .where(eq(projectProviderChoice.projectId, projectId)),
    db
      .select({
        id: providerConnections.id,
        name: providerConnections.name,
        kind: providerConnections.kind,
        dataLocation: providerConnections.dataLocation,
      })
      .from(providerConnections)
      .where(eq(providerConnections.organizationId, organizationId))
      .orderBy(asc(providerConnections.name)),
  ]);
  const options = mayChoose ? all : all.filter((o) => choices.some((c) => c.connectionId === o.id));
  return { choices, options };
}

/** What the project still needs before it can process calls (item 54a). */
export async function getProjectReadiness(projectId: string): Promise<ProjectReadiness> {
  await requireProjectAccess(uuid(projectId), 'VIEWER');
  return projectReadiness(projectId);
}

/** The connection, only when it belongs to the organisation of the project and is of the kind of the slot. */
async function connectionFor(organizationId: string, slot: ProviderKind, connectionId: string) {
  const [connection] = await db
    .select()
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.id, uuid(connectionId)),
        eq(providerConnections.organizationId, organizationId),
        eq(providerConnections.kind, slot)
      )
    );
  if (!connection) throw new NotFoundError();
  return connection;
}

/** Sets or, with a null connection, clears the choice of one slot. Project admins. */
export async function setProjectProvider(
  projectId: string,
  slot: ProviderKind,
  connectionId: string | null,
  model?: string | null
): Promise<ActionResult<ProjectProviders>> {
  return runAction(async () => {
    const { user, organizationId } = await requireProjectAccess(uuid(projectId), 'ADMIN');
    if (!oneOf(slot, PROVIDER_SLOTS)) await invalid(i18n.errors.invalidInput);
    if (connectionId === null) {
      await db
        .delete(projectProviderChoice)
        .where(and(eq(projectProviderChoice.projectId, projectId), eq(projectProviderChoice.slot, slot)));
    } else {
      const connection = await connectionFor(organizationId, slot, connectionId);
      // Typed by hand; diarization has no model.
      const name = slot === 'diarization' ? null : await requiredText(model, 200);
      await db
        .insert(projectProviderChoice)
        .values({ projectId, slot, connectionId: connection.id, model: name })
        .onConflictDoUpdate({
          target: [projectProviderChoice.projectId, projectProviderChoice.slot],
          set: { connectionId: connection.id, model: name },
        });
    }
    log('info', `provider choice changed: ${slot}`, { project_id: projectId, user_id: user.id });
    revalidatePath(`/${projectId}`, 'layout');
    return getProjectProviders(projectId);
  });
}

/**
 * Model names the provider offers, for the model field; empty on any failure, and the field then
 * stays a plain text field. Project admins.
 */
export async function getProviderModels(
  projectId: string,
  slot: ProviderKind,
  connectionId: string
): Promise<string[]> {
  const { organizationId } = await requireProjectAccess(uuid(projectId), 'ADMIN');
  if (slot !== 'speech' && slot !== 'llm') return [];
  const connection = await connectionFor(organizationId, slot, connectionId);
  let key: string | null = null;
  try {
    key = connection.apiKeyEncrypted ? decryptSecret(connection.apiKeyEncrypted) : null;
  } catch {
    return [];
  }
  return fetchModelNames(connection.baseUrl, key);
}
