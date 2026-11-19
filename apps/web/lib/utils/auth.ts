import { getAccessToken } from '@/lib/auth/cookies';
import { getTokenDisplayName, getTokenEmail, getTokenRole, getTokenUserId, isTokenExpired } from '@/lib/auth/jwt';

/**
 * Get the authenticated user ID from the JWT access token cookie.
 * Used for internal operations called from server actions.
 * Throws if not authenticated.
 */
export async function getSessionUserId(): Promise<string> {
  const token = await getAccessToken();
  // Reject expired tokens too, matching getCurrentUser and the middleware.
  if (!token || isTokenExpired(token)) throw new Error('Unauthorized');
  return getTokenUserId(token);
}

/**
 * Get the current user (id + email) from the JWT access token cookie.
 * Returns null if not authenticated.
 */
export async function getCurrentUser(): Promise<{
  id: string;
  email: string;
  role?: string;
  displayName?: string;
} | null> {
  const token = await getAccessToken();
  // Treat an expired token as logged-out, matching the auth middleware — otherwise the
  // landing page shows "Dashboard" for a dead session and the middleware bounces it back.
  if (!token || isTokenExpired(token)) return null;
  try {
    return {
      id: getTokenUserId(token),
      email: getTokenEmail(token) ?? '',
      role: getTokenRole(token),
      displayName: getTokenDisplayName(token),
    };
  } catch {
    return null;
  }
}
