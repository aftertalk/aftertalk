// What a project still needs before it can process calls (item 54a, #88). Every "missing setting"
// message comes from this one function. Access is checked by the callers.
import 'server-only';

import { sql } from 'drizzle-orm';

import { db } from '@/lib/db/client';
import type { ProjectReadiness } from '@/lib/types';

export async function projectReadiness(projectId: string): Promise<ProjectReadiness> {
  const [row] = await db.execute<{
    roles: boolean;
    templates: boolean;
    categories: boolean;
    speech: boolean;
    llm: boolean;
    diarization: boolean;
  }>(sql`
    select exists (select 1 from app.speaker_presets where project_id = ${projectId}) as roles,
           exists (select 1 from app.analysis_templates where project_id = ${projectId} and is_active) as templates,
           exists (select 1 from app.categories c join app.taxonomies t on t.id = c.taxonomy_id
                   where t.project_id = ${projectId}) as categories,
           exists (select 1 from app.project_provider_choice
                   where project_id = ${projectId} and slot = 'speech') as speech,
           exists (select 1 from app.project_provider_choice where project_id = ${projectId} and slot = 'llm') as llm,
           exists (select 1 from app.project_provider_choice
                   where project_id = ${projectId} and slot = 'diarization') as diarization`);
  return {
    ...row,
    // A missing diarization provider is only a hint: a mono file is then processed with one speaker.
    canUpload: row.roles && row.templates && row.categories && row.speech && row.llm,
  };
}
