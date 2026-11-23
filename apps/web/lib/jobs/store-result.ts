// Writing one result callback body into the database, in the caller's transaction (the "Result
// callback" shape of the Job contract). Used by the seed script now and by the result route of
// phase 3, so seeded calls are stored exactly as real ones will be. The body is trusted here: the
// route validates it against the contract before calling this.
import 'server-only';

import { eq } from 'drizzle-orm';

import type { Db } from '@/lib/db/client';
import {
  actionItems,
  analyses,
  calls,
  jobs,
  type JobStep,
  piiRanges,
  quotes,
  type Speaker,
  transcripts,
  type Turn,
  type Word,
} from '@/lib/db/schema/app';
import { renderText, sortRanges } from '@/lib/redaction';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type ResultQuote = {
  claim_path: string;
  turn: number;
  start_word: number | null;
  end_word: number | null;
  match: 'verbatim' | 'normalised' | 'other_turn' | 'unverified';
};

export type ResultAnalysis = {
  kind: 'summary' | 'call_reason' | 'scorecard';
  template_id?: string | null;
  status: 'completed' | 'failed';
  result?: unknown;
  error?: { code: string; message?: string } | null;
  quotes?: ResultQuote[];
};

export type ResultStep = {
  name: string;
  status: string;
  error_code?: string | null;
  cached?: boolean;
  tokens_in?: number;
  tokens_out?: number;
  duration_ms?: number;
};

export type ResultBody = {
  job_id: string;
  attempt: number;
  status: 'completed' | 'completed_with_errors' | 'failed';
  language?: 'pl' | 'en' | 'uk' | 'de';
  duration_ms?: number;
  transcript?: { words: Word[]; turns: Turn[]; speakers: Speaker[] };
  pii_ranges?: { start_word: number; end_word: number; type: (typeof piiRanges.$inferInsert)['type']; token: string }[];
  analyses?: ResultAnalysis[];
  steps: ResultStep[];
  error?: { step: string; code: string; message?: string } | null;
};

const toJobSteps = (steps: ResultStep[]): JobStep[] =>
  steps.map((s) => ({
    name: s.name,
    status: s.status,
    error_code: s.error_code ?? null,
    cached: s.cached === true,
    tokens: { input: s.tokens_in ?? 0, output: s.tokens_out ?? 0 },
    duration_ms: s.duration_ms ?? 0,
  }));

type SummaryActionItem = { description?: string; responsible_party?: string; deadline_mentioned?: string | null };

/**
 * A `failed` result stores nothing but the job's step report and error, so an earlier result stays
 * as it was. A completed one replaces the transcript, the ranges and every analysis of the call.
 */
export async function storeResult(
  tx: Tx,
  input: { callId: string; projectId: string; jobId: string; model: string },
  body: ResultBody
): Promise<void> {
  const finished = { steps: toJobSteps(body.steps), finishedAt: new Date() };
  if (body.status === 'failed' || !body.transcript) {
    await tx
      .update(jobs)
      .set({
        ...finished,
        status: 'failed',
        errorStep: body.error?.step ?? null,
        errorCode: body.error?.code ?? 'internal',
        errorMessage: body.error?.message ?? null,
      })
      .where(eq(jobs.id, input.jobId));
    return;
  }

  const { words, turns, speakers } = body.transcript;
  const ranges = (body.pii_ranges ?? []).map((r) => ({
    startWord: r.start_word,
    endWord: r.end_word,
    type: r.type,
    token: r.token,
  }));
  // The search text is the redacted transcript, so a search can never match a hidden word.
  const searchText = renderText(words, sortRanges(ranges), 'redacted');

  await tx
    .insert(transcripts)
    .values({ callId: input.callId, words, turns, speakers, searchText })
    .onConflictDoUpdate({
      target: transcripts.callId,
      set: { words, turns, speakers, searchText, updatedAt: new Date() },
    });
  await tx.delete(piiRanges).where(eq(piiRanges.callId, input.callId));
  if (ranges.length > 0) await tx.insert(piiRanges).values(ranges.map((r) => ({ ...r, callId: input.callId })));

  // Every analysis runs again in a re-run and replaces the stored one; quotes go with their analysis.
  // Tasks are rebuilt from the new summary, so a status a person set on an old task is lost with it.
  await tx.delete(actionItems).where(eq(actionItems.callId, input.callId));
  await tx.delete(analyses).where(eq(analyses.callId, input.callId));
  for (const analysis of body.analyses ?? []) {
    const [row] = await tx
      .insert(analyses)
      .values({
        callId: input.callId,
        jobId: input.jobId,
        kind: analysis.kind,
        templateId: analysis.template_id ?? null,
        status: analysis.status,
        result: analysis.status === 'completed' ? (analysis.result ?? null) : null,
        errorCode: analysis.status === 'failed' ? (analysis.error?.code ?? 'internal') : null,
        model: input.model,
      })
      .returning({ id: analyses.id });
    const quoteRows =
      analysis.quotes && analysis.quotes.length > 0
        ? await tx
            .insert(quotes)
            .values(
              analysis.quotes.map((q) => ({
                analysisId: row.id,
                claimPath: q.claim_path,
                turn: q.turn,
                startWord: q.match === 'unverified' ? null : q.start_word,
                endWord: q.match === 'unverified' ? null : q.end_word,
                match: q.match,
              }))
            )
            .returning({ id: quotes.id, claimPath: quotes.claimPath })
        : [];
    if (analysis.kind !== 'summary' || analysis.status !== 'completed') continue;
    const items = (analysis.result as { action_items?: SummaryActionItem[] } | null)?.action_items ?? [];
    if (items.length === 0) continue;
    await tx.insert(actionItems).values(
      items.map((item, index) => ({
        projectId: input.projectId,
        callId: input.callId,
        itemIndex: index,
        description: item.description ?? '',
        responsibleParty: item.responsible_party ?? 'unknown',
        deadlineMentioned: item.deadline_mentioned ?? null,
        quoteId: quoteRows.find((q) => q.claimPath === `action_items.${index}`)?.id ?? null,
      }))
    );
  }

  await tx
    .update(calls)
    .set({ status: body.status, language: body.language ?? null, durationMs: body.duration_ms ?? null })
    .where(eq(calls.id, input.callId));
  await tx
    .update(jobs)
    .set({ ...finished, status: body.status })
    .where(eq(jobs.id, input.jobId));
}
