import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { Surface, SurfaceHeader } from '@/components/ui/surface';
import { i18n } from '@/i18n/constants';
import type { ProjectReadiness } from '@/lib/types';

// What the project still needs before it can process calls (item 54a), on the project home. Every
// line comes from projectReadiness(), the same function the upload gate and the upload route ask.
// A missing diarization provider is only a hint: a one-channel file is then one speaker.
export async function ProjectChecklist({
  projectId,
  readiness,
  canConfigure,
}: {
  projectId: string;
  readiness: ProjectReadiness;
  /** Project admins get a link to the page that fixes each line; others are told to ask one. */
  canConfigure: boolean;
}) {
  const t = await getTranslations();
  const C = i18n.dashboard.checklist;
  const rows: { missing: boolean; label: string; tab: string; hint?: boolean }[] = [
    { missing: !readiness.categories, label: t(C.categories), tab: 'categories' },
    { missing: !readiness.roles, label: t(C.roles), tab: 'roles' },
    { missing: !readiness.templates, label: t(C.templates), tab: 'templates' },
    { missing: !readiness.speech, label: t(C.speech), tab: 'providers' },
    { missing: !readiness.llm, label: t(C.llm), tab: 'providers' },
    { missing: !readiness.diarization, label: t(C.diarization), tab: 'providers', hint: true },
  ];
  const missing = rows.filter((row) => row.missing);
  // Nothing to say when only the optional hint is left and uploads already work.
  if (missing.length === 0) return null;
  if (readiness.canUpload && missing.every((row) => row.hint)) {
    return (
      <p className="text-meta text-muted-foreground">
        {t(C.diarization)}{' '}
        {canConfigure && (
          <Link href={`/${projectId}/configure?tab=providers`} className="text-foreground underline underline-offset-2">
            {t(C.fix)}
          </Link>
        )}
      </p>
    );
  }

  return (
    <Surface>
      <SurfaceHeader title={t(C.title)} description={t(canConfigure ? C.description : C.askAdmin)} />
      <ul className="-mx-2">
        {missing.map((row) => {
          const body = (
            <>
              <span className="text-body text-foreground min-w-0 flex-1">{row.label}</span>
              {row.hint && (
                <span className="text-meta text-foreground/70 bg-foreground/[0.06] shrink-0 rounded-full px-2 py-0.5">
                  {t(C.optional)}
                </span>
              )}
              {canConfigure && <ArrowRight className="text-muted-foreground size-4 shrink-0" aria-hidden />}
            </>
          );
          return (
            <li key={row.label}>
              {canConfigure ? (
                <Link
                  href={`/${projectId}/configure?tab=${row.tab}`}
                  className="hover:bg-foreground/[0.03] flex items-center gap-3 rounded-xl px-2 py-2.5 transition-colors"
                >
                  {body}
                </Link>
              ) : (
                <div className="flex items-center gap-3 px-2 py-2.5">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </Surface>
  );
}
