'use server';

import { asc, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

import { i18n } from '@/i18n/constants';
import { requireOrgRole, requireUser } from '@/lib/access';
import { db } from '@/lib/db/client';
import { organizationMembers, organizations } from '@/lib/db/schema/app';
import { deleteOrganization as deleteOrganizationRows } from '@/lib/deletion';
import { log } from '@/lib/log';
import type { OrganizationResponse, OrgRole, UpdateOrganizationRequest } from '@/lib/types';

import { conflict, invalid, optionalText, requiredText, uuid } from './helpers';
import { type ActionResult } from './result';
import { runAction } from './run';

// The open-source edition has one organisation with one owner, created by /setup. Invitations, more
// members, removing members, more organisations and resets by an admin belong to the commercial fork
// (under `ee/`). The role checks in lib/access.ts stay here, so the fork adds people without editing
// core files.

type OrgRow = typeof organizations.$inferSelect;

function toOrganization(row: OrgRow, role: OrgRole): OrganizationResponse {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    logoUrl: row.logoUrl ?? undefined,
    useCase: row.useCase ?? undefined,
    allowMemberProjectCreate: row.allowMemberProjectCreate,
    twoFaRequired: row.twoFaRequired,
    role,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getOrganizations(): Promise<OrganizationResponse[]> {
  const user = await requireUser();
  const rows = await db
    .select({ org: organizations, role: organizationMembers.role })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(eq(organizationMembers.userId, user.id))
    .orderBy(asc(organizations.createdAt));
  return rows.map((r) => toOrganization(r.org, r.role));
}

export async function getOrganization(organizationId: string): Promise<OrganizationResponse> {
  const { role } = await requireOrgRole(uuid(organizationId), 'MEMBER');
  const [row] = await db.select().from(organizations).where(eq(organizations.id, organizationId));
  return toOrganization(row, role);
}

export async function updateOrganization(
  organizationId: string,
  input: UpdateOrganizationRequest
): Promise<ActionResult<OrganizationResponse>> {
  return runAction(async () => {
    const { user, role } = await requireOrgRole(uuid(organizationId), 'ADMIN');
    const patch: Partial<typeof organizations.$inferInsert> = {};
    if (input?.name !== undefined) patch.name = await requiredText(input.name, 100);
    if (input?.description !== undefined) patch.description = await optionalText(input.description, 500);
    if (input?.allowMemberProjectCreate !== undefined) {
      if (typeof input.allowMemberProjectCreate !== 'boolean') await invalid(i18n.errors.invalidInput);
      patch.allowMemberProjectCreate = input.allowMemberProjectCreate;
    }
    if (input?.twoFaRequired !== undefined) {
      if (typeof input.twoFaRequired !== 'boolean') await invalid(i18n.errors.invalidInput);
      // Turning it on without 2FA of one's own would lock the person out of this very page.
      if (input.twoFaRequired && !user.twoFactorEnabled) await invalid(i18n.errors.twoFactorFirst);
      patch.twoFaRequired = input.twoFaRequired;
    }
    if (Object.keys(patch).length === 0) return getOrganization(organizationId);
    const [row] = await db.update(organizations).set(patch).where(eq(organizations.id, organizationId)).returning();
    revalidatePath('/', 'layout');
    return toOrganization(row, role);
  });
}

/** Deletes the organisation with every project and call in it, for good. Owners only. */
export async function deleteOrganization(organizationId: string): Promise<ActionResult> {
  return runAction(async () => {
    const { user } = await requireOrgRole(uuid(organizationId), 'OWNER');
    // Core has no way to make another organisation (/setup closes once a user exists), so deleting
    // the only one would leave an install nobody can use. The commercial fork has more than one.
    const mine = await db
      .select({ id: organizationMembers.organizationId })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, user.id))
      .limit(2);
    if (mine.length < 2) await conflict(i18n.organization.danger.lastOrganization);
    await deleteOrganizationRows(organizationId);
    log('info', 'organisation deleted', { user_id: user.id });
    revalidatePath('/', 'layout');
  });
}
