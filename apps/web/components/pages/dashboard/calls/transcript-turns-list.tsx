'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useMemo } from 'react';

import { i18n } from '@/i18n/constants';
import { useFormat } from '@/lib/format';
import type { Speaker, Turn } from '@/lib/types';
import { speakerLabel } from '@/lib/utils/analysis-labels';
import { cn } from '@/lib/utils/cn';

export const turnDomId = (index: number) => `turn-${index}`;

const CUSTOMER_IDS = new Set(['customer', 'klient', 'client']);
const AGENT_IDS = new Set(['agent', 'konsultant', 'consultant']);

/**
 * Which speakers are the customer, so their turns get the soft fill. Role names say so when the call
 * was uploaded with them; failing that, everyone but the first voice, so the two sides still read apart.
 */
function customerSpeakers(turns: Turn[], names: Map<string, string | undefined>): Set<string> {
  const ids = [...new Set(turns.map((turn) => turn.speakerId))];
  const is = (set: Set<string>, id: string) =>
    set.has(id.toLowerCase()) || set.has((names.get(id) ?? '').toLowerCase());

  const customers = ids.filter((id) => is(CUSTOMER_IDS, id));
  if (customers.length) return new Set(customers);
  const agents = ids.filter((id) => is(AGENT_IDS, id));
  if (agents.length) return new Set(ids.filter((id) => !agents.includes(id)));
  return new Set(ids.slice(1));
}

interface TranscriptTurnsListProps {
  turns: Turn[];
  speakers: Speaker[];
  /** The turn playing now, -1 for none. */
  activeIndex: number;
  isPlaying: boolean;
  /** Plays from a turn's start; left out when there's no audio to play. */
  onSeek?: (seconds: number) => void;
}

export function TranscriptTurnsList({ turns, speakers, activeIndex, isPlaying, onSeek }: TranscriptTurnsListProps) {
  const t = useTranslations();
  const format = useFormat();

  const names = useMemo(() => new Map(speakers.map((s) => [s.speakerId, s.name])), [speakers]);
  const customers = useMemo(() => customerSpeakers(turns, names), [turns, names]);
  const firstSpeaker = turns[0]?.speakerId;

  // Follow the audio: pull the playing turn into view, but only while playing so
  // it never fights the reader when they scroll on their own.
  useEffect(() => {
    if (!isPlaying || activeIndex < 0) return;
    document.getElementById(turnDomId(activeIndex))?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeIndex, isPlaying]);

  return (
    <div className="space-y-1">
      {turns.map((turn, index) => {
        const isActive = index === activeIndex;
        const isCustomer = customers.has(turn.speakerId);
        const showSpeaker = index === 0 || turns[index - 1].speakerId !== turn.speakerId;
        const label = speakerLabel(turn.speakerId, names.get(turn.speakerId), t);
        const time = format.clock(turn.startMs / 1000);

        return (
          <div
            key={index}
            id={turnDomId(index)}
            data-active={isActive}
            className={cn(
              // Scroll margins keep a turn clear of the sticky player (top on desktop, bottom on mobile).
              'grid scroll-mt-40 scroll-mb-28 grid-cols-1 gap-1 rounded-xl px-4 py-3 transition-colors sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:gap-4',
              isCustomer && 'bg-black/[0.02] dark:bg-white/[0.03]',
              isActive && 'bg-black/[0.045] dark:bg-white/[0.06]'
            )}
          >
            <div className="flex min-w-0 flex-row items-baseline gap-2 sm:flex-col sm:items-start sm:gap-0.5 sm:pt-0.5">
              {showSpeaker && (
                <span
                  title={label}
                  className={cn(
                    'max-w-full truncate font-mono text-xs tracking-[0.12em] uppercase',
                    turn.speakerId === firstSpeaker ? 'text-foreground/70' : 'text-muted-foreground'
                  )}
                >
                  {label}
                </span>
              )}
              {onSeek ? (
                <button
                  type="button"
                  onClick={() => onSeek(turn.startMs / 1000)}
                  aria-label={t(i18n.calls.detail.playFrom, { time })}
                  className={cn(
                    'text-meta -mx-1 rounded px-1 font-mono tabular-nums transition-colors',
                    isActive ? 'text-foreground' : 'text-muted-foreground/70 hover:text-foreground'
                  )}
                >
                  {time}
                </button>
              ) : (
                <span className="text-meta text-muted-foreground/70 font-mono tabular-nums">{time}</span>
              )}
            </div>
            <p className="text-body text-foreground/90 max-w-[68ch]">{turn.text}</p>
          </div>
        );
      })}
    </div>
  );
}
