'use client';

import { twoFactorClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

// Same origin as the app, so no baseURL. On a sign-in that needs a second factor the login form
// handles it itself (it watches for `twoFactorRedirect`), so no redirect callback is set.
export const authClient = createAuthClient({ plugins: [twoFactorClient()] });
