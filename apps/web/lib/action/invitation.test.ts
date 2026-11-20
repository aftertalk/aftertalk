// Phase 1 "done when" (auto): an admin makes an invitation, the link opens on /activate, the person
// joins. Plus the ways a link must stop working.
import { and, eq } from 'drizzle-orm';

import ActivatePage from '@/app/activate/page';
import { Activate } from '@/components/auth/activate';
import { getSessionUser } from '@/lib/access';
import { db, sql } from '@/lib/db/client';
import { invitations, organizationMembers } from '@/lib/db/schema/app';
import { addMember, makeOrg, makeUser, PASSWORD, resetDb, signIn } from '@/test/fixtures';
import { testCookies } from '@/test/next-headers';

import {
  acceptInvitation,
  acceptInvitationAsNewUser,
  getInvitationByToken,
  inviteMembers,
  listInvitations,
  resendInvitation,
  revokeInvitation,
} from './organizations';

jest.mock('next-intl/server', () => jest.requireActual('@/test/intl-server'));

afterAll(() => sql.end());
beforeEach(resetDb);

async function openInvitations(orgId: string) {
  const r = await listInvitations(orgId);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

const tokenOf = (link: string) => new URL(link).searchParams.get('token')!;

async function adminWithOrg() {
  const owner = await makeUser('Owner');
  const orgId = await makeOrg(owner);
  await signIn(owner.email);
  return { owner, orgId };
}

async function invite(orgId: string, email: string, role: 'ADMIN' | 'MEMBER' = 'MEMBER') {
  const result = await inviteMembers(orgId, [{ email, role }]);
  if (!result.ok) throw new Error(result.error);
  return result.data[0].link;
}

/** Renders the /activate server page and returns the props it hands the Activate form. */
async function openActivatePage(token: string) {
  const page = await ActivatePage({ searchParams: Promise.resolve({ token }) });
  const child = (page as { props: { children: { type: unknown; props: Record<string, unknown> } } }).props.children;
  return child.type === Activate ? child.props : null;
}

test('invite → open the link on /activate → set a password → member of the organisation, signed in', async () => {
  const { orgId } = await adminWithOrg();
  const link = await invite(orgId, '  New.Person@Example.com ', 'ADMIN');
  expect(link).toMatch(/^http:\/\/localhost:3000\/activate\?token=/);

  // Only the hash is stored.
  const [row] = await db.select().from(invitations).where(eq(invitations.organizationId, orgId));
  expect(row.email).toBe('new.person@example.com');
  expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  expect(row.tokenHash).not.toContain(tokenOf(link));

  // A different browser opens the link.
  testCookies.clear();
  const props = await openActivatePage(tokenOf(link));
  expect(props).toMatchObject({ email: 'new.person@example.com', hasAccount: false, signedInEmail: null });

  const joined = await acceptInvitationAsNewUser(tokenOf(link), 'New Person', PASSWORD);
  expect(joined).toEqual({ ok: true, data: { organizationId: orgId } });

  const me = await getSessionUser();
  expect(me?.email).toBe('new.person@example.com');
  const [member] = await db
    .select()
    .from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, orgId), eq(organizationMembers.userId, me!.id)));
  expect(member.role).toBe('ADMIN');

  // The link works once.
  testCookies.clear();
  expect(await openActivatePage(tokenOf(link))).toBeNull();
  const again = await acceptInvitationAsNewUser(tokenOf(link), 'Someone', PASSWORD);
  expect(again.ok).toBe(false);
});

test('a revoked, expired or replaced link is refused', async () => {
  const { orgId } = await adminWithOrg();

  const revoked = await invite(orgId, 'a@example.com');
  const [{ id }] = await openInvitations(orgId);
  expect((await revokeInvitation(id)).ok).toBe(true);
  expect(await getInvitationByToken(tokenOf(revoked))).toBeNull();

  const expired = await invite(orgId, 'b@example.com');
  await db
    .update(invitations)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(invitations.email, 'b@example.com'));
  expect(await getInvitationByToken(tokenOf(expired))).toBeNull();

  const first = await invite(orgId, 'c@example.com');
  const [open] = (await openInvitations(orgId)).filter((i) => i.email === 'c@example.com');
  const resent = await resendInvitation(open.id);
  expect(resent.ok).toBe(true);
  expect(await getInvitationByToken(tokenOf(first))).toBeNull();
  expect(
    await getInvitationByToken(tokenOf((resent as { ok: true; data: { link: string } }).data.link))
  ).not.toBeNull();
});

test('only owners and admins invite; an owner cannot be invited; existing members are refused', async () => {
  const { owner, orgId } = await adminWithOrg();
  expect((await inviteMembers(orgId, [{ email: 'x@example.com', role: 'OWNER' as 'ADMIN' }])).ok).toBe(false);
  expect((await inviteMembers(orgId, [{ email: owner.email, role: 'MEMBER' }])).ok).toBe(false);
  expect(
    (
      await inviteMembers(
        orgId,
        Array.from({ length: 21 }, (_, i) => ({ email: `p${i}@example.com`, role: 'MEMBER' as const }))
      )
    ).ok
  ).toBe(false);

  const member = await makeUser('Member');
  await addMember(orgId, member, 'MEMBER');
  await signIn(member.email);
  const result = await inviteMembers(orgId, [{ email: 'y@example.com', role: 'MEMBER' }]);
  expect(result).toEqual({ ok: false, error: 'Forbidden' });
});

test('someone with an account joins a second organisation while signed in with the invited email', async () => {
  const { orgId } = await adminWithOrg();
  const other = await makeUser('Other');
  const otherOrg = await makeOrg(other);
  void otherOrg;
  const link = await invite(orgId, other.email);

  // Signed in as somebody else: the page says so and the action refuses.
  const stranger = await makeUser('Stranger');
  await signIn(stranger.email);
  expect(await openActivatePage(tokenOf(link))).toMatchObject({ hasAccount: true, signedInEmail: stranger.email });
  expect((await acceptInvitation(tokenOf(link))).ok).toBe(false);
  // A new account cannot be made for an email that has one.
  expect((await acceptInvitationAsNewUser(tokenOf(link), 'X', PASSWORD)).ok).toBe(false);

  await signIn(other.email);
  expect(await acceptInvitation(tokenOf(link))).toEqual({ ok: true, data: { organizationId: orgId } });
  const rows = await db.select().from(organizationMembers).where(eq(organizationMembers.userId, other.id));
  expect(rows).toHaveLength(2);
});

test('activation refuses a short password with a message, and #64 blocks inviting without 2FA', async () => {
  const { orgId } = await adminWithOrg();
  const link = await invite(orgId, 'short@example.com');
  testCookies.clear();
  expect(await acceptInvitationAsNewUser(tokenOf(link), 'Short', 'abc')).toEqual({
    ok: false,
    error: 'The password must have 8 to 128 characters',
  });
  // Malformed arguments from a hand-made request are refused, not a server error.
  expect((await acceptInvitationAsNewUser(tokenOf(link), { length: 1 } as unknown as string, PASSWORD)).ok).toBe(false);
  expect(await revokeInvitation('not-a-uuid')).toEqual({ ok: false, error: 'Unauthorized' });
  await signIn((await makeUser('Signed')).email);
  expect(await revokeInvitation('not-a-uuid')).toEqual({ ok: false, error: 'Not found' });
  expect(await inviteMembers('not-a-uuid', [])).toEqual({ ok: false, error: 'Not found' });

  const strict = await makeUser('Strict');
  const strictOrg = await makeOrg(strict, { twoFaRequired: true });
  await signIn(strict.email);
  expect(await inviteMembers(strictOrg, [{ email: 'z@example.com', role: 'MEMBER' }])).toEqual({
    ok: false,
    error: 'Two-factor authentication is required in this organization',
  });
});
