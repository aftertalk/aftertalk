import { NextRequest } from 'next/server';

import { config, isPublicPath, proxy } from './proxy';

const req = (path: string, cookie?: string) =>
  new NextRequest(new URL(path, 'http://localhost:3000'), {
    headers: cookie ? { cookie } : {},
  });

test('public paths, exactly or as a folder, not as a prefix', () => {
  for (const p of ['/login', '/setup', '/activate', '/reset-password', '/api/auth/sign-in/email', '/api/health']) {
    expect(isPublicPath(p)).toBe(true);
  }
  for (const p of ['/loginx', '/api/authx', '/setup-2fa', '/api/healthcheck', '/']) expect(isPublicPath(p)).toBe(false);
});

test('without a session cookie: pages redirect to /login with next, /api answers 401, / decides itself', async () => {
  const page = proxy(req('/abc/home?x=1'));
  expect(page.status).toBe(307);
  expect(page.headers.get('location')).toBe('http://localhost:3000/login?next=%2Fabc%2Fhome%3Fx%3D1');
  expect(proxy(req('/api/anything')).status).toBe(401);
  expect(proxy(req('/')).headers.get('location')).toBeNull();
  expect(proxy(req('/login')).headers.get('location')).toBeNull();
});

test('with a session cookie it lets the request through (pages check the session themselves)', () => {
  const res = proxy(req('/abc/home', 'better-auth.session_token=x.y'));
  expect(res.headers.get('location')).toBeNull();
  expect(res.status).toBe(200);
});

test('the matcher skips only the exact excluded paths', () => {
  const re = new RegExp(`^${config.matcher[0]}$`);
  expect(re.test('/api/upload')).toBe(false);
  expect(re.test('/api/upload/abc')).toBe(false);
  expect(re.test('/api/upload-other')).toBe(true);
  expect(re.test('/robots.txtx')).toBe(true);
  expect(re.test('/fonts/Switzer-Regular.woff')).toBe(false);
  expect(re.test('/abc/home')).toBe(true);
});
