import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { OrganizationSettings } from '@/components/pages/organization/organization-settings';
import { OrgManagersOnly } from '@/components/shared/no-access';
import { i18n } from '@/i18n/constants';
import { getOrganization } from '@/lib/action/organizations';
import { getCurrentUser } from '@/lib/utils/auth';
import { localizedPageMetadata } from '@/lib/utils/page-metadata';

export async function generateMetadata(): Promise<Metadata> {
  return localizedPageMetadata(i18n.orgSwitcher.settings);
}

export const dynamic = 'force-dynamic';

interface OrganizationSettingsPageProps {
  params: Promise<{ organizationId: string }>;
}

export default async function OrganizationSettingsPage({ params }: OrganizationSettingsPageProps) {
  const [user, { organizationId }] = await Promise.all([getCurrentUser(), params]);
  const organization = await getOrganization(organizationId).catch(() => null);

  if (!organization) redirect(`/organization/${organizationId}`);
  if (organization.role !== 'OWNER' && organization.role !== 'ADMIN') {
    return <OrgManagersOnly organizationId={organizationId} />;
  }

  return <OrganizationSettings organization={organization} userEmail={user?.email ?? ''} />;
}
