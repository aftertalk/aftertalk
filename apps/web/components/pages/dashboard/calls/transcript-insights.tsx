'use client';

import { Check, ChevronDown, ChevronRight, Minus, Pencil, Play, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Surface, SurfaceHeader } from '@/components/ui/surface';
import { i18n } from '@/i18n/constants';
import { getTaxonomy } from '@/lib/action/taxonomy';
import { setCallCategory } from '@/lib/action/transcription';
import { useFormat } from '@/lib/format';
import type {
  ActionItemStatus,
  CallAnalysis,
  CallDetail,
  Quote,
  TemplateAnalysisDetail,
  TemplateFieldResult,
} from '@/lib/types';
import type { TaxonomyCategory } from '@/lib/types/classification';
import { partyLabel, sentimentLabel, speakerLabel } from '@/lib/utils/analysis-labels';
import { backendMessage, unwrap } from '@/lib/utils/backend-error';
import { cn } from '@/lib/utils/cn';

// The aside of the call page, in reading order: the scorecard first (what the team grades on), then
// the summary, the tasks the call produced, and the file's particulars folded away at the bottom.

/**
 * Takes the reader to where a quote was said: its turn, and the time to play from when this user may
 * hear the audio. null when the quote names no turn of this transcript.
 */
export type QuoteJump = (quote: Quote) => { time: string | null; onClick: () => void } | null;

// A quote is the transcript's own words for a word range (never the model's), so it is always redacted
// like the rest of the page. An unverified claim has no range: it gets a label and no play button.
export function QuoteBlock({ quote, jumpTo }: { quote: Quote; jumpTo: QuoteJump }) {
  const t = useTranslations();

  if (quote.match === 'unverified' || quote.text === null) {
    return (
      <p className="text-meta text-muted-foreground rounded-lg bg-black/[0.03] px-3 py-2 leading-relaxed dark:bg-white/[0.04]">
        {t(i18n.calls.detail.quoteUnverified)}
      </p>
    );
  }

  const jump = jumpTo(quote);
  const text = <q className="text-foreground/80 italic">{quote.text}</q>;

  if (!jump) {
    return (
      <p className="text-meta rounded-lg bg-black/[0.03] px-3 py-2 leading-relaxed dark:bg-white/[0.04]">{text}</p>
    );
  }

  return (
    <button
      type="button"
      onClick={jump.onClick}
      aria-label={jump.time ? t(i18n.calls.detail.playFrom, { time: jump.time }) : undefined}
      className="text-meta flex w-full items-start gap-2 rounded-lg bg-black/[0.03] px-3 py-2 text-left leading-relaxed transition-colors hover:bg-black/[0.06] dark:bg-white/[0.04] dark:hover:bg-white/[0.08]"
    >
      <span className="min-w-0 flex-1">{text}</span>
      {jump.time && (
        <span className="text-muted-foreground mt-px inline-flex shrink-0 items-center gap-1 font-mono tabular-nums">
          <Play className="h-3 w-3" aria-hidden />
          {jump.time}
        </span>
      )}
    </button>
  );
}

function MicroLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground mt-5 mb-2 font-mono text-xs tracking-[0.18em] uppercase">{children}</p>;
}

// ─── Score ──────────────────────────────────────────────────────────────────

const isBoolean = (r: TemplateFieldResult) => r.answerType.toUpperCase() === 'BOOLEAN';

/** Criteria met out of the yes/no criteria; the other field types record facts, not a pass or fail. */
export function scoreOf(analysis?: TemplateAnalysisDetail): { met: number; total: number } | null {
  const criteria = analysis?.results.filter(isBoolean) ?? [];
  if (criteria.length === 0) return null;
  return { met: criteria.filter((r) => r.answered && !!r.value).length, total: criteria.length };
}

/**
 * The non-yes/no answers ("Wynik rozmowy: Rozmowa nieukończona"). They say how the call ended, which a
 * criteria count can't, so they're shown on their own beside the score rather than mixed into the list.
 */
export function outcomesOf(analysis?: TemplateAnalysisDetail): TemplateFieldResult[] {
  return analysis?.results.filter((r) => !isBoolean(r)) ?? [];
}

export function useOutcomeValue() {
  const t = useTranslations();
  const format = useFormat();
  return (result: TemplateFieldResult) =>
    !result.answered || result.value == null
      ? t(i18n.dashboard.transcriptModal.analysis.couldNotDetermine)
      : typeof result.value === 'number'
        ? format.number(result.value)
        : String(result.value);
}

// Failed first: that's what a reviewer opens the call for. Then the undetermined, and what passed last.
function rank(r: TemplateFieldResult): number {
  if (r.answered && !r.value) return 0;
  if (!r.answered) return 1;
  return 2;
}

function CriterionRow({ result, jumpTo }: { result: TemplateFieldResult; jumpTo: QuoteJump }) {
  const t = useTranslations();
  const failed = result.answered && !result.value;
  const lowConfidence = result.answered && result.confidence.toUpperCase() === 'LOW';

  return (
    <li className={cn('rounded-xl px-3 py-2.5', failed && 'bg-negative/[0.06]')}>
      <div className="flex items-start gap-2.5">
        <span className="mt-1 flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden>
          {failed ? (
            <X className="text-negative h-4 w-4" />
          ) : result.answered ? (
            <Check className="text-positive h-4 w-4" />
          ) : (
            <Minus className="text-muted-foreground h-4 w-4" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="text-body text-foreground leading-snug">{result.label}</p>
            {lowConfidence && (
              <span className="text-meta text-foreground/70 bg-foreground/[0.06] shrink-0 rounded-full px-2 py-0.5 whitespace-nowrap">
                {t(i18n.calls.detail.lowConfidence)}
              </span>
            )}
          </div>
          {!result.answered && (
            <p className="text-meta text-muted-foreground mt-0.5">
              {t(i18n.dashboard.transcriptModal.analysis.couldNotDetermine)}
            </p>
          )}
          {result.answered && result.evidence.length > 0 && (
            <details open={failed} className="group mt-1.5">
              <summary className="text-meta text-muted-foreground hover:text-foreground inline-flex cursor-pointer list-none items-center gap-1 transition-colors [&::-webkit-details-marker]:hidden">
                <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
                {t(i18n.dashboard.transcriptModal.analysis.showEvidence)}
              </summary>
              <div className="mt-2 space-y-1.5">
                {result.evidence.map((quote, i) => (
                  <QuoteBlock key={i} quote={quote} jumpTo={jumpTo} />
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
    </li>
  );
}

export function Scorecard({
  analysis,
  jumpTo,
  emptyReason,
}: {
  analysis?: TemplateAnalysisDetail;
  jumpTo: QuoteJump;
  /** Why there is no scorecard (still processing, the step failed, …); the default says none was made. */
  emptyReason?: string | null;
}) {
  const t = useTranslations();
  const outcomeValue = useOutcomeValue();
  const criteria = useMemo(
    () => (analysis?.results ?? []).filter(isBoolean).sort((a, b) => rank(a) - rank(b)),
    [analysis]
  );
  const outcomes = outcomesOf(analysis);

  if (!analysis || analysis.results.length === 0) {
    return (
      <Surface as="section">
        <SurfaceHeader
          title={t(i18n.calls.detail.score)}
          description={emptyReason ?? t(i18n.dashboard.transcriptModal.analysis.noAnalysisDescription)}
          className="mb-0"
        />
      </Surface>
    );
  }

  const score = scoreOf(analysis);

  return (
    <Surface as="section">
      <SurfaceHeader
        eyebrow={analysis.templateName}
        title={t(i18n.calls.detail.score)}
        description={score ? t(i18n.calls.detail.criteriaMet, score) : undefined}
      />
      {outcomes.length > 0 && (
        <dl className="bg-foreground/[0.04] mb-3 space-y-2 rounded-xl px-3 py-2.5">
          {outcomes.map((result, i) => (
            <div key={i} className="flex items-baseline justify-between gap-4">
              <dt className="text-meta text-muted-foreground shrink-0">{result.label}</dt>
              <dd className="text-body text-foreground min-w-0 text-right font-medium">{outcomeValue(result)}</dd>
            </div>
          ))}
        </dl>
      )}
      {criteria.length > 0 && (
        <ul className="-mx-3 space-y-1">
          {criteria.map((result, i) => (
            <CriterionRow key={i} result={result} jumpTo={jumpTo} />
          ))}
        </ul>
      )}
    </Surface>
  );
}

// ─── Summary ────────────────────────────────────────────────────────────────

export function SummaryCard({
  summary,
  jumpTo,
  emptyReason,
}: {
  summary?: CallAnalysis;
  jumpTo: QuoteJump;
  emptyReason?: string | null;
}) {
  const t = useTranslations();

  if (!summary) {
    return (
      <Surface as="section">
        <SurfaceHeader
          title={t(i18n.dashboard.transcriptModal.tabs.summary)}
          description={emptyReason ?? t(i18n.dashboard.transcriptModal.summary.noSummaryDescription)}
          className="mb-0"
        />
      </Surface>
    );
  }

  const { executiveSummary, keyDiscussionPoints, resolutionProvided, followUpRequired, nextSteps } = summary.summary;

  return (
    <Surface as="section">
      <SurfaceHeader title={t(i18n.dashboard.transcriptModal.tabs.summary)} />
      <p className="text-body text-foreground/90 leading-relaxed">{executiveSummary}</p>

      {keyDiscussionPoints.length > 0 && (
        <>
          <MicroLabel>{t(i18n.dashboard.transcriptModal.summary.keyDiscussionPoints)}</MicroLabel>
          <ol className="space-y-2">
            {keyDiscussionPoints.map((point, i) => (
              <li key={i} className="text-body text-foreground/80 flex gap-2.5 leading-relaxed">
                <span className="text-muted-foreground mt-0.5 w-4 shrink-0 font-mono text-xs tabular-nums">
                  {i + 1}
                </span>
                {point}
              </li>
            ))}
          </ol>
        </>
      )}

      {(resolutionProvided || followUpRequired) && (
        <>
          <MicroLabel>{t(i18n.dashboard.transcriptModal.summary.resolution)}</MicroLabel>
          <p className="text-body text-foreground/80 leading-relaxed">
            {resolutionProvided ?? t(i18n.dashboard.transcriptModal.summary.noResolution)}
          </p>
          {followUpRequired && (
            <span className="text-meta text-foreground/80 bg-foreground/[0.06] mt-2 inline-flex rounded-full px-2 py-0.5">
              {t(i18n.dashboard.transcriptModal.summary.followUpRequired)}
            </span>
          )}
        </>
      )}

      {nextSteps.length > 0 && (
        <>
          <MicroLabel>{t(i18n.dashboard.transcriptModal.summary.nextSteps)}</MicroLabel>
          <ul className="space-y-1.5">
            {nextSteps.map((step, i) => (
              <li key={i} className="text-body text-foreground/80 flex gap-2.5 leading-relaxed">
                <span className="bg-muted-foreground/50 mt-2.5 h-1 w-1 shrink-0 rounded-full" />
                {step}
              </li>
            ))}
          </ul>
        </>
      )}

      {summary.sentiment && summary.sentiment.evidence.length > 0 && (
        <>
          <MicroLabel>{t(i18n.calls.table.sentiment)}</MicroLabel>
          <div className="space-y-1.5">
            {summary.sentiment.evidence.map((quote, i) => (
              <QuoteBlock key={i} quote={quote} jumpTo={jumpTo} />
            ))}
          </div>
        </>
      )}
    </Surface>
  );
}

// ─── Tasks ──────────────────────────────────────────────────────────────────

export interface TaskRow {
  /** Present on tasks from the task list; the analysis' own copy has none. */
  id?: string;
  description: string;
  responsibleParty?: string;
  deadlineMentioned?: string;
  status?: ActionItemStatus;
  isOverdue?: boolean;
}

export const isOpenTask = (task: TaskRow) => task.status !== 'DONE' && task.status !== 'CANCELLED';

function StatusBadge({ task }: { task: TaskRow }) {
  const t = useTranslations();
  const [label, tone] = task.isOverdue
    ? [t(i18n.dashboard.actionItems.overdue), 'bg-negative/10 text-negative']
    : task.status === 'DONE'
      ? [t(i18n.dashboard.taskManager.status.done), 'bg-foreground/[0.08] text-foreground']
      : task.status === 'IN_PROGRESS'
        ? [t(i18n.dashboard.taskManager.status.inProgress), 'bg-foreground/[0.06] text-foreground/80']
        : task.status === 'CANCELLED'
          ? [t(i18n.dashboard.taskManager.status.cancelled), 'bg-foreground/[0.04] text-muted-foreground']
          : [t(i18n.dashboard.taskManager.status.pending), 'bg-foreground/[0.06] text-foreground/80'];

  return <span className={cn('text-meta shrink-0 rounded-full px-2 py-0.5 whitespace-nowrap', tone)}>{label}</span>;
}

export function TasksCard({ tasks, projectId }: { tasks: TaskRow[]; projectId: string }) {
  const t = useTranslations();
  if (tasks.length === 0) return null;

  return (
    <Surface as="section">
      <SurfaceHeader
        title={t(i18n.calls.table.tasks)}
        action={<span className="text-meta text-muted-foreground tabular-nums">{tasks.length}</span>}
      />
      <ul className="-mx-3 space-y-1">
        {tasks.map((task, i) => {
          const meta = [task.responsibleParty && partyLabel(task.responsibleParty, t), task.deadlineMentioned]
            .filter(Boolean)
            .join(' · ');
          const body = (
            <>
              <div className="min-w-0 flex-1">
                <p className="text-body text-foreground leading-snug">{task.description}</p>
                {meta && <p className="text-meta text-muted-foreground mt-0.5">{meta}</p>}
              </div>
              <StatusBadge task={task} />
            </>
          );
          return (
            <li key={task.id ?? i}>
              {task.id ? (
                <Link
                  href={`/${projectId}/tasks?task=${task.id}`}
                  className="hover:bg-foreground/[0.03] flex items-start gap-3 rounded-xl px-3 py-2.5 transition-colors"
                >
                  {body}
                </Link>
              ) : (
                <div className="flex items-start gap-3 px-3 py-2.5">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </Surface>
  );
}

// ─── Details ────────────────────────────────────────────────────────────────

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="text-meta text-muted-foreground shrink-0">{label}</dt>
      <dd className="text-meta text-foreground min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

export function DetailsCard({ call }: { call: CallDetail }) {
  const t = useTranslations();
  const locale = useLocale();
  const format = useFormat();

  // Talk ratio falls back to share of turns when the backend didn't supply stats.
  const totalTurns = call.turns.length || 1;
  const turnCounts = new Map<string, number>();
  call.turns.forEach((turn) => turnCounts.set(turn.speakerId, (turnCounts.get(turn.speakerId) ?? 0) + 1));
  const speakers = call.speakers.length
    ? call.speakers
    : [...turnCounts.keys()].map((id) => ({ speakerId: id }) as CallDetail['speakers'][number]);

  const languageName = (() => {
    // Empty until a result is stored.
    if (!call.language) return '—';
    try {
      const name = new Intl.DisplayNames(locale, { type: 'language' }).of(call.language);
      return name ? name.charAt(0).toLocaleUpperCase(locale) + name.slice(1) : call.language;
    } catch {
      return call.language.toUpperCase();
    }
  })();

  const classification = call.classification;

  return (
    <Surface as="section" pad="none">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-2xl p-5 [&::-webkit-details-marker]:hidden">
          <span className="text-title text-foreground font-medium">{t(i18n.calls.detail.details)}</span>
          <ChevronDown className="text-muted-foreground h-4 w-4 transition-transform group-open:rotate-180" />
        </summary>
        <div className="space-y-5 px-5 pb-5">
          <div>
            <p className="text-muted-foreground mb-2 font-mono text-xs tracking-[0.18em] uppercase">
              {t(i18n.dashboard.transcriptModal.speakers)}
            </p>
            <div className="space-y-1.5">
              {speakers.map((speaker, i) => {
                const turnCount = speaker.turnCount ?? turnCounts.get(speaker.speakerId) ?? 0;
                const ratio = speaker.talkRatio != null ? speaker.talkRatio : turnCount / totalTurns;
                return (
                  <div key={speaker.speakerId} className="flex items-center gap-3 py-1">
                    <span className="text-meta text-foreground w-28 shrink-0 truncate">
                      {speakerLabel(speaker.speakerId, speaker.name, t)}
                    </span>
                    <span className="bg-foreground/[0.06] h-1.5 flex-1 overflow-hidden rounded-full">
                      <span
                        className={cn('block h-full rounded-full', i === 0 ? 'bg-foreground/60' : 'bg-foreground/30')}
                        style={{ width: `${Math.round(ratio * 100)}%` }}
                      />
                    </span>
                    <span className="text-meta text-muted-foreground w-10 shrink-0 text-right tabular-nums">
                      {format.percent(ratio * 100)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <dl>
            <DetailRow label={t(i18n.dashboard.transcriptModal.language)}>{languageName}</DetailRow>
            <DetailRow label={t(i18n.dashboard.transcriptModal.info.filename)}>
              <span className="font-mono" title={call.filename}>
                {call.filename}
              </span>
            </DetailRow>
            <DetailRow label={t(i18n.dashboard.transcriptModal.info.fileSize)}>
              {format.fileSize(call.sizeBytes)}
            </DetailRow>
            {classification && (
              <DetailRow label={t(i18n.dashboard.transcriptModal.category.primaryCategory)}>
                {classification.primary.categoryNames.join(' › ')}
                <span className="text-muted-foreground ml-1.5 tabular-nums">
                  {format.percent(classification.primary.confidence * 100)}
                </span>
              </DetailRow>
            )}
            {classification?.secondary.map((cat) => (
              <DetailRow key={cat.categoryId} label={t(i18n.dashboard.transcriptModal.category.secondaryCategories)}>
                {cat.categoryNames.join(' › ')}
                <span className="text-muted-foreground ml-1.5 tabular-nums">
                  {format.percent(cat.confidence * 100)}
                </span>
              </DetailRow>
            ))}
          </dl>

          {/* The model's own words about its choice, shown as such: not a quote from the call. */}
          {(classification?.primary.explanation || classification?.reasoning) && (
            <div>
              <p className="text-muted-foreground mb-2 font-mono text-xs tracking-[0.18em] uppercase">
                {t(i18n.dashboard.transcriptModal.category.whyThisClassification)}
              </p>
              <p className="text-meta text-foreground/80 leading-relaxed">
                {classification.primary.explanation || classification.reasoning}
              </p>
            </div>
          )}
        </div>
      </details>
    </Surface>
  );
}

// ─── Sentiment ──────────────────────────────────────────────────────────────

// The progression field is free text ("neutral → positive"); map the words back to enum values.
const PROGRESSION_MAP: Record<string, string> = {
  'very positive': 'very_positive',
  positive: 'positive',
  neutral: 'neutral',
  negative: 'negative',
  'very negative': 'very_negative',
};

/** "Neutralny → Negatywny", or null when the backend's free text isn't the two-level shape. */
export function useSentimentProgression(text?: string): string | null {
  const t = useTranslations();
  if (!text) return null;
  const parts = text.toLowerCase().split(/\s*(?:→|->|\bto\b)\s*/);
  if (parts.length !== 2) return null;
  const [from, to] = parts.map((p) => PROGRESSION_MAP[p.trim()]);
  return from && to ? `${sentimentLabel(from, t)} → ${sentimentLabel(to, t)}` : null;
}

// ─── Category override ──────────────────────────────────────────────────────

function flattenForSelect(categories: TaxonomyCategory[], depth = 0): { id: string; name: string; depth: number }[] {
  return categories.flatMap((cat) => [
    { id: cat.id, name: cat.name, depth },
    ...flattenForSelect(cat.children ?? [], depth + 1),
  ]);
}

// Radix treats an empty string as "no selection", so clearing needs a sentinel of its own.
const CLEAR_VALUE = '__none__';

/**
 * Lets someone correct the classifier from the call itself. The classifier is confident, not always
 * right, and its category feeds the analytics — so a wrong one is worth more than a note to self.
 *
 * The taxonomy is fetched when the control is opened rather than with the call: most people reading a
 * transcript never touch this, and the list is only needed once they do.
 */
export function CategoryOverride({
  projectId,
  callId,
  currentCategory,
}: {
  projectId: string;
  callId: string;
  /** The call's category name, so the list opens on it rather than on a blank placeholder. */
  currentCategory?: string | null;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<{ id: string; name: string; depth: number }[] | null>(null);
  const [saving, setSaving] = useState(false);
  // Picking a value closes the list too; only a close without a pick (Esc, click away) closes the editor.
  const picked = useRef(false);
  // A failed save remounts the select, so picking the same category again still fires.
  const [attempt, setAttempt] = useState(0);

  const openEditor = async () => {
    picked.current = false;
    setOpen(true);
    if (options) return;
    try {
      setOptions(flattenForSelect(await getTaxonomy(projectId)));
    } catch {
      toast.error(t(i18n.dashboard.transcriptModal.category.loadFailed));
      setOpen(false);
    }
  };

  const save = async (value: string) => {
    picked.current = true;
    setSaving(true);
    try {
      unwrap(await setCallCategory(projectId, callId, value === CLEAR_VALUE ? null : value));
      toast.success(t(i18n.dashboard.transcriptModal.category.changeSaved));
      setOpen(false);
      router.refresh();
    } catch (e) {
      // The select stays on screen so the change can be tried again.
      picked.current = false;
      setAttempt((n) => n + 1);
      toast.error(backendMessage(e) ?? t(i18n.dashboard.transcriptModal.category.changeFailed));
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={openEditor}
        className="text-meta text-muted-foreground hover:text-foreground inline-flex items-center gap-1 transition-colors"
      >
        <Pencil className="h-3 w-3" />
        {t(i18n.dashboard.transcriptModal.category.change)}
      </button>
    );
  }

  return (
    // Opens as soon as the categories arrive: the reader already clicked "Zmień" once.
    <Select
      key={options === null ? 'loading' : `ready-${attempt}`}
      defaultOpen={options !== null}
      defaultValue={options?.find((o) => o.name === currentCategory)?.id ?? (currentCategory ? undefined : CLEAR_VALUE)}
      disabled={saving || options === null}
      onValueChange={save}
      onOpenChange={(next) => !next && !picked.current && setOpen(false)}
    >
      <SelectTrigger className="text-meta h-8 w-full">
        <SelectValue placeholder={t(i18n.dashboard.transcriptModal.category.selectCategory)} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={CLEAR_VALUE}>{t(i18n.dashboard.transcriptModal.category.noCategory)}</SelectItem>
        {(options ?? []).map((cat) => (
          <SelectItem key={cat.id} value={cat.id}>
            {'—'.repeat(cat.depth)} {cat.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
