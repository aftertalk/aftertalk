import { auth } from './auth';

/** Clears a user's 2FA and ends their sessions. Better Auth has no public server call for this (spike Q3). */
export async function clearTwoFactor(userId: string): Promise<void> {
  const ctx = await auth.$context;
  await ctx.internalAdapter.updateUser(userId, { twoFactorEnabled: false });
  await ctx.adapter.deleteMany({ model: 'twoFactor', where: [{ field: 'userId', value: userId }] });
  await ctx.internalAdapter.deleteUserSessions(userId);
}
