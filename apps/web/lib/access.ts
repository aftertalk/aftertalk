// The one place roles are checked (item 27). Every server action and route handler calls
// requireOrgRole or requireProjectAccess. Rules as in the cloud's PermissionEvaluator.kt:
// org OWNER/ADMIN are project ADMIN everywhere in the org; a MEMBER gets the higher of their
// project_members role and, when visibility is ORG, the project's default_role. No role → not
// found (404); a role below the one asked → forbidden (403), or TwoFactorRequiredError when the
// organisation requires 2FA and the user has none (#64).
import 'server-only';

import { and, eq } from 'drizzle-orm';
import { headers } from 'next/headers';

import { auth } from '@/lib/auth/auth';
import { db } from '@/lib/db/client';
import { organizationMembers, organizations, projectMembers, projects } from '@/lib/db/schema/app';

import { BackendError, ForbiddenError, NotFoundError, TwoFactorRequiredError } from './action/result';

export type OrgRole = 'OWNER' | 'ADMIN' | 'MEMBER';
export type ProjectRole = 'VIEWER' | 'EDITOR' | 'ADMIN';

const ORG_RANK: Record<OrgRole, number> = { MEMBER: 0, ADMIN: 1, OWNER: 2 };
const PROJECT_RANK: Record<ProjectRole, number> = { VIEWER: 0, EDITOR: 1, ADMIN: 2 };

export const orgRoleAtLeast = (role: OrgRole, least: OrgRole) => ORG_RANK[role] >= ORG_RANK[least];
export const projectRoleAtLeast = (role: ProjectRole, least: ProjectRole) => PROJECT_RANK[role] >= PROJECT_RANK[least];

/** No session: routes answer 401, pages redirect to /login. */
export class UnauthorizedError extends BackendError {
  constructor() {
    super(401, 'Unauthorized');
    this.name = 'UnauthorizedError';
  }
}

export type SessionUser = { id: string; email: string; name: string; twoFactorEnabled: boolean };

/** The signed-in user, read from the database on every call (cookie cache is off). */
export async function getSessionUser(): Promise<SessionUser | null> {
  const result = await auth.api.getSession({ headers: await headers() });
  if (!result) return null;
  const u = result.user as typeof result.user & { twoFactorEnabled?: boolean | null };
  return { id: u.id, email: u.email, name: u.name, twoFactorEnabled: !!u.twoFactorEnabled };
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new UnauthorizedError();
  return user;
}

/** The pure rule, so it can be tested without a session. */
export function effectiveProjectRole(input: {
  orgRole: OrgRole | null;
  memberRole: ProjectRole | null;
  visibility: 'ORG' | 'PRIVATE';
  defaultRole: ProjectRole;
}): ProjectRole | null {
  if (!input.orgRole) return null; // not an organisation member: a project_members row does not count
  if (input.orgRole === 'OWNER' || input.orgRole === 'ADMIN') return 'ADMIN';
  const candidates: ProjectRole[] = [];
  if (input.memberRole) candidates.push(input.memberRole);
  if (input.visibility === 'ORG') candidates.push(input.defaultRole);
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (PROJECT_RANK[b] > PROJECT_RANK[a] ? b : a));
}

function checkTwoFactor(user: SessionUser, twoFaRequired: boolean) {
  if (twoFaRequired && !user.twoFactorEnabled) throw new TwoFactorRequiredError();
}

export async function requireOrgRole(
  organizationId: string,
  least: OrgRole,
  user?: SessionUser
): Promise<{ user: SessionUser; role: OrgRole }> {
  const u = user ?? (await requireUser());
  const [row] = await db
    .select({ role: organizationMembers.role, twoFaRequired: organizations.twoFaRequired })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, u.id)));
  if (!row) throw new NotFoundError();
  checkTwoFactor(u, row.twoFaRequired);
  if (!orgRoleAtLeast(row.role, least)) throw new ForbiddenError();
  return { user: u, role: row.role };
}

export async function requireProjectAccess(
  projectId: string,
  least: ProjectRole,
  user?: SessionUser
): Promise<{ user: SessionUser; role: ProjectRole; organizationId: string; orgRole: OrgRole }> {
  const u = user ?? (await requireUser());
  const [row] = await db
    .select({
      organizationId: projects.organizationId,
      visibility: projects.visibility,
      defaultRole: projects.defaultRole,
      twoFaRequired: organizations.twoFaRequired,
      orgRole: organizationMembers.role,
      memberRole: projectMembers.role,
    })
    .from(projects)
    .innerJoin(organizations, eq(organizations.id, projects.organizationId))
    .leftJoin(
      organizationMembers,
      and(eq(organizationMembers.organizationId, projects.organizationId), eq(organizationMembers.userId, u.id))
    )
    .leftJoin(projectMembers, and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, u.id)))
    .where(eq(projects.id, projectId));
  const role = row ? effectiveProjectRole(row) : null;
  if (!row || !role || !row.orgRole) throw new NotFoundError();
  checkTwoFactor(u, row.twoFaRequired);
  if (!projectRoleAtLeast(role, least)) throw new ForbiddenError();
  return { user: u, role, organizationId: row.organizationId, orgRole: row.orgRole };
}

/** For route handlers: maps the access errors to HTTP answers. */
export function accessErrorResponse(e: unknown): Response | null {
  if (e instanceof BackendError && e.status < 500) {
    return Response.json({ error: e.message }, { status: e.status });
  }
  return null;
}
