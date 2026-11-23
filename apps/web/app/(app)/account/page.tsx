import type { Metadata } from 'next';
import { cookies } from 'next/headers';

import { SettingsHeader } from '@/components/pages/settings/settings-header';
import { SettingsProfile } from '@/components/pages/settings/settings-profile';
import { SettingsSecurity } from '@/components/pages/settings/settings-security';
import { AppShell } from '@/components/shared/app-shell';
import { PageContainer } from '@/components/shared/page-container';
import { SettingsSections } from '@/components/shared/settings-section';
import { i18n } from '@/i18n/constants';
import { getAccount } from '@/lib/action/account';
import { getOrganizations } from '@/lib/action/organizations';
import { getProjects } from '@/lib/action/projects';
import { getCurrentUser } from '@/lib/utils/auth';
import { localizedPageMetadata } from '@/lib/utils/page-metadata';

export async function generateMetadata(): Promise<Metadata> {
  return localizedPageMetadata(i18n.meta.settings);
}

export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const user = await getCurrentUser();

  const [account, projects, organizations, cookieStore] = await Promise.all([
    user ? getAccount().catch(() => null) : Promise.resolve(null),
    getProjects().catch(() => []),
    getOrganizations().catch(() => []),
    cookies(),
  ]);

  const sidebarCollapsed = cookieStore.get('sidebarCollapsed')?.value === 'true';
  // The org the visitor was working in (written by the app shell), so the back link returns there.
  const lastOrgId = cookieStore.get('atLastOrg')?.value;
  const returnOrgId = organizations.some((o) => o.id === lastOrgId) ? lastOrgId : undefined;

  return (
    <AppShell
      user={user}
      context={{ kind: 'account', organizationId: returnOrgId }}
      projects={projects}
      organizations={organizations}
      initialSidebarCollapsed={sidebarCollapsed}
    >
      <PageContainer>
        <SettingsHeader />
        <SettingsSections>
          <SettingsProfile />
          <SettingsSecurity userEmail={user?.email ?? ''} twoFactorEnabled={account?.twoFactorEnabled ?? false} />
        </SettingsSections>
      </PageContainer>
    </AppShell>
  );
}
