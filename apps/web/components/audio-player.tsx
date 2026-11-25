'use client';

import { Pause, Play, RotateCcw, RotateCw, Volume2, VolumeX } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';

import { Slider } from '@/components/ui/slider';
import { i18n } from '@/i18n/constants';
import { useFormat } from '@/lib/format';
import { cn } from '@/lib/utils/cn';

export interface AudioPlayerHandle {
  /** Jump to a point in the recording and play from there. */
  seek: (seconds: number) => void;
}

interface AudioPlayerProps {
  audioUrl: string;
  ref?: React.Ref<AudioPlayerHandle>;
  onEnded?: () => void;
  onError?: () => void;
  onTimeUpdate?: (currentTime: number) => void;
  onPlayingStateChange?: (isPlaying: boolean) => void;
  /** Shown as the length until the file's own is known (it is fetched only on play or seek). */
  durationSeconds?: number;
  className?: string;
}

const SPEEDS = [1, 1.25, 1.5, 2] as const;
const SKIP_S = 15;
const ARROW_SKIP_S = 5;

// Neutral track and fill: coral is kept for the play button, the one primary action here.
const SLIDER =
  'cursor-pointer [&_[data-slot=slider-range]]:bg-foreground/60 [&_[data-slot=slider-thumb]]:border-foreground/20 [&_[data-slot=slider-track]]:bg-foreground/[0.08]';

// Keys typed into a field, or pressed on a control that already handles them, aren't for the player.
function isOwnKeyTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    !!target.closest(
      'input, textarea, select, button, a, [role="slider"], [role="menu"], [role="dialog"], [role="listbox"]'
    )
  );
}

export function AudioPlayer({
  audioUrl,
  ref,
  onEnded,
  onError,
  onTimeUpdate,
  onPlayingStateChange,
  durationSeconds,
  className,
}: AudioPlayerProps) {
  const t = useTranslations();
  const locale = useLocale();
  const format = useFormat();
  const speedFormat = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(durationSeconds ?? 0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [speed, setSpeed] = useState<number>(1);

  // Stable references to callbacks so the audio effect runs only for a new URL.
  const callbacks = useRef({ onTimeUpdate, onEnded, onError, onPlayingStateChange });
  useEffect(() => {
    callbacks.current = { onTimeUpdate, onEnded, onError, onPlayingStateChange };
  }, [onTimeUpdate, onEnded, onError, onPlayingStateChange]);

  useEffect(() => {
    const audio = new Audio(audioUrl);
    // Nothing is fetched until someone plays or seeks: every request for the audio is a row in the
    // call's access log, and opening the page is not listening. The length shown until then is the
    // call's own.
    audio.preload = 'none';
    audioRef.current = audio;

    const handleTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
      callbacks.current.onTimeUpdate?.(audio.currentTime);
    };
    const handleLoadedMetadata = () => setDuration(audio.duration);
    // Driven by the element's own events, so a play() the browser refuses never shows as playing.
    const handlePlay = () => {
      setIsPlaying(true);
      callbacks.current.onPlayingStateChange?.(true);
    };
    const handlePause = () => {
      setIsPlaying(false);
      callbacks.current.onPlayingStateChange?.(false);
    };
    const handleEnded = () => {
      setCurrentTime(0);
      callbacks.current.onEnded?.();
    };
    const handleError = () => callbacks.current.onError?.();

    audio.addEventListener('timeupdate', handleTimeUpdate);
    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('ended', handleEnded);
    audio.addEventListener('error', handleError);

    return () => {
      audio.removeEventListener('timeupdate', handleTimeUpdate);
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('ended', handleEnded);
      audio.removeEventListener('error', handleError);
      audio.pause();
    };
  }, [audioUrl]);

  const seekTo = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const max = Number.isFinite(audio.duration) ? audio.duration : seconds;
    audio.currentTime = Math.min(Math.max(0, seconds), max);
    setCurrentTime(audio.currentTime);
    callbacks.current.onTimeUpdate?.(audio.currentTime);
  };

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  };

  const skip = (delta: number) => seekTo((audioRef.current?.currentTime ?? 0) + delta);

  useImperativeHandle(ref, () => ({
    seek: (seconds: number) => {
      seekTo(seconds);
      audioRef.current?.play().catch(() => {});
    },
  }));

  // Space plays and pauses, the arrows skip, wherever the reader is on the page, except in a field or
  // on a control that has its own use for the key.
  const keyActions = useRef({ togglePlay, skip });
  useEffect(() => {
    keyActions.current = { togglePlay, skip };
  });
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isOwnKeyTarget(e.target)) return;
      if (e.key === ' ') {
        e.preventDefault();
        keyActions.current.togglePlay();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        keyActions.current.skip(-ARROW_SKIP_S);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        keyActions.current.skip(ARROW_SKIP_S);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const cycleSpeed = () => {
    const next = SPEEDS[(SPEEDS.indexOf(speed as (typeof SPEEDS)[number]) + 1) % SPEEDS.length];
    if (audioRef.current) audioRef.current.playbackRate = next;
    setSpeed(next);
  };

  const handleVolumeChange = (value: number[]) => {
    if (!audioRef.current) return;
    audioRef.current.volume = value[0];
    setVolume(value[0]);
    setIsMuted(value[0] === 0);
  };

  const toggleMute = () => {
    if (!audioRef.current) return;
    const newVolume = isMuted ? volume || 0.5 : 0;
    audioRef.current.volume = newVolume;
    setVolume(isMuted ? newVolume : volume);
    setIsMuted(!isMuted);
  };

  const iconButton =
    'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.05] flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors';

  return (
    <div className={cn('flex w-full items-center gap-2 sm:gap-3', className)}>
      <button
        type="button"
        onClick={() => skip(-SKIP_S)}
        aria-label={t(i18n.calls.player.back)}
        title={t(i18n.calls.player.back)}
        className={cn(iconButton, 'hidden sm:flex')}
      >
        <RotateCcw className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={togglePlay}
        aria-label={isPlaying ? t(i18n.calls.player.pause) : t(i18n.calls.player.play)}
        className="bg-brand-coral flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white transition hover:brightness-105 active:scale-95"
      >
        {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
      </button>
      <button
        type="button"
        onClick={() => skip(SKIP_S)}
        aria-label={t(i18n.calls.player.forward)}
        title={t(i18n.calls.player.forward)}
        className={cn(iconButton, 'hidden sm:flex')}
      >
        <RotateCw className="h-4 w-4" />
      </button>

      <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
        <span className="text-meta text-muted-foreground min-w-[2.5rem] text-right tabular-nums">
          {format.clock(currentTime)}
        </span>
        <Slider
          value={[currentTime]}
          max={duration || 100}
          step={0.1}
          onValueChange={(value) => seekTo(value[0])}
          aria-label={t(i18n.calls.player.position)}
          className={cn(SLIDER, 'flex-1')}
        />
        <span className="text-meta text-muted-foreground min-w-[2.5rem] tabular-nums">{format.clock(duration)}</span>
      </div>

      <button
        type="button"
        onClick={cycleSpeed}
        aria-label={`${t(i18n.calls.player.speed)}: ${speedFormat.format(speed)}×`}
        title={t(i18n.calls.player.speed)}
        className="text-meta text-foreground/80 hover:bg-foreground/[0.09] bg-foreground/[0.05] h-8 min-w-[3.25rem] shrink-0 rounded-full px-2 font-medium tabular-nums transition-colors"
      >
        {speedFormat.format(speed)}×
      </button>

      <div className="hidden shrink-0 items-center gap-1 md:flex">
        <button
          type="button"
          onClick={toggleMute}
          aria-label={isMuted ? t(i18n.calls.player.unmute) : t(i18n.calls.player.mute)}
          className={iconButton}
        >
          {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </button>
        <Slider
          value={[isMuted ? 0 : volume]}
          max={1}
          step={0.01}
          onValueChange={handleVolumeChange}
          aria-label={t(i18n.calls.player.volume)}
          className={cn(SLIDER, 'w-16')}
        />
      </div>
    </div>
  );
}
