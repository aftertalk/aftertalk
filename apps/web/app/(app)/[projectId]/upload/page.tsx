import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { Upload } from '@/components/pages/upload/upload';
import { UploadSetupGate } from '@/components/pages/upload/upload-setup-gate';
import { i18n } from '@/i18n/constants';
import { orgRoleAtLeast, projectRoleAtLeast } from '@/lib/access';
import { getProjectProviders } from '@/lib/action/project-providers';
import { getProject } from '@/lib/action/projects';
import { getSpeakerPresets } from '@/lib/action/speaker-presets';
import { requireProjectPage } from '@/lib/page-access';
import { projectReadiness } from '@/lib/project-readiness';
import { localizedPageMetadata } from '@/lib/utils/page-metadata';

export async function generateMetadata(): Promise<Metadata> {
  return localizedPageMetadata(i18n.meta.upload);
}

interface UploadPageProps {
  params: Promise<{ projectId: string }>;
}

export default async function UploadPage({ params }: UploadPageProps) {
  const { projectId } = await params;
  const { role, orgRole } = await requireProjectPage(projectId);
  // Uploading needs a project editor; a viewer has no use for this page.
  if (!projectRoleAtLeast(role, 'EDITOR')) notFound();

  const [presets, project, readiness, providers] = await Promise.all([
    getSpeakerPresets(projectId),
    getProject(projectId).catch(() => null),
    projectReadiness(projectId),
    getProjectProviders(projectId).catch(() => ({ choices: [], options: [] })),
  ]);

  // One function decides (item 54a): the three lists of the cloud's gate plus a speech and an LLM
  // provider. The upload route asks it again, so a hand-made request cannot skip the gate.
  if (!readiness.canUpload) {
    return (
      <UploadSetupGate
        projectId={projectId}
        projectName={project?.name}
        organizationId={project?.organizationId}
        providers={providers}
        canManage={projectRoleAtLeast(role, 'ADMIN')}
        isOrgAdmin={orgRoleAtLeast(orgRole, 'ADMIN')}
      />
    );
  }

  return <Upload presets={presets} projectId={projectId} projectName={project?.name} />;
}
