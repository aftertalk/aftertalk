'use client';

import { useTranslations } from 'next-intl';

import { i18n } from '@/i18n/constants';
import type { Call, CallStatus } from '@/lib/types';
import { cn } from '@/lib/utils/cn';
import { LANGUAGE_KEYS, type UploadLanguage } from '@/lib/utils/upload-language';

// The status of a call as the lists and the call page show it (item 54): one badge with five values,
// "Failed: {reason}" and a note when a later run is queued, running or failed. The cloud showed no
// status, so all of this is new. The badge and the reason sit side by side: "Failed" + the sentence.

const STATUS_KEY: Record<CallStatus, string> = {
  queued: i18n.calls.status.queued,
  processing: i18n.calls.status.processing,
  completed: i18n.calls.status.completed,
  completed_with_errors: i18n.calls.status.completedWithErrors,
  failed: i18n.calls.status.failed,
};

// Neutral for in-flight states and for done, the negative token only where something went wrong.
const STATUS_TONE: Record<CallStatus, string> = {
  queued: 'bg-foreground/[0.06] text-foreground/70',
  processing: 'bg-foreground/[0.06] text-foreground/70',
  completed: 'bg-foreground/[0.08] text-foreground',
  completed_with_errors: 'bg-negative/10 text-negative',
  failed: 'bg-negative/10 text-negative',
};

/** Error code → a sentence a person can act on. Codes this version does not know get the generic one. */
export function useJobErrorSentence() {
  const t = useTranslations();
  const known = i18n.jobErrors as Record<string, string>;
  return (code: string | null | undefined, detectedLanguage?: string | null): string => {
    if (code === 'language_not_allowed' && detectedLanguage && detectedLanguage in LANGUAGE_KEYS) {
      return t(i18n.jobErrors.language_not_allowed_detected, {
        language: t(LANGUAGE_KEYS[detectedLanguage as UploadLanguage]),
      });
    }
    return t(code && code in known && code !== 'language_not_allowed_detected' ? known[code] : i18n.jobErrors.unknown);
  };
}

type StatusFields = Pick<Call, 'status' | 'failedReason' | 'detectedLanguage' | 'laterRun'>;

export function CallStatusBadge({ call, className }: { call: StatusFields; className?: string }) {
  const t = useTranslations();
  return (
    <span
      className={cn(
        'text-meta shrink-0 rounded-full px-2 py-0.5 font-medium whitespace-nowrap',
        STATUS_TONE[call.status],
        className
      )}
    >
      {t(STATUS_KEY[call.status])}
    </span>
  );
}

/**
 * The sentence under the badge: why a call failed, or what a later run is doing. null when there is
 * nothing to add (a call that is simply queued, processing or completed).
 */
export function useCallStatusNote() {
  const t = useTranslations();
  const sentence = useJobErrorSentence();
  return (call: StatusFields): string | null => {
    if (call.status === 'failed') {
      // The badge beside it already says "Failed".
      return sentence(call.failedReason, call.detectedLanguage);
    }
    if (call.laterRun?.status === 'queued') return t(i18n.calls.status.laterQueued);
    if (call.laterRun?.status === 'processing') return t(i18n.calls.status.laterProcessing);
    if (call.laterRun?.status === 'failed') {
      return t(i18n.calls.status.laterFailed, { reason: sentence(call.laterRun.errorCode, call.detectedLanguage) });
    }
    return null;
  };
}

/** Badge plus note, for a list row. A completed call with nothing to add renders nothing. */
export function CallStatusLine({ call, className }: { call: StatusFields; className?: string }) {
  const note = useCallStatusNote()(call);
  if (call.status === 'completed' && !note) return null;
  return (
    <span className={cn('flex min-w-0 items-center gap-2', className)}>
      {call.status !== 'completed' && <CallStatusBadge call={call} />}
      {note && (
        <span
          className={cn(
            'text-meta min-w-0 truncate',
            call.status === 'failed' ? 'text-negative' : 'text-muted-foreground'
          )}
          title={note}
        >
          {note}
        </span>
      )}
    </span>
  );
}
