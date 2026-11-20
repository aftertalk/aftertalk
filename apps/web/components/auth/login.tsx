'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TextLink } from '@/components/ui/text-link';
import { i18n } from '@/i18n/constants';
import { authClient } from '@/lib/auth/client';
import { safeNext } from '@/lib/utils/safe-next';

import { AuthFormHeader } from './auth-form-header';

type Step = 'password' | 'totp' | 'backup';

export function Login() {
  const t = useTranslations();
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = safeNext(searchParams.get('next'));

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<Step>('password');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const done = () => {
    router.push(next);
    router.refresh();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      if (step === 'password') {
        const { data, error: err } = await authClient.signIn.email({ email, password });
        if (err) return setError(err.message ?? t(i18n.auth.login.signInFailed));
        if (data && 'twoFactorRedirect' in data && data.twoFactorRedirect) return setStep('totp');
        return done();
      }
      const { error: err } =
        step === 'totp'
          ? await authClient.twoFactor.verifyTotp({ code })
          : await authClient.twoFactor.verifyBackupCode({ code });
      if (err) return setError(err.message ?? t(i18n.auth.twoFactor.verificationFailed));
      done();
    } catch {
      setError(t(i18n.appError.title));
    } finally {
      setIsLoading(false);
    }
  };

  const backToPassword = () => {
    setStep('password');
    setCode('');
    setError(null);
  };

  return (
    <>
      <AuthFormHeader
        title={t(i18n.auth.login.title)}
        description={step === 'password' ? t(i18n.auth.login.description) : t(i18n.auth.twoFactor.description)}
      />

      <form onSubmit={handleSubmit} className="mt-8">
        <div className="flex flex-col gap-6">
          {step === 'password' ? (
            <>
              <div className="grid gap-2">
                <Label htmlFor="email">{t(i18n.common.email)}</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="password">{t(i18n.common.password)}</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            </>
          ) : (
            <div className="grid gap-2">
              <Label htmlFor="code">
                {step === 'totp' ? t(i18n.auth.twoFactor.code) : t(i18n.twoFactorExtra.backupCode)}
              </Label>
              <Input
                id="code"
                type="text"
                inputMode={step === 'totp' ? 'numeric' : 'text'}
                autoComplete="one-time-code"
                maxLength={step === 'totp' ? 6 : 32}
                required
                value={code}
                onChange={(e) => setCode(e.target.value.trim())}
                autoFocus
              />
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-red-500">
              {error}
            </p>
          )}

          <Button type="submit" variant="brand" className="w-full" disabled={isLoading}>
            {isLoading
              ? t(i18n.common.loading)
              : step === 'password'
                ? t(i18n.common.continue)
                : t(i18n.auth.twoFactor.verify)}
          </Button>

          {step === 'password' ? (
            <p className="text-muted-foreground text-center text-sm">{t(i18n.recovery.askAdmin)}</p>
          ) : (
            <div className="flex justify-between text-sm">
              <TextLink className="text-muted-foreground" onClick={backToPassword}>
                {t(i18n.auth.twoFactor.backToLogin)}
              </TextLink>
              {step === 'totp' && (
                <TextLink
                  className="text-muted-foreground"
                  onClick={() => {
                    setStep('backup');
                    setCode('');
                    setError(null);
                  }}
                >
                  {t(i18n.twoFactorExtra.useBackupCode)}
                </TextLink>
              )}
            </div>
          )}
        </div>
      </form>
    </>
  );
}
