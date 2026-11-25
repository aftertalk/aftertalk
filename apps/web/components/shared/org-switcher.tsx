'use client';

import { Check, ChevronsUpDown } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { i18n } from '@/i18n/constants';
import type { OrganizationResponse } from '@/lib/types';
import { cn } from '@/lib/utils/cn';

interface OrgSwitcherProps {
  organizations: OrganizationResponse[];
  currentOrgId?: string;
  /** `sidebar`: full-width row at the top of the sidebar. `rail`: the initial only (collapsed sidebar). */
  variant?: 'bar' | 'sidebar' | 'rail';
  className?: string;
}

// A neutral square with the org's first letter: tells orgs apart without inventing logos or colours.
function OrgMark({ name }: { name?: string }) {
  return (
    <span
      aria-hidden
      className="text-foreground/80 flex size-6 shrink-0 items-center justify-center rounded-md bg-black/[0.07] text-[11px] font-semibold dark:bg-white/[0.1]"
    >
      {(name?.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

export function OrgSwitcher({ organizations, currentOrgId, variant = 'bar', className }: OrgSwitcherProps) {
  const t = useTranslations();
  const router = useRouter();

  const currentOrg = organizations.find((o) => o.id === currentOrgId);

  if (organizations.length === 0) return null;

  const label = currentOrg?.name ?? t(i18n.orgSwitcher.organization);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          title={label}
          aria-label={variant === 'rail' ? label : undefined}
          className={cn(
            'text-foreground hover:bg-foreground/6 flex min-w-0 items-center rounded-xl text-sm transition-colors',
            variant === 'bar' && 'max-w-[240px] gap-1.5 px-2 py-1.5',
            variant === 'sidebar' && 'w-full gap-2.5 px-2 py-2 font-medium',
            variant === 'rail' && 'size-9 justify-center',
            className
          )}
        >
          {variant !== 'bar' && <OrgMark name={currentOrg?.name} />}
          {variant !== 'rail' && (
            <>
              <span className="min-w-0 flex-1 truncate text-left">{label}</span>
              <ChevronsUpDown className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side={variant === 'rail' ? 'right' : 'bottom'} className="w-60">
        {organizations.map((org) => (
          // The current org too: from inside a project it is the way back to the org home.
          <DropdownMenuItem
            key={org.id}
            onClick={() => router.push(`/organization/${org.id}`)}
            className="flex items-center gap-2"
          >
            <Check className={cn('h-4 w-4 shrink-0', org.id === currentOrgId ? 'opacity-100' : 'opacity-0')} />
            <span className="truncate">{org.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
