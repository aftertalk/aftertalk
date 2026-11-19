// Better Auth (item 25): email and password with the twoFactor plugin. Open sign-up is off: accounts
// come from /setup or an invitation (lib/auth/create-user.ts). No mailer: a reset link is handed back
// to the caller by sendResetPassword. Cookie cache off, so every request reads the session from the
// database and a removed user is signed out at once.
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { twoFactor } from 'better-auth/plugins';

import { env } from '@/env';
import { db } from '@/lib/db/client';
import { account, rateLimit, session, twoFactor as twoFactorTable, user, verification } from '@/lib/db/schema/auth';

/** Reset links handed back by sendResetPassword, keyed by user id; read once by createPasswordResetLink. */
const g = globalThis as unknown as { __aftertalkResetLinks?: Map<string, string> };
export const resetLinks = (g.__aftertalkResetLinks ??= new Map<string, string>());

export const RESET_LINK_TTL_SECONDS = 60 * 60;

export const auth = betterAuth({
  appName: 'Aftertalk',
  baseURL: env.PUBLIC_URL,
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: { user, session, account, verification, twoFactor: twoFactorTable, rateLimit },
  }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    requireEmailVerification: false,
    minPasswordLength: 8,
    resetPasswordTokenExpiresIn: RESET_LINK_TTL_SECONDS,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user: u, url }) => {
      resetLinks.set(u.id, url);
    },
  },
  user: {
    additionalFields: {
      displayName: { type: 'string', required: false, input: false },
      timeZone: { type: 'string', required: false, defaultValue: 'Europe/Warsaw', input: false },
      passwordResetAt: { type: 'date', required: false, input: false },
      passwordResetBy: { type: 'string', required: false, input: false },
    },
  },
  session: { cookieCache: { enabled: false } },
  rateLimit: {
    // Better Auth turns it on only in production by default; here it is always on (item 25).
    enabled: process.env.NODE_ENV !== 'test',
    storage: 'database',
    customRules: {
      '/two-factor/*': { window: 60, max: 10 },
      '/reset-password/*': { window: 60, max: 10 },
    },
  },
  advanced: {
    // Set only by an operator's reverse proxy; without one, all clients share one bucket.
    ipAddress: { ipAddressHeaders: ['x-forwarded-for'] },
  },
  plugins: [twoFactor({ issuer: 'Aftertalk' }), nextCookies()],
});

export type Session = typeof auth.$Infer.Session;
