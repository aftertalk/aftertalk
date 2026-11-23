'use client';

import { ChevronLeft, ChevronRight, Download, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';

import { BackLink } from '@/components/shared/back-link';
import { ConfirmModal } from '@/components/ui/confirm-modal';
import { i18n } from '@/i18n/constants';
import { deleteTranscript } from '@/lib/action/transcription';
import type { CallDetail } from '@/lib/types';
import { cn } from '@/lib/utils/cn';

export interface CallNeighbours {
  position: number;
  total: number;
  prevHref: string | null;
  nextHref: string | null;
}

interface CallDetailNavProps {
  call: CallDetail;
  projectId: string;
  /** The audio route, or null when this user may not hear the recording (the route would answer 403). */
  audioUrl: string | null;
  backHref: string;
  neighbours: CallNeighbours | null;
}

const ICON_BUTTON =
  'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] flex h-8 w-8 items-center justify-center rounded-full transition-colors';

function StepLink({ href, label, children }: { href: string | null; label: string; children: React.ReactNode }) {
  if (!href) {
    return (
      <span className={cn(ICON_BUTTON, 'pointer-events-none opacity-40')} aria-hidden>
        {children}
      </span>
    );
  }
  return (
    <Link href={href} aria-label={label} title={label} className={ICON_BUTTON}>
      {children}
    </Link>
  );
}

export function CallDetailNav({ call, projectId, audioUrl, backHref, neighbours }: CallDetailNavProps) {
  const t = useTranslations();
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await deleteTranscript(projectId, call.id);
      router.push(backHref);
    } catch {
      toast.error(t(i18n.calls.detail.deleteFailed));
      setIsDeleting(false);
      setConfirmOpen(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-3">
      <BackLink href={backHref}>{t(i18n.calls.detail.back)}</BackLink>

      <div className="flex items-center gap-1">
        {neighbours && (
          <>
            <span className="text-meta text-muted-foreground mr-1 tabular-nums">
              {t(i18n.calls.detail.position, { position: neighbours.position, total: neighbours.total })}
            </span>
            <StepLink href={neighbours.prevHref} label={t(i18n.calls.detail.previous)}>
              <ChevronLeft className="h-4 w-4" />
            </StepLink>
            <StepLink href={neighbours.nextHref} label={t(i18n.calls.detail.next)}>
              <ChevronRight className="h-4 w-4" />
            </StepLink>
          </>
        )}

        {/* Two actions at most, so they sit in the bar rather than behind a "…" that often held one. */}
        {audioUrl && (
          <a
            href={audioUrl}
            download={call.filename}
            className={ICON_BUTTON}
            aria-label={t(i18n.calls.detail.downloadAudio)}
            title={t(i18n.calls.detail.downloadAudio)}
          >
            <Download className="h-4 w-4" />
          </a>
        )}
        {call.canDelete && (
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            className={cn(ICON_BUTTON, 'hover:text-negative')}
            aria-label={t(i18n.calls.table.deleteConfirm.title)}
            title={t(i18n.calls.table.deleteConfirm.title)}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>

      <ConfirmModal
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={handleDelete}
        title={t(i18n.calls.table.deleteConfirm.title)}
        description={t(i18n.calls.table.deleteConfirm.description)}
        confirmText={t(i18n.calls.table.deleteConfirm.title)}
        cancelText={t(i18n.common.cancel)}
        loadingText={t(i18n.common.deleting)}
        variant="destructive"
        isLoading={isDeleting}
        // Deleting is permanent (no bin), so the file name has to be typed.
        confirmPhrase={call.filename}
        confirmPhraseLabel={t(i18n.calls.table.deleteConfirm.typeToConfirm, { name: call.filename })}
      />
    </div>
  );
}
