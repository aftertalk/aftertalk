// Item 16: the proxy only checks that a session cookie is present. It cannot read the database, so
// the real check (session valid, role, 2FA) happens again in every page, action and route handler
// through lib/access.ts. Without a cookie, pages redirect to /login?next=… and /api/* answers 401.
import { getSessionCookie } from 'better-auth/cookies';
import { type NextRequest, NextResponse } from 'next/server';

import eeRoutes from '@/ee/routes';

const PUBLIC_PATHS = [
  '/login',
  '/setup',
  '/reset-password',
  '/activate',
  '/api/auth',
  '/api/health',
  '/internal/jobs',
  ...eeRoutes.publicPaths,
];

/**
 * First path segments that are app routes, not a project id. Anything else at the top level is read
 * as `/[projectId]/…`.
 */
export const TOP_LEVEL_ROUTES = [
  'login',
  'setup',
  'setup-2fa',
  'reset-password',
  'activate',
  'no-organization',
  'api',
  'internal',
  ...eeRoutes.topLevelRoutes,
];

export const isPublicPath = (pathname: string) =>
  PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (isPublicPath(pathname) || getSessionCookie(request)) return NextResponse.next();
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // `/` decides for itself (setup, login or a project), so it is let through.
  if (pathname === '/') return NextResponse.next();
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Uploads stream large bodies and check the session themselves; static files need no check.
  // Anchored, so /api/upload-something or /robots.txtx still go through the check.
  matcher: ['/((?!api/upload(?:/|$)|_next/static/|_next/image(?:/|$)|fonts/|favicon\\.ico$|robots\\.txt$).*)'],
};
