import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { OrganizationProjects } from '@/components/pages/organization/organization-projects';
import { i18n } from '@/i18n/constants';
import { getOrganizations } from '@/lib/action/organizations';
import { getProjects } from '@/lib/action/projects';
import { getCallsFiltered } from '@/lib/action/transcription';
import { localizedPageMetadata } from '@/lib/utils/page-metadata';

export async function generateMetadata(): Promise<Metadata> {
  return localizedPageMetadata(i18n.meta.projects);
}

export const dynamic = 'force-dynamic';

interface OrganizationPageProps {
  params: Promise<{ organizationId: string }>;
}

export default async function OrganizationPage({ params }: OrganizationPageProps) {
  const [{ organizationId }, projects, organizations] = await Promise.all([
    params,
    getProjects().catch(() => []),
    getOrganizations().catch(() => []),
  ]);

  const organization = organizations.find((o) => o.id === organizationId);
  if (!organization) redirect('/');

  const canManage = organization.role === 'OWNER' || organization.role === 'ADMIN';
  const canCreate = canManage || organization.allowMemberProjectCreate;
  const orgProjects = projects.filter((p) => p.organizationId === organizationId);

  // Per project: how many calls and when the latest one came in (newest first, so one row is enough).
  // A project that can't be read just shows no numbers.
  const activity = await Promise.all(
    orgProjects.map((p) =>
      getCallsFiltered(p.id, { page: 1, pageSize: 1 })
        .then((r) => ({ projectId: p.id, calls: r.total, lastCallAt: r.data[0]?.createdAt ?? null }))
        .catch(() => null)
    )
  );

  return (
    <OrganizationProjects
      organization={organization}
      projects={orgProjects}
      activity={Object.fromEntries(activity.filter((a) => a !== null).map((a) => [a.projectId, a]))}
      canCreate={canCreate}
    />
  );
}
