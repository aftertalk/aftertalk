import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { i18n } from '@/i18n/constants';

export default function NotFound() {
  const t = useTranslations();
  return (
    <main className="bg-background text-foreground flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <div className="text-foreground/10 mb-4 font-mono text-[10rem] leading-none font-light tracking-tight">404</div>
      <p className="text-muted-foreground/70 mb-3 text-xs tracking-[0.2em] uppercase">{t(i18n.notFound.eyebrow)}</p>
      <h1 className="text-foreground mb-4 text-3xl tracking-tight">{t(i18n.notFound.title)}</h1>
      <p className="text-muted-foreground mb-10 max-w-sm text-base">{t(i18n.notFound.description)}</p>
      <Link href="/" className="bg-primary text-primary-foreground rounded-full px-6 py-2.5 text-sm font-medium">
        {t(i18n.notFound.goHome)}
      </Link>
    </main>
  );
}
