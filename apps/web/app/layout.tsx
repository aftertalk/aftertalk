import './globals.css';

import type { Metadata } from 'next';
import { Geist_Mono } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale } from 'next-intl/server';
import { ThemeProvider } from 'next-themes';
import { Toaster } from 'sonner';

// The mono eyebrows and labels (font-mono) resolve to --font-geist-mono in globals.css; this defines it.
const geistMono = Geist_Mono({ subsets: ['latin', 'latin-ext'], variable: '--font-geist-mono' });

export const metadata: Metadata = {
  title: { default: 'Aftertalk', template: '%s · Aftertalk' },
  // Self-hosted: pages are private, nothing should be indexed.
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const locale = await getLocale();

  return (
    <html lang={locale} className={geistMono.variable} suppressHydrationWarning>
      <body className="antialiased" suppressHydrationWarning>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <NextIntlClientProvider>{children}</NextIntlClientProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
