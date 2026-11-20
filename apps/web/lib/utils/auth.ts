import { getSessionUser, UnauthorizedError } from '@/lib/access';

/**
 * The signed-in user's id, for server actions. Throws when signed out.
 * Kept from the cloud (item 18d); reads the Better Auth session.
 */
export async function getSessionUserId(): Promise<string> {
  const user = await getSessionUser();
  if (!user) throw new UnauthorizedError();
  return user.id;
}

/** The signed-in user, or null. Same return type as the cloud's, without the cloud-admin `role`. */
export async function getCurrentUser(): Promise<{ id: string; email: string; displayName?: string } | null> {
  const user = await getSessionUser();
  return user ? { id: user.id, email: user.email, displayName: user.name || undefined } : null;
}
