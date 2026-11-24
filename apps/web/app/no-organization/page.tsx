import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { AuthFormHeader, AuthShell } from '@/components/auth/auth-form-header';
import { SignOutButton } from '@/components/auth/sign-out-button';
import { Button } from '@/components/ui/button';
import { i18n } from '@/i18n/constants';
import { getSessionUser } from '@/lib/access';
import { landingFor } from '@/lib/landing';
import { localizedPageMetadata } from '@/lib/utils/page-metadata';

export const dynamic = 'force-dynamic';
export const generateMetadata = () => localizedPageMetadata('noOrganization.title');

// Two cases share this page: no organisation at all, or an organisation with no project the user
// can see. The second leads on to the organisation's page, where a project is created.
export default async function NoOrganizationPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  const landing = await landingFor(user.id);
  if (landing.kind === 'project') redirect('/');
  const t = await getTranslations();
  const noProject = landing.kind === 'no-project';
  const isAdmin = noProject && landing.orgRole !== 'MEMBER';
  return (
    <AuthShell>
      <AuthFormHeader
        title={noProject ? t(i18n.noOrganization.noProjectTitle) : t(i18n.noOrganization.title)}
        description={
          isAdmin
            ? t(i18n.noOrganization.noProjectAdmin)
            : noProject
              ? t(i18n.noOrganization.noProjectDescription)
              : t(i18n.noOrganization.description)
        }
      />
      <div className="mt-8 space-y-3">
        {noProject && (
          <Button asChild className="w-full">
            <Link href={`/organization/${landing.organizationId}`}>{t(i18n.noOrganization.openOrganization)}</Link>
          </Button>
        )}
        <SignOutButton label={t(i18n.noOrganization.signOut)} />
      </div>
    </AuthShell>
  );
}
