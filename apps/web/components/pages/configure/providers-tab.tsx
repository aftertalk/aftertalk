'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useState } from 'react';

import { SettingsRow, SettingsSection } from '@/components/shared/settings-section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { i18n } from '@/i18n/constants';
import { getProviderModels, setProjectProvider } from '@/lib/action/project-providers';
import type { ProjectProviders, ProviderKind } from '@/lib/types';
import { backendMessage, unwrap } from '@/lib/utils/backend-error';

const NONE = '__none__';

const SLOTS: { slot: ProviderKind; label: string; hint: string }[] = [
  { slot: 'speech', label: i18n.projectConfig.providers.speech, hint: i18n.projectConfig.providers.speechHint },
  { slot: 'llm', label: i18n.projectConfig.providers.llm, hint: i18n.projectConfig.providers.llmHint },
  {
    slot: 'diarization',
    label: i18n.projectConfig.providers.diarization,
    hint: i18n.projectConfig.providers.diarizationHint,
  },
];

const LOCATION: Record<string, string> = {
  eu: i18n.providers.location.eu,
  us: i18n.providers.location.us,
  own_network: i18n.providers.location.ownNetwork,
  other: i18n.providers.location.other,
};

interface ProvidersTabProps {
  projectId: string;
  organizationId?: string;
  providers: ProjectProviders;
  /** Project admins choose; everyone else reads. */
  canManage: boolean;
  /** Organisation owners and admins get a link to the page where connections are added. */
  canManageConnections: boolean;
}

// Which connection and model the project uses for speech, the LLM and (optionally) diarization
// (item 37f). The connections themselves belong to the organisation.
export function ProvidersTab({
  projectId,
  organizationId,
  providers,
  canManage,
  canManageConnections,
}: ProvidersTabProps) {
  const t = useTranslations();
  const connectionsHref = organizationId ? `/organization/${organizationId}/providers` : null;

  return (
    <SettingsSection
      title={t(i18n.projectConfig.providers.title)}
      description={t(i18n.projectConfig.providers.description)}
    >
      {SLOTS.map(({ slot, label, hint }) => (
        <SlotRow
          key={slot}
          projectId={projectId}
          slot={slot}
          label={t(label)}
          hint={t(hint)}
          providers={providers}
          disabled={!canManage}
        />
      ))}
      <SettingsRow
        label={t(i18n.projectConfig.providers.connections)}
        description={t(
          canManageConnections
            ? i18n.projectConfig.providers.connectionsHint
            : i18n.projectConfig.providers.connectionsAskAdmin
        )}
      >
        {canManageConnections && connectionsHref && (
          <Button variant="outline" asChild>
            <Link href={connectionsHref}>{t(i18n.projectConfig.providers.manage)}</Link>
          </Button>
        )}
      </SettingsRow>
    </SettingsSection>
  );
}

function SlotRow({
  projectId,
  slot,
  label,
  hint,
  providers,
  disabled,
}: {
  projectId: string;
  slot: ProviderKind;
  label: string;
  hint: string;
  providers: ProjectProviders;
  disabled: boolean;
}) {
  const t = useTranslations();
  const router = useRouter();
  const listId = useId();
  const options = providers.options.filter((o) => o.kind === slot);
  const choice = providers.choices.find((c) => c.slot === slot);
  const needsModel = slot !== 'diarization';

  const [connectionId, setConnectionId] = useState(choice?.connectionId ?? NONE);
  const [model, setModel] = useState(choice?.model ?? '');
  const [saved, setSaved] = useState({ connectionId: choice?.connectionId ?? NONE, model: choice?.model ?? '' });
  const [models, setModels] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Names the provider offers, as suggestions; on any failure the field stays a plain text field.
  useEffect(() => {
    if (disabled || !needsModel || connectionId === NONE) return;
    let live = true;
    getProviderModels(projectId, slot, connectionId)
      .then((names) => live && setModels(names))
      .catch(() => live && setModels([]));
    return () => {
      live = false;
    };
  }, [projectId, slot, connectionId, disabled, needsModel]);

  const save = async (nextConnection: string, nextModel: string) => {
    const trimmed = nextModel.trim();
    if (nextConnection === saved.connectionId && trimmed === saved.model) return;
    // A connection without its model is not a choice yet: wait for the model.
    if (nextConnection !== NONE && needsModel && !trimmed) {
      setError(t(i18n.projectConfig.providers.modelRequired));
      return;
    }
    setIsSaving(true);
    setError(null);
    setSavedAt(null);
    try {
      unwrap(
        await setProjectProvider(projectId, slot, nextConnection === NONE ? null : nextConnection, trimmed || null)
      );
      setSaved({ connectionId: nextConnection, model: nextConnection === NONE ? '' : trimmed });
      if (nextConnection === NONE) setModel('');
      setSavedAt(Date.now());
      // The upload gate and the checklist on the project home read the same choices.
      router.refresh();
    } catch (e) {
      setError(backendMessage(e) ?? t(i18n.projectConfig.general.saveFailed));
    } finally {
      setIsSaving(false);
    }
  };

  const selected = options.find((o) => o.id === connectionId);

  return (
    <SettingsRow
      label={label}
      description={hint}
      status={
        <span role="status" className="text-meta">
          {savedAt && (
            <span
              key={savedAt}
              className="text-muted-foreground animate-out fade-out fill-mode-forwards delay-1000 duration-500"
            >
              {t(i18n.projectConfig.saved)}
            </span>
          )}
        </span>
      }
    >
      <div className="w-full sm:w-72">
        <div className="flex flex-col gap-2">
          <Select
            value={connectionId}
            onValueChange={(value) => {
              setConnectionId(value);
              setModels([]);
              void save(value, model);
            }}
            disabled={disabled || isSaving}
          >
            <SelectTrigger className="w-full" aria-label={label} aria-invalid={!!error}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t(i18n.projectConfig.providers.none)}</SelectItem>
              {options.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {needsModel && connectionId !== NONE && (
            <>
              <Input
                value={model}
                list={listId}
                onChange={(e) => setModel(e.target.value)}
                onBlur={() => save(connectionId, model)}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                placeholder={t(i18n.projectConfig.providers.modelPlaceholder)}
                aria-label={t(i18n.projectConfig.providers.model)}
                maxLength={200}
                disabled={disabled || isSaving}
                autoComplete="off"
              />
              <datalist id={listId}>
                {models.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </>
          )}
        </div>
        {selected && (
          <p className="text-meta text-muted-foreground mt-1.5">
            {t(i18n.providers.locationDeclared, { location: t(LOCATION[selected.dataLocation]) })}
          </p>
        )}
        {options.length === 0 && (
          <p className="text-meta text-muted-foreground mt-1.5">{t(i18n.projectConfig.providers.noConnections)}</p>
        )}
        {error && <p className="text-meta text-negative mt-1.5">{error}</p>}
      </div>
    </SettingsRow>
  );
}
