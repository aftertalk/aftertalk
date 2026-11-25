import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { TemplateEditor } from '@/components/pages/templates/template-editor';
import { i18n } from '@/i18n/constants';
import { getAnalysisTemplate } from '@/lib/action/analysis-templates';
import { requireProjectPage } from '@/lib/page-access';
import { localizedPageMetadata } from '@/lib/utils/page-metadata';

export async function generateMetadata(): Promise<Metadata> {
  return localizedPageMetadata(i18n.meta.configure);
}

interface TemplateEditorPageProps {
  params: Promise<{ projectId: string; templateId: string }>;
  searchParams: Promise<{ from?: string }>;
}

// `new` creates a template; any other id edits that one. Opened from Configure, or from the upload
// setup (`from=upload`), and it returns to whichever list it came from.
export default async function TemplateEditorPage({ params, searchParams }: TemplateEditorPageProps) {
  const [{ projectId, templateId }, { from }] = await Promise.all([params, searchParams]);
  // Templates are created and edited by project editors; viewers read them in the list.
  await requireProjectPage(projectId, 'EDITOR');

  const template =
    templateId === 'new' ? undefined : await getAnalysisTemplate(projectId, templateId).catch(() => null);
  if (template === null) notFound();

  const backHref = from === 'upload' ? `/${projectId}/upload?tab=templates` : `/${projectId}/configure?tab=templates`;

  return <TemplateEditor projectId={projectId} template={template} backHref={backHref} />;
}
