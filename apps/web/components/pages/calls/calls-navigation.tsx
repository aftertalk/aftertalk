'use client';

import { useRouter } from 'next/navigation';
import { createContext, use, useCallback, useMemo, useTransition } from 'react';

import { cn } from '@/lib/utils/cn';

// Search and pagination both move the list. Navigating inside one transition keeps the current
// rows on screen (dimmed) until the next page arrives, instead of a blank page or a frozen click.

interface CallsNavigationValue {
  isPending: boolean;
  navigate: (href: string) => void;
}

const CallsNavigationContext = createContext<CallsNavigationValue | null>(null);

export function CallsNavigation({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const navigate = useCallback((href: string) => startTransition(() => router.push(href)), [router]);
  const value = useMemo(() => ({ isPending, navigate }), [isPending, navigate]);

  return <CallsNavigationContext value={value}>{children}</CallsNavigationContext>;
}

export function useCallsNavigation(): CallsNavigationValue {
  const value = use(CallsNavigationContext);
  if (!value) throw new Error('useCallsNavigation must be used inside <CallsNavigation>');
  return value;
}

export function CallsResults({ children }: { children: React.ReactNode }) {
  const { isPending } = useCallsNavigation();
  return (
    <div aria-busy={isPending} className={cn('space-y-4 transition-opacity', isPending && 'opacity-60')}>
      {children}
    </div>
  );
}
