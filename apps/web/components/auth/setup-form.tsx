'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { i18n } from '@/i18n/constants';
import { completeSetup } from '@/lib/action/setup';

import { AuthFormHeader } from './auth-form-header';

/** Item 29: the first-start form. On success the owner is signed in and offered 2FA. */
export function SetupForm() {
  const t = useTranslations();
  const router = useRouter();
  const [form, setForm] = useState({ token: '', name: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    try {
      const result = await completeSetup({ ...form, token: form.token.trim(), email: form.email.trim() });
      if (!result.ok) return setError(result.error);
      router.push(`/setup-2fa?next=${encodeURIComponent(`/${result.data.projectId}/home`)}`);
      router.refresh();
    } catch {
      setError(t(i18n.appError.title));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      <AuthFormHeader title={t(i18n.setup.title)} description={t(i18n.setup.description)} />
      <form onSubmit={handleSubmit} className="mt-8">
        <div className="flex flex-col gap-6">
          <div className="grid gap-2">
            <Label htmlFor="token">{t(i18n.setup.token)}</Label>
            <Input id="token" required autoComplete="off" value={form.token} onChange={set('token')} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="name">{t(i18n.setup.name)}</Label>
            <Input id="name" required maxLength={100} autoComplete="name" value={form.name} onChange={set('name')} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="email">{t(i18n.common.email)}</Label>
            <Input
              id="email"
              type="email"
              required
              autoComplete="username"
              value={form.email}
              onChange={set('email')}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">{t(i18n.common.password)}</Label>
            <Input
              id="password"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={form.password}
              onChange={set('password')}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-red-500">
              {error}
            </p>
          )}
          <Button type="submit" variant="brand" className="w-full" disabled={isLoading}>
            {isLoading ? t(i18n.setup.submitting) : t(i18n.setup.submit)}
          </Button>
        </div>
      </form>
    </>
  );
}
