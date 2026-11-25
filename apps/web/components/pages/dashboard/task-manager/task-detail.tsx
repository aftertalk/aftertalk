'use client';

import { ArrowRight, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';

import { stripExtension, useCallLabels } from '@/components/pages/calls/call-labels';
import { BackLink } from '@/components/shared/back-link';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { i18n } from '@/i18n/constants';
import type { ActionItem, ActionItemPriority, ActionItemStatus } from '@/lib/types';
import { partyLabel } from '@/lib/utils/analysis-labels';
import { cn } from '@/lib/utils/cn';

const STATUS_ORDER: ActionItemStatus[] = ['PENDING', 'IN_PROGRESS', 'DONE', 'CANCELLED'];
const PRIORITY_ORDER: ActionItemPriority[] = ['LOW', 'MEDIUM', 'HIGH'];

const STATUS_DOT: Record<ActionItemStatus, string> = {
  PENDING: 'bg-muted-foreground/40',
  IN_PROGRESS: 'bg-foreground/70',
  DONE: 'bg-foreground/60',
  CANCELLED: 'bg-muted-foreground/20',
};

const STATUS_LABEL_KEYS: Record<ActionItemStatus, string> = {
  PENDING: i18n.dashboard.taskManager.status.pending,
  IN_PROGRESS: i18n.dashboard.taskManager.status.inProgress,
  DONE: i18n.dashboard.taskManager.status.done,
  CANCELLED: i18n.dashboard.taskManager.status.cancelled,
};

const PRIORITY_LABEL_KEYS: Record<ActionItemPriority, string> = {
  LOW: i18n.dashboard.taskManager.priority.low,
  MEDIUM: i18n.dashboard.taskManager.priority.medium,
  HIGH: i18n.dashboard.taskManager.priority.high,
};

// A compact, borderless trigger: the value reads as text in the row and turns into a control on hover.
// The type size sits on a span inside it: cn() (tailwind-merge) reads `text-meta` as a colour and drops it.
const COMPACT_TRIGGER =
  'text-foreground -mr-2 w-auto gap-2 border-0 bg-transparent px-2 shadow-none hover:bg-black/[0.04] dark:bg-transparent dark:hover:bg-white/[0.06]';

interface TaskDetailProps {
  item: ActionItem;
  projectId: string;
  canEdit: boolean;
  onSetStatus: (status: ActionItemStatus) => void;
  onSetPriority: (priority: ActionItemPriority) => void;
  onSaveNotes: (notes: string) => Promise<void>;
  onDelete: () => void;
  onBack?: () => void;
}

export function TaskDetail({
  item,
  projectId,
  canEdit,
  onSetStatus,
  onSetPriority,
  onSaveNotes,
  onDelete,
  onBack,
}: TaskDetailProps) {
  const t = useTranslations();
  const locale = useLocale();
  const callLabels = useCallLabels();
  const [notes, setNotes] = useState(item.notes ?? '');
  const [notesState, setNotesState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // A different task gets a fresh draft through the parent's `key={item.id}`. When the task's own
  // notes change (a save, or a list refresh), reset the draft to them while rendering, which React
  // prefers over doing it in an effect and re-rendering.
  const [syncedNotes, setSyncedNotes] = useState(item.notes);
  if (item.notes !== syncedNotes) {
    setSyncedNotes(item.notes);
    setNotes(item.notes ?? '');
    setNotesState('idle');
  }

  // Rendered into SelectValue explicitly: Radix leaves it empty after a full page load until a re-render.
  const statusValue = (
    <span className="flex items-center gap-2">
      <span className={cn('size-2 rounded-full', STATUS_DOT[item.status])} />
      {t(STATUS_LABEL_KEYS[item.status])}
    </span>
  );
  const priorityValue = t(PRIORITY_LABEL_KEYS[item.priority]);

  const handleNotesBlur = async () => {
    if (notes === (item.notes ?? '')) return;
    setNotesState('saving');
    try {
      await onSaveNotes(notes);
      setNotesState('saved');
      setTimeout(() => setNotesState('idle'), 2000);
    } catch {
      setNotesState('error');
    }
  };

  return (
    <div className="p-5 md:p-6">
      {onBack && (
        <BackLink onClick={onBack} className="mb-4 lg:hidden">
          {t(i18n.dashboard.taskManager.backToList)}
        </BackLink>
      )}

      <div className="flex items-start justify-between gap-3">
        <h2 className="text-title text-foreground font-medium">{item.description}</h2>
        {canEdit && (
          <button
            type="button"
            onClick={onDelete}
            aria-label={t(i18n.dashboard.taskManager.delete)}
            className="text-muted-foreground hover:text-negative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>

      {item.isOverdue && (
        <span className="bg-negative/10 text-negative mt-3 inline-flex rounded-full px-2.5 py-1 text-xs font-medium">
          {t(i18n.dashboard.taskManager.overdue)}
        </span>
      )}

      <dl className="mt-5 divide-y divide-black/[0.05] dark:divide-white/[0.06]">
        <DetailRow label={t(i18n.dashboard.taskManager.statusLabel)}>
          {canEdit ? (
            <Select value={item.status} onValueChange={(v) => onSetStatus(v as ActionItemStatus)}>
              <SelectTrigger
                size="sm"
                className={COMPACT_TRIGGER}
                aria-label={t(i18n.dashboard.taskManager.statusLabel)}
              >
                <span className="text-meta">
                  <SelectValue>{statusValue}</SelectValue>
                </span>
              </SelectTrigger>
              <SelectContent className="z-[70]">
                {STATUS_ORDER.map((s) => (
                  <SelectItem key={s} value={s}>
                    <span className="flex items-center gap-2">
                      <span className={cn('size-2 rounded-full', STATUS_DOT[s])} />
                      {t(STATUS_LABEL_KEYS[s])}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            statusValue
          )}
        </DetailRow>

        <DetailRow label={t(i18n.dashboard.taskManager.priorityHeading)}>
          {canEdit ? (
            <Select value={item.priority} onValueChange={(v) => onSetPriority(v as ActionItemPriority)}>
              <SelectTrigger
                size="sm"
                className={COMPACT_TRIGGER}
                aria-label={t(i18n.dashboard.taskManager.priorityHeading)}
              >
                <span className="text-meta">
                  <SelectValue>{priorityValue}</SelectValue>
                </span>
              </SelectTrigger>
              <SelectContent className="z-[70]">
                {PRIORITY_ORDER.map((p) => (
                  <SelectItem key={p} value={p}>
                    {t(PRIORITY_LABEL_KEYS[p])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            priorityValue
          )}
        </DetailRow>

        {item.responsibleParty && (
          <DetailRow label={t(i18n.dashboard.taskManager.owner)}>{partyLabel(item.responsibleParty, t)}</DetailRow>
        )}

        {item.deadlineMentioned && (
          <DetailRow label={t(i18n.dashboard.taskManager.deadline)}>{item.deadlineMentioned}</DetailRow>
        )}

        <DetailRow label={t(i18n.dashboard.taskManager.sourceCall)}>
          <span className="truncate" title={item.callFilename}>
            {stripExtension(item.callFilename)} · {callLabels.day(item.callDate)}
          </span>
        </DetailRow>
      </dl>

      <Link
        href={`/${projectId}/calls/${item.transcriptId}`}
        className="text-meta text-foreground mt-3 inline-flex items-center gap-1.5 rounded-lg bg-black/[0.04] px-3 py-1.5 font-medium transition-colors hover:bg-black/[0.07] dark:bg-white/[0.06] dark:hover:bg-white/[0.1]"
      >
        {t(i18n.dashboard.taskManager.openCall)}
        <ArrowRight className="size-3.5" aria-hidden />
      </Link>

      {/* The quoted words are the transcript's own (redacted like every page); an unverified claim
          has no words to show, so it gets a label. */}
      {item.quote && (
        <Section label={t(i18n.dashboard.taskManager.evidence)}>
          {item.quote.text ? (
            <blockquote className="text-body text-muted-foreground rounded-xl bg-black/[0.03] px-4 py-3 dark:bg-white/[0.04]">
              {locale === 'pl' ? '\u201e' : '\u201c'}
              {item.quote.text}
              {'\u201d'}
            </blockquote>
          ) : (
            <p className="text-meta text-muted-foreground">{t(i18n.calls.detail.quoteUnverified)}</p>
          )}
        </Section>
      )}

      <Section
        label={
          <span className="flex items-center gap-2">
            {t(i18n.dashboard.taskManager.notes)}
            {notesState === 'saving' && <span className="normal-case">{t(i18n.dashboard.taskManager.saving)}</span>}
            {notesState === 'saved' && <span className="normal-case">{t(i18n.dashboard.taskManager.saved)}</span>}
            {notesState === 'error' && (
              <span className="text-negative normal-case">{t(i18n.dashboard.taskManager.updateFailed)}</span>
            )}
          </span>
        }
      >
        <Textarea
          aria-label={t(i18n.dashboard.taskManager.notes)}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={handleNotesBlur}
          disabled={!canEdit}
          placeholder={t(i18n.dashboard.taskManager.notesPlaceholder)}
          rows={3}
          className="min-h-[84px] resize-none"
        />
      </Section>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-4 py-1.5">
      <dt className="text-meta text-muted-foreground shrink-0">{label}</dt>
      <dd className="text-meta text-foreground flex min-w-0 justify-end text-right">{children}</dd>
    </div>
  );
}

function Section({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mt-7">
      <div className="text-muted-foreground mb-2.5 font-mono text-xs tracking-[0.18em] uppercase">{label}</div>
      {children}
    </div>
  );
}
