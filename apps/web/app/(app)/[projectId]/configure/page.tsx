import type { Metadata } from 'next';

import { ProjectConfigure } from '@/components/pages/configure/project-configure';
import { i18n } from '@/i18n/constants';
import { orgRoleAtLeast, projectRoleAtLeast } from '@/lib/access';
import { getProjectProviders } from '@/lib/action/project-providers';
import { getProject } from '@/lib/action/projects';
import { requireProjectPage } from '@/lib/page-access';
import { localizedPageMetadata } from '@/lib/utils/page-metadata';

export async function generateMetadata(): Promise<Metadata> {
  return localizedPageMetadata(i18n.meta.configure);
}

interface ConfigurePageProps {
  params: Promise<{ projectId: string }>;
}

export default async function ConfigurePage({ params }: ConfigurePageProps) {
  const { projectId } = await params;
  const { role, orgRole } = await requireProjectPage(projectId);

  const [project, providers] = await Promise.all([
    getProject(projectId).catch(() => null),
    getProjectProviders(projectId).catch(() => ({ choices: [], options: [] })),
  ]);

  // Project settings, provider choices and deleting the project all need a project admin
  // (organisation owners and admins are one on every project).
  const isProjectAdmin = projectRoleAtLeast(role, 'ADMIN');

  return (
    <ProjectConfigure
      projectId={projectId}
      projectName={project?.name ?? ''}
      projectDescription={project?.description ?? ''}
      organizationId={project?.organizationId}
      settings={
        project
          ? {
              allowedLanguages: project.allowedLanguages,
              memberPiiAccess: project.memberPiiAccess,
              retentionDays: project.retentionDays,
            }
          : undefined
      }
      providers={providers}
      canDelete={isProjectAdmin}
      canManageSettings={isProjectAdmin}
      isOrgAdmin={orgRoleAtLeast(orgRole, 'ADMIN')}
    />
  );
}
