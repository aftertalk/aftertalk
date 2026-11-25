'use client';

import { Check } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { PageContainer } from '@/components/shared/page-container';
import { PageHeader } from '@/components/shared/page-header';
import { SettingsRow, SettingsSection, SettingsSections } from '@/components/shared/settings-section';
import { Button } from '@/components/ui/button';
import { ConfirmModal } from '@/components/ui/confirm-modal';
import { Input } from '@/components/ui/input';
import { i18n } from '@/i18n/constants';
import { deleteOrganization, updateOrganization } from '@/lib/action/organizations';
import type { OrganizationResponse, UpdateOrganizationRequest } from '@/lib/types';
import { backendMessage, unwrap } from '@/lib/utils/backend-error';

interface OrganizationSettingsProps {
  organization: OrganizationResponse;
  /** False for the only organisation of an install: core cannot make another one. */
  canDelete: boolean;
}

type Field = 'name';

// Brief inline confirmation next to the control that was just saved.
function Saved({ label }: { label: string }) {
  return (
    <span className="text-meta text-muted-foreground flex items-center gap-1 whitespace-nowrap" role="status">
      <Check className="h-3.5 w-3.5" />
      {label}
    </span>
  );
}

export function OrganizationSettings({ organization, canDelete }: OrganizationSettingsProps) {
  const t = useTranslations();
  const router = useRouter();
  const isOwner = organization.role === 'OWNER';
  const isAdmin = isOwner || organization.role === 'ADMIN';

  const [savedName, setSavedName] = useState(organization.name);
  const [name, setName] = useState(organization.name);
  const [saving, setSaving] = useState<Field | null>(null);
  const [justSaved, setJustSaved] = useState<Field | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (!justSaved) return;
    const timer = setTimeout(() => setJustSaved(null), 2500);
    return () => clearTimeout(timer);
  }, [justSaved]);

  // The open version has one organisation with one owner (decision 91), so the settings for
  // members (who may create projects, required 2FA) are not shown; the name is the only setting.
  const save = async (field: Field, patch: UpdateOrganizationRequest, revert?: () => void) => {
    setSaving(field);
    try {
      unwrap(await updateOrganization(organization.id, patch));
      setJustSaved(field);
      router.refresh();
      return true;
    } catch (e) {
      revert?.();
      toast.error(backendMessage(e) ?? t(i18n.organization.general.saveFailed));
      return false;
    } finally {
      setSaving(null);
    }
  };

  // The name saves when the field is left or Enter is pressed; an emptied field snaps back.
  const commitName = async () => {
    const next = name.trim();
    if (!next) return setName(savedName);
    if (next === savedName) return;
    if (await save('name', { name: next }, () => setName(savedName))) setSavedName(next);
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      unwrap(await deleteOrganization(organization.id));
      toast.success(t(i18n.organization.danger.deleted));
      router.push('/');
    } catch (e) {
      toast.error(backendMessage(e) ?? t(i18n.organization.danger.deleteFailed));
      setIsDeleting(false);
    }
  };

  const savedLabel = t(i18n.organization.general.savedInline);

  return (
    <PageContainer>
      <PageHeader
        eyebrow={t(i18n.navbar.organization)}
        title={t(i18n.navbar.settings)}
        description={t(i18n.organization.settings.description)}
      />

      <SettingsSections>
        <SettingsSection
          title={t(i18n.organization.general.title)}
          description={t(i18n.organization.general.description)}
        >
          <SettingsRow
            label={t(i18n.organization.general.name)}
            htmlFor="org-name"
            status={justSaved === 'name' && <Saved label={savedLabel} />}
          >
            <Input
              id="org-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') setName(savedName);
              }}
              disabled={!isAdmin || saving === 'name'}
              className="w-full sm:w-72"
            />
          </SettingsRow>
        </SettingsSection>

        {isOwner && canDelete && (
          <SettingsSection
            title={t(i18n.organization.danger.title)}
            description={t(i18n.organization.danger.sectionDescription)}
            tone="danger"
          >
            <SettingsRow
              label={t(i18n.organization.danger.delete)}
              description={t(i18n.organization.danger.description)}
            >
              <Button variant="destructiveOutline" onClick={() => setDeleteOpen(true)}>
                {t(i18n.organization.danger.deleteAction)}
              </Button>
            </SettingsRow>
          </SettingsSection>
        )}
      </SettingsSections>

      <ConfirmModal
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onConfirm={handleDelete}
        title={t(i18n.organization.danger.confirmTitle)}
        description={t(i18n.organization.danger.confirmDescription, { name: savedName })}
        confirmText={t(i18n.organization.danger.delete)}
        cancelText={t(i18n.common.cancel)}
        variant="destructive"
        confirmPhrase={savedName}
        confirmPhraseLabel={t(i18n.organization.danger.typeToConfirm, { name: savedName })}
        isLoading={isDeleting}
      />
    </PageContainer>
  );
}
