import { redirect } from 'next/navigation';

import { requireProjectPage } from '@/lib/page-access';

// Account concerns moved to /account; project concerns live in /{projectId}/configure.
export default async function SettingsRedirectPage({ params }: { params: Promise<{ projectId: string }> }) {
  await requireProjectPage((await params).projectId);
  redirect('/account');
}
