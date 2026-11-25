// Database rows → view types for calls (items 29a, 33). The only code that reads transcripts, and so
// the only code that turns words into text: always through lib/redaction.ts. Access is checked by
// the callers (server actions and route handlers); every query here is scoped by project id.
import 'server-only';

import { and, asc, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';

import { db } from '@/lib/db/client';
import {
  analyses,
  analysisTemplateFields,
  analysisTemplates,
  calls,
  categories,
  jobs,
  type JobStep,
  piiRanges,
  quotes,
  taxonomies,
  transcripts,
  type Word,
} from '@/lib/db/schema/app';
import { renderText, sortRanges, type TextRange } from '@/lib/redaction';
import type {
  ActionItem,
  ActionItemPriority,
  ActionItemStatus,
  AnalysisFailure,
  Call,
  CallDetail,
  CallSearchResult,
  CallStatus,
  CategoryClassification,
  LaterRun,
  PagedResult,
  Quote,
  QuoteMatch,
  SentimentAnalysisOverallSentiment,
  Speaker,
  Step,
  Turn,
} from '@/lib/types';

// --- status ----------------------------------------------------------------------------------

type JobState = { status: string; errorCode: string | null } | null;

/** The Status model: `calls.status` is the stored result; the latest job says what is happening now. */
export function shownStatus(
  callStatus: 'pending' | 'completed' | 'completed_with_errors',
  job: JobState
): { status: CallStatus; failedReason: string | null; laterRun: LaterRun | null } {
  const failed = job?.status === 'failed' || job?.status === 'superseded';
  const failure = failed ? (job!.errorCode ?? (job!.status === 'superseded' ? 'stalled' : 'internal')) : null;
  if (callStatus === 'pending') {
    if (failed) return { status: 'failed', failedReason: failure, laterRun: null };
    return { status: job?.status === 'sent' ? 'processing' : 'queued', failedReason: null, laterRun: null };
  }
  let laterRun: LaterRun | null = null;
  if (job?.status === 'queued') laterRun = { status: 'queued', errorCode: null };
  else if (job?.status === 'sent') laterRun = { status: 'processing', errorCode: null };
  else if (failed) laterRun = { status: 'failed', errorCode: failure };
  return { status: callStatus, failedReason: null, laterRun };
}

// --- lists -----------------------------------------------------------------------------------

const iso = (column: SQL) => sql<string>`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

type ListRow = {
  id: string;
  filename: string;
  language: string | null;
  size_bytes: number;
  duration_ms: number | null;
  status: 'pending' | 'completed' | 'completed_with_errors';
  created_at: string;
  job_status: string | null;
  job_error: string | null;
  title: string | null;
  sentiment: string | null;
  category: string | null;
  action_items: number;
  snippet?: string | null;
  total: number;
};

function toCall(row: ListRow): Call {
  return {
    id: row.id,
    filename: row.filename,
    language: row.language ?? '',
    sizeBytes: Number(row.size_bytes),
    durationS: Math.round((row.duration_ms ?? 0) / 1000),
    sentimentLevel: row.sentiment ?? undefined,
    primaryCategory: row.category ?? undefined,
    actionItemsCount: row.action_items,
    createdAt: row.created_at,
    title: row.title ?? undefined,
    detectedLanguage: null,
    ...shownStatus(row.status, row.job_status ? { status: row.job_status, errorCode: row.job_error } : null),
  };
}

export type CallListFilter = { from?: Date; to?: Date; q?: string };

const SNIPPET_RADIUS = 80;

/** The WHERE of the calls list, shared with the export so both see the same calls. */
function listWhere(projectId: string, filter: CallListFilter): SQL {
  const parts: SQL[] = [sql`c.project_id = ${projectId}`];
  if (filter.from) parts.push(sql`c.created_at >= ${filter.from.toISOString()}`);
  if (filter.to) parts.push(sql`c.created_at <= ${filter.to.toISOString()}`);
  if (filter.q) {
    // A substring search over redacted text only; the trigram index serves it from three characters up.
    const pattern = `%${filter.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    parts.push(sql`exists (select 1 from app.transcripts t where t.call_id = c.id and t.search_text ilike ${pattern})`);
  }
  return sql.join(parts, sql` and `);
}

function markSnippet(text: string, q: string): string {
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return text;
  return `${text.slice(0, at)}<mark>${text.slice(at, at + q.length)}</mark>${text.slice(at + q.length)}`;
}

export async function listCalls(
  projectId: string,
  filter: CallListFilter,
  page: number,
  pageSize: number
): Promise<PagedResult<CallSearchResult>> {
  const q = filter.q ?? '';
  const snippet = q
    ? sql`(select substring(t.search_text from greatest(strpos(lower(t.search_text), lower(${q})) - ${SNIPPET_RADIUS}, 1)
            for ${2 * SNIPPET_RADIUS + q.length}) from app.transcripts t where t.call_id = c.id)`
    : sql`null`;
  const rows = await db.execute<ListRow>(sql`
    select c.id, c.original_filename as filename, c.language, c.size_bytes, c.duration_ms, c.status,
           ${iso(sql`c.created_at`)} as created_at,
           j.status as job_status, j.error_code as job_error,
           s.result ->> 'title' as title,
           s.result #>> '{sentiment,overall_sentiment}' as sentiment,
           coalesce(mc.name, rc.name) as category,
           (select count(*)::int from app.action_items ai where ai.call_id = c.id) as action_items,
           ${snippet} as snippet,
           count(*) over ()::int as total
    from app.calls c
    left join lateral (
      select status, error_code from app.jobs where call_id = c.id order by created_at desc, attempt desc limit 1
    ) j on true
    left join app.analyses s on s.call_id = c.id and s.kind = 'summary' and s.status = 'completed'
    left join app.analyses r on r.call_id = c.id and r.kind = 'call_reason' and r.status = 'completed'
    left join app.categories mc on mc.id = c.manual_category_id
    left join app.categories rc on rc.id::text = r.result #>> '{primary,category_path,-1}'
    where ${listWhere(projectId, filter)}
    order by c.created_at desc, c.id
    limit ${pageSize} offset ${(page - 1) * pageSize}`);
  let total = rows[0]?.total ?? 0;
  if (rows.length === 0 && page > 1) {
    const [count] = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from app.calls c where ${listWhere(projectId, filter)}`
    );
    total = count.n;
  }
  return {
    data: rows.map((row) => ({
      ...toCall(row),
      snippet: row.snippet ? markSnippet(row.snippet, q) : '',
      relevance: 1,
    })),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/** Ids of the calls a list filter matches, oldest first, for the export. */
export async function listCallIds(projectId: string, filter: CallListFilter): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(
    sql`select c.id from app.calls c where ${listWhere(projectId, filter)} order by c.created_at, c.id`
  );
  return rows.map((r) => r.id);
}

// --- quotes ----------------------------------------------------------------------------------

type QuoteRow = { turn: number; startWord: number | null; endWord: number | null; match: QuoteMatch };

/** A quote is shown by rendering its word range, so the text is the transcript's, not the model's. */
export function toQuote(row: QuoteRow, words: readonly Word[], sortedRanges: readonly TextRange[]): Quote {
  const inRange = row.startWord !== null && row.endWord !== null && row.startWord < words.length;
  return {
    turn: row.turn,
    startWord: row.startWord,
    endWord: row.endWord,
    startMs: inRange ? (words[row.startWord!].start_ms ?? null) : null,
    match: row.match,
    text: inRange ? renderText(words, sortedRanges, 'redacted', row.startWord!, row.endWord!) : null,
  };
}

// --- action items ----------------------------------------------------------------------------

export type ActionItemRow = {
  id: string;
  project_id: string;
  call_id: string;
  item_index: number;
  call_date: string;
  call_filename: string;
  description: string;
  responsible_party: string;
  deadline_mentioned: string | null;
  status: ActionItemStatus;
  priority: ActionItemPriority;
  notes: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  q_turn: number | null;
  q_start: number | null;
  q_end: number | null;
  q_match: QuoteMatch | null;
  q_words: Word[] | null;
  q_ranges: { s: number; e: number; t: string }[] | null;
};

/** The columns of {@link ActionItemRow}; `ai` is app.action_items and `c` is app.calls. */
export const ACTION_ITEM_COLUMNS = sql`
  ai.id, ai.project_id, ai.call_id, ai.item_index, ai.description, ai.responsible_party, ai.deadline_mentioned,
  ai.status, ai.priority, ai.notes,
  ${iso(sql`c.created_at`)} as call_date, c.original_filename as call_filename,
  ${iso(sql`ai.completed_at`)} as completed_at, ${iso(sql`ai.created_at`)} as created_at,
  ${iso(sql`ai.updated_at`)} as updated_at,
  q.turn as q_turn, q.start_word as q_start, q.end_word as q_end, q.match as q_match,
  case when q.start_word is not null then (
    select jsonb_path_query_array(t.words, '$[$a to $b]', jsonb_build_object('a', q.start_word, 'b', q.end_word))
    from app.transcripts t where t.call_id = ai.call_id) end as q_words,
  case when q.start_word is not null then (
    select jsonb_agg(jsonb_build_object('s', p.start_word, 'e', p.end_word, 't', p.token))
    from app.pii_ranges p
    where p.call_id = ai.call_id and p.start_word <= q.end_word and p.end_word >= q.start_word) end as q_ranges`;

/** The joins {@link ACTION_ITEM_COLUMNS} needs. */
export const ACTION_ITEM_JOINS = sql`
  from app.action_items ai
  join app.calls c on c.id = ai.call_id
  left join app.quotes q on q.id = ai.quote_id`;

export function toActionItem(row: ActionItemRow): ActionItem {
  let quote: Quote | null = null;
  if (row.q_turn !== null && row.q_match !== null) {
    // Only the quoted words were loaded; shift the ranges so both count from the first of them.
    const offset = row.q_start ?? 0;
    const words = row.q_words ?? [];
    const ranges = sortRanges(
      (row.q_ranges ?? []).map((r) => ({ startWord: r.s - offset, endWord: r.e - offset, token: r.t }))
    );
    quote = {
      turn: row.q_turn,
      startWord: row.q_start,
      endWord: row.q_end,
      startMs: words[0]?.start_ms ?? null,
      match: row.q_match,
      text: words.length > 0 ? renderText(words, ranges, 'redacted') : null,
    };
  }
  return {
    id: row.id,
    projectId: row.project_id,
    transcriptId: row.call_id,
    transcriptIndex: row.item_index,
    callDate: row.call_date,
    callFilename: row.call_filename,
    description: row.description,
    responsibleParty: row.responsible_party,
    deadlineMentioned: row.deadline_mentioned ?? undefined,
    quote,
    status: row.status,
    priority: row.priority,
    notes: row.notes ?? undefined,
    completedAt: row.completed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // A deadline is the caller's words ("by Friday"), not a date, so nothing is ever overdue.
    isOverdue: false,
  };
}

// --- one call --------------------------------------------------------------------------------

export type DetailAccess = {
  /** Organisation owner or admin, or the project's member_pii_access is `full`. */
  mayUsePersonalData: boolean;
  canDelete: boolean;
  canSeeAccessLog: boolean;
};

type SummaryResult = {
  title?: string;
  executive_summary?: string;
  key_discussion_points?: string[];
  resolution_provided?: string | null;
  follow_up_required?: boolean;
  next_steps?: string[];
  sentiment?: { overall_sentiment?: string; sentiment_progression?: string | null; confidence?: number };
};
type Reason = { category_path?: string[]; confidence?: number; explanation?: string | null };
type ReasonResult = { primary?: Reason; secondary?: Reason[]; overall_confidence?: number; reasoning?: string | null };
type ScorecardResult = { fields?: { field_id: string; value?: unknown; confidence?: string; answered?: boolean }[] };

function toSteps(steps: JobStep[] | null | undefined): Step[] {
  return (steps ?? []).map((s) => ({
    name: s.name,
    status: s.status === 'failed' || s.status === 'skipped' ? s.status : 'completed',
    errorCode: s.error_code ?? null,
    cached: s.cached === true,
    tokensIn: s.tokens?.input ?? 0,
    tokensOut: s.tokens?.output ?? 0,
    durationMs: s.duration_ms ?? 0,
  }));
}

export type LoadedTranscript = { words: Word[]; ranges: TextRange[]; turns: Turn[]; speakers: Speaker[] };

/** The transcript of a call with its sorted ranges, turns rendered in `mode`. null when none is stored. */
export async function loadTranscript(callId: string, mode: 'redacted' | 'original'): Promise<LoadedTranscript | null> {
  const [[transcript], rangeRows] = await Promise.all([
    db.select().from(transcripts).where(eq(transcripts.callId, callId)),
    db
      .select({ startWord: piiRanges.startWord, endWord: piiRanges.endWord, token: piiRanges.token })
      .from(piiRanges)
      .where(eq(piiRanges.callId, callId)),
  ]);
  if (!transcript) return null;
  const words = transcript.words;
  const ranges = sortRanges(rangeRows);
  const turns: Turn[] = transcript.turns.map((turn, i) => ({
    index: i + 1,
    speakerId: turn.speaker,
    text: renderText(words, ranges, mode, turn.start_word, turn.end_word),
    startMs: words[turn.start_word]?.start_ms ?? 0,
    endMs: words[turn.end_word]?.end_ms ?? 0,
    startWord: turn.start_word,
    endWord: turn.end_word,
  }));
  const spoken = turns.reduce((sum, turn) => sum + Math.max(0, turn.endMs - turn.startMs), 0);
  const speakers: Speaker[] = transcript.speakers.map((speaker) => {
    const own = turns.filter((turn) => turn.speakerId === speaker.id);
    const ms = own.reduce((sum, turn) => sum + Math.max(0, turn.endMs - turn.startMs), 0);
    return {
      speakerId: speaker.id,
      name: speaker.label,
      talkRatio: spoken > 0 ? ms / spoken : 0,
      turnCount: own.length,
      wordCount: own.reduce((sum, turn) => sum + (turn.endWord - turn.startWord + 1), 0),
      totalDurationS: Math.round(ms / 1000),
    };
  });
  return { words, ranges, turns, speakers };
}

export async function loadCallDetail(
  projectId: string,
  callId: string,
  access: DetailAccess
): Promise<CallDetail | null> {
  const [call] = await db
    .select()
    .from(calls)
    .where(and(eq(calls.id, callId), eq(calls.projectId, projectId)));
  if (!call) return null;

  const [jobRows, transcript, analysisRows, categoryRows, itemRows, piiTypes] = await Promise.all([
    db
      .select({ status: jobs.status, errorCode: jobs.errorCode, steps: jobs.steps, request: jobs.request })
      .from(jobs)
      .where(eq(jobs.callId, callId))
      .orderBy(desc(jobs.createdAt), desc(jobs.attempt))
      .limit(5),
    loadTranscript(callId, 'redacted'),
    db.select().from(analyses).where(eq(analyses.callId, callId)),
    db
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .innerJoin(taxonomies, eq(taxonomies.id, categories.taxonomyId))
      .where(eq(taxonomies.projectId, projectId)),
    db.execute<ActionItemRow>(
      sql`select ${ACTION_ITEM_COLUMNS} ${ACTION_ITEM_JOINS} where ai.call_id = ${callId} order by ai.item_index`
    ),
    db
      .select({ type: piiRanges.type, n: sql<number>`count(*)::int` })
      .from(piiRanges)
      .where(eq(piiRanges.callId, callId))
      .groupBy(piiRanges.type),
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
          .orderBy(asc(quotes.turn), asc(quotes.startWord))
      : [];
  const words = transcript?.words ?? [];
  const ranges = transcript?.ranges ?? [];
  const quotesAt = (analysisId: string, claimPath: string): Quote[] =>
    quoteRows
      .filter((row) => row.analysisId === analysisId && row.claimPath === claimPath)
      .map((row) => toQuote(row, words, ranges));

  const done = (kind: 'summary' | 'call_reason' | 'scorecard') =>
    analysisRows.find((a) => a.kind === kind && a.status === 'completed' && a.result);
  const failedAnalyses: AnalysisFailure[] = analysisRows
    .filter((a) => a.status === 'failed')
    .map((a) => ({ kind: a.kind, errorCode: a.errorCode }));
  const categoryName = new Map(categoryRows.map((c) => [c.id, c.name]));
  const actionItems = itemRows.map(toActionItem);

  const summaryRow = done('summary');
  const summary = summaryRow?.result as SummaryResult | undefined;
  const reasonRow = done('call_reason');
  const reason = reasonRow?.result as ReasonResult | undefined;
  const scorecardRow = done('scorecard');
  const scorecard = scorecardRow?.result as ScorecardResult | undefined;

  const toReason = (r: Reason): CategoryClassification => {
    const path = Array.isArray(r.category_path) ? r.category_path : [];
    return {
      categoryId: path.at(-1) ?? '',
      categoryPath: path,
      categoryNames: path.map((id) => categoryName.get(id)).filter((name): name is string => !!name),
      confidence: r.confidence ?? 0,
      explanation: r.explanation ?? null,
      depth: path.length,
    };
  };
  const primary = reason?.primary ? toReason(reason.primary) : undefined;

  let templateAnalysis: CallDetail['templateAnalysis'];
  if (scorecardRow && scorecard) {
    const answers = Array.isArray(scorecard.fields) ? scorecard.fields : [];
    const [[template], fieldRows] = await Promise.all([
      scorecardRow.templateId
        ? db
            .select({ name: analysisTemplates.name })
            .from(analysisTemplates)
            .where(eq(analysisTemplates.id, scorecardRow.templateId))
        : Promise.resolve([]),
      scorecardRow.templateId
        ? db
            .select()
            .from(analysisTemplateFields)
            .where(eq(analysisTemplateFields.templateId, scorecardRow.templateId))
            .orderBy(asc(analysisTemplateFields.displayOrder))
        : Promise.resolve([]),
    ]);
    // A question removed from the template since the run has no label any more and is left out.
    templateAnalysis = {
      templateName: template?.name ?? '',
      modelUsed: scorecardRow.model,
      analyzedAt: scorecardRow.createdAt.toISOString(),
      results: fieldRows.flatMap((field) => {
        const answer = answers.find((a) => a.field_id === field.id);
        if (!answer) return [];
        return [
          {
            label: field.label,
            value: answer.value ?? undefined,
            answerType: field.answerType,
            confidence: answer.confidence ?? 'low',
            evidence: quotesAt(scorecardRow.id, `fields.${field.id}`),
            answered: answer.answered === true,
          },
        ];
      }),
    };
  }

  const latest = jobRows[0] ?? null;
  const stepsJob = jobRows.find((j) => j.steps && j.steps.length > 0);
  const request = jobRows.find((j) => j.status === 'completed' || j.status === 'completed_with_errors')?.request as
    { settings?: { diarization?: unknown } } | null | undefined;
  const manualName = call.manualCategoryId ? categoryName.get(call.manualCategoryId) : undefined;
  const sentimentLevel = summary?.sentiment?.overall_sentiment;
  const hasResult = call.status !== 'pending';

  return {
    id: call.id,
    filename: call.originalFilename,
    language: call.language ?? '',
    sizeBytes: call.sizeBytes,
    durationS: Math.round((call.durationMs ?? 0) / 1000),
    sentimentLevel,
    primaryCategory: manualName ?? primary?.categoryNames.at(-1),
    actionItemsCount: actionItems.length,
    createdAt: call.createdAt.toISOString(),
    updatedAt: call.updatedAt.toISOString(),
    title: summary?.title || undefined,
    detectedLanguage: null,
    ...shownStatus(call.status, latest),
    fullText: (transcript?.turns ?? []).map((turn) => turn.text).join('\n'),
    speakers: transcript?.speakers ?? [],
    turns: transcript?.turns ?? [],
    piiStatistics: transcript
      ? {
          totalDetected: piiTypes.reduce((sum, row) => sum + row.n, 0),
          types: Object.fromEntries(piiTypes.map((row) => [row.type, row.n])),
        }
      : undefined,
    classification:
      reasonRow && reason && primary
        ? {
            primary,
            secondary: (Array.isArray(reason.secondary) ? reason.secondary : []).map(toReason),
            overallConfidence: reason.overall_confidence ?? 0,
            reasoning: reason.reasoning ?? '',
            modelUsed: reasonRow.model,
          }
        : undefined,
    manualCategoryId: call.manualCategoryId,
    summary:
      summaryRow && summary
        ? {
            summary: {
              executiveSummary: summary.executive_summary ?? '',
              keyDiscussionPoints: summary.key_discussion_points ?? [],
              resolutionProvided: summary.resolution_provided ?? undefined,
              followUpRequired: summary.follow_up_required === true,
              nextSteps: summary.next_steps ?? [],
            },
            sentiment: sentimentLevel
              ? {
                  overallSentiment: sentimentLevel as SentimentAnalysisOverallSentiment,
                  sentimentProgression: summary.sentiment?.sentiment_progression ?? undefined,
                  confidence: summary.sentiment?.confidence ?? 0,
                  evidence: quotesAt(summaryRow.id, 'sentiment'),
                }
              : undefined,
            sentimentLevel,
            actionItems,
            modelUsed: summaryRow.model,
          }
        : undefined,
    templateAnalysis,
    failedAnalyses,
    steps: toSteps(stepsJob?.steps),
    channelRoles: call.channelRoles,
    canShowOriginal: access.mayUsePersonalData && !!transcript,
    canPlayAudio: access.mayUsePersonalData && hasResult,
    canDelete: access.canDelete,
    canSeeAccessLog: access.canSeeAccessLog,
    diarized: !transcript || transcript.speakers.length > 1 || !!request?.settings?.diarization,
  };
}
