import { eq } from 'drizzle-orm';

import { db, sql } from '@/lib/db/client';
import { user as userTable } from '@/lib/db/schema/auth';
import { addMember, addProjectMember, makeOrg, makeProject, makeUser, resetDb, signIn } from '@/test/fixtures';
import { testCookies } from '@/test/next-headers';

import { effectiveProjectRole, requireOrgRole, requireProjectAccess, UnauthorizedError } from './access';
import { ForbiddenError, NotFoundError, TwoFactorRequiredError } from './action/result';

afterAll(() => sql.end());

describe('effectiveProjectRole (as PermissionEvaluator.kt)', () => {
  test.each([
    // orgRole, memberRole, visibility, defaultRole → expected
    ['OWNER', null, 'PRIVATE', 'VIEWER', 'ADMIN'],
    ['ADMIN', 'VIEWER', 'PRIVATE', 'VIEWER', 'ADMIN'],
    ['MEMBER', null, 'ORG', 'VIEWER', 'VIEWER'],
    ['MEMBER', null, 'ORG', 'EDITOR', 'EDITOR'],
    ['MEMBER', null, 'PRIVATE', 'EDITOR', null],
    ['MEMBER', 'VIEWER', 'ORG', 'EDITOR', 'EDITOR'],
    ['MEMBER', 'ADMIN', 'ORG', 'VIEWER', 'ADMIN'],
    ['MEMBER', 'EDITOR', 'PRIVATE', 'ADMIN', 'EDITOR'],
    [null, 'ADMIN', 'ORG', 'ADMIN', null],
  ] as const)('%s / %s / %s / default %s → %s', (orgRole, memberRole, visibility, defaultRole, expected) => {
    expect(effectiveProjectRole({ orgRole, memberRole, visibility, defaultRole })).toBe(expected);
  });
});

describe('requireProjectAccess and requireOrgRole', () => {
  beforeEach(resetDb);

  test('signed out → 401', async () => {
    testCookies.clear();
    await expect(requireOrgRole('00000000-0000-0000-0000-000000000000', 'MEMBER')).rejects.toBeInstanceOf(
      UnauthorizedError
    );
  });

  test('no role → 404, role too low → 403, enough → the role', async () => {
    const owner = await makeUser('Owner');
    const orgId = await makeOrg(owner);
    const open = await makeProject(orgId, { visibility: 'ORG', defaultRole: 'VIEWER' });
    const closed = await makeProject(orgId, { visibility: 'PRIVATE' });

    const outsider = await makeUser('Outsider');
    await signIn(outsider.email);
    await expect(requireProjectAccess(open, 'VIEWER')).rejects.toBeInstanceOf(NotFoundError);
    await expect(requireOrgRole(orgId, 'MEMBER')).rejects.toBeInstanceOf(NotFoundError);

    const member = await makeUser('Member');
    await addMember(orgId, member, 'MEMBER');
    await signIn(member.email);
    expect((await requireProjectAccess(open, 'VIEWER')).role).toBe('VIEWER');
    await expect(requireProjectAccess(open, 'EDITOR')).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requireProjectAccess(closed, 'VIEWER')).rejects.toBeInstanceOf(NotFoundError);
    await expect(requireOrgRole(orgId, 'ADMIN')).rejects.toBeInstanceOf(ForbiddenError);

    await addProjectMember(closed, member, 'EDITOR');
    expect((await requireProjectAccess(closed, 'EDITOR')).role).toBe('EDITOR');

    await signIn(owner.email);
    expect((await requireProjectAccess(closed, 'ADMIN')).role).toBe('ADMIN');
    expect((await requireOrgRole(orgId, 'OWNER')).role).toBe('OWNER');
  });

  test('a project_members row in another organisation grants nothing', async () => {
    const owner = await makeUser('Owner');
    const orgId = await makeOrg(owner);
    const project = await makeProject(orgId, { visibility: 'PRIVATE' });
    const removed = await makeUser('Removed');
    await addProjectMember(project, removed, 'ADMIN'); // left behind after leaving the organisation
    await signIn(removed.email);
    await expect(requireProjectAccess(project, 'VIEWER')).rejects.toBeInstanceOf(NotFoundError);
  });

  test('an organisation that requires 2FA refuses a member without it', async () => {
    const owner = await makeUser('Owner');
    const orgId = await makeOrg(owner, { twoFaRequired: true });
    const project = await makeProject(orgId);
    await signIn(owner.email);
    await expect(requireProjectAccess(project, 'VIEWER')).rejects.toBeInstanceOf(TwoFactorRequiredError);
    await expect(requireOrgRole(orgId, 'MEMBER')).rejects.toBeInstanceOf(TwoFactorRequiredError);

    await db.update(userTable).set({ twoFactorEnabled: true }).where(eq(userTable.id, owner.id));
    expect((await requireProjectAccess(project, 'VIEWER')).role).toBe('ADMIN');
  });

  test('a removed user is signed out at once (no cookie cache)', async () => {
    const owner = await makeUser('Owner');
    const orgId = await makeOrg(owner);
    await signIn(owner.email);
    expect((await requireOrgRole(orgId, 'OWNER')).role).toBe('OWNER');
    await sql`delete from auth.session where user_id = ${owner.id}`;
    await expect(requireOrgRole(orgId, 'MEMBER')).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
