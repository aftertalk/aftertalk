'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { ProvidersTab } from '@/components/pages/configure/providers-tab';
import { CategoriesEditor, RolesEditor, TemplatesEditor } from '@/components/shared/config-editors';
import { PageContainer } from '@/components/shared/page-container';
import { PageHeader } from '@/components/shared/page-header';
import { SettingsSections } from '@/components/shared/settings-section';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { i18n } from '@/i18n/constants';
import type { ProjectProviders } from '@/lib/types';

type GateStep = 'categories' | 'roles' | 'templates' | 'providers';

interface UploadSetupGateProps {
  projectId: string;
  projectName?: string;
  organizationId?: string;
  providers: ProjectProviders;
  /** Project admins choose the providers; others are told to ask one. */
  canManage: boolean;
  isOrgAdmin: boolean;
}

// Uploads are meaningless without config, so this is the one deliberately forced
// setup in the app: the page keeps showing this gate until the three lists have
// entries and the project has a speech and an LLM provider. The left sidebar nests
// the steps under Upload and drives which one shows;
// below lg, where the sidebar isn't, the tab row here does.
export function UploadSetupGate({
  projectId,
  projectName,
  organizationId,
  providers,
  canManage,
  isOrgAdmin,
}: UploadSetupGateProps) {
  const t = useTranslations();
  const searchParams = useSearchParams();
  const raw = searchParams.get('tab');
  const step: GateStep = raw === 'roles' || raw === 'templates' || raw === 'providers' ? raw : 'categories';

  const steps: { value: GateStep; label: string }[] = [
    { value: 'categories', label: t(i18n.navbar.categories) },
    { value: 'roles', label: t(i18n.navbar.channelRoles) },
    { value: 'templates', label: t(i18n.navbar.analysisTemplates) },
    { value: 'providers', label: t(i18n.projectConfig.providers.title) },
  ];

  return (
    <PageContainer>
      <PageHeader eyebrow={projectName} title={t('uploadGate.title')} description={t('uploadGate.description')} />

      {/* All four steps stay mounted and only the active one shows, so switching steps never re-fetches. */}
      <Tabs value={step} className="gap-8">
        <TabsList className="lg:hidden" aria-label={t('uploadGate.title')}>
          {steps.map(({ value, label }) => (
            <TabsTrigger key={value} value={value} asChild>
              <Link href={`/${projectId}/upload?tab=${value}`} scroll={false}>
                {label}
              </Link>
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="categories" forceMount className="data-[state=inactive]:hidden">
          <SettingsSections>
            <CategoriesEditor projectId={projectId} />
          </SettingsSections>
        </TabsContent>
        <TabsContent value="roles" forceMount className="data-[state=inactive]:hidden">
          <SettingsSections>
            <RolesEditor projectId={projectId} />
          </SettingsSections>
        </TabsContent>
        <TabsContent value="templates" forceMount className="data-[state=inactive]:hidden">
          <SettingsSections>
            <TemplatesEditor projectId={projectId} from="upload" />
          </SettingsSections>
        </TabsContent>
        <TabsContent value="providers" forceMount className="data-[state=inactive]:hidden">
          <SettingsSections>
            <ProvidersTab
              projectId={projectId}
              organizationId={organizationId}
              providers={providers}
              canManage={canManage}
              canManageConnections={isOrgAdmin}
            />
          </SettingsSections>
        </TabsContent>
      </Tabs>
    </PageContainer>
  );
}
