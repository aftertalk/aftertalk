import { and, eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getFormatter, getTranslations } from 'next-intl/server';

import { ResetNotice } from '@/components/auth/reset-notice';
import { TimeZoneSync } from '@/components/shared/time-zone-sync';
import { i18n } from '@/i18n/constants';
import { getSessionUser } from '@/lib/access';
import { takePasswordResetNotice } from '@/lib/auth/reset-notice';
import { db } from '@/lib/db/client';
import { organizationMembers, organizations } from '@/lib/db/schema/app';
import { user as userTable } from '@/lib/db/schema/auth';

// Every signed-in page. The proxy only saw a cookie; this checks the session for real.
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect('/login');

  // Item 25 / #64: a member of an organisation that requires 2FA sets it up before anything else.
  if (!user.twoFactorEnabled) {
    const [required] = await db
      .select({ id: organizations.id })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(and(eq(organizationMembers.userId, user.id), eq(organizations.twoFaRequired, true)))
      .limit(1);
    if (required) redirect('/setup-2fa?next=%2F');
  }

  const [[row], notice] = await Promise.all([
    db.select({ timeZone: userTable.timeZone }).from(userTable).where(eq(userTable.id, user.id)),
    takePasswordResetNotice(user.id),
  ]);

  let noticeText: string | null = null;
  if (notice) {
    const [t, format] = await Promise.all([getTranslations(), getFormatter()]);
    noticeText = t(i18n.recovery.resetNotice, {
      date: format.dateTime(new Date(notice.at), { dateStyle: 'medium', timeStyle: 'short' }),
      by: notice.by ?? t(i18n.recovery.someone),
    });
  }

  return (
    <>
      <TimeZoneSync timeZone={row?.timeZone ?? 'Europe/Warsaw'} />
      {noticeText && <ResetNotice text={noticeText} />}
      {children}
    </>
  );
}
