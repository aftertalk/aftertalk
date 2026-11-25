'use client';

import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

import { useJobErrorSentence } from '@/components/pages/calls/call-status';
import { EmptyState } from '@/components/shared/empty-state';
import { PageContainer } from '@/components/shared/page-container';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmModal } from '@/components/ui/confirm-modal';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Surface } from '@/components/ui/surface';
import { i18n } from '@/i18n/constants';
import {
  createProviderConnection,
  deleteProviderConnection,
  testProviderConnection,
  updateProviderConnection,
} from '@/lib/action/providers';
import type { DataLocation, ProviderConnection, ProviderKind } from '@/lib/types';
import { backendMessage, unwrap } from '@/lib/utils/backend-error';

const P = i18n.providers;

const KIND_KEY: Record<ProviderKind, string> = {
  speech: P.kinds.speech,
  llm: P.kinds.llm,
  diarization: P.kinds.diarization,
};

const LOCATION_KEY: Record<DataLocation, string> = {
  eu: P.location.eu,
  us: P.location.us,
  own_network: P.location.ownNetwork,
  other: P.location.other,
};

const KINDS: ProviderKind[] = ['speech', 'llm', 'diarization'];
const LOCATIONS: DataLocation[] = ['eu', 'us', 'own_network', 'other'];

interface OrganizationProvidersProps {
  organizationId: string;
  organizationName: string;
  connections: ProviderConnection[];
}

type Editor = { kind: 'add' } | { kind: 'edit'; connection: ProviderConnection } | null;

// Add, edit, test and remove provider connections (item 37d). An API key is write-only: once saved
// the page only says whether one is stored.
export function OrganizationProviders({ organizationId, organizationName, connections }: OrganizationProvidersProps) {
  const t = useTranslations();
  const router = useRouter();
  const errorSentence = useJobErrorSentence();
  const [editor, setEditor] = useState<Editor>(null);
  const [removing, setRemoving] = useState<ProviderConnection | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  // The outcome of the last test of each connection, shown under its row until the page reloads.
  const [testNote, setTestNote] = useState<Record<string, { ok: boolean; text: string }>>({});

  const handleTest = async (connection: ProviderConnection) => {
    setTestingId(connection.id);
    try {
      const result = unwrap(await testProviderConnection(connection.id));
      setTestNote((prev) => ({
        ...prev,
        [connection.id]: result.ok
          ? { ok: true, text: t(P.testPassed) }
          : { ok: false, text: t(P.testFailed, { reason: errorSentence(result.code) }) },
      }));
      router.refresh();
    } catch (e) {
      setTestNote((prev) => ({
        ...prev,
        [connection.id]: { ok: false, text: backendMessage(e) ?? t(P.testFailed, { reason: errorSentence(null) }) },
      }));
    } finally {
      setTestingId(null);
    }
  };

  const handleRemove = async () => {
    if (!removing) return;
    setIsRemoving(true);
    try {
      unwrap(await deleteProviderConnection(removing.id));
      toast.success(t(P.removed));
      setRemoving(null);
      router.refresh();
    } catch (e) {
      toast.error(backendMessage(e) ?? t(P.removeFailed));
    } finally {
      setIsRemoving(false);
    }
  };

  return (
    <PageContainer>
      <PageHeader eyebrow={organizationName} title={t(P.title)} description={t(P.description)}>
        <Button onClick={() => setEditor({ kind: 'add' })}>
          <Plus />
          {t(P.add)}
        </Button>
      </PageHeader>

      {connections.length === 0 ? (
        <Surface>
          <EmptyState title={t(P.empty)} className="py-10" />
        </Surface>
      ) : (
        <Surface pad="none">
          <ul className="divide-y divide-black/[0.06] dark:divide-white/[0.06]">
            {connections.map((connection) => {
              const note = testNote[connection.id];
              return (
                <li key={connection.id} className="px-5 py-4 md:px-6">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                    <div className="min-w-0 flex-1 basis-64">
                      <p className="text-body text-foreground flex flex-wrap items-center gap-2 font-medium">
                        <span className="truncate">{connection.name}</span>
                        <Chip>{t(KIND_KEY[connection.kind])}</Chip>
                        {connection.inUse && <Chip>{t(P.inUse)}</Chip>}
                      </p>
                      <p
                        className="text-meta text-muted-foreground mt-0.5 truncate font-mono"
                        title={connection.baseUrl}
                      >
                        {connection.baseUrl}
                      </p>
                      <p className="text-meta text-muted-foreground mt-0.5">
                        {t(connection.hasApiKey ? P.keySet : P.keyNone)}
                        {' · '}
                        {t(P.locationDeclared, { location: t(LOCATION_KEY[connection.dataLocation]) })}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleTest(connection)}
                        disabled={testingId !== null}
                      >
                        {testingId === connection.id ? t(P.testing) : t(P.test)}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setEditor({ kind: 'edit', connection })}>
                        {t(P.edit)}
                      </Button>
                      {/* A connection a project uses cannot be removed; the action refuses it too. */}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setRemoving(connection)}
                        disabled={connection.inUse}
                      >
                        {t(P.remove)}
                      </Button>
                    </div>
                  </div>
                  {note && (
                    <p role="status" className={`text-meta mt-2 ${note.ok ? 'text-foreground' : 'text-negative'}`}>
                      {note.text}
                    </p>
                  )}
                  {connection.kind === 'speech' && connection.wordTimes === false && (
                    <p className="text-meta text-muted-foreground mt-2">{t(P.noWordTimes)}</p>
                  )}
                </li>
              );
            })}
          </ul>
        </Surface>
      )}

      {editor && (
        <ConnectionDialog
          // A new form for each connection, so nothing typed for one shows up in another.
          key={editor.kind === 'edit' ? editor.connection.id : 'add'}
          organizationId={organizationId}
          connection={editor.kind === 'edit' ? editor.connection : undefined}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            toast.success(t(P.saved));
            router.refresh();
          }}
        />
      )}

      <ConfirmModal
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        onConfirm={handleRemove}
        title={t(P.removeTitle)}
        description={t(P.removeDescription)}
        confirmText={t(P.remove)}
        cancelText={t(i18n.common.cancel)}
        loadingText={t(i18n.common.deleting)}
        variant="destructive"
        isLoading={isRemoving}
      />
    </PageContainer>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-meta text-foreground/70 bg-foreground/[0.06] shrink-0 rounded-full px-2 py-0.5 font-normal whitespace-nowrap">
      {children}
    </span>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="text-body text-foreground block font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-meta text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ConnectionDialog({
  organizationId,
  connection,
  onClose,
  onSaved,
}: {
  organizationId: string;
  /** Present when editing: kind and adapter are fixed, and an empty key keeps the stored one. */
  connection?: ProviderConnection;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations();
  const [name, setName] = useState(connection?.name ?? '');
  const [kind, setKind] = useState<ProviderKind>(connection?.kind ?? 'speech');
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [dataLocation, setDataLocation] = useState<DataLocation>(connection?.dataLocation ?? 'eu');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setError(null);
    try {
      unwrap(
        connection
          ? await updateProviderConnection(connection.id, {
              name,
              baseUrl,
              dataLocation,
              apiKey: apiKey || undefined,
              removeKey: removeKey || undefined,
            })
          : await createProviderConnection(organizationId, {
              name,
              kind,
              baseUrl,
              dataLocation,
              apiKey: apiKey || undefined,
            })
      );
      onSaved();
    } catch (err) {
      // The server's sentence says which field is wrong.
      setError(backendMessage(err) ?? t(P.saveFailed));
      setIsSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !isSaving && onClose()}>
      <DialogContent>
        <form onSubmit={handleSubmit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>{t(connection ? P.editTitle : P.addTitle)}</DialogTitle>
          </DialogHeader>

          <Field label={t(P.name)} htmlFor="providerName">
            <Input
              id="providerName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t(P.namePlaceholder)}
              maxLength={80}
              required
              autoComplete="off"
            />
          </Field>

          <Field label={t(P.kind)} htmlFor="providerKind" hint={connection ? undefined : t(P.kindFixed)}>
            <Select value={kind} onValueChange={(v) => setKind(v as ProviderKind)} disabled={!!connection}>
              <SelectTrigger id="providerKind" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {t(KIND_KEY[k])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field
            label={t(P.baseUrl)}
            htmlFor="providerBaseUrl"
            hint={t(kind === 'diarization' ? P.baseUrlHintDiarization : P.baseUrlHint)}
          >
            <Input
              id="providerBaseUrl"
              type="url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              maxLength={500}
              required
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <Field label={t(P.apiKey)} htmlFor="providerApiKey" hint={t(connection ? P.apiKeyHintEdit : P.apiKeyHintNew)}>
            <Input
              id="providerApiKey"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              maxLength={500}
              disabled={removeKey}
              // Not a sign-in password: keep the browser from offering to save or fill it.
              autoComplete="new-password"
              spellCheck={false}
            />
            {connection?.hasApiKey && (
              <label className="text-meta text-foreground flex items-center gap-2">
                <Checkbox checked={removeKey} onCheckedChange={(checked) => setRemoveKey(checked === true)} />
                {t(P.removeKey)}
              </label>
            )}
          </Field>

          <Field label={t(P.dataLocation)} htmlFor="providerLocation" hint={t(P.dataLocationHint)}>
            <Select value={dataLocation} onValueChange={(v) => setDataLocation(v as DataLocation)}>
              <SelectTrigger id="providerLocation" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LOCATIONS.map((location) => (
                  <SelectItem key={location} value={location}>
                    {t(LOCATION_KEY[location])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {error && (
            <p role="alert" className="text-meta text-negative">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>
              {t(i18n.common.cancel)}
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving ? t(P.saving) : t(P.save)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
