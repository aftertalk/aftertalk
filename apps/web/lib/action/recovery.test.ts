// #73 / item 30: who may reset whom, what a reset does, and removing members.
import { eq } from 'drizzle-orm';

import { getSessionUser } from '@/lib/access';
import { auth } from '@/lib/auth/auth';
import { db, sql } from '@/lib/db/client';
import { organizationMembers } from '@/lib/db/schema/app';
import { user as userTable } from '@/lib/db/schema/auth';
import { addMember, makeOrg, makeUser, resetDb, signIn } from '@/test/fixtures';

import {
  createPasswordResetLink,
  removeOrganizationMember,
  resetTwoFactor,
  takePasswordResetNotice,
} from './organizations';

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

/** Follows the link the way a browser does: Better Auth's callback, then /reset-password?token=. */
async function useResetLink(link: string, newPassword: string) {
  const res = await auth.handler(new Request(link));
  const location = res.headers.get('location')!;
  const token = new URL(location, 'http://localhost:3000').searchParams.get('token')!;
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
  expect(link).toContain('/api/auth/reset-password/');

  const [{ n: after }] = await sql<
    { n: number }[]
  >`select count(*)::int n from auth.session where user_id = ${member.id}`;
  expect(after).toBe(0);

  await useResetLink(link, 'a brand new password');
  await expect(useResetLink(link, 'another one again')).rejects.toThrow();

  await signIn(member.email, 'a brand new password');
  expect((await getSessionUser())?.id).toBe(member.id);
  const notice = await takePasswordResetNotice();
  expect(notice?.by).toBe('Admin');
  expect(await takePasswordResetNotice()).toBeNull();
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
