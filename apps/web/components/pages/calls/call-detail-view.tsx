'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';

import { AudioPlayer, type AudioPlayerHandle } from '@/components/audio-player';
import { CallDetailNav, type CallNeighbours } from '@/components/pages/calls/call-detail-nav';
import { SentimentDot, stripExtension, useCallLabels } from '@/components/pages/calls/call-labels';
import { AccessLogCard, StepsCard } from '@/components/pages/calls/call-run-cards';
import { CallStatusBadge, useCallStatusNote, useJobErrorSentence } from '@/components/pages/calls/call-status';
import {
  CategoryOverride,
  DetailsCard,
  isOpenTask,
  type QuoteJump,
  Scorecard,
  SummaryCard,
  type TaskRow,
  TasksCard,
  useSentimentProgression,
} from '@/components/pages/dashboard/calls/transcript-insights';
import { TranscriptTurnsList, turnDomId } from '@/components/pages/dashboard/calls/transcript-turns-list';
import { PageContainer } from '@/components/shared/page-container';
import { PageHeader } from '@/components/shared/page-header';
import { Surface } from '@/components/ui/surface';
import { Switch } from '@/components/ui/switch';
import { TAB_LIST_CLASS, TAB_TRIGGER_CLASS } from '@/components/ui/tabs';
import { i18n } from '@/i18n/constants';
import { getOriginalTranscript } from '@/lib/action/transcription';
import { useFormat } from '@/lib/format';
import type { CallDetail, Turn } from '@/lib/types';
import { sentimentLabel } from '@/lib/utils/analysis-labels';
import { backendMessage, unwrap } from '@/lib/utils/backend-error';
import { cn } from '@/lib/utils/cn';

interface CallDetailViewProps {
  call: CallDetail;
  projectId: string;
  tasks: TaskRow[];
  /** "← Calls": the list page the call was opened from. */
  backHref: string;
  neighbours: CallNeighbours | null;
  /** Where a project admin fixes a missing setting; others are told to ask one. */
  canConfigure: boolean;
}

type Tab = 'transcript' | 'score' | 'summary';

function turnIndexAt(turns: Turn[], time: number) {
  return turns.findIndex((turn) => time >= turn.startMs / 1000 && time <= turn.endMs / 1000);
}

const EYEBROW = 'text-muted-foreground font-mono text-xs tracking-[0.18em] uppercase';

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Surface className="flex min-w-0 flex-col gap-1.5">
      <p className={EYEBROW}>{label}</p>
      {children}
    </Surface>
  );
}

export function CallDetailView({ call, projectId, tasks, backHref, neighbours, canConfigure }: CallDetailViewProps) {
  const t = useTranslations();
  const format = useFormat();
  const labels = useCallLabels();
  const statusNote = useCallStatusNote()(call);
  const errorSentence = useJobErrorSentence();

  const playerRef = useRef<AudioPlayerHandle>(null);
  // The audio route answers 403 for a user who may not hear the recording, so the player and the
  // download link are not rendered at all for them (items 37a, 53).
  const [audioFailed, setAudioFailed] = useState(false);
  const audioUrl = call.canPlayAudio && !audioFailed ? `/api/calls/${call.id}/audio` : null;
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [tab, setTab] = useState<Tab>('transcript');

  // "Show original" (item 36a): off on every page load. The original words are fetched only when the
  // switch is turned on, and each fetch is written to the access log on the server.
  const [original, setOriginal] = useState<Turn[] | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [loadingOriginal, setLoadingOriginal] = useState(false);
  const [logVersion, setLogVersion] = useState(0);

  const toggleOriginal = async (on: boolean) => {
    if (!on) {
      setShowOriginal(false);
      return;
    }
    setLoadingOriginal(true);
    try {
      setOriginal(unwrap(await getOriginalTranscript(projectId, call.id)));
      setShowOriginal(true);
      setLogVersion((n) => n + 1);
    } catch (e) {
      toast.error(backendMessage(e) ?? t(i18n.calls.detail.originalFailed));
    } finally {
      setLoadingOriginal(false);
    }
  };

  const turns = showOriginal && original ? original : call.turns;
  const activeIndex = turnIndexAt(turns, currentTime);

  const seek = useCallback((seconds: number) => playerRef.current?.seek(seconds), []);

  // A quote names its turn (1-based) and the time of its first word: nothing is searched for.
  const jumpTo: QuoteJump = useCallback(
    (quote) => {
      const index = quote.turn - 1;
      const turn = call.turns[index];
      if (!turn) return null;
      const startMs = quote.startMs ?? turn.startMs;
      return {
        time: audioUrl ? format.clock(startMs / 1000) : null,
        onClick: () => {
          if (audioUrl) seek(startMs / 1000);
          setTab('transcript');
          // After the tab switch has rendered the transcript.
          requestAnimationFrame(() =>
            document.getElementById(turnDomId(index))?.scrollIntoView({ block: 'center', behavior: 'smooth' })
          );
        },
      };
    },
    [call.turns, audioUrl, format, seek]
  );

  const sentimentLevel = call.summary?.sentiment?.overallSentiment ?? call.sentimentLevel;
  const progression = useSentimentProgression(call.summary?.sentiment?.sentimentProgression);
  const openTasks = tasks.filter(isOpenTask).length;
  const hasResult = call.status === 'completed' || call.status === 'completed_with_errors';

  // Why a section is empty (item 54a): the run is not finished, the run failed, or that one step failed.
  const emptyReason = (kind: 'summary' | 'scorecard'): string | null => {
    if (call.status === 'queued' || call.status === 'processing') return t(i18n.calls.detail.emptyProcessing);
    if (call.status === 'failed') return t(i18n.calls.detail.emptyFailed);
    const failure = call.failedAnalyses.find((f) => f.kind === kind);
    if (failure) return t(i18n.calls.detail.emptyStepFailed, { reason: errorSentence(failure.errorCode) });
    if (kind === 'scorecard') {
      return t(canConfigure ? i18n.calls.detail.emptyNoTemplate : i18n.calls.detail.emptyNoTemplateAskAdmin);
    }
    return null;
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: 'transcript', label: t(i18n.dashboard.transcriptModal.tabs.transcript) },
    { id: 'score', label: t(i18n.calls.detail.score) },
    { id: 'summary', label: t(i18n.dashboard.transcriptModal.tabs.summary) },
  ];

  return (
    // A flex column so the player can be laid out last on mobile (see below) without moving in the DOM.
    <PageContainer className="flex flex-col gap-8 space-y-0 pb-6 md:pb-16">
      <CallDetailNav
        call={call}
        projectId={projectId}
        audioUrl={audioUrl}
        backHref={backHref}
        neighbours={neighbours}
      />

      <div className="space-y-3">
        <PageHeader
          // An untitled call already carries its day in the title ("Billing · 28 May"), so the eyebrow
          // adds only the time; a titled one gets the full date there.
          eyebrow={[
            t(i18n.calls.detail.eyebrow),
            labels.titleParts(call).day ? format.time(call.createdAt) : format.dateTime(call.createdAt),
            // A call that never got a result has no known length.
            call.durationS > 0 ? format.clock(call.durationS) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
          title={labels.title(call)}
          // Category and sentiment are in the tiles below; the header names the file only.
          description={<span className="text-meta font-mono">{stripExtension(call.filename)}</span>}
        />
        <div className="flex flex-wrap items-center gap-2">
          <CallStatusBadge call={call} />
          {statusNote && (
            <p className={cn('text-meta', call.status === 'failed' ? 'text-negative' : 'text-muted-foreground')}>
              {statusNote}
            </p>
          )}
        </div>
      </div>

      {/* At-a-glance strip. The score lives in the scorecard panel, which says it in full; a tasks tile
          only appears when the call produced tasks. */}
      <div
        className={cn(
          // Two to a row on a phone; a third tile takes the whole row rather than leaving half of it empty.
          'grid grid-cols-2 gap-3 [&>*:nth-child(3)]:col-span-2 lg:[&>*:nth-child(3)]:col-span-1',
          tasks.length > 0 ? 'lg:grid-cols-3' : 'lg:grid-cols-2'
        )}
      >
        <Tile label={t(i18n.calls.table.sentiment)}>
          {sentimentLevel ? (
            <p className="text-title text-foreground flex items-center gap-2 font-medium">
              <SentimentDot level={sentimentLevel} />
              {sentimentLabel(sentimentLevel, t)}
            </p>
          ) : (
            <p className="text-title text-muted-foreground">—</p>
          )}
          {progression && <p className="text-meta text-muted-foreground mt-auto">{progression}</p>}
        </Tile>
        <Tile label={t(i18n.dashboard.transcriptModal.tabs.category)}>
          <p className="text-title text-foreground truncate font-medium" title={call.primaryCategory}>
            {call.primaryCategory ?? t(i18n.calls.table.noCategory)}
          </p>
          <div className="mt-auto">
            <CategoryOverride projectId={projectId} callId={call.id} currentCategory={call.primaryCategory} />
          </div>
        </Tile>
        {tasks.length > 0 && (
          <Tile label={t(i18n.calls.table.tasks)}>
            <p className="text-title text-foreground font-medium">
              {t(i18n.calls.detail.openTasks, { count: openTasks })}
            </p>
            <p className="text-meta text-muted-foreground mt-auto">
              {t(i18n.calls.table.tasksCount, { count: tasks.length })}
            </p>
          </Tile>
        )}
      </div>

      {/* Player: sticky at the top on desktop (under the top bar while there is one, below lg); on mobile
          it is laid out last and sticks to the bottom of the screen, clear of the home indicator. */}
      {audioUrl ? (
        <div
          className={cn(
            'sticky z-20 order-last rounded-2xl px-3 py-2.5 backdrop-blur-md sm:px-4',
            'bg-background/85 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.25)] ring-1 ring-black/[0.06] dark:ring-white/[0.08]',
            'bottom-[max(0.75rem,env(safe-area-inset-bottom))]',
            'md:top-16 md:bottom-auto md:order-none lg:top-3'
          )}
        >
          <AudioPlayer
            ref={playerRef}
            audioUrl={audioUrl}
            onTimeUpdate={(time) => {
              // timeupdate fires several times a second; only re-render when the active turn changes.
              if (turnIndexAt(turns, time) !== activeIndex) setCurrentTime(time);
            }}
            onPlayingStateChange={setIsPlaying}
            onEnded={() => setCurrentTime(0)}
            onError={() => setAudioFailed(true)}
          />
        </div>
      ) : (
        // Says why there is no player: no result yet, no permission, or the file would not play.
        <Surface tone="muted" pad="none" className="text-meta text-muted-foreground px-4 py-3">
          {t(
            !hasResult
              ? i18n.calls.detail.audioNotReady
              : !call.canPlayAudio
                ? i18n.calls.detail.audioNotAllowed
                : i18n.dashboard.transcriptModal.playback.noAudio
          )}
        </Surface>
      )}

      <div className="space-y-6">
        {/* Mobile and tablet: one pane at a time */}
        <div role="group" className={cn(TAB_LIST_CLASS, 'xl:hidden')} aria-label={t(i18n.calls.detail.details)}>
          {tabs.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              aria-pressed={tab === id}
              data-state={tab === id ? 'active' : 'inactive'}
              onClick={() => setTab(id)}
              className={TAB_TRIGGER_CLASS}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_26rem] 2xl:grid-cols-[minmax(0,1fr)_28rem]">
          <section
            aria-label={t(i18n.dashboard.transcriptModal.tabs.transcript)}
            className={cn('min-w-0', tab !== 'transcript' && 'hidden xl:block')}
          >
            {turns.length > 0 ? (
              <>
                {(call.canShowOriginal || !call.diarized) && (
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4">
                    {/* A mono file in a project with no diarization provider: one speaker for the whole call. */}
                    <p className="text-meta text-muted-foreground">
                      {!call.diarized && t(i18n.calls.detail.notDiarized)}
                    </p>
                    {call.canShowOriginal && (
                      <label className="text-meta text-foreground flex items-center gap-2">
                        <Switch
                          checked={showOriginal}
                          onCheckedChange={toggleOriginal}
                          disabled={loadingOriginal}
                          aria-describedby="original-hint"
                        />
                        {t(i18n.calls.detail.showOriginal)}
                      </label>
                    )}
                  </div>
                )}
                {showOriginal && (
                  <p id="original-hint" className="text-meta text-muted-foreground mb-3 px-4">
                    {t(i18n.calls.detail.originalShown)}
                  </p>
                )}
                <TranscriptTurnsList
                  turns={turns}
                  speakers={call.speakers}
                  activeIndex={activeIndex}
                  isPlaying={isPlaying}
                  onSeek={audioUrl ? seek : undefined}
                />
              </>
            ) : (
              <p className="text-body text-muted-foreground px-4 py-6">
                {t(
                  call.status === 'queued' || call.status === 'processing'
                    ? i18n.calls.detail.emptyProcessing
                    : call.status === 'failed'
                      ? i18n.calls.detail.emptyFailed
                      : i18n.calls.detail.noTranscript
                )}
              </p>
            )}
          </section>

          <aside
            className={cn(
              'space-y-4 xl:sticky xl:top-[5.25rem] xl:max-h-[calc(100dvh-6.25rem)] xl:self-start xl:overflow-y-auto xl:overscroll-contain',
              tab === 'transcript' && 'hidden xl:block'
            )}
          >
            <div className={cn(tab !== 'score' && 'hidden xl:block')}>
              <Scorecard analysis={call.templateAnalysis} jumpTo={jumpTo} emptyReason={emptyReason('scorecard')} />
            </div>
            <div className={cn('space-y-4', tab !== 'summary' && 'hidden xl:block')}>
              <SummaryCard summary={call.summary} jumpTo={jumpTo} emptyReason={emptyReason('summary')} />
              <TasksCard tasks={tasks} projectId={projectId} />
              <DetailsCard call={call} />
              <StepsCard steps={call.steps} />
              {call.canSeeAccessLog && <AccessLogCard projectId={projectId} callId={call.id} version={logVersion} />}
            </div>
          </aside>
        </div>
      </div>
    </PageContainer>
  );
}
