'use client';

import { ArrowRight, CircleCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';

import { UploadArea } from '@/components/pages/upload/upload-area';
import { UploadHeader } from '@/components/pages/upload/upload-header';
import { UploadQueue } from '@/components/pages/upload/upload-queue';
import { MAX_UPLOAD_BYTES } from '@/components/pages/upload/upload-utils';
import { PageContainer } from '@/components/shared/page-container';
import { Button } from '@/components/ui/button';
import { Surface } from '@/components/ui/surface';
import { i18n } from '@/i18n/constants';
import type { SpeakerPreset } from '@/lib/types';
import { ChannelRoles, parsePresetSpeakers, speakersToChannelRoles } from '@/lib/utils/channel-roles';

// One POST per file to /api/upload: the body is the file itself, and the name, project and channel
// labels travel in percent-encoded headers (the route says why it is not a form). XHR rather than
// fetch for the upload progress events. Resolves with the server's sentence on a refusal, and with
// null for the message when the request itself failed.
function postFile(
  projectId: string,
  file: File,
  channelRoles: ChannelRoles | undefined,
  onProgress: (fraction: number) => void
) {
  return new Promise<{ ok: true } | { ok: false; message: string | null }>((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Aftertalk-Project', projectId);
    xhr.setRequestHeader('X-Aftertalk-Filename', encodeURIComponent(file.name));
    if (channelRoles?.channel_0 && channelRoles?.channel_1) {
      xhr.setRequestHeader('X-Aftertalk-Channel-0', encodeURIComponent(channelRoles.channel_0));
      xhr.setRequestHeader('X-Aftertalk-Channel-1', encodeURIComponent(channelRoles.channel_1));
    }
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve({ ok: true });
      let message: string | null = null;
      try {
        const body = JSON.parse(xhr.responseText) as { error?: unknown };
        // 4xx answers carry a translated sentence written for the uploader.
        if (xhr.status >= 400 && xhr.status < 500 && typeof body.error === 'string') message = body.error;
      } catch {
        // Not JSON: a proxy's error page. The generic message below covers it.
      }
      resolve({ ok: false, message });
    };
    xhr.onerror = xhr.onabort = () => resolve({ ok: false, message: null });
    xhr.send(file);
  });
}

export interface StagedFile {
  id: string;
  name: string;
  size: number;
  status: 'staged' | 'uploading' | 'processing' | 'completed' | 'error';
  progress: number;
  error?: string;
  file: File;
  channelRoles?: ChannelRoles;
}

interface UploadProps {
  presets: SpeakerPreset[];
  projectId: string;
  projectName?: string;
}

export function Upload({ presets, projectId, projectName }: UploadProps) {
  const [files, setFiles] = useState<StagedFile[]>([]);
  const router = useRouter();
  const t = useTranslations();
  // Which file of the running batch is going up, for "Uploading 2 of 5…".
  const [batch, setBatch] = useState<{ current: number; total: number } | null>(null);

  const defaultPreset = useMemo(() => presets.find((p) => p.isDefault), [presets]);

  const handleFiles = (fileList: File[]) => {
    const defaultChannelRoles = defaultPreset
      ? speakersToChannelRoles(parsePresetSpeakers(defaultPreset.speakers).map((s) => s.label))
      : undefined;

    const newFiles: StagedFile[] = fileList.map((file) => ({
      id: Math.random().toString(36).slice(2, 11),
      name: file.name,
      size: file.size,
      status: file.size > MAX_UPLOAD_BYTES ? 'error' : 'staged',
      error: file.size > MAX_UPLOAD_BYTES ? t(i18n.upload.errors.tooLarge) : undefined,
      progress: 0,
      file,
      channelRoles: defaultChannelRoles,
    }));
    setFiles((prev) => [...prev, ...newFiles]);
  };

  const updateFileChannelRoles = (fileId: string, channelRoles: ChannelRoles | undefined) => {
    setFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, channelRoles } : f)));
  };

  // The batch bar: one choice written to every file that hasn't gone up yet.
  const applyToAll = (update: Pick<StagedFile, 'channelRoles'>) => {
    setFiles((prev) => prev.map((f) => (f.status === 'staged' ? { ...f, ...update } : f)));
  };

  const removeFile = (fileId: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== fileId));
  };

  const uploadFile = async (stagedFile: StagedFile) => {
    const fileId = stagedFile.id;
    const patch = (update: Partial<StagedFile>) =>
      setFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, ...update } : f)));

    patch({ status: 'uploading', progress: 5, error: undefined });
    const result = await postFile(projectId, stagedFile.file, stagedFile.channelRoles, (p) => {
      // The last few percent are the server checking and storing the file.
      if (p >= 1) patch({ status: 'processing', progress: 95 });
      else patch({ progress: 5 + Math.round(p * 85) });
    });
    if (!result.ok) {
      patch({ status: 'error', error: result.message ?? t(i18n.upload.errors.uploadFailed), progress: 0 });
      return;
    }
    patch({ status: 'completed', progress: 100 });
    router.refresh();
  };

  const startUpload = async () => {
    const stagedFiles = files.filter((f) => f.status === 'staged');
    for (const [index, file] of stagedFiles.entries()) {
      setBatch({ current: index + 1, total: stagedFiles.length });
      await uploadFile(file);
    }
    setBatch(null);
  };

  const hasStagedFiles = files.some((f) => f.status === 'staged');
  const isUploading = batch !== null || files.some((f) => f.status === 'uploading' || f.status === 'processing');
  const completedCount = files.filter((f) => f.status === 'completed').length;
  const failedCount = files.filter((f) => f.status === 'error').length;
  const isDone = completedCount > 0 && !isUploading && !hasStagedFiles;

  // Closing the tab mid-upload abandons the files still in flight, so ask first.
  useEffect(() => {
    if (!isUploading) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [isUploading]);

  return (
    <PageContainer>
      <UploadHeader eyebrow={projectName} />

      {isDone && (
        <Surface className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <CircleCheck className="text-foreground size-5 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-body text-foreground">{t(i18n.upload.summary.done, { count: completedCount })}</p>
            {failedCount > 0 && (
              <p className="text-meta text-muted-foreground mt-0.5">
                {t(i18n.upload.summary.failed, { count: failedCount })}
              </p>
            )}
          </div>
          <Button asChild className="shrink-0">
            <Link href={`/${projectId}/calls`}>
              {t(i18n.upload.summary.goToCalls)}
              <ArrowRight />
            </Link>
          </Button>
        </Surface>
      )}

      <UploadArea compact={files.length > 0} onFilesSelected={handleFiles} />

      {files.length > 0 && (
        <UploadQueue
          files={files}
          presets={presets}
          onRemoveFile={removeFile}
          onUpdateChannelRoles={updateFileChannelRoles}
          onApplyToAll={applyToAll}
          onStartUpload={startUpload}
          batch={batch}
          isUploading={isUploading}
        />
      )}
    </PageContainer>
  );
}
