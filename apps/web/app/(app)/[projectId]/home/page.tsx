import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { SignOutButton } from '@/components/auth/sign-out-button';
import { Button } from '@/components/ui/button';
import { i18n } from '@/i18n/constants';
import { requireUser } from '@/lib/access';

// Phase 1 placeholder: proves sign-in, the project check and 2FA. The real home arrives in phase 2.
export default async function HomePage({ params }: { params: Promise<{ projectId: string }> }) {
  const [{ projectId }, user, t] = await Promise.all([params, requireUser(), getTranslations()]);
  return (
    <main className="mx-auto flex max-w-lg flex-col gap-4 px-6 py-16">
      <h1 className="text-2xl">Aftertalk</h1>
      <p className="text-muted-foreground text-sm">{t(i18n.home.placeholder, { email: user.email })}</p>
      <p data-testid="two-factor-state" className="text-sm">
        {user.twoFactorEnabled ? t(i18n.home.twoFactorOn) : t(i18n.home.twoFactorOff)}
      </p>
      {!user.twoFactorEnabled && (
        <Button variant="outline" asChild>
          <Link href={`/setup-2fa?next=${encodeURIComponent(`/${projectId}/home`)}`}>
            {t(i18n.home.setUpTwoFactor)}
          </Link>
        </Button>
      )}
      <SignOutButton label={t(i18n.home.signOut)} />
    </main>
  );
}
