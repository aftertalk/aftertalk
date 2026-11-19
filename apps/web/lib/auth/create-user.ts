import { auth } from './auth';

/**
 * Creates a user with an email+password account while open sign-up is off (spike Q3): Better Auth's
 * public sign-up refuses, and the admin plugin's createUser needs an admin session, so this uses the
 * internal adapter and Better Auth's own password hashing. Called only from /setup and the activate page.
 */
export async function createUser(input: { email: string; name: string; password: string }): Promise<{ id: string }> {
  const ctx = await auth.$context;
  const email = input.email.trim().toLowerCase();
  const { minPasswordLength, maxPasswordLength } = ctx.password.config;
  if (input.password.length < minPasswordLength || input.password.length > maxPasswordLength) {
    throw new Error('password length');
  }
  const created = await ctx.internalAdapter.createUser(
    { email, name: input.name.trim(), emailVerified: true },
    { method: 'email-password' }
  );
  await ctx.internalAdapter.linkAccount({
    userId: created.id,
    providerId: 'credential',
    accountId: created.id,
    password: await ctx.password.hash(input.password),
  });
  return { id: created.id };
}
