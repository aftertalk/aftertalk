// Page-side wrappers around lib/access.ts: the same checks, answered with a redirect or a 404 page
// instead of an error. Every project page calls requireProjectPage itself, not only the layout:
// Next keeps a shared layout across client navigation, so a layout-only check can be stale.
import 'server-only';

import { notFound, redirect } from 'next/navigation';

import { type ProjectRole, requireProjectAccess, UnauthorizedError } from '@/lib/access';
import { ForbiddenError, NotFoundError, TwoFactorRequiredError } from '@/lib/action/result';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function requireProjectPage(projectId: string, least: ProjectRole = 'VIEWER') {
  if (!UUID.test(projectId)) notFound();
  try {
    return await requireProjectAccess(projectId, least);
  } catch (e) {
    if (e instanceof UnauthorizedError) redirect('/login');
    if (e instanceof TwoFactorRequiredError) redirect(`/setup-2fa?next=${encodeURIComponent(`/${projectId}/home`)}`);
    // A role too low for this page is shown as not found, like no role: nothing about it leaks.
    if (e instanceof NotFoundError || e instanceof ForbiddenError) notFound();
    throw e;
  }
}
