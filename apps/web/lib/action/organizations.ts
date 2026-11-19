'use server';

import { createHash, randomBytes } from 'node:crypto';

import { and, asc, count, eq, gt, inArray, isNotNull, isNull } from 'drizzle-orm';
import { headers } from 'next/headers';

import { env } from '@/env';
import { orgRoleAtLeast, requireOrgRole, requireUser } from '@/lib/access';
import { auth, resetLinks } from '@/lib/auth/auth';
import { clearTwoFactor } from '@/lib/auth/clear-2fa';
import { createUser } from '@/lib/auth/create-user';
import { db } from '@/lib/db/client';
import { invitations, organizationMembers, organizations } from '@/lib/db/schema/app';
import { session as sessionTable, user as userTable } from '@/lib/db/schema/auth';
import { log } from '@/lib/log';

import { type ActionResult, BackendError, ForbiddenError, NotFoundError, runAction } from './result';

// Invitations differ from the cloud, which creates an inactive account at once (item 30): here only
// the SHA-256 of a random link token is stored, and the link is shown once to the person who made it.

const INVITATION_TTL_DAYS = 7;
const MAX_INVITATIONS = 20;

export type InvitableRole = 'ADMIN' | 'MEMBER';
export type OrganizationSummary = { id: string; name: string; role: 'OWNER' | 'ADMIN' | 'MEMBER' };
export type InvitationView = {
  id: string;
  email: string;
  role: InvitableRole;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
};

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
const invitationLink = (token: string) =>
  new URL(`/activate?token=${encodeURIComponent(token)}`, env.PUBLIC_URL).toString();

// --- organisations of the signed-in user ------------------------------------------------------

export async function getOrganizations(): Promise<OrganizationSummary[]> {
  const user = await requireUser();
  return db
    .select({ id: organizations.id, name: organizations.name, role: organizationMembers.role })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(eq(organizationMembers.userId, user.id))
    .orderBy(asc(organizations.createdAt));
}

// --- invitations ------------------------------------------------------------------------------

/** Creates one link per email (at most 20). An open invitation for the same email is revoked first. */
export async function inviteMembers(
  organizationId: string,
  entries: { email: string; role: InvitableRole }[]
): Promise<ActionResult<{ email: string; link: string }[]>> {
  return runAction(async () => {
    const { user } = await requireOrgRole(organizationId, 'ADMIN');
    if (entries.length === 0) return [];
    if (entries.length > MAX_INVITATIONS) throw new BackendError(400, `At most ${MAX_INVITATIONS} invitations at once`);
    const normalised = entries.map((e) => ({ email: e.email.trim().toLowerCase(), role: e.role }));
    for (const e of normalised) {
      if (e.role !== 'ADMIN' && e.role !== 'MEMBER') throw new BackendError(400, 'An owner cannot be invited');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.email)) throw new BackendError(400, `Not an email address: ${e.email}`);
    }
    const emails = normalised.map((e) => e.email);
    if (new Set(emails).size !== emails.length) throw new BackendError(400, 'An email is listed twice');

    const members = await db
      .select({ email: userTable.email })
      .from(organizationMembers)
      .innerJoin(userTable, eq(userTable.id, organizationMembers.userId))
      .where(and(eq(organizationMembers.organizationId, organizationId), inArray(userTable.email, emails)));
    if (members.length > 0) throw new BackendError(409, `Already a member: ${members.map((m) => m.email).join(', ')}`);

    const now = new Date();
    const expiresAt = new Date(now.getTime() + INVITATION_TTL_DAYS * 24 * 3600 * 1000);
    const links = normalised.map((e) => ({ ...e, token: newToken() }));
    await db.transaction(async (tx) => {
      await tx
        .update(invitations)
        .set({ revokedAt: now })
        .where(
          and(
            eq(invitations.organizationId, organizationId),
            inArray(invitations.email, emails),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt)
          )
        );
      await tx.insert(invitations).values(
        links.map((l) => ({
          organizationId,
          email: l.email,
          role: l.role,
          tokenHash: hashToken(l.token),
          invitedBy: user.id,
          expiresAt,
        }))
      );
    });
    log('info', 'invitations created', { user_id: user.id });
    return links.map((l) => ({ email: l.email, link: invitationLink(l.token) }));
  });
}

/** Open invitations (not accepted, not revoked), expired ones included and marked. */
export async function listInvitations(organizationId: string): Promise<InvitationView[]> {
  await requireOrgRole(organizationId, 'ADMIN');
  const rows = await db
    .select()
    .from(invitations)
    .where(
      and(eq(invitations.organizationId, organizationId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt))
    )
    .orderBy(asc(invitations.createdAt));
  const now = Date.now();
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    expired: r.expiresAt.getTime() <= now,
  }));
}

async function findOpenInvitationById(id: string) {
  const [row] = await db
    .select()
    .from(invitations)
    .where(and(eq(invitations.id, id), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
  if (!row) throw new NotFoundError();
  return row;
}

export async function revokeInvitation(id: string): Promise<ActionResult> {
  return runAction(async () => {
    const inv = await findOpenInvitationById(id);
    await requireOrgRole(inv.organizationId, 'ADMIN');
    await db.update(invitations).set({ revokedAt: new Date() }).where(eq(invitations.id, id));
  });
}

/** Makes a new link (the old token is unrecoverable by design) and revokes the old invitation. */
export async function resendInvitation(id: string): Promise<ActionResult<{ email: string; link: string }>> {
  return runAction(async () => {
    const inv = await findOpenInvitationById(id);
    const result = await inviteMembers(inv.organizationId, [{ email: inv.email, role: inv.role }]);
    if (!result.ok) throw new BackendError(400, result.error);
    return result.data[0];
  });
}

/** What the activate page needs to know about a link. Never throws; an unusable link is `null`. */
export async function getInvitationByToken(token: string): Promise<{
  email: string;
  organizationName: string;
  hasAccount: boolean;
} | null> {
  if (!token) return null;
  const [row] = await db
    .select({ email: invitations.email, organizationName: organizations.name })
    .from(invitations)
    .innerJoin(organizations, eq(organizations.id, invitations.organizationId))
    .where(
      and(
        eq(invitations.tokenHash, hashToken(token)),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, new Date())
      )
    );
  if (!row) return null;
  const [existing] = await db.select({ id: userTable.id }).from(userTable).where(eq(userTable.email, row.email));
  return { email: row.email, organizationName: row.organizationName, hasAccount: !!existing };
}

/**
 * Marks the invitation accepted and adds the member row, in one transaction. The conditional update
 * makes a link usable once even when two requests race.
 */
async function consumeInvitation(token: string, userId: string, email: string) {
  return db.transaction(async (tx) => {
    const [inv] = await tx
      .update(invitations)
      .set({ acceptedAt: new Date() })
      .where(
        and(
          eq(invitations.tokenHash, hashToken(token)),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, new Date()),
          eq(invitations.email, email)
        )
      )
      .returning();
    if (!inv) throw new NotFoundError('This invitation is not valid');
    await tx
      .insert(organizationMembers)
      .values({ organizationId: inv.organizationId, userId, role: inv.role, invitedBy: inv.invitedBy })
      .onConflictDoNothing();
    return inv;
  });
}

/** Item 28c: a new person opens their link, sets name and password, and joins. Signs them in. */
export async function acceptInvitationAsNewUser(
  token: string,
  name: string,
  password: string
): Promise<ActionResult<{ organizationId: string }>> {
  return runAction(async () => {
    const info = await getInvitationByToken(token);
    if (!info) throw new NotFoundError('This invitation is not valid');
    if (info.hasAccount) throw new BackendError(409, 'An account with this email exists: sign in to join');
    if (!name.trim()) throw new BackendError(400, 'Name is required');
    const created = await createUser({ email: info.email, name, password });
    let inv;
    try {
      inv = await consumeInvitation(token, created.id, info.email);
    } catch (e) {
      const ctx = await auth.$context;
      await ctx.internalAdapter.deleteUser(created.id).catch(() => {});
      throw e;
    }
    log('info', 'invitation accepted', { user_id: created.id });
    await auth.api.signInEmail({ body: { email: info.email, password }, headers: await headers() });
    return { organizationId: inv.organizationId };
  });
}

/** Item 28c: a signed-in person whose email already has an account joins another organisation. */
export async function acceptInvitation(token: string): Promise<ActionResult<{ organizationId: string }>> {
  return runAction(async () => {
    const user = await requireUser();
    const info = await getInvitationByToken(token);
    if (!info) throw new NotFoundError('This invitation is not valid');
    if (info.email !== user.email.toLowerCase()) throw new ForbiddenError('This invitation is for another email');
    const inv = await consumeInvitation(token, user.id, info.email);
    log('info', 'invitation accepted', { user_id: user.id });
    return { organizationId: inv.organizationId };
  });
}

// --- removing people ----------------------------------------------------------------------------

/**
 * As in the cloud: owners and admins remove any non-owner; anyone may leave; an owner may be removed
 * or leave only while another owner remains. A user left with no organisation is signed out.
 */
export async function removeOrganizationMember(organizationId: string, userId: string): Promise<ActionResult> {
  return runAction(async () => {
    const actor = await requireUser();
    const self = actor.id === userId;
    const { role: actorRole } = await requireOrgRole(organizationId, self ? 'MEMBER' : 'ADMIN', actor);
    await db.transaction(async (tx) => {
      const [target] = await tx
        .select({ role: organizationMembers.role })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId)))
        .for('update');
      if (!target) throw new NotFoundError();
      if (target.role === 'OWNER') {
        if (!self && actorRole !== 'OWNER') throw new ForbiddenError('Only an owner can remove an owner');
        const [{ owners }] = await tx
          .select({ owners: count() })
          .from(organizationMembers)
          .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.role, 'OWNER')));
        if (owners <= 1) throw new BackendError(409, 'The last owner cannot leave or be removed');
      }
      await tx
        .delete(organizationMembers)
        .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId)));
      const [{ left }] = await tx
        .select({ left: count() })
        .from(organizationMembers)
        .where(eq(organizationMembers.userId, userId));
      if (left === 0) await tx.delete(sessionTable).where(eq(sessionTable.userId, userId));
    });
    log('info', 'member removed', { user_id: actor.id });
  });
}

// --- account recovery (#73) ---------------------------------------------------------------------

/**
 * The actor's role in the target's only organisation, after the two recovery conditions: the target
 * belongs to exactly one organisation, and the actor's role there is above the target's.
 */
async function recoveryContext(targetUserId: string, least: 'ADMIN' | 'OWNER') {
  const actor = await requireUser();
  if (actor.id === targetUserId) throw new ForbiddenError('Use your own account settings');
  const memberships = await db
    .select({ organizationId: organizationMembers.organizationId, role: organizationMembers.role })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, targetUserId));
  if (memberships.length === 0) throw new NotFoundError();
  // Visible only to someone in one of the target's organisations.
  const shared = await db
    .select({ organizationId: organizationMembers.organizationId })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.userId, actor.id),
        inArray(
          organizationMembers.organizationId,
          memberships.map((m) => m.organizationId)
        )
      )
    );
  if (shared.length === 0) throw new NotFoundError();
  if (memberships.length > 1) {
    throw new ForbiddenError('This person belongs to several organizations: the operator must use reset-owner.js');
  }
  const target = memberships[0];
  const { role: actorRole } = await requireOrgRole(target.organizationId, least, actor);
  if (!orgRoleAtLeast(actorRole, target.role) || actorRole === target.role) {
    throw new ForbiddenError('You can only do this for someone whose role is below yours');
  }
  return { actor, organizationId: target.organizationId };
}

/**
 * A one-hour reset link for a user below the actor's role. Ends the user's sessions and records who
 * did it; the user sees that once, after their next sign-in. 2FA is not removed.
 */
export async function createPasswordResetLink(userId: string): Promise<ActionResult<{ link: string }>> {
  return runAction(async () => {
    const { actor } = await recoveryContext(userId, 'ADMIN');
    const [target] = await db.select({ email: userTable.email }).from(userTable).where(eq(userTable.id, userId));
    if (!target) throw new NotFoundError();
    const link = await issueResetLink(userId, target.email);
    await db
      .update(userTable)
      .set({ passwordResetAt: new Date(), passwordResetBy: actor.id })
      .where(eq(userTable.id, userId));
    await db.delete(sessionTable).where(eq(sessionTable.userId, userId));
    log('info', 'password reset link created', { user_id: actor.id });
    return { link };
  });
}

/** Asks Better Auth for a reset token; sendResetPassword hands the URL back instead of mailing it.
 * Not exported: in a "use server" file every exported function is callable from the browser. */
async function issueResetLink(userId: string, email: string): Promise<string> {
  resetLinks.delete(userId);
  await auth.api.requestPasswordReset({ body: { email, redirectTo: '/reset-password' } });
  const link = resetLinks.get(userId);
  resetLinks.delete(userId);
  if (!link) throw new Error('Better Auth did not produce a reset link');
  return link;
}

/** An organisation owner clears 2FA for a user below them who has lost their device and codes. */
export async function resetTwoFactor(userId: string): Promise<ActionResult> {
  return runAction(async () => {
    const { actor } = await recoveryContext(userId, 'OWNER');
    await clearTwoFactor(userId);
    log('info', '2fa reset', { user_id: actor.id });
  });
}

/** The reset notice (item 30): returned once, then cleared. */
export async function takePasswordResetNotice(): Promise<{ at: string; by: string | null } | null> {
  const user = await requireUser();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ at: userTable.passwordResetAt, by: userTable.passwordResetBy })
      .from(userTable)
      .where(and(eq(userTable.id, user.id), isNotNull(userTable.passwordResetAt)))
      .for('update');
    if (!row?.at) return null;
    let byName: string | null = null;
    if (row.by) {
      const [actor] = await tx.select({ name: userTable.name }).from(userTable).where(eq(userTable.id, row.by));
      byName = actor?.name ?? null;
    }
    await tx.update(userTable).set({ passwordResetAt: null, passwordResetBy: null }).where(eq(userTable.id, user.id));
    return { at: row.at.toISOString(), by: byName };
  });
}
