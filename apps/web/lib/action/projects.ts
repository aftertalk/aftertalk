'use server';

import { and, asc, eq, exists, or, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { getLocale } from 'next-intl/server';

import { i18n } from '@/i18n/constants';
import { orgRoleAtLeast, requireOrgRole, requireProjectAccess, requireUser } from '@/lib/access';
import { db } from '@/lib/db/client';
import { LANGUAGES, organizationMembers, PII_ACCESS, projectMembers, projects } from '@/lib/db/schema/app';
import { deleteProject as deleteProjectRows } from '@/lib/deletion';
import { log } from '@/lib/log';
import type { MemberPiiAccess, MyProjectAccessResponse, ProjectResponse, SupportedLanguage } from '@/lib/types';

import { invalid, oneOf, optionalText, requiredText, uuid } from './helpers';
import { type ActionResult, ForbiddenError, runAction } from './result';

type ProjectRow = typeof projects.$inferSelect;

function toProject(row: ProjectRow): ProjectResponse {
  const allowedLanguages = row.allowedLanguages as SupportedLanguage[];
  return {
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    description: row.description ?? undefined,
    defaultLanguage: allowedLanguages[0],
    allowedLanguages,
    memberPiiAccess: row.memberPiiAccess,
    retentionDays: row.retentionDays,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Every project the user can see, in every organisation they belong to. */
export async function getProjects(): Promise<ProjectResponse[]> {
  const user = await requireUser();
  const rows = await db
    .select({ project: projects })
    .from(projects)
    .innerJoin(
      organizationMembers,
      and(eq(organizationMembers.organizationId, projects.organizationId), eq(organizationMembers.userId, user.id))
    )
    .where(
      or(
        sql`${organizationMembers.role} in ('OWNER', 'ADMIN')`,
        eq(projects.visibility, 'ORG'),
        exists(
          db
            .select({ one: sql`1` })
            .from(projectMembers)
            .where(and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, user.id)))
        )
      )
    )
    .orderBy(asc(projects.createdAt));
  return rows.map((r) => toProject(r.project));
}

export async function getProject(projectId: string): Promise<ProjectResponse> {
  await requireProjectAccess(uuid(projectId), 'VIEWER');
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId));
  return toProject(row);
}

/** The signed-in user's role in the project. */
export async function getMyProjectRole(projectId: string): Promise<MyProjectAccessResponse> {
  const { role, orgRole } = await requireProjectAccess(uuid(projectId), 'VIEWER');
  return { role, orgRole };
}

export async function createProject(input: {
  name: string;
  description?: string | null;
  organizationId?: string;
}): Promise<ActionResult<ProjectResponse>> {
  return runAction(async () => {
    const user = await requireUser();
    let organizationId = input?.organizationId;
    if (!organizationId) {
      const [first] = await db
        .select({ id: organizationMembers.organizationId })
        .from(organizationMembers)
        .where(eq(organizationMembers.userId, user.id))
        .orderBy(asc(organizationMembers.joinedAt))
        .limit(1);
      organizationId = first?.id;
    }
    const { role } = await requireOrgRole(uuid(organizationId), 'MEMBER', user);
    if (!orgRoleAtLeast(role, 'ADMIN')) {
      const [org] = await db.query.organizations.findMany({
        columns: { allowMemberProjectCreate: true },
        where: (o, { eq }) => eq(o.id, organizationId!),
      });
      if (!org?.allowMemberProjectCreate) throw new ForbiddenError();
    }
    const name = await requiredText(input?.name, 100);
    const description = await optionalText(input?.description, 500);
    const language: SupportedLanguage = (await getLocale()) === 'pl' ? 'pl' : 'en';

    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(projects)
        .values({ organizationId: organizationId!, name, description, allowedLanguages: [language] })
        .returning();
      // A member who creates a project administers it; owners and admins already do.
      if (role === 'MEMBER') {
        await tx
          .insert(projectMembers)
          .values({ projectId: created.id, userId: user.id, role: 'ADMIN', addedBy: user.id });
      }
      return created;
    });
    // The project list lives in the app-wide layout (the picker in the sidebar).
    revalidatePath('/', 'layout');
    return toProject(row);
  });
}

export type UpdateProjectInput = Partial<{
  name: string;
  description: string | null;
  allowedLanguages: string[];
  memberPiiAccess: MemberPiiAccess;
  retentionDays: number | null;
}>;

export async function updateProject(
  projectId: string,
  input: UpdateProjectInput
): Promise<ActionResult<ProjectResponse>> {
  return runAction(async () => {
    const { user, organizationId } = await requireProjectAccess(uuid(projectId), 'ADMIN');
    const patch: Partial<typeof projects.$inferInsert> = {};
    if (input?.name !== undefined) patch.name = await requiredText(input.name, 100);
    if (input?.description !== undefined) patch.description = await optionalText(input.description, 500);
    if (input?.allowedLanguages !== undefined) {
      const langs = input.allowedLanguages;
      if (!Array.isArray(langs) || langs.length === 0 || !langs.every((l) => oneOf(l, LANGUAGES))) {
        await invalid(i18n.errors.languages);
      }
      patch.allowedLanguages = [...new Set(langs)];
    }
    if (input?.retentionDays !== undefined) {
      const days = input.retentionDays;
      if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650))
        await invalid(i18n.errors.retentionDays);
      patch.retentionDays = days;
    }
    let accessChange: MemberPiiAccess | null = null;
    if (input?.memberPiiAccess !== undefined) {
      // Only organisation owners and admins may change who sees original text and audio (item 37b).
      await requireOrgRole(organizationId, 'ADMIN', user);
      if (!oneOf(input.memberPiiAccess, PII_ACCESS)) await invalid(i18n.errors.invalidInput);
      patch.memberPiiAccess = input.memberPiiAccess;
      accessChange = input.memberPiiAccess;
    }
    if (Object.keys(patch).length === 0) return getProject(projectId);
    const [row] = await db.update(projects).set(patch).where(eq(projects.id, projectId)).returning();
    if (accessChange)
      log('info', `member_pii_access set to ${accessChange}`, { project_id: projectId, user_id: user.id });
    revalidatePath(`/${projectId}`, 'layout');
    return toProject(row);
  });
}

/** Deletes the project and every call in it, for good. */
export async function deleteProject(projectId: string): Promise<void> {
  await requireProjectAccess(uuid(projectId), 'ADMIN');
  await deleteProjectRows(projectId);
  revalidatePath('/', 'layout');
}
