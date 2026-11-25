import { cookies } from 'next/headers';

import { AppShell } from '@/components/shared/app-shell';
import { SetLastProject } from '@/components/shared/set-last-project';
import { getOrganizations } from '@/lib/action/organizations';
import { getProjects } from '@/lib/action/projects';
import { requireProjectPage } from '@/lib/page-access';
import { projectReadiness } from '@/lib/project-readiness';
import { getCurrentUser } from '@/lib/utils/auth';

export const dynamic = 'force-dynamic';

interface ProjectLayoutProps {
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}

// Every project page needs at least VIEWER (item 27). Each page repeats the check itself
// (lib/page-access.ts says why); this layout draws the shell and remembers the project for `/`.
export default async function ProjectLayout({ children, params }: ProjectLayoutProps) {
  const { projectId } = await params;
  const { organizationId } = await requireProjectPage(projectId);

  // The sidebar nests the setup steps under Upload while the project still needs any of them.
  const [user, projects, organizations, readiness, cookieStore] = await Promise.all([
    getCurrentUser(),
    getProjects(),
    getOrganizations().catch(() => []),
    projectReadiness(projectId),
    cookies(),
  ]);

  const uploadSetup = {
    categories: readiness.categories,
    roles: readiness.roles,
    templates: readiness.templates,
    providers: readiness.speech && readiness.llm,
  };

  const sidebarCollapsed = cookieStore.get('sidebarCollapsed')?.value === 'true';

  return (
    <AppShell
      user={user}
      context={{ kind: 'project', projectId }}
      projects={projects}
      organizations={organizations}
      uploadSetup={uploadSetup}
      initialSidebarCollapsed={sidebarCollapsed}
    >
      <SetLastProject projectId={projectId} organizationId={organizationId} />
      {children}
    </AppShell>
  );
}
