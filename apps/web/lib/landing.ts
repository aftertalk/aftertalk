// Item 18b: where `/` sends a signed-in user. The organisation and project used last (preferLastUsed),
// if they can still see them; otherwise the first, oldest organisation first.
import 'server-only';

import { and, asc, eq } from 'drizzle-orm';

import { effectiveProjectRole, type OrgRole, type ProjectRole } from '@/lib/access';
import { db } from '@/lib/db/client';
import { organizationMembers, organizations, projectMembers, projects } from '@/lib/db/schema/app';
import { preferLastUsed } from '@/lib/utils/last-used';

export type Landing =
  | { kind: 'project'; projectId: string }
  | { kind: 'no-organization' }
  /** In an organisation, but no project they can see (none made yet, or all private). */
  | { kind: 'no-project'; orgRole: OrgRole };

export async function landingFor(userId: string): Promise<Landing> {
  const rows = await db
    .select({
      organizationId: organizationMembers.organizationId,
      orgRole: organizationMembers.role,
      projectId: projects.id,
      visibility: projects.visibility,
      defaultRole: projects.defaultRole,
      memberRole: projectMembers.role,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .leftJoin(projects, eq(projects.organizationId, organizationMembers.organizationId))
    .leftJoin(projectMembers, and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, userId)))
    .where(eq(organizationMembers.userId, userId))
    .orderBy(asc(organizations.createdAt), asc(projects.createdAt));
  if (rows.length === 0) return { kind: 'no-organization' };

  const visible: { id: string; organizationId: string }[] = [];
  for (const r of rows) {
    if (!r.projectId || !r.visibility || !r.defaultRole) continue;
    const role = effectiveProjectRole({
      orgRole: r.orgRole,
      memberRole: r.memberRole as ProjectRole | null,
      visibility: r.visibility,
      defaultRole: r.defaultRole,
    });
    if (role) visible.push({ id: r.projectId, organizationId: r.organizationId });
  }

  const prefer = await preferLastUsed();
  const orgs = [...new Map(rows.map((r) => [r.organizationId, { id: r.organizationId, role: r.orgRole }])).values()];
  const org = prefer.org(orgs)!;
  // Last-used project if still visible; else the first in the last-used organisation; else any.
  const project = prefer.project(visible.filter((p) => p.organizationId === org.id)) ?? prefer.project(visible);
  if (!project) return { kind: 'no-project', orgRole: org.role };
  return { kind: 'project', projectId: project.id };
}
