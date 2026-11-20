import { sql } from '@/lib/db/client';
import { makeUser, PASSWORD, resetDb } from '@/test/fixtures';

import { auth } from './auth';
import {
  clearSignInFailures,
  isSignInBlocked,
  recordSignInFailure,
  SIGN_IN_MAX_FAILURES,
  SIGN_IN_WINDOW_SECONDS,
} from './throttle';

afterAll(() => sql.end());
beforeEach(resetDb);

/** A sign-in as a browser sends it, through Better Auth's HTTP handler. */
const signInOverHttp = (email: string, password: string, ip: string) =>
  auth.handler(
    new Request('http://localhost:3000/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', 'x-forwarded-for': ip },
      body: JSON.stringify({ email, password }),
    })
  );

test('counts failures per account; the window expires; clearing resets', async () => {
  const t0 = Date.now();
  for (let i = 0; i < SIGN_IN_MAX_FAILURES; i++) {
    expect(await isSignInBlocked('A@Example.com', t0)).toBe(false);
    await recordSignInFailure('a@example.com', t0 + i);
  }
  expect(await isSignInBlocked('a@example.com ', t0 + 100)).toBe(true);
  expect(await isSignInBlocked('other@example.com', t0 + 100)).toBe(false);
  expect(await isSignInBlocked('a@example.com', t0 + SIGN_IN_WINDOW_SECONDS * 1000 + 1)).toBe(false);
  await clearSignInFailures('a@example.com');
  expect(await isSignInBlocked('a@example.com', t0 + 100)).toBe(false);
});

test('over HTTP: wrong passwords from ever-new IPs hit 429; a correct sign-in before that clears the count', async () => {
  const user = await makeUser('Victim');
  for (let i = 0; i < SIGN_IN_MAX_FAILURES - 1; i++) {
    expect((await signInOverHttp(user.email, 'wrong password!', `10.0.0.${i + 1}`)).status).toBe(401);
  }
  // A correct sign-in succeeds and wipes the failures, so the owner is not one try from a lockout.
  expect((await signInOverHttp(user.email, PASSWORD, '10.0.1.1')).status).toBe(200);
  expect(await isSignInBlocked(user.email)).toBe(false);

  for (let i = 0; i < SIGN_IN_MAX_FAILURES; i++) {
    expect((await signInOverHttp(user.email, 'wrong password!', `10.0.2.${i + 1}`)).status).toBe(401);
  }
  expect((await signInOverHttp(user.email, 'wrong password!', '10.0.3.1')).status).toBe(429);
  expect((await signInOverHttp(user.email, PASSWORD, '10.0.3.2')).status).toBe(429);
});

test('endpoints with no use here are switched off', async () => {
  for (const path of ['/sign-up/email', '/request-password-reset', '/verify-email', '/change-email', '/update-user']) {
    const res = await auth.handler(
      new Request(`http://localhost:3000/api/auth${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        body: JSON.stringify({ email: 'x@example.com', password: 'abcdefghij', name: 'x' }),
      })
    );
    expect([path, res.status]).toEqual([path, 404]);
  }
});
