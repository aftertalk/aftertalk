'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { i18n } from '@/i18n/constants';

// A project page that throws renders here, inside the project layout, so the sidebar and top bar stay
// and the user can move to another page. Errors above the project layout still reach app/(app)/error.tsx.
// No error reporting service: the server logged the error with its digest.
export default function ProjectError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations();
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <h1 className="mb-3 text-2xl tracking-tight">{t(i18n.appError.title)}</h1>
      <p className="text-muted-foreground mb-8 max-w-sm text-sm">{t(i18n.appError.description)}</p>
      <Button onClick={reset}>{t(i18n.appError.retry)}</Button>
    </div>
  );
}
