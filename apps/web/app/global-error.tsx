'use client';

import { useSyncExternalStore } from 'react';

// Replaces the root layout when it crashes, so no i18n/theme providers are available here — plain markup only.
// The language: the locale cookie, falling back to the browser's language.
const COPY = {
  pl: { title: 'Coś poszło nie tak', reload: 'Odśwież' },
  en: { title: 'Something went wrong', reload: 'Reload' },
};

function clientLocale(): keyof typeof COPY {
  const cookie = document.cookie.match(/(?:^|; )NEXT_LOCALE=(\w+)/)?.[1];
  return (cookie ?? navigator.language).startsWith('en') ? 'en' : 'pl';
}

const subscribe = () => () => {};

export default function GlobalError() {
  const locale = useSyncExternalStore(subscribe, clientLocale, () => 'pl' as const);

  return (
    <html lang={locale}>
      <body className="bg-background text-foreground flex min-h-screen flex-col items-center justify-center px-6 text-center">
        <h1 className="mb-3 text-2xl tracking-tight">{COPY[locale].title}</h1>
        <button className="underline" onClick={() => window.location.reload()}>
          {COPY[locale].reload}
        </button>
      </body>
    </html>
  );
}
