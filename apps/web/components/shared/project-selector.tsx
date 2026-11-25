'use client';

import { Check, ChevronsUpDown, LayoutGrid, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { i18n } from '@/i18n/constants';
import type { ProjectResponse } from '@/lib/types';
import { cn } from '@/lib/utils/cn';

interface ProjectSelectorProps {
  projects: ProjectResponse[];
  currentProjectId?: string;
  /** The active org — new projects are created under it. */
  currentOrgId?: string;
  /** False when a member's org disallows project creation; owners/admins are always true. */
  canCreate?: boolean;
  /** `sidebar`: full-width row under the org switcher. */
  variant?: 'bar' | 'sidebar';
}

export function ProjectSelector({
  projects,
  currentProjectId,
  currentOrgId,
  canCreate = true,
  variant = 'bar',
}: ProjectSelectorProps) {
  const t = useTranslations();
  const router = useRouter();

  const currentProject = projects.find((p) => p.id === currentProjectId);
  // Creation lives on the org's Projects grid; ?create=1 opens the dialog on arrival.
  const newProjectHref = currentOrgId ? `/organization/${currentOrgId}?create=1` : '/';

  const handleSwitch = (projectId: string) => {
    router.push(`/${projectId}/home`);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            'text-foreground hover:bg-foreground/6 flex min-w-0 items-center gap-1.5 rounded-xl text-sm transition-colors',
            variant === 'bar' ? 'max-w-[240px] px-2 py-1.5' : 'w-full py-1.5 pr-2 pl-[2.625rem]'
          )}
        >
          <span className="min-w-0 flex-1 truncate text-left">
            {currentProject?.name ?? t(i18n.projectSelector.selectProject)}
          </span>
          <ChevronsUpDown className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        {currentOrgId && (
          <>
            <DropdownMenuItem onClick={() => router.push(`/organization/${currentOrgId}`)} className="gap-2">
              <LayoutGrid className="h-4 w-4" />
              {t(i18n.navbar.allProjects)}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {projects.map((project) => (
          <DropdownMenuItem
            key={project.id}
            onClick={() => handleSwitch(project.id)}
            className="flex items-center gap-2"
          >
            <Check className={cn('h-4 w-4 shrink-0', project.id === currentProjectId ? 'opacity-100' : 'opacity-0')} />
            <span className="truncate">{project.name}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => router.push(newProjectHref)} disabled={!canCreate} className="gap-2">
          <Plus className="h-4 w-4" />
          {t(i18n.projectSelector.newProject)}
        </DropdownMenuItem>
        {!canCreate && (
          <p className="text-muted-foreground px-2 pt-0.5 pb-1.5 text-xs leading-snug">
            {t(i18n.projectSelector.createRestricted)}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
