// JSON export of calls and analyses (item 37, #10). Text is always redacted, for every role;
// `result` is as stored (the names of the engine contract). One call at a time, so a large project
// is streamed and never held in memory. Access is checked by the route.
import 'server-only';

import { and, asc, desc, eq, inArray } from 'drizzle-orm';

import { loadTranscript, shownStatus } from '@/lib/calls/queries';
import { db } from '@/lib/db/client';
import { actionItems, analyses, calls, jobs, quotes } from '@/lib/db/schema/app';
import { renderText } from '@/lib/redaction';

export type ExportedCall = {
  id: string;
  filename: string;
  created_at: string;
  language: string | null;
  duration_ms: number | null;
  status: string;
  channel_roles: { channel_0: string; channel_1: string } | null;
  speakers: { id: string; label: string }[];
  turns: { index: number; speaker: string; start_ms: number; end_ms: number; text: string }[];
  analyses: {
    kind: string;
    status: string;
    model: string;
    result: unknown;
    quotes: { claim_path: string; turn: number; match: string; text: string | null }[];
  }[];
  action_items: {
    description: string;
    responsible_party: string;
    status: string;
    priority: string;
    deadline_mentioned: string | null;
  }[];
};

/** null when the call is gone (deleted while the export ran) or belongs to another project. */
export async function exportCall(projectId: string, callId: string): Promise<ExportedCall | null> {
  const [call] = await db
    .select()
    .from(calls)
    .where(and(eq(calls.id, callId), eq(calls.projectId, projectId)));
  if (!call) return null;
  const [transcript, analysisRows, itemRows, [job]] = await Promise.all([
    loadTranscript(callId, 'redacted'),
    db.select().from(analyses).where(eq(analyses.callId, callId)).orderBy(asc(analyses.kind)),
    db.select().from(actionItems).where(eq(actionItems.callId, callId)).orderBy(asc(actionItems.itemIndex)),
    db
      .select({ status: jobs.status, errorCode: jobs.errorCode })
      .from(jobs)
      .where(eq(jobs.callId, callId))
      .orderBy(desc(jobs.createdAt), desc(jobs.attempt))
      .limit(1),
  ]);
  const quoteRows =
    analysisRows.length > 0
      ? await db
          .select()
          .from(quotes)
          .where(
            inArray(
              quotes.analysisId,
              analysisRows.map((a) => a.id)
            )
          )
          .orderBy(asc(quotes.claimPath), asc(quotes.turn))
      : [];
  const words = transcript?.words ?? [];
  const ranges = transcript?.ranges ?? [];
  return {
    id: call.id,
    filename: call.originalFilename,
    created_at: call.createdAt.toISOString(),
    language: call.language,
    duration_ms: call.durationMs,
    status: call.status === 'pending' ? shownStatus(call.status, job ?? null).status : call.status,
    channel_roles: call.channelRoles,
    speakers: (transcript?.speakers ?? []).map((s) => ({ id: s.speakerId, label: s.name ?? s.speakerId })),
    turns: (transcript?.turns ?? []).map((turn) => ({
      index: turn.index,
      speaker: turn.speakerId,
      start_ms: turn.startMs,
      end_ms: turn.endMs,
      text: turn.text,
    })),
    analyses: analysisRows.map((a) => ({
      kind: a.kind,
      status: a.status,
      model: a.model,
      result: a.result ?? null,
      quotes: quoteRows
        .filter((q) => q.analysisId === a.id)
        .map((q) => ({
          claim_path: q.claimPath,
          turn: q.turn,
          match: q.match,
          text:
            q.startWord !== null && q.endWord !== null
              ? renderText(words, ranges, 'redacted', q.startWord, q.endWord)
              : null,
        })),
    })),
    action_items: itemRows.map((item) => ({
      description: item.description,
      responsible_party: item.responsibleParty,
      status: item.status,
      priority: item.priority,
      deadline_mentioned: item.deadlineMentioned,
    })),
  };
}
