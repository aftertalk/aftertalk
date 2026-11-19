// Better Auth (item 25): email and password with the twoFactor plugin. Open sign-up is off: accounts
// come from /setup or an invitation (lib/auth/create-user.ts). No mailer: a reset link is handed back
// as a link the caller shows (lib/auth/reset-token.ts). Cookie cache off, so every request reads the session from the
// database and a removed user is signed out at once.
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { nextCookies } from 'better-auth/next-js';
import { twoFactor } from 'better-auth/plugins';

import { env } from '@/env';
import { db } from '@/lib/db/client';
import { account, rateLimit, session, twoFactor as twoFactorTable, user, verification } from '@/lib/db/schema/auth';

import { RESET_LINK_TTL_SECONDS } from './reset-token';
import { clearSignInFailures, isSignInBlocked, recordSignInFailure } from './throttle';

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
    maxPasswordLength: 128,
    resetPasswordTokenExpiresIn: RESET_LINK_TTL_SECONDS,
    revokeSessionsOnPasswordReset: true,
  },
  // No mailer, so nobody may ask for a reset by email: links are made by an admin
  // (lib/action/organizations.ts) or the operator (scripts/reset-owner.ts). Changing the email or
  // deleting the account through Better Auth is off too; phase 2 adds its own actions.
  disabledPaths: [
    '/request-password-reset',
    '/forget-password',
    '/send-verification-email',
    '/verify-email',
    '/change-email',
    '/delete-user',
    '/delete-user/callback',
    '/sign-up/email',
    // No social providers and no OTP sender are configured.
    '/sign-in/social',
    '/link-social',
    '/unlink-account',
    '/two-factor/send-otp',
    '/two-factor/verify-otp',
    // Profile changes come with phase 2's own actions; until then nothing edits the user row.
    '/update-user',
    '/update-session',
  ],
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
    // The client IP for the per-IP limit. Behind a reverse proxy set TRUSTED_PROXIES to its address
    // so the forwarded chain is read from the right. Without a proxy a client can forge the header,
    // which is why sign-in is also limited per account (hooks below).
    ipAddress: { ipAddressHeaders: ['x-forwarded-for'], trustedProxies: env.TRUSTED_PROXIES },
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== '/sign-in/email') return;
      const email = (ctx.body as { email?: unknown } | undefined)?.email;
      if (typeof email === 'string' && (await isSignInBlocked(email))) {
        throw new APIError('TOO_MANY_REQUESTS', { message: 'Too many sign-in attempts. Try again in a few minutes.' });
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== '/sign-in/email') return;
      const email = (ctx.body as { email?: unknown } | undefined)?.email;
      if (typeof email !== 'string') return;
      const returned = ctx.context.returned;
      if (returned instanceof APIError) {
        // Only a wrong email or password counts, not the 429 above or a malformed request.
        if (returned.statusCode === 401) await recordSignInFailure(email);
      } else {
        await clearSignInFailures(email);
      }
    }),
  },
  plugins: [twoFactor({ issuer: 'Aftertalk' }), nextCookies()],
});

export type Session = typeof auth.$Infer.Session;
