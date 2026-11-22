'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import QRCode from 'qrcode';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { i18n } from '@/i18n/constants';
import { authClient } from '@/lib/auth/client';
import { safeNext } from '@/lib/utils/safe-next';

import { AuthFormHeader } from './auth-form-header';

/**
 * Turning on 2FA (items 25, 29): confirm the password, scan the QR code, keep the backup codes, then
 * enter a code. Better Auth marks 2FA on only after that first code verifies.
 */
export function SetupTwoFactor({ required }: { required: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));

  const [password, setPassword] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const { data, error: err } = await authClient.twoFactor.enable({ password });
      if (err || !data || data.method !== 'totp') {
        return setError(err?.message ?? t(i18n.auth.twoFactorSetup.setupError));
      }
      setSecret(new URL(data.totpURI).searchParams.get('secret'));
      setBackupCodes(data.backupCodes);
      setQrDataUrl(await QRCode.toDataURL(data.totpURI, { width: 200, margin: 1 }));
      setPassword('');
    } catch {
      setError(t(i18n.auth.twoFactorSetup.setupError));
    } finally {
      setIsLoading(false);
    }
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const { error: err } = await authClient.twoFactor.verifyTotp({ code });
      if (err) return setError(err.message ?? t(i18n.auth.twoFactor.verificationFailed));
      toast.success(t(i18n.auth.twoFactorSetup.successTitle));
      router.push(next);
      router.refresh();
    } catch {
      setError(t(i18n.auth.twoFactor.verificationFailed));
    } finally {
      setIsLoading(false);
    }
  };

  const errorLine = error && (
    <p role="alert" className="text-sm text-red-500">
      {error}
    </p>
  );

  if (!qrDataUrl) {
    return (
      <>
        <AuthFormHeader
          title={t(i18n.auth.twoFactorSetup.title)}
          description={required ? t(i18n.twoFactorExtra.required) : t(i18n.twoFactorExtra.confirmPassword)}
        />
        <form onSubmit={start} className="mt-8">
          <div className="flex flex-col gap-6">
            <div className="grid gap-2">
              <Label htmlFor="password">{t(i18n.common.password)}</Label>
              <Input
                id="password"
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {errorLine}
            <Button type="submit" variant="brand" className="w-full" disabled={isLoading}>
              {isLoading ? t(i18n.common.loading) : t(i18n.twoFactorExtra.start)}
            </Button>
            {!required && (
              <Button type="button" variant="ghost" className="w-full" onClick={() => router.push(next)}>
                {t(i18n.twoFactorExtra.skip)}
              </Button>
            )}
          </div>
        </form>
      </>
    );
  }

  return (
    <>
      <AuthFormHeader
        title={t(i18n.auth.twoFactorSetup.title)}
        description={t(i18n.auth.twoFactorSetup.scanInstruction)}
      />
      <form onSubmit={verify} className="mt-8">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qrDataUrl} alt="2FA QR code" className="rounded-lg bg-white p-2" width={200} height={200} />
            {secret && (
              <div className="text-center">
                <p className="text-muted-foreground text-xs">{t(i18n.auth.twoFactorSetup.manualEntry)}</p>
                <code data-testid="totp-secret" className="text-sm break-all select-all">
                  {secret}
                </code>
              </div>
            )}
          </div>
          <div className="grid gap-2">
            <p className="text-muted-foreground text-sm">{t(i18n.twoFactorExtra.backupCodes)}</p>
            <pre className="bg-muted rounded-md p-3 text-center font-mono text-sm leading-6 select-all">
              {backupCodes.join('\n')}
            </pre>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="code">{t(i18n.auth.twoFactorSetup.code)}</Label>
            <Input
              id="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              value={code}
              onChange={(e) => setCode(e.target.value.trim())}
              autoFocus
            />
          </div>
          {errorLine}
          <Button type="submit" variant="brand" className="w-full" disabled={isLoading}>
            {isLoading ? t(i18n.auth.twoFactorSetup.verifying) : t(i18n.auth.twoFactorSetup.verify)}
          </Button>
        </div>
      </form>
    </>
  );
}
