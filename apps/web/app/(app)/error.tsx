'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { i18n } from '@/i18n/constants';

// No error reporting service: the server logged the error with its digest.
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations();
  return (
    <main className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl">{t(i18n.appError.title)}</h1>
      <p className="text-muted-foreground max-w-sm text-sm">{t(i18n.appError.description)}</p>
      {error.digest && <code className="text-muted-foreground text-xs">{error.digest}</code>}
      <div className="flex gap-3">
        <Button onClick={reset}>{t(i18n.appError.retry)}</Button>
        <Button variant="outline" asChild>
          <Link href="/">{t(i18n.appError.goHome)}</Link>
        </Button>
      </div>
    </main>
  );
}
