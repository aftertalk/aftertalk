'use client';

import { Check, LogOut, Moon, Sun, UserRound } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';

import { useLocaleSwitch } from '@/components/shared/language-switcher';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SUPPORTED_LOCALES, type SupportedLocale } from '@/i18n/config';
import { authClient } from '@/lib/auth/client';
import { cn } from '@/lib/utils/cn';

/** "jan.kowalski@firma.pl" → "JK", "anna@firma.pl" → "A". The API has no names, only addresses. */
export function initialsFromEmail(email?: string): string {
  const local = (email ?? '').split('@')[0];
  const parts = local.split(/[._-]+/).filter(Boolean);
  const initials = parts.length > 1 ? parts[0][0] + parts[1][0] : local.slice(0, 1);
  return initials.toUpperCase() || '?';
}

export function InitialsAvatar({ email, className }: { email?: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'text-foreground/80 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-black/[0.07] text-xs font-medium dark:bg-white/[0.1]',
        className
      )}
    >
      {initialsFromEmail(email)}
    </span>
  );
}

interface AccountMenuProps {
  email?: string;
  /** `avatar`: the initials alone (top bars). `row`: initials and address, full width (sidebar footer). */
  variant?: 'avatar' | 'row';
  /** Where the menu opens; the sidebar footer opens it upwards or to the right. */
  side?: 'top' | 'right' | 'bottom';
}

export function AccountMenu({ email, variant = 'avatar', side = 'bottom' }: AccountMenuProps) {
  const t = useTranslations('navbar');
  const tc = useTranslations('common');
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const { locale, setLocale } = useLocaleSwitch();

  const localeName: Record<SupportedLocale, string> = {
    en: tc('languages.english'),
    pl: tc('languages.polish'),
  };

  const handleLogout = async () => {
    await authClient.signOut();
    router.push('/login');
    router.refresh();
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {variant === 'row' ? (
          <button className="hover:bg-foreground/6 flex w-full min-w-0 items-center gap-2.5 rounded-xl px-1.5 py-1.5 text-left transition-colors">
            <InitialsAvatar email={email} className="size-7" />
            {/* The local part reads as a name and fits; the full address is in the menu. */}
            <span className="text-muted-foreground min-w-0 flex-1 truncate text-sm" title={email}>
              {email?.split('@')[0]}
            </span>
          </button>
        ) : (
          <button
            aria-label={t('accountSettings')}
            className="hover:ring-foreground/15 flex rounded-full ring-1 ring-transparent transition-shadow"
          >
            <InitialsAvatar email={email} />
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={side === 'bottom' ? 'end' : 'start'} side={side} className="w-56">
        <DropdownMenuLabel>
          <div className="flex flex-col gap-0.5">
            <span className="text-muted-foreground text-xs">{t('signedInAs')}</span>
            <span className="truncate text-sm">{email}</span>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/account">
            <UserRound className="mr-2 h-4 w-4" />
            {t('accountSettings')}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">{t('theme')}</DropdownMenuLabel>
        {(
          [
            { value: 'light', label: t('themeLight'), icon: Sun },
            { value: 'dark', label: t('themeDark'), icon: Moon },
          ] as const
        ).map((opt) => (
          <DropdownMenuItem key={opt.value} onClick={() => setTheme(opt.value)}>
            <opt.icon className="mr-2 h-4 w-4" />
            {opt.label}
            {resolvedTheme === opt.value && <Check className="ml-auto h-4 w-4" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">{tc('language')}</DropdownMenuLabel>
        {SUPPORTED_LOCALES.map((loc) => (
          <DropdownMenuItem key={loc} onClick={() => setLocale(loc)}>
            <span className="mr-2 inline-flex h-4 w-4 items-center justify-center text-[10px] font-semibold">
              {loc.toUpperCase()}
            </span>
            {localeName[loc]}
            {locale === loc && <Check className="ml-auto h-4 w-4" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleLogout} className="text-red-600 focus:text-red-600">
          <LogOut className="mr-2 h-4 w-4" />
          {t('logout')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
