'use client';

import { Check, ChevronRight, FolderPlus, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

import { EmptyState } from '@/components/shared/empty-state';
import { InlineEditor, InlineEditorActions } from '@/components/shared/inline-editor';
import { PageContainer } from '@/components/shared/page-container';
import { PageHeader } from '@/components/shared/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LoadingButton } from '@/components/ui/loading-button';
import { Surface } from '@/components/ui/surface';
import { createProject } from '@/lib/action/projects';
import type { OrganizationResponse, ProjectResponse } from '@/lib/types';
import { backendMessage, unwrap } from '@/lib/utils/backend-error';
import { cn } from '@/lib/utils/cn';

interface OrganizationProjectsProps {
  organization: OrganizationResponse;
  projects: ProjectResponse[];
  /** Calls per project and the latest one's date, keyed by project id; absent when unknown. */
  activity: Record<string, { calls: number; lastCallAt: string | null }>;
  /** Owners and admins, or members when the organisation lets them create projects. */
  canCreate: boolean;
}

export function OrganizationProjects({ organization, projects, activity, canCreate }: OrganizationProjectsProps) {
  const t = useTranslations();
  const format = useFormatter();
  const router = useRouter();
  const searchParams = useSearchParams();
  const organizationId = organization.id;

  // ?create=1 (from the project switcher's "Nowy projekt") opens the inline row on arrival.
  const [createOpen, setCreateOpen] = useState(searchParams.get('create') === '1' && canCreate);
  const [name, setName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState('');
  const [createdId, setCreatedId] = useState<string | null>(null);
  const headerTriggerRef = useRef<HTMLButtonElement>(null);
  const emptyTriggerRef = useRef<HTMLButtonElement>(null);

  // The new row flashes "Utworzono" once the refreshed list contains it.
  useEffect(() => {
    if (!createdId || !projects.some((p) => p.id === createdId)) return;
    const timer = setTimeout(() => setCreatedId(null), 1500);
    return () => clearTimeout(timer);
  }, [createdId, projects]);

  const closeEditor = () => {
    setCreateOpen(false);
    setName('');
    setError('');
    requestAnimationFrame(() => (headerTriggerRef.current ?? emptyTriggerRef.current)?.focus());
  };

  const handleCreate = async () => {
    if (isCreating) return;
    if (!name.trim()) return setError(t('orgProjects.nameRequired'));
    setIsCreating(true);
    setError('');
    try {
      const project = unwrap(await createProject({ name: name.trim(), description: null, organizationId }));
      setCreatedId(project.id);
      setCreateOpen(false);
      setName('');
      router.refresh();
    } catch (e) {
      setError(backendMessage(e) ?? t('orgProjects.error'));
    } finally {
      setIsCreating(false);
    }
  };

  const activityLine = (projectId: string) => {
    const a = activity[projectId];
    if (!a) return null;
    if (a.calls === 0) return t('orgProjects.noCalls');
    const count = t('orgProjects.callCount', { count: a.calls });
    return a.lastCallAt
      ? `${count} · ${t('orgProjects.lastCall', {
          date: format.dateTime(new Date(a.lastCallAt), { day: 'numeric', month: 'short' }),
        })}`
      : count;
  };

  const editor = (
    <InlineEditor open={createOpen} onCancel={closeEditor} onSubmit={handleCreate} label={t('orgProjects.newProject')}>
      <div className="space-y-1.5">
        <label htmlFor="new-project-name" className="text-body text-foreground block font-medium">
          {t('orgProjects.nameLabel')}
        </label>
        <Input
          id="new-project-name"
          placeholder={t('orgProjects.namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="sm:max-w-md"
        />
      </div>
      <InlineEditorActions error={error}>
        <Button type="button" variant="ghost" onClick={closeEditor} disabled={isCreating}>
          {t('common.cancel')}
        </Button>
        <LoadingButton type="submit" loading={isCreating}>
          {t('orgProjects.create')}
        </LoadingButton>
      </InlineEditorActions>
    </InlineEditor>
  );

  return (
    <PageContainer>
      <PageHeader
        eyebrow={t('navbar.organization')}
        title={organization.name}
        description={t('orgProjects.description')}
      >
        {canCreate && projects.length > 0 && !createOpen && (
          <Button ref={headerTriggerRef} onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            {t('orgProjects.newProject')}
          </Button>
        )}
      </PageHeader>

      <section className="space-y-4">
        <h2 className="text-title text-foreground font-medium">{t('orgProjects.title')}</h2>
        {projects.length === 0 ? (
          <Surface pad="none" className="overflow-hidden">
            {createOpen ? (
              editor
            ) : (
              <EmptyState
                icon={FolderPlus}
                title={t('orgEmpty.title')}
                description={t('orgEmpty.description')}
                action={
                  canCreate && (
                    <Button ref={emptyTriggerRef} onClick={() => setCreateOpen(true)}>
                      {t('orgEmpty.createProject')}
                    </Button>
                  )
                }
              />
            )}
          </Surface>
        ) : (
          <Surface pad="none" className="overflow-hidden">
            {editor}
            <ul
              className={cn(
                'divide-y divide-black/[0.06] border-black/[0.06] dark:divide-white/[0.06] dark:border-white/[0.06]',
                createOpen && 'border-t'
              )}
            >
              {projects.map((project) => {
                const line = activityLine(project.id);
                const fresh = project.id === createdId;
                return (
                  <li key={project.id}>
                    <Link
                      href={`/${project.id}/home`}
                      className={cn(
                        'group flex items-center gap-4 px-5 py-4 transition-colors duration-700 hover:bg-black/[0.02] md:px-6 dark:hover:bg-white/[0.03]',
                        fresh && 'bg-black/[0.03] dark:bg-white/[0.04]'
                      )}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-body text-foreground truncate font-medium">{project.name}</p>
                        {project.description && (
                          <p className="text-meta text-muted-foreground mt-0.5 truncate">{project.description}</p>
                        )}
                      </div>
                      {fresh ? (
                        <span className="text-meta text-muted-foreground flex items-center gap-1" role="status">
                          <Check className="h-3.5 w-3.5" />
                          {t('orgProjects.created')}
                        </span>
                      ) : (
                        line && (
                          <p className="text-meta text-muted-foreground hidden shrink-0 tabular-nums sm:block">
                            {line}
                          </p>
                        )
                      )}
                      <ChevronRight className="text-muted-foreground/60 group-hover:text-foreground h-4 w-4 shrink-0 transition-colors" />
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Surface>
        )}
      </section>
    </PageContainer>
  );
}
