'use server';

import { asc, eq } from 'drizzle-orm';

import { requireUser } from '@/lib/access';
import { db } from '@/lib/db/client';
import { organizationMembers, organizations } from '@/lib/db/schema/app';

// The open-source edition has one organisation with one owner, created by /setup. Invitations, more
// members, removing members and resets by an admin belong to the commercial fork (under `ee/`).
// The role checks in lib/access.ts stay here, so the fork adds people without editing core files.

export type OrganizationSummary = { id: string; name: string; role: 'OWNER' | 'ADMIN' | 'MEMBER' };

export async function getOrganizations(): Promise<OrganizationSummary[]> {
  const user = await requireUser();
  return db
    .select({ id: organizations.id, name: organizations.name, role: organizationMembers.role })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(eq(organizationMembers.userId, user.id))
    .orderBy(asc(organizations.createdAt));
}
