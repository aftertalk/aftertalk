'use client';

import { Lock } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

import { GeneralTab } from '@/components/pages/configure/general-tab';
import { ProvidersTab } from '@/components/pages/configure/providers-tab';
import { CategoriesEditor, RolesEditor, TemplatesEditor } from '@/components/shared/config-editors';
import { PageContainer } from '@/components/shared/page-container';
import { PageHeader } from '@/components/shared/page-header';
import { SettingsRow, SettingsSection, SettingsSections } from '@/components/shared/settings-section';
import { Button } from '@/components/ui/button';
import { ConfirmModal } from '@/components/ui/confirm-modal';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { i18n } from '@/i18n/constants';
import { deleteProject } from '@/lib/action/projects';
import type { MemberPiiAccess, ProjectProviders } from '@/lib/types';
import type { UploadLanguage } from '@/lib/utils/upload-language';

type ConfigTab = 'general' | 'categories' | 'roles' | 'templates' | 'providers';

interface ProjectConfigureProps {
  projectId: string;
  projectName: string;
  projectDescription: string;
  organizationId?: string;
  /** Undefined when the project couldn't be read — the General tab says so rather than guessing. */
  settings?: { allowedLanguages: UploadLanguage[]; memberPiiAccess: MemberPiiAccess; retentionDays: number | null };
  providers: ProjectProviders;
  /** Deleting a project is for project admins; it closes the General tab. */
  canDelete: boolean;
  canManageSettings: boolean;
  /** Organisation owners and admins: the personal-data level and the provider connections. */
  isOrgAdmin: boolean;
}

export function ProjectConfigure({
  projectId,
  projectName,
  projectDescription,
  organizationId,
  settings,
  providers,
  canDelete,
  canManageSettings,
  isOrgAdmin,
}: ProjectConfigureProps) {
  const t = useTranslations();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const tabs: { value: ConfigTab; label: string }[] = [
    { value: 'general', label: t(i18n.projectConfig.general.title) },
    { value: 'categories', label: t(i18n.navbar.categories) },
    { value: 'roles', label: t(i18n.navbar.channelRoles) },
    { value: 'templates', label: t(i18n.navbar.analysisTemplates) },
    { value: 'providers', label: t(i18n.projectConfig.providers.title) },
  ];

  // The sidebar (and below lg, the tab row here) drives which section shows; the URL is the source of
  // truth. No tab named means General, the first entry.
  const requestedTab = searchParams.get('tab');
  const tab: ConfigTab = tabs.find((x) => x.value === requestedTab)?.value ?? 'general';

  const handleDeleteProject = async () => {
    setIsDeleting(true);
    try {
      await deleteProject(projectId);
      setDeleteOpen(false);
      toast.success(t(i18n.projectConfig.delete.success));
      router.push(organizationId ? `/organization/${organizationId}` : '/');
      router.refresh();
    } catch {
      toast.error(t(i18n.projectConfig.delete.error));
      setIsDeleting(false);
    }
  };

  return (
    <PageContainer>
      <PageHeader
        eyebrow={projectName || undefined}
        title={t(i18n.projectConfig.title)}
        description={t(i18n.projectConfig.description)}
      />
      {/* Disabled fields with no word of why read as broken. */}
      {!canManageSettings && (
        <p className="text-meta text-muted-foreground flex items-center gap-1.5">
          <Lock className="size-3.5 shrink-0" aria-hidden />
          {t(i18n.projectConfig.readOnly)}
        </p>
      )}

      {/* Every section stays mounted and is only hidden when inactive, so switching sections never
          re-fetches or loses what's on screen. */}
      <Tabs value={tab} className="gap-8">
        {/* Five sections don't fit a phone's width as tabs (they were cut off), so there it's a picker; from
            lg the sidebar lists them. */}
        <Select value={tab} onValueChange={(v) => router.push(`/${projectId}/configure?tab=${v}`, { scroll: false })}>
          <SelectTrigger className="w-full sm:hidden" aria-label={t(i18n.projectConfig.title)}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {tabs.map(({ value, label }) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <TabsList className="hidden sm:flex lg:hidden" aria-label={t(i18n.projectConfig.title)}>
          {tabs.map(({ value, label }) => (
            <TabsTrigger key={value} value={value} asChild>
              <Link href={`/${projectId}/configure?tab=${value}`} scroll={false}>
                {label}
              </Link>
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="general" forceMount className="data-[state=inactive]:hidden">
          <SettingsSections>
            <SettingsSection
              title={t(i18n.projectConfig.general.title)}
              description={t(i18n.projectConfig.general.description)}
            >
              {settings ? (
                <GeneralTab
                  projectId={projectId}
                  name={projectName}
                  description={projectDescription}
                  allowedLanguages={settings.allowedLanguages}
                  memberPiiAccess={settings.memberPiiAccess}
                  retentionDays={settings.retentionDays}
                  canManage={canManageSettings}
                  canManagePiiAccess={isOrgAdmin}
                />
              ) : (
                <p className="text-body text-muted-foreground px-5 py-5 md:px-6">
                  {t(i18n.projectConfig.general.loadError)}
                </p>
              )}
            </SettingsSection>

            {canDelete && (
              <SettingsSection
                tone="danger"
                title={t(i18n.projectConfig.dangerTitle)}
                description={t(i18n.projectConfig.dangerDescription)}
              >
                <SettingsRow
                  label={t(i18n.projectConfig.delete.button)}
                  description={t(i18n.projectConfig.delete.description)}
                >
                  <Button variant="destructiveOutline" onClick={() => setDeleteOpen(true)}>
                    {t(i18n.projectConfig.delete.open)}
                  </Button>
                </SettingsRow>
              </SettingsSection>
            )}
          </SettingsSections>
        </TabsContent>

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
            <TemplatesEditor projectId={projectId} />
          </SettingsSections>
        </TabsContent>
        <TabsContent value="providers" forceMount className="data-[state=inactive]:hidden">
          <SettingsSections>
            <ProvidersTab
              projectId={projectId}
              organizationId={organizationId}
              providers={providers}
              canManage={canManageSettings}
              canManageConnections={isOrgAdmin}
            />
          </SettingsSections>
        </TabsContent>
      </Tabs>

      <ConfirmModal
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onConfirm={handleDeleteProject}
        title={t(i18n.projectConfig.delete.title)}
        description={t(i18n.projectConfig.delete.description)}
        confirmText={t(i18n.projectConfig.delete.confirm)}
        cancelText={t(i18n.common.cancel)}
        loadingText={t(i18n.projectConfig.delete.deleting)}
        variant="destructive"
        isLoading={isDeleting}
        confirmPhrase={projectName}
        confirmPhraseLabel={t(i18n.projectConfig.delete.typeToConfirm, { name: projectName })}
      />
    </PageContainer>
  );
}
