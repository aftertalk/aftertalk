import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

import { AppShell } from '@/components/shared/app-shell';
import { getOrganizations } from '@/lib/action/organizations';
import { getProjects } from '@/lib/action/projects';
import { getCurrentUser } from '@/lib/utils/auth';
import { preferLastUsed } from '@/lib/utils/last-used';
import { isUuid } from '@/lib/utils/uuid';

export const dynamic = 'force-dynamic';

interface OrganizationLayoutProps {
  children: React.ReactNode;
  params: Promise<{ organizationId: string }>;
}

export default async function OrganizationLayout({ children, params }: OrganizationLayoutProps) {
  if (!isUuid((await params).organizationId)) notFound();
  const [user, { organizationId }, projects, organizations] = await Promise.all([
    getCurrentUser(),
    params,
    getProjects().catch(() => []),
    getOrganizations().catch(() => []),
  ]);

  // Unknown or foreign org — let the resolver route to a workspace the user does have.
  const organization = organizations.find((o) => o.id === organizationId);
  if (!organization) {
    const project = (await preferLastUsed()).project(projects);
    redirect(project ? `/${project.id}/home` : '/');
  }

  const sidebarCollapsed = (await cookies()).get('sidebarCollapsed')?.value === 'true';

  return (
    <AppShell
      user={user}
      context={{ kind: 'org', organizationId }}
      projects={projects}
      organizations={organizations}
      initialSidebarCollapsed={sidebarCollapsed}
    >
      {children}
    </AppShell>
  );
}
