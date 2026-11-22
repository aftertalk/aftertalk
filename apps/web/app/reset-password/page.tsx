import { Suspense } from 'react';

import { AuthShell } from '@/components/auth/auth-form-header';
import { ResetPassword } from '@/components/auth/reset-password';
import { localizedPageMetadata } from '@/lib/utils/page-metadata';

export const generateMetadata = () => localizedPageMetadata('auth.updatePassword.title');

export default function ResetPasswordPage() {
  return (
    <AuthShell>
      <Suspense>
        <ResetPassword />
      </Suspense>
    </AuthShell>
  );
}
