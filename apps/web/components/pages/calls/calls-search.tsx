'use client';

import { Loader2, Search, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRef } from 'react';

import { useCallsNavigation } from '@/components/pages/calls/calls-navigation';
import { Input } from '@/components/ui/input';
import { i18n } from '@/i18n/constants';

interface CallsSearchProps {
  projectId: string;
  initialQuery?: string;
  /** Serialized URLSearchParams without `q` or `page` — preserved on navigation */
  baseParams?: string;
}

export function callsSearchHref(projectId: string, baseParams: string, q: string) {
  const params = new URLSearchParams(baseParams);
  if (q) params.set('q', q);
  const qs = params.toString();
  return `/${projectId}/calls${qs ? `?${qs}` : ''}`;
}

export function CallsSearch({ projectId, initialQuery = '', baseParams = '' }: CallsSearchProps) {
  const t = useTranslations();
  const { isPending, navigate } = useCallsNavigation();
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    navigate(callsSearchHref(projectId, baseParams, inputRef.current?.value.trim() ?? ''));
  };

  const Icon = isPending ? Loader2 : Search;

  return (
    <form onSubmit={handleSubmit} role="search" className="max-w-lg">
      <div className="relative">
        <Icon
          className="text-muted-foreground/60 pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 data-[pending=true]:animate-spin"
          data-pending={isPending}
          aria-hidden
        />
        <Input
          ref={inputRef}
          key={initialQuery}
          defaultValue={initialQuery}
          placeholder={t(i18n.calls.search.placeholder)}
          aria-label={t(i18n.calls.search.placeholder)}
          className="text-body h-11 rounded-xl border-black/[0.06] pr-9 pl-10 dark:border-white/10"
        />
        {initialQuery && (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md"
            onClick={() => navigate(callsSearchHref(projectId, baseParams, ''))}
            aria-label={t(i18n.calls.search.clear)}
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </form>
  );
}
