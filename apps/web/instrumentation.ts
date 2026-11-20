// Runs once when the server starts (item 15), never during `next build`. Phase 3 adds the job timer.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { ensureSetupToken } = await import('./lib/auth/setup-token');
  await ensureSetupToken().catch(() => {
    // The database may not be migrated yet in development; /setup calls it again.
  });
}
