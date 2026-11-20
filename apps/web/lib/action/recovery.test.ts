// #73 / item 30: who may reset whom, what a reset does, and removing members.
import { eq } from 'drizzle-orm';

import { getSessionUser } from '@/lib/access';
import { auth } from '@/lib/auth/auth';
import { takePasswordResetNotice } from '@/lib/auth/reset-notice';
import { db, sql } from '@/lib/db/client';
import { organizationMembers } from '@/lib/db/schema/app';
import { user as userTable } from '@/lib/db/schema/auth';
import { addMember, makeOrg, makeUser, resetDb, signIn } from '@/test/fixtures';

import { createPasswordResetLink, removeOrganizationMember, resetTwoFactor } from './organizations';

afterAll(() => sql.end());
beforeEach(resetDb);

async function team() {
  const owner = await makeUser('Owner');
  const orgId = await makeOrg(owner);
  const admin = await makeUser('Admin');
  const member = await makeUser('Member');
  await addMember(orgId, admin, 'ADMIN');
  await addMember(orgId, member, 'MEMBER');
  return { owner, admin, member, orgId };
}

/** What the /reset-password page does with the link: posts the token and the new password. */
async function useResetLink(link: string, newPassword: string) {
  const token = new URL(link).searchParams.get('token')!;
  return auth.api.resetPassword({ body: { token, newPassword } });
}

test('an admin resets a member: one-hour link works once, sessions end, the notice shows once', async () => {
  const { admin, member } = await team();
  await signIn(member.email);
  const [{ n: before }] = await sql<
    { n: number }[]
  >`select count(*)::int n from auth.session where user_id = ${member.id}`;
  expect(before).toBe(1);

  await signIn(admin.email);
  const result = await createPasswordResetLink(member.id);
  expect(result.ok).toBe(true);
  const { link } = (result as { ok: true; data: { link: string } }).data;
  expect(link).toMatch(/^http:\/\/localhost:3000\/reset-password\?token=[A-Za-z0-9]{32}$/);

  // The old password stops working at once (pentest M2), and a second link replaces the first.
  await expect(signIn(member.email)).rejects.toThrow();
  await signIn(admin.email);
  const second = await createPasswordResetLink(member.id);
  const secondLink = (second as { ok: true; data: { link: string } }).data.link;
  await expect(useResetLink(link, 'a brand new password')).rejects.toThrow();
  await signIn(admin.email);

  const [{ n: after }] = await sql<
    { n: number }[]
  >`select count(*)::int n from auth.session where user_id = ${member.id}`;
  expect(after).toBe(0);

  await useResetLink(secondLink, 'a brand new password');
  await expect(useResetLink(secondLink, 'another one again')).rejects.toThrow();

  await signIn(member.email, 'a brand new password');
  expect((await getSessionUser())?.id).toBe(member.id);
  const notice = await takePasswordResetNotice(member.id);
  expect(notice?.by).toBe('Admin');
  expect(await takePasswordResetNotice(member.id)).toBeNull();
});

test('only someone above the target, and only when the target has one organisation', async () => {
  const { owner, admin, member, orgId } = await team();
  const otherAdmin = await makeUser('Admin2');
  await addMember(orgId, otherAdmin, 'ADMIN');

  await signIn(admin.email);
  expect((await createPasswordResetLink(otherAdmin.id)).ok).toBe(false); // same role
  expect((await createPasswordResetLink(owner.id)).ok).toBe(false); // above
  expect((await createPasswordResetLink(admin.id)).ok).toBe(false); // self
  expect((await resetTwoFactor(member.id)).ok).toBe(false); // owners only

  const elsewhere = await makeOrg(await makeUser('Elsewhere'));
  await addMember(elsewhere, member, 'MEMBER');
  await signIn(owner.email);
  const refused = await createPasswordResetLink(member.id);
  expect(refused.ok).toBe(false);
  expect((refused as { error: string }).error).toMatch(/several organizations/);

  // Someone outside every organisation of the target sees "not found".
  const stranger = await makeUser('Stranger');
  await makeOrg(stranger);
  await signIn(stranger.email);
  expect(await createPasswordResetLink(admin.id)).toEqual({ ok: false, error: 'Not found' });
});

test('an owner turns off 2FA for an admin and ends their sessions', async () => {
  const { owner, admin } = await team();
  await db.update(userTable).set({ twoFactorEnabled: true }).where(eq(userTable.id, admin.id));
  await signIn(admin.email);
  await signIn(owner.email);
  expect((await resetTwoFactor(admin.id)).ok).toBe(true);
  const [row] = await db.select().from(userTable).where(eq(userTable.id, admin.id));
  expect(row.twoFactorEnabled).toBe(false);
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int n from auth.session where user_id = ${admin.id}`;
  expect(n).toBe(0);
});

test('removing members: admins remove non-owners, the last owner stays, a user left with no organisation is signed out', async () => {
  const { owner, admin, member, orgId } = await team();

  await signIn(admin.email);
  expect((await removeOrganizationMember(orgId, owner.id)).ok).toBe(false);
  await signIn(member.email);
  await signIn(admin.email);
  expect((await removeOrganizationMember(orgId, member.id)).ok).toBe(true);
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int n from auth.session where user_id = ${member.id}`;
  expect(n).toBe(0);

  await signIn(owner.email);
  expect(await removeOrganizationMember(orgId, owner.id)).toMatchObject({ ok: false });
  const co = await makeUser('CoOwner');
  await addMember(orgId, co, 'OWNER');
  expect((await removeOrganizationMember(orgId, owner.id)).ok).toBe(true);
  const left = await db.select().from(organizationMembers).where(eq(organizationMembers.organizationId, orgId));
  expect(left.map((m) => m.userId).sort()).toEqual([admin.id, co.id].sort());
});

test('a member learns nothing about a target in several organisations', async () => {
  const { owner, member, orgId } = await team();
  void orgId;
  await addMember(await makeOrg(await makeUser('Elsewhere')), owner, 'MEMBER');
  await signIn(member.email);
  const refused = await createPasswordResetLink(owner.id);
  expect(refused).toEqual({ ok: false, error: 'You can only do this for someone whose role is below yours' });
});

test('two owners removing each other at once: one wins, the organisation keeps an owner', async () => {
  const { owner, orgId } = await team();
  const co = await makeUser('CoOwner');
  await addMember(orgId, co, 'OWNER');
  // Two "browsers": each signs in, keeps its cookie jar, then both remove the other concurrently.
  const { testCookies } = await import('@/test/next-headers');
  await signIn(owner.email);
  const ownerJar = testCookies.snapshot();
  await signIn(co.email);
  const coJar = testCookies.snapshot();
  // Drizzle runs both transactions on separate pool connections; the cookie jar is read at the start
  // of each action, so switch jars between the two calls before awaiting.
  testCookies.restore(ownerJar);
  const a = removeOrganizationMember(orgId, co.id);
  await new Promise((r) => setTimeout(r, 0));
  testCookies.restore(coJar);
  const b = removeOrganizationMember(orgId, owner.id);
  const results = await Promise.all([a, b]);
  const owners = await db.select().from(organizationMembers).where(eq(organizationMembers.organizationId, orgId));
  expect(owners.filter((m) => m.role === 'OWNER')).toHaveLength(1);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
});

test('removing a member also removes their project roles in that organisation', async () => {
  const { owner, member, orgId } = await team();
  const { makeProject, addProjectMember } = await import('@/test/fixtures');
  const project = await makeProject(orgId, { visibility: 'PRIVATE' });
  await addProjectMember(project, member, 'ADMIN');
  await signIn(owner.email);
  expect((await removeOrganizationMember(orgId, member.id)).ok).toBe(true);
  const [{ n }] = await sql<
    { n: number }[]
  >`select count(*)::int n from app.project_members where user_id = ${member.id}`;
  expect(n).toBe(0);
});
