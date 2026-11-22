import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { AuthShell } from '@/components/auth/auth-form-header';
import { SetupTwoFactor } from '@/components/auth/setup-two-factor';
import { getSessionUser } from '@/lib/access';
import { db } from '@/lib/db/client';
import { organizationMembers, organizations } from '@/lib/db/schema/app';
import { localizedPageMetadata } from '@/lib/utils/page-metadata';
import { safeNext } from '@/lib/utils/safe-next';

export const dynamic = 'force-dynamic';
export const generateMetadata = () => localizedPageMetadata('auth.twoFactorSetup.title');

export default async function SetupTwoFactorPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next ?? null);
  const user = await getSessionUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/setup-2fa?next=${encodeURIComponent(next)}`)}`);
  if (user.twoFactorEnabled) redirect(next);

  // Required when any of the user's organisations asks for it (#64): then there is no "skip".
  const orgs = await db
    .select({ required: organizations.twoFaRequired })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(eq(organizationMembers.userId, user.id));

  return (
    <AuthShell>
      <Suspense>
        <SetupTwoFactor required={orgs.some((o) => o.required)} />
      </Suspense>
    </AuthShell>
  );
}
