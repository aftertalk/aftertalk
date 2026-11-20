'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { i18n } from '@/i18n/constants';
import { authClient } from '@/lib/auth/client';

import { AuthFormHeader } from './auth-form-header';

/** Opened from a link an admin made (#73). There is no self-service "forgot password" without a mailer. */
export function ResetPassword() {
  const t = useTranslations();
  const router = useRouter();
  const searchParams = useSearchParams();
  // Better Auth redirects here with ?token=…, or ?error=INVALID_TOKEN for a used or expired link.
  const token = searchParams.get('error') ? null : searchParams.get('token');

  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setIsLoading(true);
    setError(null);
    try {
      const { error: err } = await authClient.resetPassword({ newPassword, token });
      if (err) return setError(err.message ?? t(i18n.auth.updatePassword.errorDescription));
      toast.success(t(i18n.auth.updatePassword.successTitle), {
        description: t(i18n.auth.updatePassword.successDescription),
      });
      router.push('/login');
    } catch {
      setError(t(i18n.appError.title));
    } finally {
      setIsLoading(false);
    }
  };

  if (!token) {
    return (
      <>
        <AuthFormHeader
          title={t(i18n.auth.updatePassword.errorTitle)}
          description={t(i18n.auth.updatePassword.errorDescription)}
        />
        <p className="text-muted-foreground mt-6 text-sm">{t(i18n.recovery.askAdmin)}</p>
      </>
    );
  }

  return (
    <>
      <AuthFormHeader title={t(i18n.auth.updatePassword.title)} description={t(i18n.auth.updatePassword.description)} />
      <form onSubmit={handleSubmit} className="mt-8">
        <div className="flex flex-col gap-6">
          <div className="grid gap-2">
            <Label htmlFor="password">{t(i18n.auth.updatePassword.newPassword)}</Label>
            <Input
              id="password"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-red-500">
              {error}
            </p>
          )}
          <Button type="submit" variant="brand" className="w-full" disabled={isLoading}>
            {isLoading ? t(i18n.auth.updatePassword.saving) : t(i18n.auth.updatePassword.savePassword)}
          </Button>
        </div>
      </form>
    </>
  );
}
