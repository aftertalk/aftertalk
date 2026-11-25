// The Personal data rule of the Access control section: organisation owners and admins may always
// load original text and audio; an organisation member may when the project's member_pii_access is
// `full`, whatever their project role.
import 'server-only';

import { eq } from 'drizzle-orm';

import { type OrgRole, orgRoleAtLeast } from '@/lib/access';
import { db } from '@/lib/db/client';
import { projects } from '@/lib/db/schema/app';

export async function mayUsePersonalData(projectId: string, orgRole: OrgRole): Promise<boolean> {
  if (orgRoleAtLeast(orgRole, 'ADMIN')) return true;
  const [project] = await db
    .select({ access: projects.memberPiiAccess })
    .from(projects)
    .where(eq(projects.id, projectId));
  return project?.access === 'full';
}
