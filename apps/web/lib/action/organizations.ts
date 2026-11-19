'use server';

import { createHash, randomBytes } from 'node:crypto';

import { and, asc, count, eq, gt, inArray, isNull } from 'drizzle-orm';
import { headers } from 'next/headers';
import { z } from 'zod';

import { env } from '@/env';
import { type OrgRole, orgRoleAtLeast, requireOrgRole, requireUser } from '@/lib/access';
import { auth } from '@/lib/auth/auth';
import { clearTwoFactor } from '@/lib/auth/clear-2fa';
import { createUser, validateNewAccount } from '@/lib/auth/create-user';
import { issueResetToken, scramblePassword } from '@/lib/auth/reset-token';
import { clearSignInFailures } from '@/lib/auth/throttle';
import { db } from '@/lib/db/client';
import { invitations, organizationMembers, organizations, projectMembers, projects } from '@/lib/db/schema/app';
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

// Every export here is a public endpoint taking any JSON, so arguments are checked before use: a
// malformed id answers "not found" instead of a database cast error.
const UUID = z.string().uuid();
const TOKEN = z.string().min(1).max(200);
function idOrNotFound(value: unknown): string {
  const parsed = UUID.safeParse(value);
  if (!parsed.success) throw new NotFoundError();
  return parsed.data;
}
function tokenOrNull(value: unknown): string | null {
  const parsed = TOKEN.safeParse(value);
  return parsed.success ? parsed.data : null;
}

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
    const { user } = await requireOrgRole(idOrNotFound(organizationId), 'ADMIN');
    if (!Array.isArray(entries)) throw new BackendError(400, 'Invalid request');
    if (entries.length === 0) return [];
    if (entries.length > MAX_INVITATIONS) throw new BackendError(400, `At most ${MAX_INVITATIONS} invitations at once`);
    const normalised = entries.map((e) => ({
      email: typeof e?.email === 'string' ? e.email.trim().toLowerCase() : '',
      role: e?.role,
    }));
    for (const e of normalised) {
      if (e.role !== 'ADMIN' && e.role !== 'MEMBER') throw new BackendError(400, 'An owner cannot be invited');
      if (!z.string().email().max(254).safeParse(e.email).success) {
        throw new BackendError(400, `Not an email address: ${e.email.slice(0, 254)}`);
      }
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
          role: l.role as InvitableRole,
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
export async function listInvitations(organizationId: string): Promise<ActionResult<InvitationView[]>> {
  return runAction(async () => {
    organizationId = idOrNotFound(organizationId);
    await requireOrgRole(organizationId, 'ADMIN');
    return openInvitations(organizationId);
  });
}

async function openInvitations(organizationId: string): Promise<InvitationView[]> {
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

/** The open invitation, after checking the signed-in user is an admin of its organisation. */
async function findOpenInvitationAsAdmin(id: unknown) {
  await requireUser();
  const [row] = await db
    .select()
    .from(invitations)
    .where(and(eq(invitations.id, idOrNotFound(id)), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
  if (!row) throw new NotFoundError();
  await requireOrgRole(row.organizationId, 'ADMIN');
  return row;
}

export async function revokeInvitation(id: string): Promise<ActionResult> {
  return runAction(async () => {
    const inv = await findOpenInvitationAsAdmin(id);
    await db.update(invitations).set({ revokedAt: new Date() }).where(eq(invitations.id, inv.id));
  });
}

/** Makes a new link (the old token is unrecoverable by design) and revokes the old invitation. */
export async function resendInvitation(id: string): Promise<ActionResult<{ email: string; link: string }>> {
  return runAction(async () => {
    const inv = await findOpenInvitationAsAdmin(id);
    const result = await inviteMembers(inv.organizationId, [{ email: inv.email, role: inv.role }]);
    if (!result.ok) throw new BackendError(400, result.error);
    return result.data[0];
  });
}

/** What the activate page needs to know about a link. Never throws; an unusable link is `null`. */
export async function getInvitationByToken(rawToken: string): Promise<{
  email: string;
  organizationName: string;
  hasAccount: boolean;
} | null> {
  const token = tokenOrNull(rawToken);
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
    validateNewAccount({ email: info.email, name, password });
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
    organizationId = idOrNotFound(organizationId);
    if (typeof userId !== 'string' || !userId) throw new NotFoundError();
    const actor = await requireUser();
    const self = actor.id === userId;
    await requireOrgRole(organizationId, self ? 'MEMBER' : 'ADMIN', actor);
    await db.transaction(async (tx) => {
      // One removal per organisation at a time, so two owners removing each other cannot both pass
      // the "another owner remains" check.
      await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .for('no key update');
      // The actor's role, read again under the lock: an admin removed a moment ago removes nobody.
      const [actorNow] = await tx
        .select({ role: organizationMembers.role })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, actor.id)));
      if (!actorNow || (!self && !orgRoleAtLeast(actorNow.role, 'ADMIN'))) throw new ForbiddenError();
      const actorRole = actorNow.role;
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
      // Project roles in this organisation go too, so a later re-invite starts from nothing.
      await tx
        .delete(projectMembers)
        .where(
          and(
            eq(projectMembers.userId, userId),
            inArray(
              projectMembers.projectId,
              tx.select({ id: projects.id }).from(projects).where(eq(projects.organizationId, organizationId))
            )
          )
        );
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
 * The two recovery conditions (#73): the actor's role is above the target's in an organisation they
 * share (and at least `least`), and the target belongs to no other organisation. Checked in that
 * order, so someone without the right learns nothing about the target's other memberships.
 */
async function recoveryContext(targetUserId: unknown, least: 'ADMIN' | 'OWNER') {
  if (typeof targetUserId !== 'string' || !targetUserId) throw new NotFoundError();
  const actor = await requireUser();
  if (actor.id === targetUserId) throw new ForbiddenError('Use your own account settings');
  const memberships = await db
    .select({ organizationId: organizationMembers.organizationId, role: organizationMembers.role })
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, targetUserId));
  const mine = memberships.length
    ? await db
        .select({ organizationId: organizationMembers.organizationId, role: organizationMembers.role })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.userId, actor.id),
            inArray(
              organizationMembers.organizationId,
              memberships.map((m) => m.organizationId)
            )
          )
        )
    : [];
  // Not in any of the target's organisations: the target does not exist for this actor.
  if (mine.length === 0) throw new NotFoundError();
  const above = (a: OrgRole, t: OrgRole) => orgRoleAtLeast(a, t) && a !== t;
  const qualifying = mine.find((m) => {
    const target = memberships.find((t) => t.organizationId === m.organizationId)!;
    return orgRoleAtLeast(m.role, least) && above(m.role, target.role);
  });
  if (!qualifying) throw new ForbiddenError('You can only do this for someone whose role is below yours');
  // Re-checked through the one access function, which also applies the organisation's 2FA rule.
  await requireOrgRole(qualifying.organizationId, least, actor);
  if (memberships.length > 1) {
    throw new ForbiddenError('This person belongs to several organizations: the operator must use reset-owner.js');
  }
  return { actor, organizationId: qualifying.organizationId };
}

/**
 * A one-hour reset link for a user below the actor's role. In one transaction: the old password
 * stops working (so whoever might know it cannot sign in before the user does), earlier links are
 * replaced, sessions end, and who did it is recorded for the one-time notice. 2FA stays.
 */
export async function createPasswordResetLink(userId: string): Promise<ActionResult<{ link: string }>> {
  return runAction(async () => {
    const { actor } = await recoveryContext(userId, 'ADMIN');
    const link = await db.transaction(async (tx) => {
      const url = await issueResetToken(tx, userId);
      await scramblePassword(tx, userId);
      await tx
        .update(userTable)
        .set({ passwordResetAt: new Date(), passwordResetBy: actor.id })
        .where(eq(userTable.id, userId));
      await tx.delete(sessionTable).where(eq(sessionTable.userId, userId));
      return url;
    });
    // A lockout from failed sign-ins must not outlive the reset.
    const [target] = await db.select({ email: userTable.email }).from(userTable).where(eq(userTable.id, userId));
    if (target) await clearSignInFailures(target.email);
    log('info', 'password reset link created', { user_id: actor.id });
    return { link };
  });
}

/** An organisation owner clears 2FA for a user below them who has lost their device and codes. */
export async function resetTwoFactor(userId: string): Promise<ActionResult> {
  return runAction(async () => {
    const { actor } = await recoveryContext(userId, 'OWNER');
    await clearTwoFactor(userId);
    log('info', '2fa reset', { user_id: actor.id });
  });
}
