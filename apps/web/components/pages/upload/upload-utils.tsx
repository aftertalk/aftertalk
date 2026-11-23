import type { StagedFile } from '@/components/pages/upload/upload';
import { i18n } from '@/i18n/constants';

// The server's limit and formats (lib/upload.ts); checked here first so the uploader hears at once.
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

export const ACCEPTED_EXTENSIONS = ['.wav', '.mp3', '.m4a', '.ogg', '.flac', '.webm'];

// Status chips on the dark app surface: neutral for in-flight states, the sentiment tokens for the outcome.
export const STATUS_CHIP: Record<StagedFile['status'], string> = {
  staged: 'bg-foreground/[0.06] text-foreground/70',
  uploading: 'bg-foreground/[0.06] text-foreground/70',
  processing: 'bg-foreground/[0.06] text-foreground/70',
  completed: 'bg-foreground/[0.08] text-foreground',
  error: 'bg-negative/10 text-negative',
};

export const STATUS_KEYS: Record<StagedFile['status'], string> = {
  staged: i18n.upload.queue.status.staged,
  uploading: i18n.upload.queue.status.uploading,
  processing: i18n.upload.queue.status.processing,
  completed: i18n.upload.queue.status.completed,
  error: i18n.upload.queue.status.error,
};
