import { z } from 'zod';

import { BackendError } from '@/lib/action/result';

import { auth } from './auth';

// Same bounds as Better Auth's emailAndPassword settings in auth.ts.
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;

/**
 * Checks what a browser sent for a new account. Server actions take any JSON, so this runs on the
 * server whatever the form did; failures are 400s with a message the form shows.
 */
export function validateNewAccount(input: { email: unknown; name: unknown; password: unknown }) {
  if (typeof input.email !== 'string' || !z.string().email().max(254).safeParse(input.email.trim()).success) {
    throw new BackendError(400, 'Enter a valid email address');
  }
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 100) {
    throw new BackendError(400, 'Enter your name (at most 100 characters)');
  }
  if (
    typeof input.password !== 'string' ||
    input.password.length < MIN_PASSWORD ||
    input.password.length > MAX_PASSWORD
  ) {
    throw new BackendError(400, `The password must have ${MIN_PASSWORD} to ${MAX_PASSWORD} characters`);
  }
}

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
    throw new BackendError(400, `The password must have ${minPasswordLength} to ${maxPasswordLength} characters`);
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
