import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { AuthShell } from '@/components/auth/auth-form-header';
import { Login } from '@/components/auth/login';
import { hasAnyUser } from '@/lib/auth/setup-token';
import { localizedPageMetadata } from '@/lib/utils/page-metadata';

export const dynamic = 'force-dynamic';
export const generateMetadata = () => localizedPageMetadata('auth.login.title');

export default async function LoginPage() {
  if (!(await hasAnyUser())) redirect('/setup');
  return (
    <AuthShell>
      <Suspense>
        <Login />
      </Suspense>
    </AuthShell>
  );
}
