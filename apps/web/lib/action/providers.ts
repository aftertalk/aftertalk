'use server';

import { and, asc, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

import { i18n } from '@/i18n/constants';
import { requireOrgRole } from '@/lib/access';
import { db } from '@/lib/db/client';
import { DATA_LOCATIONS, projectProviderChoice, PROVIDER_SLOTS, providerConnections } from '@/lib/db/schema/app';
import { log } from '@/lib/log';
import { type BaseUrlProblem, cleanBaseUrl } from '@/lib/providers';
import { encryptSecret } from '@/lib/secrets';
import type { DataLocation, ProviderConnection, ProviderKind } from '@/lib/types';

import { conflict, invalid, isUniqueViolation, oneOf, requiredText, uuid } from './helpers';
import { type ActionResult, NotFoundError } from './result';
import { runAction } from './run';

// Provider connections (item 37d): organisation owners and admins only. The key is stored encrypted
// (lib/secrets.ts) and never returned to the browser after saving.
const MAX_CONNECTIONS = 50;
const MAX_KEY = 500;

const ADAPTER = { speech: 'openai-compatible', llm: 'openai-compatible', diarization: 'pyannote-ai' } as const;

const URL_MESSAGE: Record<BaseUrlProblem, string> = {
  invalid: i18n.providers.errors.baseUrl,
  resource_path: i18n.providers.errors.baseUrlResource,
  host_not_allowed: i18n.providers.errors.hostNotAllowed,
};

async function baseUrl(raw: unknown): Promise<string> {
  const result = cleanBaseUrl(raw);
  if ('problem' in result) return invalid(URL_MESSAGE[result.problem]);
  return result.url;
}

async function apiKey(raw: unknown): Promise<string> {
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > MAX_KEY) {
    return invalid(i18n.providers.errors.apiKey);
  }
  return raw.trim();
}

async function load(organizationId: string, id?: string): Promise<ProviderConnection[]> {
  const rows = await db
    .select({
      connection: providerConnections,
      inUse: sql<boolean>`exists (select 1 from ${projectProviderChoice}
        where ${projectProviderChoice.connectionId} = ${providerConnections.id})`,
    })
    .from(providerConnections)
    .where(and(eq(providerConnections.organizationId, organizationId), id ? eq(providerConnections.id, id) : undefined))
    .orderBy(asc(providerConnections.kind), asc(providerConnections.name));
  return rows.map(({ connection: c, inUse }) => ({
    id: c.id,
    kind: c.kind,
    adapter: c.adapter,
    name: c.name,
    baseUrl: c.baseUrl,
    hasApiKey: c.apiKeyEncrypted !== null,
    dataLocation: c.dataLocation,
    wordTimes: c.wordTimes,
    inUse,
    createdAt: c.createdAt.toISOString(),
  }));
}

/** The connection with its organisation, after checking the caller administers that organisation. */
async function owned(id: string) {
  const [row] = await db
    .select({
      id: providerConnections.id,
      organizationId: providerConnections.organizationId,
      baseUrl: providerConnections.baseUrl,
      hasKey: sql<boolean>`${providerConnections.apiKeyEncrypted} is not null`,
    })
    .from(providerConnections)
    .where(eq(providerConnections.id, uuid(id)));
  // Checked before the role, so an id from another organisation answers like one that does not exist.
  if (!row) throw new NotFoundError();
  const { user } = await requireOrgRole(row.organizationId, 'ADMIN');
  return { ...row, user };
}

export async function getProviderConnections(organizationId: string): Promise<ProviderConnection[]> {
  await requireOrgRole(uuid(organizationId), 'ADMIN');
  return load(organizationId);
}

export async function createProviderConnection(
  organizationId: string,
  input: { name: string; kind: ProviderKind; baseUrl: string; apiKey?: string; dataLocation: DataLocation }
): Promise<ActionResult<ProviderConnection>> {
  return runAction(async () => {
    const { user } = await requireOrgRole(uuid(organizationId), 'ADMIN');
    const name = await requiredText(input?.name, 80);
    if (!oneOf(input?.kind, PROVIDER_SLOTS) || !oneOf(input?.dataLocation, DATA_LOCATIONS)) {
      await invalid(i18n.errors.invalidInput);
    }
    const url = await baseUrl(input.baseUrl);
    const key = input.apiKey ? await apiKey(input.apiKey) : null;
    const existing = await db
      .select({ id: providerConnections.id })
      .from(providerConnections)
      .where(eq(providerConnections.organizationId, organizationId));
    if (existing.length >= MAX_CONNECTIONS) await invalid(i18n.errors.tooMany, { max: MAX_CONNECTIONS });
    try {
      const [row] = await db
        .insert(providerConnections)
        .values({
          organizationId,
          kind: input.kind,
          adapter: ADAPTER[input.kind],
          name,
          baseUrl: url,
          apiKeyEncrypted: key ? encryptSecret(key) : null,
          dataLocation: input.dataLocation,
          createdBy: user.id,
        })
        .returning({ id: providerConnections.id });
      log('info', 'provider connection added', { user_id: user.id });
      revalidatePath(`/organization/${organizationId}`, 'layout');
      return (await load(organizationId, row.id))[0];
    } catch (e) {
      if (isUniqueViolation(e)) await conflict(i18n.errors.nameTaken);
      throw e;
    }
  });
}

/**
 * Edits a connection in place (#63), including one in use, so a key is rotated without unassigning
 * it. Kind and adapter cannot change. An empty key keeps the stored one; `removeKey` clears it.
 */
export async function updateProviderConnection(
  id: string,
  input: { name?: string; baseUrl?: string; apiKey?: string; removeKey?: boolean; dataLocation?: DataLocation }
): Promise<ActionResult<ProviderConnection>> {
  return runAction(async () => {
    const current = await owned(id);
    const patch: Partial<typeof providerConnections.$inferInsert> = {};
    if (input?.name !== undefined) patch.name = await requiredText(input.name, 80);
    if (input?.baseUrl !== undefined) {
      patch.baseUrl = await baseUrl(input.baseUrl);
      if (patch.baseUrl !== current.baseUrl) {
        // The last test was of another address.
        patch.wordTimes = null;
        // A stored key is sent to whatever address the connection names. Moving a connection to
        // another origin (scheme, host or port: https to http would send it in clear text) must not
        // carry a key the person changing it may never have seen, so the key has to be typed again
        // (or removed) in the same change.
        const sameOrigin = new URL(patch.baseUrl).origin === new URL(current.baseUrl).origin;
        if (!sameOrigin && current.hasKey && !input.apiKey && input.removeKey !== true) {
          await invalid(i18n.providers.errors.keyAgain);
        }
      }
    }
    if (input?.dataLocation !== undefined) {
      if (!oneOf(input.dataLocation, DATA_LOCATIONS)) await invalid(i18n.errors.invalidInput);
      patch.dataLocation = input.dataLocation;
    }
    if (input?.removeKey === true) patch.apiKeyEncrypted = null;
    else if (input?.apiKey) patch.apiKeyEncrypted = encryptSecret(await apiKey(input.apiKey));
    try {
      await db
        .update(providerConnections)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(providerConnections.id, current.id));
    } catch (e) {
      if (isUniqueViolation(e)) await conflict(i18n.errors.nameTaken);
      throw e;
    }
    log('info', 'provider connection changed', { user_id: current.user.id });
    revalidatePath(`/organization/${current.organizationId}`, 'layout');
    return (await load(current.organizationId, current.id))[0];
  });
}

/** A connection in use by a project cannot be removed. */
export async function deleteProviderConnection(id: string): Promise<ActionResult> {
  return runAction(async () => {
    const current = await owned(id);
    const [used] = await db
      .select({ projectId: projectProviderChoice.projectId })
      .from(projectProviderChoice)
      .where(eq(projectProviderChoice.connectionId, current.id))
      .limit(1);
    if (used) await conflict(i18n.providers.errors.inUse);
    await db.delete(providerConnections).where(eq(providerConnections.id, current.id));
    log('info', 'provider connection removed', { user_id: current.user.id });
    revalidatePath(`/organization/${current.organizationId}`, 'layout');
  });
}

export type ProviderTestResult = { ok: true; latencyMs: number; wordTimes?: boolean } | { ok: false; code: string };

/**
 * Asks the engine to send one request through the connection. The engine route (`POST
 * /providers/test`) arrives in phase 4; until then the answer is the engine's own "could not reach
 * the provider" code, and a connection saves without a test.
 */
export async function testProviderConnection(id: string, model?: string): Promise<ActionResult<ProviderTestResult>> {
  return runAction(async () => {
    await owned(id);
    void model;
    return { ok: false, code: 'provider_unreachable' } as const;
  });
}
