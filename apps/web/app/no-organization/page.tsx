import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { AuthFormHeader, AuthShell } from '@/components/auth/auth-form-header';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { i18n } from '@/i18n/constants';
import { getSessionUser } from '@/lib/access';
import { landingFor } from '@/lib/landing';
import { localizedPageMetadata } from '@/lib/utils/page-metadata';

export const dynamic = 'force-dynamic';
export const generateMetadata = () => localizedPageMetadata('noOrganization.title');

export default async function NoOrganizationPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  if ((await landingFor(user.id)).kind === 'project') redirect('/');
  const t = await getTranslations();
  return (
    <AuthShell>
      <AuthFormHeader title={t(i18n.noOrganization.title)} description={t(i18n.noOrganization.description)} />
      <div className="mt-8">
        <SignOutButton label={t(i18n.noOrganization.signOut)} />
      </div>
    </AuthShell>
  );
}
