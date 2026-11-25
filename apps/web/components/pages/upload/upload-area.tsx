'use client';

import { CloudUpload, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import React, { useState } from 'react';

import { ACCEPTED_EXTENSIONS, MAX_UPLOAD_BYTES } from '@/components/pages/upload/upload-utils';
import { Surface } from '@/components/ui/surface';
import { i18n } from '@/i18n/constants';
import { useFormat } from '@/lib/format';
import { cn } from '@/lib/utils/cn';

interface UploadAreaProps {
  onFilesSelected: (files: File[]) => void;
  /** Files are already queued: shrink to a one-line "add more" strip. */
  compact: boolean;
}

export function UploadArea({ onFilesSelected, compact }: UploadAreaProps) {
  const t = useTranslations();
  const format = useFormat();
  const [dragActive, setDragActive] = useState(false);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true);
    else if (e.type === 'dragleave') setDragActive(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    // Drops bypass the input's `accept`, so filter them the same way the picker does.
    const accepted = Array.from(e.dataTransfer.files).filter((file) =>
      ACCEPTED_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext))
    );
    if (accepted[0]) onFilesSelected(accepted);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.preventDefault();
    if (e.target.files && e.target.files[0]) onFilesSelected(Array.from(e.target.files));
    // Clear so picking the same file again still fires onChange.
    e.target.value = '';
  };

  const limits = t(i18n.upload.area.limits, {
    formats: ACCEPTED_EXTENSIONS.map((ext) => ext.slice(1).toUpperCase()).join(', '),
    size: format.fileSize(MAX_UPLOAD_BYTES),
  });

  return (
    <Surface
      pad="none"
      className="focus-within:ring-ring/50 relative p-2 focus-within:ring-2"
      onDragEnter={handleDrag}
      onDragLeave={handleDrag}
      onDragOver={handleDrag}
      onDrop={handleDrop}
    >
      {/* The whole surface is the picker: an invisible input stretched over it. */}
      <input
        type="file"
        multiple
        accept={ACCEPTED_EXTENSIONS.join(',')}
        onChange={handleChange}
        aria-label={t(i18n.upload.area.chooseRecordings)}
        className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
      />

      {/* The dashed outline is the drop target; it turns coral while a file is dragged over it. */}
      <div
        className={cn(
          'rounded-xl border border-dashed transition-colors',
          dragActive ? 'border-brand-coral/60 bg-brand-coral/[0.06]' : 'border-foreground/15 hover:bg-foreground/[0.02]'
        )}
      >
        {compact ? (
          <div className="flex h-14 items-center gap-3 px-4">
            <Plus className="text-muted-foreground size-4 shrink-0" aria-hidden />
            <span className="text-body text-foreground font-medium">
              {dragActive ? t(i18n.upload.dropToUpload) : t(i18n.upload.area.addMore)}
            </span>
            <span className="text-meta text-muted-foreground ml-auto hidden truncate sm:block">{limits}</span>
          </div>
        ) : (
          <div className="flex min-h-[240px] flex-col items-center justify-center gap-5 px-6 py-10 text-center md:min-h-[calc(100dvh-17rem)]">
            <span className="bg-foreground/[0.05] text-muted-foreground flex size-14 items-center justify-center rounded-2xl">
              <CloudUpload className="size-7" strokeWidth={1.5} aria-hidden />
            </span>
            <div>
              {/* Touch screens can't drag files in, so they get the picker wording instead. */}
              <p className="text-title text-foreground font-medium">
                <span className="pointer-coarse:hidden">
                  {dragActive ? t(i18n.upload.dropToUpload) : t(i18n.upload.area.dragAndDrop)}
                </span>
                <span className="hidden pointer-coarse:inline">{t(i18n.upload.area.chooseRecordings)}</span>
              </p>
              <p className="text-meta text-muted-foreground mt-1.5">{limits}</p>
            </div>
            {/* Looks like the primary button; the click itself lands on the input above. */}
            <span className="text-body bg-brand-coral inline-flex h-10 items-center rounded-lg px-5 font-medium text-white">
              {t(i18n.upload.area.browseFiles)}
            </span>
          </div>
        )}
      </div>
    </Surface>
  );
}
