'use client';

import { CalendarClock, Check, RotateCcw, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

import { stripExtension, useCallLabels } from '@/components/pages/calls/call-labels';
import { Checkbox } from '@/components/ui/checkbox';
import { i18n } from '@/i18n/constants';
import type { ActionItem, ActionItemStatus } from '@/lib/types';
import { partyLabel } from '@/lib/utils/analysis-labels';
import { cn } from '@/lib/utils/cn';

const THRESHOLD = 84;
const MAX_DRAG = 180;
// Horizontal travel before a touch counts as a swipe rather than a tap.
const SLOP = 8;

interface TaskRowProps {
  item: ActionItem;
  canEdit: boolean;
  isSelected: boolean;
  onOpen: () => void;
  onSetStatus: (status: ActionItemStatus) => void;
}

export function TaskRow({ item, canEdit, isSelected, onOpen, onSetStatus }: TaskRowProps) {
  const t = useTranslations();
  const callLabels = useCallLabels();
  const fgRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const drag = useRef({ startX: 0, dx: 0, dragging: false, moved: false });
  // A swipe or a tap that dismisses the latched confirm must not also open the task.
  const suppressClick = useRef(false);
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [latchOffset, setLatchOffset] = useState(0);

  const isDone = item.status === 'DONE';
  const isCancelled = item.status === 'CANCELLED';
  const isMuted = isDone || isCancelled;

  // Touch only: right swipe completes (or reopens if already resolved); left swipe cancels
  // (or reopens a cancelled task). Left is destructive, so it latches for confirm.
  const rightReopens = isDone || isCancelled;
  const leftReopens = isCancelled;

  const unlatch = () => {
    setConfirming(false);
    setDx(0);
  };

  // Dismiss the latched confirm when tapping anywhere outside this row.
  useEffect(() => {
    if (!confirming) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) unlatch();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [confirming]);

  const handlePointerDown = (e: React.PointerEvent) => {
    suppressClick.current = confirming;
    if (confirming) {
      unlatch();
      return;
    }
    if (e.pointerType !== 'touch') return;
    drag.current = { startX: e.clientX, dx: 0, dragging: true, moved: false };
    setDragging(true);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!drag.current.dragging) return;
    const raw = e.clientX - drag.current.startX;
    if (!drag.current.moved) {
      if (Math.abs(raw) <= SLOP) return;
      drag.current.moved = true;
      // Capture only once it's a swipe, so a plain tap still lands on the row's button as a click.
      try {
        fgRef.current?.setPointerCapture(e.pointerId);
      } catch {
        // pointer capture is best-effort
      }
    }
    const clamped = Math.max(-MAX_DRAG, Math.min(raw, MAX_DRAG));
    drag.current.dx = clamped;
    setDx(clamped);
  };

  const endDrag = () => {
    if (!drag.current.dragging) return;
    const { dx: finalDx, moved } = drag.current;
    drag.current.dragging = false;
    setDragging(false);
    if (moved) suppressClick.current = true;

    const committed = Math.abs(finalDx) >= THRESHOLD;
    const left = finalDx < 0;

    if (committed && !left) {
      setDx(0);
      onSetStatus(rightReopens ? 'PENDING' : 'DONE');
    } else if (committed && left) {
      const confW = confirmRef.current?.offsetWidth ?? 120;
      const rowW = rootRef.current?.offsetWidth ?? 320;
      setLatchOffset(Math.min(confW + 28, rowW - 36));
      setConfirming(true);
    } else {
      setDx(0);
    }
  };

  const handleClick = (e: React.MouseEvent) => {
    // detail === 0 is a keyboard press (Enter / Space), which always opens.
    if (suppressClick.current && e.detail !== 0) {
      suppressClick.current = false;
      return;
    }
    onOpen();
  };

  const commitConfirm = () => {
    onSetStatus(leftReopens ? 'PENDING' : 'CANCELLED');
    unlatch();
  };

  const translateX = confirming ? -latchOffset : dx;
  const progress = Math.min(1, Math.abs(dx) / THRESHOLD);
  const swipingLeft = dx < 0;
  const idle = !dragging && dx === 0 && !confirming;

  // Which action the sliding row reveals underneath.
  const rightAction = rightReopens
    ? { label: t(i18n.dashboard.taskManager.reopen), icon: RotateCcw, bg: 'bg-neutral-tone' }
    : { label: t(i18n.dashboard.taskManager.status.done), icon: Check, bg: 'bg-foreground/60' };
  const leftAction = leftReopens
    ? { label: t(i18n.dashboard.taskManager.reopen), icon: RotateCcw, bg: 'bg-neutral-tone' }
    : { label: t(i18n.dashboard.taskManager.cancelTask), icon: X, bg: 'bg-negative' };
  const action = swipingLeft || confirming ? leftAction : rightAction;
  const ActionIcon = action.icon;

  const statusBadge =
    item.status === 'IN_PROGRESS'
      ? t(i18n.dashboard.taskManager.status.inProgress)
      : isCancelled
        ? t(i18n.dashboard.taskManager.status.cancelled)
        : null;

  return (
    <div ref={rootRef} className="relative overflow-hidden">
      {/* Action revealed behind the row while swiping / latched (touch only) */}
      <div
        aria-hidden={!confirming}
        className={cn(
          'absolute inset-0 flex items-center gap-2.5 px-4 text-xs font-bold text-white transition-opacity',
          action.bg,
          swipingLeft || confirming ? 'justify-end' : 'justify-start',
          idle && 'opacity-0'
        )}
      >
        {confirming ? (
          <div ref={confirmRef} className="flex items-center gap-2.5">
            <button
              type="button"
              aria-label={t(i18n.dashboard.taskManager.keep)}
              onClick={unlatch}
              className="flex h-7 w-7 items-center justify-center rounded-md bg-white/20"
            >
              <X className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={commitConfirm}
              className={cn(
                'rounded-md bg-white px-3 py-2 text-xs font-bold',
                leftReopens ? 'text-foreground' : 'text-negative'
              )}
            >
              {leftReopens ? t(i18n.dashboard.taskManager.reopen) : t(i18n.dashboard.taskManager.cancelTask)}
            </button>
          </div>
        ) : (
          <span
            className="flex items-center gap-2.5"
            style={{ opacity: progress, transform: `scale(${0.7 + 0.3 * progress})` }}
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/25">
              <ActionIcon className="h-3.5 w-3.5" />
            </span>
            {action.label}
          </span>
        )}
      </div>

      {/* Foreground: completion checkbox + the row's open button */}
      <div
        ref={fgRef}
        onPointerDown={canEdit ? handlePointerDown : undefined}
        onPointerMove={canEdit ? handlePointerMove : undefined}
        onPointerUp={canEdit ? endDrag : undefined}
        onPointerCancel={canEdit ? endDrag : undefined}
        style={{ transform: `translateX(${translateX}px)`, touchAction: 'pan-y' }}
        className={cn(
          'relative z-10 flex items-start gap-3 px-4 py-3.5',
          !dragging && 'transition-transform duration-200 ease-out',
          // Idle rows are transparent so the surface shows through; while swiping/latched the row must
          // be opaque to cover the action revealed behind it.
          idle
            ? isSelected
              ? 'lg:bg-black/[0.035] lg:dark:bg-white/[0.05]'
              : 'hover:bg-black/[0.02] dark:hover:bg-white/[0.03]'
            : 'bg-white dark:bg-[#111]'
        )}
      >
        {canEdit && (
          <Checkbox
            checked={isDone}
            onCheckedChange={(checked) => onSetStatus(checked === true ? 'DONE' : 'PENDING')}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label={t(isDone ? i18n.dashboard.taskManager.markPendingFor : i18n.dashboard.taskManager.markDoneFor, {
              task: item.description,
            })}
            className="data-[state=checked]:border-foreground/60 data-[state=checked]:bg-foreground/60 mt-[3px] size-[18px] rounded-full border-black/25 shadow-none data-[state=checked]:text-white dark:border-white/25 [&_svg]:size-3"
          />
        )}

        <button
          type="button"
          onClick={handleClick}
          data-task-id={item.id}
          aria-current={isSelected ? 'true' : undefined}
          className="focus-visible:outline-ring flex min-w-0 flex-1 items-start gap-3 rounded-md text-left select-none focus-visible:outline-2 focus-visible:outline-offset-4"
        >
          <span className="min-w-0 flex-1">
            {/* Not cn(): tailwind-merge reads text-body as a colour and would drop it next to text-foreground. */}
            <span className={`text-body block ${isMuted ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
              {item.description}
            </span>
            <span className="text-meta text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              {/* Tasks only carry the call's filename; a title would need the backend to send it. */}
              <span className="max-w-[220px] truncate" title={item.callFilename}>
                {stripExtension(item.callFilename)}
              </span>
              <span className="whitespace-nowrap">{callLabels.day(item.callDate)}</span>
              {item.responsibleParty && <span>{partyLabel(item.responsibleParty, t)}</span>}
              {item.deadlineMentioned && (
                <span className="flex items-center gap-1">
                  <CalendarClock className="size-3.5" aria-hidden />
                  {item.deadlineMentioned}
                </span>
              )}
              {statusBadge && (
                <span className="text-foreground/80 rounded-full bg-black/[0.05] px-2 py-px text-xs font-medium dark:bg-white/[0.08]">
                  {statusBadge}
                </span>
              )}
              {item.isOverdue && !isMuted && (
                <span className="bg-negative/10 text-negative rounded-full px-2 py-px text-xs font-medium">
                  {t(i18n.dashboard.taskManager.overdue)}
                </span>
              )}
            </span>
          </span>

          {item.priority !== 'LOW' && (
            <span
              className={cn(
                'mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-xs font-medium',
                item.priority === 'HIGH'
                  ? 'text-foreground bg-black/[0.07] dark:bg-white/[0.1]'
                  : 'text-muted-foreground bg-black/[0.035] dark:bg-white/[0.05]'
              )}
            >
              {t(
                item.priority === 'HIGH'
                  ? i18n.dashboard.taskManager.priority.high
                  : i18n.dashboard.taskManager.priority.medium
              )}
            </span>
          )}
        </button>
      </div>
    </div>
  );
}
