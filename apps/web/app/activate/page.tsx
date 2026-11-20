import { getTranslations } from 'next-intl/server';

import { Activate } from '@/components/auth/activate';
import { AuthFormHeader, AuthShell } from '@/components/auth/auth-form-header';
import { i18n } from '@/i18n/constants';
import { getSessionUser } from '@/lib/access';
import { getInvitationByToken } from '@/lib/action/organizations';
import { localizedPageMetadata } from '@/lib/utils/page-metadata';

export const dynamic = 'force-dynamic';
export const generateMetadata = () => localizedPageMetadata('auth.activate.title');

export default async function ActivatePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const token = (await searchParams).token ?? '';
  const [invitation, user, t] = await Promise.all([getInvitationByToken(token), getSessionUser(), getTranslations()]);

  return (
    <AuthShell>
      {invitation ? (
        <Activate token={token} {...invitation} signedInEmail={user?.email ?? null} />
      ) : (
        <AuthFormHeader title={t(i18n.auth.updatePassword.errorTitle)} description={t(i18n.invitation.invalid)} />
      )}
    </AuthShell>
  );
}
