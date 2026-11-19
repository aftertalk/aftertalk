import { notFound, redirect } from 'next/navigation';

import { SetLastProject } from '@/components/shared/set-last-project';
import { requireProjectAccess, UnauthorizedError } from '@/lib/access';
import { NotFoundError, TwoFactorRequiredError } from '@/lib/action/result';

// Every project page needs at least VIEWER (item 27). An organisation that requires 2FA sends a user
// without it to set it up first (#64).
export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) notFound();
  try {
    await requireProjectAccess(projectId, 'VIEWER');
  } catch (e) {
    if (e instanceof UnauthorizedError) redirect('/login');
    if (e instanceof TwoFactorRequiredError) {
      redirect(`/setup-2fa?next=${encodeURIComponent(`/${projectId}/home`)}`);
    }
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  return (
    <>
      <SetLastProject projectId={projectId} />
      {children}
    </>
  );
}
