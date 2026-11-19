// Shared helpers for database tests: wipe the worker's database, make users and organisations, sign in.
import { auth } from '@/lib/auth/auth';
import { createUser } from '@/lib/auth/create-user';
import { db, sql } from '@/lib/db/client';
import { organizationMembers, organizations, projectMembers, projects } from '@/lib/db/schema/app';

import { testCookies } from './next-headers';

export const PASSWORD = 'correct horse battery';

export async function resetDb() {
  testCookies.clear();
  await sql`truncate auth."user", auth.verification, auth.rate_limit, app.organizations cascade`;
}

let n = 0;
export async function makeUser(name = 'User'): Promise<{ id: string; email: string }> {
  n += 1;
  const email = `${name.toLowerCase().replace(/\W+/g, '')}${n}@example.com`;
  const { id } = await createUser({ email, name, password: PASSWORD });
  return { id, email };
}

export async function makeOrg(owner: { id: string }, opts: { twoFaRequired?: boolean } = {}) {
  const [org] = await db
    .insert(organizations)
    .values({ name: 'Org', createdBy: owner.id, twoFaRequired: opts.twoFaRequired ?? false })
    .returning({ id: organizations.id });
  await db.insert(organizationMembers).values({ organizationId: org.id, userId: owner.id, role: 'OWNER' });
  return org.id;
}

export async function addMember(organizationId: string, user: { id: string }, role: 'OWNER' | 'ADMIN' | 'MEMBER') {
  await db.insert(organizationMembers).values({ organizationId, userId: user.id, role });
}

export async function makeProject(
  organizationId: string,
  opts: { visibility?: 'ORG' | 'PRIVATE'; defaultRole?: 'VIEWER' | 'EDITOR' | 'ADMIN' } = {}
) {
  const [p] = await db
    .insert(projects)
    .values({
      organizationId,
      name: 'Project',
      visibility: opts.visibility ?? 'ORG',
      defaultRole: opts.defaultRole ?? 'VIEWER',
      allowedLanguages: ['pl'],
    })
    .returning({ id: projects.id });
  return p.id;
}

export async function addProjectMember(projectId: string, user: { id: string }, role: 'VIEWER' | 'EDITOR' | 'ADMIN') {
  await db.insert(projectMembers).values({ projectId, userId: user.id, role });
}

/** Signs in through Better Auth; the session cookie lands in the test cookie jar. */
export async function signIn(email: string, password = PASSWORD) {
  testCookies.clear();
  await auth.api.signInEmail({ body: { email, password }, headers: new Headers() });
}
