'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

import type { CallDetail } from '@/lib/types';

interface TranscriptDetailsModalProps {
  transcript: CallDetail | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}

/**
 * Interim: a call is a page now (/{projectId}/calls/{callId}). Callers that still "open the modal"
 * are sent there instead. Remove once nothing imports this; link to the call page directly.
 */
export function TranscriptDetailsModal({ transcript, open, onOpenChange, projectId }: TranscriptDetailsModalProps) {
  const router = useRouter();

  useEffect(() => {
    if (!open || !transcript) return;
    onOpenChange(false);
    router.push(`/${projectId}/calls/${transcript.id}`);
  }, [open, transcript, onOpenChange, projectId, router]);

  return null;
}
