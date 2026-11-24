import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { OrganizationSettings } from '@/components/pages/organization/organization-settings';
import { OrgManagersOnly } from '@/components/shared/no-access';
import { i18n } from '@/i18n/constants';
import { getOrganization, getOrganizations } from '@/lib/action/organizations';
import { localizedPageMetadata } from '@/lib/utils/page-metadata';

export async function generateMetadata(): Promise<Metadata> {
  return localizedPageMetadata(i18n.orgSwitcher.settings);
}

export const dynamic = 'force-dynamic';

interface OrganizationSettingsPageProps {
  params: Promise<{ organizationId: string }>;
}

export default async function OrganizationSettingsPage({ params }: OrganizationSettingsPageProps) {
  const { organizationId } = await params;
  const organization = await getOrganization(organizationId).catch(() => null);

  if (!organization) redirect(`/organization/${organizationId}`);
  if (organization.role !== 'OWNER' && organization.role !== 'ADMIN') {
    return <OrgManagersOnly organizationId={organizationId} />;
  }

  const organizations = await getOrganizations();
  return <OrganizationSettings organization={organization} canDelete={organizations.length > 1} />;
}
