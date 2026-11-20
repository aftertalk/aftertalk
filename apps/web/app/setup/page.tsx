import { notFound } from 'next/navigation';

import { AuthShell } from '@/components/auth/auth-form-header';
import { SetupForm } from '@/components/auth/setup-form';
import { setupStatus } from '@/lib/action/setup';
import { localizedPageMetadata } from '@/lib/utils/page-metadata';

// Item 29: shown only while the database has no user; afterwards the page does not exist.
export const dynamic = 'force-dynamic';
export const generateMetadata = () => localizedPageMetadata('setup.title');

export default async function SetupPage() {
  const { open } = await setupStatus();
  if (!open) notFound();
  return (
    <AuthShell>
      <SetupForm />
    </AuthShell>
  );
}
