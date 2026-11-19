'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { i18n } from '@/i18n/constants';
import { acceptInvitation, acceptInvitationAsNewUser } from '@/lib/action/organizations';
import { authClient } from '@/lib/auth/client';

import { AuthFormHeader } from './auth-form-header';

export type ActivateProps = {
  token: string;
  email: string;
  organizationName: string;
  /** The invited email already has an account. */
  hasAccount: boolean;
  /** Email of whoever is signed in on this browser, if anyone. */
  signedInEmail: string | null;
};

/** Item 28c: one invitation link, three cases: new person, existing account signed in, or not. */
export function Activate({ token, email, organizationName, hasAccount, signedInEmail }: ActivateProps) {
  const t = useTranslations();
  const router = useRouter();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const run = async (fn: () => Promise<{ ok: true } | { ok: false; error: string }>) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await fn();
      if (!result.ok) return setError(result.error);
      toast.success(t(i18n.auth.activate.successTitle));
      router.push('/');
      router.refresh();
    } catch {
      setError(t(i18n.appError.title));
    } finally {
      setIsLoading(false);
    }
  };

  const errorLine = error && (
    <p role="alert" className="text-sm text-red-500">
      {error}
    </p>
  );

  if (hasAccount) {
    const here = `/activate?token=${encodeURIComponent(token)}`;
    const signedInAsOther = signedInEmail && signedInEmail.toLowerCase() !== email;
    return (
      <>
        <AuthFormHeader
          title={t(i18n.invitation.joinTitle, { organization: organizationName })}
          description={
            signedInAsOther ? t(i18n.invitation.wrongAccount, { email }) : t(i18n.invitation.joinDescription, { email })
          }
        />
        <div className="mt-8 flex flex-col gap-6">
          {errorLine}
          {!signedInEmail && (
            <Button
              variant="brand"
              className="w-full"
              onClick={() => router.push(`/login?next=${encodeURIComponent(here)}`)}
            >
              {t(i18n.invitation.signInToJoin)}
            </Button>
          )}
          {signedInEmail && !signedInAsOther && (
            <Button
              variant="brand"
              className="w-full"
              disabled={isLoading}
              onClick={() => run(() => acceptInvitation(token))}
            >
              {isLoading ? t(i18n.common.loading) : t(i18n.invitation.join)}
            </Button>
          )}
          {signedInAsOther && (
            <Button
              variant="outline"
              className="w-full"
              onClick={async () => {
                await authClient.signOut();
                router.push(`/login?next=${encodeURIComponent(here)}`);
              }}
            >
              {t(i18n.noOrganization.signOut)}
            </Button>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <AuthFormHeader
        title={t(i18n.invitation.joinTitle, { organization: organizationName })}
        description={t(i18n.auth.activate.description)}
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => acceptInvitationAsNewUser(token, name.trim(), password));
        }}
        className="mt-8"
      >
        <div className="flex flex-col gap-6">
          <div className="grid gap-2">
            <Label htmlFor="email">{t(i18n.invitation.emailLabel)}</Label>
            <Input id="email" type="email" value={email} readOnly disabled autoComplete="username" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="name">{t(i18n.auth.activate.displayName)}</Label>
            <Input
              id="name"
              required
              maxLength={100}
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">{t(i18n.auth.activate.setPassword)}</Label>
            <Input
              id="password"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {errorLine}
          <Button type="submit" variant="brand" className="w-full" disabled={isLoading}>
            {isLoading ? t(i18n.auth.activate.activating) : t(i18n.auth.activate.activate)}
          </Button>
        </div>
      </form>
    </>
  );
}
