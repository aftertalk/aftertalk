import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { OrganizationProviders } from '@/components/pages/organization/organization-providers';
import { OrgManagersOnly } from '@/components/shared/no-access';
import { i18n } from '@/i18n/constants';
import { getOrganization } from '@/lib/action/organizations';
import { getProviderConnections } from '@/lib/action/providers';
import { localizedPageMetadata } from '@/lib/utils/page-metadata';

export async function generateMetadata(): Promise<Metadata> {
  return localizedPageMetadata(i18n.meta.providers);
}

export const dynamic = 'force-dynamic';

interface ProvidersPageProps {
  params: Promise<{ organizationId: string }>;
}

// Provider connections (item 37d): organisation owners and admins only. The actions check again.
export default async function ProvidersPage({ params }: ProvidersPageProps) {
  const { organizationId } = await params;
  const organization = await getOrganization(organizationId).catch(() => null);

  if (!organization) redirect(`/organization/${organizationId}`);
  if (organization.role !== 'OWNER' && organization.role !== 'ADMIN') {
    return <OrgManagersOnly organizationId={organizationId} />;
  }

  const connections = await getProviderConnections(organizationId);
  return (
    <OrganizationProviders
      organizationId={organizationId}
      organizationName={organization.name}
      connections={connections}
    />
  );
}
