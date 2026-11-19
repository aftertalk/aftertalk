// Item 18b: where `/` sends a signed-in user. The last project they opened (a cookie the project layout
// sets), if they can still see it; otherwise the first project they can see, oldest organisation first.
import 'server-only';

import { and, asc, eq } from 'drizzle-orm';
import { cookies } from 'next/headers';

import { effectiveProjectRole } from '@/lib/access';
import { db } from '@/lib/db/client';
import { organizationMembers, organizations, projectMembers, projects } from '@/lib/db/schema/app';

export const LAST_PROJECT_COOKIE = 'atLastProject';

export type Landing = { kind: 'project'; projectId: string } | { kind: 'no-organization' } | { kind: 'no-project' };

export async function landingFor(userId: string): Promise<Landing> {
  const rows = await db
    .select({
      projectId: projects.id,
      visibility: projects.visibility,
      defaultRole: projects.defaultRole,
      orgRole: organizationMembers.role,
      memberRole: projectMembers.role,
      organizationId: organizationMembers.organizationId,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .leftJoin(projects, eq(projects.organizationId, organizationMembers.organizationId))
    .leftJoin(projectMembers, and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, userId)))
    .where(eq(organizationMembers.userId, userId))
    .orderBy(asc(organizations.createdAt), asc(projects.createdAt));
  if (rows.length === 0) return { kind: 'no-organization' };

  const visible = rows
    .filter(
      (
        r
      ): r is typeof r & {
        projectId: string;
        visibility: 'ORG' | 'PRIVATE';
        defaultRole: 'VIEWER' | 'EDITOR' | 'ADMIN';
      } => !!r.projectId && !!r.visibility && !!r.defaultRole
    )
    .filter((r) => effectiveProjectRole(r) !== null)
    .map((r) => r.projectId);
  if (visible.length === 0) return { kind: 'no-project' };

  const last = (await cookies()).get(LAST_PROJECT_COOKIE)?.value;
  return { kind: 'project', projectId: last && visible.includes(last) ? last : visible[0] };
}
