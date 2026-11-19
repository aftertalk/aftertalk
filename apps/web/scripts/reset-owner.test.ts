import { eq } from 'drizzle-orm';

import { getSessionUser } from '@/lib/access';
import { auth } from '@/lib/auth/auth';
import { db, sql } from '@/lib/db/client';
import { user as userTable } from '@/lib/db/schema/auth';
import { addMember, makeOrg, makeUser, resetDb, signIn } from '@/test/fixtures';

import { parseArgs, resetOwner } from './reset-owner';

afterAll(() => sql.end());
beforeEach(resetDb);

test('parses its arguments', () => {
  expect(parseArgs([])).toEqual({ email: null, reset2fa: false });
  expect(parseArgs(['--email', ' A@B.com ', '--reset-2fa'])).toEqual({ email: 'a@b.com', reset2fa: true });
  expect(parseArgs(['--email=x@y.z'])).toEqual({ email: 'x@y.z', reset2fa: false });
  expect(() => parseArgs(['--force'])).toThrow();
});

test('without --email: the first owner gets a link the reset page accepts, sessions end, 2FA off', async () => {
  const owner = await makeUser('Owner');
  const orgId = await makeOrg(owner);
  await addMember(orgId, await makeUser('Admin'), 'ADMIN');
  await db.update(userTable).set({ twoFactorEnabled: true }).where(eq(userTable.id, owner.id));
  await signIn(owner.email);

  const { email, link } = await resetOwner(process.env.DATABASE_URL!, 'http://localhost:3000', {
    email: null,
    reset2fa: true,
  });
  expect(email).toBe(owner.email);
  const token = new URL(link).searchParams.get('token')!;
  expect(link).toBe(`http://localhost:3000/reset-password?token=${token}`);

  const [row] = await db.select().from(userTable).where(eq(userTable.id, owner.id));
  expect(row.twoFactorEnabled).toBe(false);
  expect(row.passwordResetAt).not.toBeNull();
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int n from auth.session where user_id = ${owner.id}`;
  expect(n).toBe(0);

  await auth.api.resetPassword({ body: { token, newPassword: 'operator reset pw' } });
  await signIn(owner.email, 'operator reset pw');
  expect((await getSessionUser())?.id).toBe(owner.id);
});

test('with an unknown --email it fails without changing anything', async () => {
  await expect(
    resetOwner(process.env.DATABASE_URL!, 'http://localhost:3000', { email: 'nobody@example.com', reset2fa: false })
  ).rejects.toThrow('No user with that email');
});
