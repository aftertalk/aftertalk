import { redirect } from 'next/navigation';

import { getSessionUser } from '@/lib/access';
import { hasAnyUser } from '@/lib/auth/setup-token';
import { landingFor } from '@/lib/landing';

// Item 18b: no account yet → first-start setup; signed out → login; otherwise the user's project.
export const dynamic = 'force-dynamic';

export default async function Root() {
  if (!(await hasAnyUser())) redirect('/setup');
  const user = await getSessionUser();
  if (!user) redirect('/login');
  const landing = await landingFor(user.id);
  // An organisation member who can see no project yet: the same page explains whom to ask.
  if (landing.kind !== 'project') redirect('/no-organization');
  redirect(`/${landing.projectId}/home`);
}
