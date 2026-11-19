import { SetLastProject } from '@/components/shared/set-last-project';
import { requireProjectPage } from '@/lib/page-access';

// Every project page needs at least VIEWER (item 27). Each page repeats the check itself
// (lib/page-access.ts says why); this layout only remembers the project for `/`.
export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const { organizationId } = await requireProjectPage(projectId);
  return (
    <>
      <SetLastProject projectId={projectId} organizationId={organizationId} />
      {children}
    </>
  );
}
