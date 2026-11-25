'use client';

import { Check } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';

import { InlineEditor, InlineEditorActions } from '@/components/shared/inline-editor';
import { SettingsRow, SettingsSection } from '@/components/shared/settings-section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingButton } from '@/components/ui/loading-button';
import { i18n } from '@/i18n/constants';
import { authClient } from '@/lib/auth/client';
import { cn } from '@/lib/utils/cn';

interface SettingsSecurityProps {
  userEmail: string;
  twoFactorEnabled: boolean;
}

type Editor = 'password' | 'enable2fa' | 'disable2fa';

// Each row expands in place (one at a time) instead of opening a dialog, and reports its result in the row.
export function SettingsSecurity({ userEmail, twoFactorEnabled }: SettingsSecurityProps) {
  const t = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState<Editor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const triggers = useRef<Partial<Record<Editor, HTMLButtonElement | null>>>({});

  // Change password
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [sessionsRevoked, setSessionsRevoked] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  // Two-factor: password → QR and backup codes → code; disabling takes the password
  const [twoFaPassword, setTwoFaPassword] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [twoFaSaved, setTwoFaSaved] = useState(false);

  useEffect(() => {
    if (!twoFaSaved) return;
    const timer = setTimeout(() => setTwoFaSaved(false), 1500);
    return () => clearTimeout(timer);
  }, [twoFaSaved]);

  // Typed secrets never outlive their editor.
  const resetFields = () => {
    setError(null);
    setMismatch(false);
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setTwoFaPassword('');
    setSecret(null);
    setBackupCodes([]);
    setQrDataUrl(null);
    setCode('');
  };

  const openEditor = (editor: Editor) => {
    resetFields();
    setOpen(editor);
  };

  const closeEditor = () => {
    const editor = open;
    setOpen(null);
    resetFields();
    if (editor) requestAnimationFrame(() => triggers.current[editor]?.focus());
  };

  const trigger = (editor: Editor, label: string) =>
    open !== editor && (
      <Button
        ref={(el) => {
          triggers.current[editor] = el;
        }}
        variant="outline"
        onClick={() => openEditor(editor)}
      >
        {label}
      </Button>
    );

  const run = async (action: () => Promise<void>) => {
    setLoading(true);
    setError(null);
    try {
      await action();
    } catch {
      setError(t(i18n.appError.title));
    } finally {
      setLoading(false);
    }
  };

  const handleChangePassword = () => {
    if (newPassword !== confirmPassword) return setMismatch(true);
    void run(async () => {
      const { error: err } = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: false,
      });
      if (err) return setError(err.message ?? t(i18n.appError.title));
      setPasswordChanged(true);
      setSessionsRevoked(false);
      closeEditor();
    });
  };

  const handleLogoutOthers = async () => {
    setRevoking(true);
    setRevokeError(null);
    try {
      const { error: err } = await authClient.revokeOtherSessions();
      if (err) return setRevokeError(err.message ?? t(i18n.appError.title));
      setPasswordChanged(false);
      setSessionsRevoked(true);
    } catch {
      setRevokeError(t(i18n.appError.title));
    } finally {
      setRevoking(false);
    }
  };

  const handleStartEnable = () =>
    run(async () => {
      const { data, error: err } = await authClient.twoFactor.enable({ password: twoFaPassword });
      if (err || !data || data.method !== 'totp') {
        return setError(err?.message ?? t(i18n.auth.twoFactorSetup.setupError));
      }
      setSecret(new URL(data.totpURI).searchParams.get('secret'));
      setBackupCodes(data.backupCodes);
      setQrDataUrl(await QRCode.toDataURL(data.totpURI, { width: 160, margin: 1 }));
      setTwoFaPassword('');
    });

  // Better Auth marks 2FA on only after this first code verifies.
  const handleConfirmEnable = () =>
    run(async () => {
      const { error: err } = await authClient.twoFactor.verifyTotp({ code });
      if (err) return setError(err.message ?? t(i18n.auth.twoFactor.verificationFailed));
      closeEditor();
      setTwoFaSaved(true);
      router.refresh();
    });

  const handleDisable = () =>
    run(async () => {
      const { error: err } = await authClient.twoFactor.disable({ password: twoFaPassword });
      if (err) return setError(err.message ?? t(i18n.appError.title));
      closeEditor();
      setTwoFaSaved(true);
      router.refresh();
    });

  const note = (text: string) => (
    <span className="text-meta text-muted-foreground flex items-center gap-1" role="status">
      <Check className="h-3.5 w-3.5 shrink-0" />
      {text}
    </span>
  );

  // Lets password managers file the new password under the right account.
  const usernameField = (
    <input
      type="text"
      name="username"
      autoComplete="username"
      value={userEmail}
      readOnly
      tabIndex={-1}
      aria-hidden
      className="sr-only"
    />
  );

  const actions = (submitLabel: string, disabled = false) => (
    <InlineEditorActions error={error}>
      <Button type="button" variant="ghost" onClick={closeEditor} disabled={loading}>
        {t(i18n.common.cancel)}
      </Button>
      <LoadingButton type="submit" loading={loading} disabled={disabled}>
        {submitLabel}
      </LoadingButton>
    </InlineEditorActions>
  );

  const field = (id: string, label: string, input: React.ReactNode, hint?: React.ReactNode) => (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {input}
      {hint}
    </div>
  );

  return (
    // One button style for every row: enabling 2FA is no louder than changing the password.
    <SettingsSection title={t(i18n.settings.security.title)} description={t(i18n.settings.security.description)}>
      {/* Password */}
      <SettingsRow
        label={t(i18n.settings.security.password)}
        description={t(i18n.settings.security.changePasswordDescription)}
        status={
          revokeError ? (
            <span className="text-meta text-negative">{revokeError}</span>
          ) : passwordChanged ? (
            note(t(i18n.settings.security.passwordChanged))
          ) : (
            sessionsRevoked && note(t(i18n.settings.security.sessionsRevoked))
          )
        }
      >
        {passwordChanged && open !== 'password' ? (
          <LoadingButton variant="outline" onClick={handleLogoutOthers} loading={revoking}>
            {t(i18n.settings.security.logoutOthers)}
          </LoadingButton>
        ) : (
          trigger('password', t(i18n.settings.security.changePassword))
        )}
      </SettingsRow>
      <InlineEditor
        open={open === 'password'}
        onCancel={closeEditor}
        onSubmit={handleChangePassword}
        label={t(i18n.settings.security.changePassword)}
      >
        <div className="grid gap-4 sm:max-w-md">
          {field(
            'currentPassword',
            t(i18n.settings.security.currentPassword),
            <Input
              id="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          )}
          {field(
            'newPassword',
            t(i18n.settings.security.newPassword),
            <Input
              id="newPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          )}
          {field(
            'confirmPassword',
            t(i18n.settings.security.confirmPassword),
            <Input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={confirmPassword}
              aria-invalid={mismatch}
              onChange={(e) => {
                setConfirmPassword(e.target.value);
                setMismatch(false);
              }}
            />,
            mismatch && <p className="text-meta text-negative">{t(i18n.settings.security.passwordsDontMatch)}</p>
          )}
          {usernameField}
        </div>
        {actions(t(i18n.settings.security.changePassword))}
      </InlineEditor>

      {/* Email: shown only, it cannot be changed in this release. */}
      <SettingsRow label={t(i18n.settings.profile.email)}>
        <span className="text-meta text-foreground break-all">{userEmail}</span>
      </SettingsRow>

      {/* Two-factor */}
      <SettingsRow
        label={
          <span className="flex flex-wrap items-center gap-2">
            {t(i18n.settings.security.twoFactorAuth)}
            <span
              className={cn(
                'rounded-full px-2.5 py-0.5 text-xs font-normal whitespace-nowrap',
                twoFactorEnabled ? 'bg-foreground/[0.08] text-foreground' : 'text-muted-foreground bg-foreground/[0.06]'
              )}
            >
              {twoFactorEnabled ? t(i18n.settings.security.enabled) : t(i18n.settings.security.notEnabled)}
            </span>
          </span>
        }
        description={t(i18n.settings.security.twoFactorDescription)}
        status={twoFaSaved && note(t(i18n.settings.profile.savedInline))}
      >
        {twoFactorEnabled
          ? trigger('disable2fa', t(i18n.settings.security.disable))
          : trigger('enable2fa', t(i18n.settings.security.enable))}
      </SettingsRow>
      <InlineEditor
        open={open === 'enable2fa'}
        onCancel={closeEditor}
        onSubmit={qrDataUrl ? handleConfirmEnable : handleStartEnable}
        label={t(i18n.settings.security.twoFactorAuth)}
      >
        {!qrDataUrl ? (
          <div className="grid gap-4 sm:max-w-md">
            {field(
              'enablePassword',
              t(i18n.settings.security.password),
              <Input
                id="enablePassword"
                type="password"
                autoComplete="current-password"
                required
                value={twoFaPassword}
                onChange={(e) => setTwoFaPassword(e.target.value)}
              />
            )}
            {usernameField}
          </div>
        ) : (
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={qrDataUrl}
              alt={t(i18n.settings.security.twoFactorAuth)}
              width={160}
              height={160}
              className="size-40 shrink-0 rounded-lg bg-white p-2"
            />
            <div className="min-w-0 flex-1 space-y-4">
              <p className="text-meta text-muted-foreground">{t(i18n.auth.twoFactorSetup.scanInstruction)}</p>
              {secret && (
                <div>
                  <p className="text-meta text-muted-foreground">{t(i18n.auth.twoFactorSetup.manualEntry)}</p>
                  <code className="text-meta break-all select-all">{secret}</code>
                </div>
              )}
              <div className="space-y-1.5">
                <p className="text-meta text-muted-foreground">{t(i18n.twoFactorExtra.backupCodes)}</p>
                <pre className="bg-muted text-meta rounded-md p-3 font-mono leading-6 select-all">
                  {backupCodes.join('\n')}
                </pre>
              </div>
              {field(
                'enableCode',
                t(i18n.settings.security.code),
                <Input
                  id="enableCode"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  required
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value.trim())}
                  className="sm:max-w-40"
                />
              )}
            </div>
          </div>
        )}
        {actions(qrDataUrl ? t(i18n.auth.twoFactor.verify) : t(i18n.common.continue))}
      </InlineEditor>
      <InlineEditor
        open={open === 'disable2fa'}
        onCancel={closeEditor}
        onSubmit={handleDisable}
        label={t(i18n.settings.security.disableTwoFactorTitle)}
      >
        <div className="grid gap-4 sm:max-w-md">
          <p className="text-meta text-muted-foreground">{t('settings.security.disableTwoFactorPassword')}</p>
          {field(
            'disablePassword',
            t(i18n.settings.security.password),
            <Input
              id="disablePassword"
              type="password"
              autoComplete="current-password"
              required
              value={twoFaPassword}
              onChange={(e) => setTwoFaPassword(e.target.value)}
            />
          )}
          {usernameField}
        </div>
        {actions(t(i18n.settings.security.disable))}
      </InlineEditor>
    </SettingsSection>
  );
}
