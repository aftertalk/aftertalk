'use client';

import { FileAudio, Loader2, Upload as UploadIcon, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { StagedFile } from '@/components/pages/upload/upload';
import { STATUS_CHIP, STATUS_KEYS } from '@/components/pages/upload/upload-utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Surface } from '@/components/ui/surface';
import { i18n } from '@/i18n/constants';
import { useFormat } from '@/lib/format';
import type { SpeakerPreset } from '@/lib/types';
import {
  ChannelRoles,
  channelRolesToSpeakers,
  parsePresetSpeakers,
  speakersToChannelRoles,
} from '@/lib/utils/channel-roles';
import { cn } from '@/lib/utils/cn';

type BatchUpdate = Pick<StagedFile, 'channelRoles'>;

interface UploadQueueProps {
  files: StagedFile[];
  presets: SpeakerPreset[];
  onRemoveFile: (fileId: string) => void;
  onUpdateChannelRoles: (fileId: string, channelRoles: ChannelRoles | undefined) => void;
  /** The batch bar: writes one choice to every file that hasn't gone up yet. */
  onApplyToAll: (update: BatchUpdate) => void;
  onStartUpload: () => void;
  /** Which file of the running batch is going up; null when no batch is running. */
  batch: { current: number; total: number } | null;
  isUploading: boolean;
}

const CUSTOM_VALUE = '__custom__';

// An empty Select value shows the placeholder, which the batch bar uses for "files differ".
const MIXED_VALUE = '';

const isEditable = (f: StagedFile) => f.status === 'staged';

const presetRoles = (preset: SpeakerPreset) =>
  speakersToChannelRoles(parsePresetSpeakers(preset.speakers).map((s) => s.label));

/** The preset these roles came from, CUSTOM_VALUE when typed by hand, '' when none were set. */
function rolesValue(presets: SpeakerPreset[], channelRoles: ChannelRoles | undefined): string {
  if (!channelRoles) return '';
  const speakers = channelRolesToSpeakers(channelRoles);
  const match = presets.find((p) => {
    const labels = parsePresetSpeakers(p.speakers).map((s) => s.label);
    return labels.length === speakers.length && labels.every((s, i) => s === speakers[i]);
  });
  return match?.id ?? CUSTOM_VALUE;
}

/** The value every file shares, or MIXED_VALUE when they differ. */
const shared = (values: string[]) => (values.every((v) => v === values[0]) ? values[0] : MIXED_VALUE);

export function UploadQueue({
  files,
  presets,
  onRemoveFile,
  onUpdateChannelRoles,
  onApplyToAll,
  onStartUpload,
  batch,
  isUploading,
}: UploadQueueProps) {
  const t = useTranslations();
  const format = useFormat();

  const stagedCount = files.filter((f) => f.status === 'staged').length;
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  const editable = files.filter(isEditable);

  const batchRoles = shared(editable.map((f) => rolesValue(presets, f.channelRoles)));

  return (
    <Surface pad="none">
      <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between md:px-6">
        <div>
          <h2 className="text-title text-foreground font-medium">{t(i18n.upload.queue.title)}</h2>
          <p className="text-meta text-muted-foreground">
            {t(i18n.upload.queue.fileCount, { count: files.length })} · {format.fileSize(totalSize)}
          </p>
        </div>
        {(stagedCount > 0 || batch) && (
          <Button onClick={onStartUpload} disabled={isUploading} className="shrink-0">
            {batch ? (
              <>
                <Loader2 className="animate-spin" />
                {t(i18n.upload.queue.uploadingProgress, batch)}
              </>
            ) : (
              <>
                <UploadIcon />
                {t(i18n.upload.queue.startUpload, { count: stagedCount })}
              </>
            )}
          </Button>
        )}
      </div>

      {editable.length > 1 && (
        <div className="border-foreground/[0.06] bg-foreground/[0.02] flex flex-wrap items-center gap-2 border-t px-5 py-3 md:px-6">
          <span className="text-meta text-muted-foreground mr-1">{t(i18n.upload.queue.forAll)}</span>
          <RolesSelect
            prefix={t(i18n.upload.queue.channelRoles)}
            value={batchRoles === CUSTOM_VALUE ? MIXED_VALUE : batchRoles}
            presets={presets}
            onChange={(value) => {
              const preset = presets.find((p) => p.id === value);
              if (preset) onApplyToAll({ channelRoles: presetRoles(preset) });
            }}
          />
        </div>
      )}

      <ul className="divide-foreground/[0.06] border-foreground/[0.06] divide-y border-t">
        {files.map((file) => (
          <QueueRow
            key={file.id}
            file={file}
            presets={presets}
            fileSize={format.fileSize(file.size)}
            onRemove={() => onRemoveFile(file.id)}
            onUpdateChannelRoles={(roles) => onUpdateChannelRoles(file.id, roles)}
          />
        ))}
      </ul>
    </Surface>
  );
}

function QueueRow({
  file,
  presets,
  fileSize,
  onRemove,
  onUpdateChannelRoles,
}: {
  file: StagedFile;
  presets: SpeakerPreset[];
  fileSize: string;
  onRemove: () => void;
  onUpdateChannelRoles: (roles: ChannelRoles | undefined) => void;
}) {
  const t = useTranslations();
  const editable = isEditable(file);
  const inFlight = file.status === 'uploading' || file.status === 'processing';
  const roles = rolesValue(presets, file.channelRoles);
  const speakers = file.channelRoles ? channelRolesToSpeakers(file.channelRoles) : [];

  const handleRolesChange = (value: string) => {
    if (value === CUSTOM_VALUE) {
      onUpdateChannelRoles(speakersToChannelRoles(['', '']));
      return;
    }
    const preset = presets.find((p) => p.id === value);
    if (preset) onUpdateChannelRoles(presetRoles(preset));
  };

  const channelLabels = [t(i18n.upload.queue.channel0), t(i18n.upload.queue.channel1)];

  return (
    <li className="px-5 py-4 md:px-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-1 basis-48 items-center gap-3">
          <FileAudio className="text-muted-foreground size-4 shrink-0" aria-hidden />
          <div className="min-w-0">
            <p className="text-body text-foreground truncate">{file.name}</p>
            <p className="text-meta text-muted-foreground tabular-nums">
              {fileSize}
              {inFlight && ` · ${Math.round(file.progress)}%`}
            </p>
          </div>
        </div>

        {file.status !== 'staged' && (
          <span className={cn('text-meta shrink-0 rounded-full px-2 py-px font-medium', STATUS_CHIP[file.status])}>
            {t(STATUS_KEYS[file.status])}
          </span>
        )}

        {editable && (
          <div className="order-last w-full md:order-none md:w-auto">
            <RolesSelect
              value={roles}
              presets={presets}
              onChange={handleRolesChange}
              allowCustom
              className="w-full md:w-44"
              label={t(i18n.upload.queue.channelRoles)}
            />
          </div>
        )}

        {(file.status === 'staged' || file.status === 'error') && (
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground size-8 shrink-0 md:order-last"
            onClick={onRemove}
            aria-label={t(i18n.upload.queue.remove)}
          >
            <X />
          </Button>
        )}
      </div>

      {inFlight && <Progress value={file.progress} className="mt-3 h-1" />}

      {editable && roles === CUSTOM_VALUE && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {speakers.map((speaker, index) => (
            <div key={index} className="space-y-1.5">
              <label htmlFor={`${file.id}-channel-${index}`} className="text-meta text-muted-foreground block">
                {channelLabels[index] ?? t(i18n.upload.queue.speakerLabel, { index })}
              </label>
              <Input
                id={`${file.id}-channel-${index}`}
                value={speaker}
                onChange={(e) =>
                  onUpdateChannelRoles(
                    speakersToChannelRoles(speakers.map((s, i) => (i === index ? e.target.value : s)))
                  )
                }
                placeholder={t(i18n.settings.speakerPresets.speakerPlaceholder)}
                className="h-8"
              />
            </div>
          ))}
        </div>
      )}

      {file.error && <p className="text-meta text-negative mt-2">{file.error}</p>}
    </li>
  );
}

function RolesSelect({
  value,
  presets,
  onChange,
  allowCustom = false,
  prefix,
  label,
  className,
}: {
  value: string;
  presets: SpeakerPreset[];
  onChange: (value: string) => void;
  allowCustom?: boolean;
  prefix?: string;
  label?: string;
  className?: string;
}) {
  const t = useTranslations();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger size="sm" className={cn('text-meta', className)} aria-label={label ?? prefix}>
        {prefix && <span className="text-muted-foreground">{prefix}:</span>}
        <SelectValue placeholder={t(prefix ? i18n.upload.queue.mixed : i18n.upload.queue.selectPreset)} />
      </SelectTrigger>
      <SelectContent>
        {presets.map((preset) => (
          <SelectItem key={preset.id} value={preset.id}>
            {preset.name}
          </SelectItem>
        ))}
        {allowCustom && <SelectItem value={CUSTOM_VALUE}>{t(i18n.upload.queue.customSpeakers)}</SelectItem>}
      </SelectContent>
    </Select>
  );
}
