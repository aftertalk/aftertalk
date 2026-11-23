'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { SettingsRow } from '@/components/shared/settings-section';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { i18n } from '@/i18n/constants';
import { updateProject, type UpdateProjectInput } from '@/lib/action/projects';
import type { MemberPiiAccess } from '@/lib/types';
import { backendMessage, unwrap } from '@/lib/utils/backend-error';
import { LANGUAGE_KEYS, UPLOAD_LANGUAGES, type UploadLanguage } from '@/lib/utils/upload-language';

interface GeneralTabProps {
  projectId: string;
  name: string;
  description: string;
  allowedLanguages: UploadLanguage[];
  memberPiiAccess: MemberPiiAccess;
  retentionDays: number | null;
  canManage: boolean;
  /** Organisation owners and admins: the only ones who may change who sees original text and audio. */
  canManagePiiAccess: boolean;
}

// Single values, so each saves on its own (on blur or Enter for text, on change for the rest) and says
// "Saved" in place; a failure shows under the field and keeps what was typed.
export function GeneralTab({
  projectId,
  name,
  description,
  allowedLanguages,
  memberPiiAccess,
  retentionDays,
  canManage,
  canManagePiiAccess,
}: GeneralTabProps) {
  const t = useTranslations();
  const router = useRouter();

  // The name also shows in the sidebar and page headers, so those re-read it after a save.
  const save = async (input: UpdateProjectInput) => {
    unwrap(await updateProject(projectId, input));
    router.refresh();
  };

  return (
    <>
      <TextRow
        id="projectName"
        label={t(i18n.projectConfig.general.name)}
        initial={name}
        required
        maxLength={100}
        disabled={!canManage}
        onSave={(value) => save({ name: value })}
      />
      <TextRow
        id="projectDescription"
        label={t(i18n.projectConfig.general.projectDescription)}
        initial={description}
        multiline
        maxLength={500}
        disabled={!canManage}
        onSave={(value) => save({ description: value })}
      />
      <LanguagesRow
        initial={allowedLanguages}
        disabled={!canManage}
        onSave={(langs) => save({ allowedLanguages: langs })}
      />
      <TextRow
        id="retentionDays"
        label={t(i18n.projectConfig.general.retention)}
        description={t(i18n.projectConfig.general.retentionHint)}
        initial={retentionDays === null ? '' : String(retentionDays)}
        numeric
        maxLength={4}
        placeholder={t(i18n.projectConfig.general.retentionNever)}
        disabled={!canManage}
        onSave={(value) => save({ retentionDays: value === '' ? null : Number(value) })}
      />
      <PiiAccessRow
        initial={memberPiiAccess}
        disabled={!canManagePiiAccess}
        onSave={(value) => save({ memberPiiAccess: value })}
      />
    </>
  );
}

/** "Saved" that fades out; a new `savedAt` restarts it. */
function SavedNote({ savedAt }: { savedAt: number | null }) {
  const t = useTranslations();
  return (
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
  );
}

function TextRow({
  id,
  label,
  description,
  initial,
  required = false,
  multiline = false,
  numeric = false,
  maxLength,
  placeholder,
  disabled,
  onSave,
}: {
  id: string;
  label: string;
  description?: string;
  initial: string;
  required?: boolean;
  /** A longer text: a full-width textarea under the label; Enter makes a new line instead of saving. */
  multiline?: boolean;
  /** Digits only, in a short field. */
  numeric?: boolean;
  maxLength: number;
  placeholder?: string;
  disabled: boolean;
  onSave: (value: string) => Promise<void>;
}) {
  const t = useTranslations();
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const commit = async () => {
    const next = value.trim();
    if (next === saved) {
      setError(null);
      return;
    }
    if (required && !next) {
      setError(t(i18n.projectConfig.general.nameRequired));
      return;
    }
    setError(null);
    setSavedAt(null);
    try {
      await onSave(next);
      setSaved(next);
      setValue(next);
      setSavedAt(Date.now());
    } catch (e) {
      // The server's own sentence when it refused the value; the generic one when the request failed.
      setError(backendMessage(e) ?? t(i18n.projectConfig.general.saveFailed));
    }
  };

  return (
    <SettingsRow
      label={label}
      description={description}
      htmlFor={id}
      status={<SavedNote savedAt={savedAt} />}
      wide={multiline}
    >
      <div className={multiline ? 'w-full' : numeric ? 'w-full sm:w-28' : 'w-full sm:w-72'}>
        {multiline ? (
          <Textarea
            id={id}
            value={value}
            rows={3}
            onChange={(e) => setValue(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setValue(saved);
                setError(null);
              }
            }}
            disabled={disabled}
            maxLength={maxLength}
            aria-invalid={!!error}
          />
        ) : (
          <Input
            id={id}
            value={value}
            inputMode={numeric ? 'numeric' : undefined}
            placeholder={placeholder}
            onChange={(e) => setValue(numeric ? e.target.value.replace(/\D/g, '') : e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                setValue(saved);
                setError(null);
              }
            }}
            disabled={disabled}
            maxLength={maxLength}
            aria-invalid={!!error}
          />
        )}
        {error && <p className="text-meta text-negative mt-1.5">{error}</p>}
      </div>
    </SettingsRow>
  );
}

/** The languages a call may be in. With one, every call is processed in it and nothing is detected. */
function LanguagesRow({
  initial,
  disabled,
  onSave,
}: {
  initial: UploadLanguage[];
  disabled: boolean;
  onSave: (languages: UploadLanguage[]) => Promise<void>;
}) {
  const t = useTranslations();
  const [languages, setLanguages] = useState<UploadLanguage[]>(initial);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const toggle = async (code: UploadLanguage, checked: boolean) => {
    const next = UPLOAD_LANGUAGES.filter((l) => (l === code ? checked : languages.includes(l)));
    if (next.length === 0) {
      setError(t(i18n.errors.languages));
      return;
    }
    const previous = languages;
    setLanguages(next);
    setIsSaving(true);
    setError(null);
    setSavedAt(null);
    try {
      await onSave(next);
      // It was just set to null, so the note is mounted again and its fade restarts.
      setSavedAt(1);
    } catch (e) {
      setError(backendMessage(e) ?? t(i18n.projectConfig.general.saveFailed));
      setLanguages(previous);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <SettingsRow
      label={t(i18n.projectConfig.general.languages)}
      description={t(i18n.projectConfig.general.languagesHint)}
      status={<SavedNote savedAt={savedAt} />}
    >
      <div>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {UPLOAD_LANGUAGES.map((code) => (
            <label key={code} className="text-body text-foreground flex items-center gap-2">
              <Checkbox
                checked={languages.includes(code)}
                onCheckedChange={(checked) => toggle(code, checked === true)}
                disabled={disabled || isSaving}
              />
              {t(LANGUAGE_KEYS[code])}
            </label>
          ))}
        </div>
        {error && <p className="text-meta text-negative mt-1.5">{error}</p>}
      </div>
    </SettingsRow>
  );
}

/** Who may see original text and hear audio (item 37b). */
function PiiAccessRow({
  initial,
  disabled,
  onSave,
}: {
  initial: MemberPiiAccess;
  disabled: boolean;
  onSave: (value: MemberPiiAccess) => Promise<void>;
}) {
  const t = useTranslations();
  const [value, setValue] = useState<MemberPiiAccess>(initial);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const handleChange = async (next: MemberPiiAccess) => {
    const previous = value;
    setValue(next);
    setIsSaving(true);
    setError(null);
    setSavedAt(null);
    try {
      await onSave(next);
      setSavedAt(Date.now());
    } catch (e) {
      setError(backendMessage(e) ?? t(i18n.projectConfig.general.saveFailed));
      setValue(previous);
    } finally {
      setIsSaving(false);
    }
  };

  const hint =
    value === 'full' ? i18n.projectConfig.general.piiAccessFullHint : i18n.projectConfig.general.piiAccessStrictHint;

  return (
    <SettingsRow
      label={t(i18n.projectConfig.general.piiAccess)}
      description={`${t(hint)}${disabled ? ` ${t(i18n.projectConfig.general.piiAccessLocked)}` : ''}`}
      htmlFor="memberPiiAccess"
      status={<SavedNote savedAt={savedAt} />}
    >
      <div className="w-full sm:w-56">
        <Select value={value} onValueChange={(v) => handleChange(v as MemberPiiAccess)} disabled={disabled || isSaving}>
          <SelectTrigger id="memberPiiAccess" className="w-full" aria-invalid={!!error}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="full">{t(i18n.projectConfig.general.piiAccessFull)}</SelectItem>
            <SelectItem value="strict">{t(i18n.projectConfig.general.piiAccessStrict)}</SelectItem>
          </SelectContent>
        </Select>
        {error && <p className="text-meta text-negative mt-1.5">{error}</p>}
      </div>
    </SettingsRow>
  );
}
