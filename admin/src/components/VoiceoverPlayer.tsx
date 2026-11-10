import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type Ref,
} from "react";
import { Button, ActivityIndicator } from "./ui/Primitives";
import { Icon } from "./ui/Icon";
import "./VoiceoverPlayer.css";

export interface VoiceoverPlayerProps {
  takeLabel: string;
  loaded: boolean;
  loading: boolean;
  peaks: readonly number[] | null;
  durationSeconds?: number;
  onListen: () => void;
  registerAudio: (element: HTMLAudioElement | null) => void;
  onEnded: () => void;
  onPlay: () => void;
  onError: () => void;
  toggleRef?: Ref<HTMLButtonElement>;
}

function finiteTime(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function formatTime(value: number): string {
  const seconds = Math.floor(finiteTime(value));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export function VoiceoverListenButton({
  takeLabel,
  durationSeconds,
  onListen,
  loading = false,
}: {
  takeLabel: string;
  durationSeconds?: number;
  onListen: () => void;
  loading?: boolean;
}) {
  return (
    <div className="voiceover-player voiceover-player-idle">
      <Button
        aria-busy={loading || undefined}
        className="voiceover-player-toggle"
        disabled={loading}
        onClick={onListen}
        title="Listen"
      >
        {loading ? <ActivityIndicator /> : <Icon name="play" />}
        <span className="sr-only">Listen</span>
      </Button>
      <output
        aria-label={`${takeLabel} playback time`}
        aria-live="off"
        className="voiceover-player-time"
      >
        {formatTime(durationSeconds ?? 0)}
      </output>
    </div>
  );
}

function Waveform({
  clipId,
  peaks,
  progress,
}: {
  clipId: string;
  peaks: readonly number[];
  progress: number;
}) {
  const width = Math.max(1, peaks.length * 2 - 0.8);
  const bars = peaks.map((peak, index) => {
    const height = Math.min(1, Math.max(0, finiteTime(peak))) * 36;
    return (
      <rect
        height={height}
        key={index}
        rx={0.6}
        width={1.2}
        x={index * 2}
        y={(44 - height) / 2}
      />
    );
  });

  return (
    <svg
      aria-hidden="true"
      className="voiceover-player-waveform"
      focusable="false"
      preserveAspectRatio="none"
      viewBox={`0 0 ${width} 44`}
    >
      <defs>
        <clipPath id={clipId}>
          <rect height="44" width={width * progress} x="0" y="0" />
        </clipPath>
      </defs>
      <g className="voiceover-player-waveform-remaining">{bars}</g>
      <g className="voiceover-player-waveform-played" clipPath={`url(#${clipId})`}>
        {bars}
      </g>
    </svg>
  );
}

export function VoiceoverPlayer({
  takeLabel,
  loaded,
  loading,
  peaks,
  durationSeconds,
  onListen,
  registerAudio,
  onEnded,
  onPlay,
  onError,
  toggleRef,
}: VoiceoverPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const registerAudioRef = useRef(registerAudio);
  const [currentTime, setCurrentTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const clipId = `voiceover-progress-${useId().replaceAll(":", "")}`;

  useEffect(() => {
    registerAudioRef.current = registerAudio;
  }, [registerAudio]);

  const setAudioRef = useCallback((element: HTMLAudioElement | null) => {
    audioRef.current = element;
    registerAudioRef.current(element);
  }, []);

  useEffect(() => {
    if (loaded) return;
    setCurrentTime(0);
    setMediaDuration(0);
    setPlaying(false);
  }, [loaded]);

  const syncMediaTime = useCallback((element: HTMLAudioElement) => {
    const duration = finiteTime(element.duration);
    setMediaDuration(duration);
    setCurrentTime(Math.min(finiteTime(element.currentTime), duration || Infinity));
  }, []);

  const displayedDuration = mediaDuration || finiteTime(durationSeconds ?? 0);
  const seekEnabled = loaded && mediaDuration > 0;
  const progress = seekEnabled
    ? Math.min(1, Math.max(0, currentTime / mediaDuration))
    : 0;
  const actionLabel = playing ? "Pause" : "Listen";

  const togglePlayback = () => {
    if (playing) {
      audioRef.current?.pause();
      return;
    }
    onListen();
  };

  const seek = (event: ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    if (!audio || !seekEnabled) return;
    const nextTime = Math.min(mediaDuration, finiteTime(Number(event.currentTarget.value)));
    audio.currentTime = nextTime;
    setCurrentTime(nextTime);
  };

  return (
    <div className="voiceover-player">
      <Button
        aria-busy={loading || undefined}
        className="voiceover-player-toggle"
        disabled={loading}
        onClick={togglePlayback}
        ref={toggleRef}
        title={actionLabel}
      >
        {loading ? <ActivityIndicator /> : <Icon name={playing ? "pause" : "play"} />}
        <span className="sr-only">{actionLabel}</span>
      </Button>

      <div className="voiceover-player-timeline">
        <span aria-hidden="true" className="voiceover-player-track" />
        {peaks ? <Waveform clipId={clipId} peaks={peaks} progress={progress} /> : null}
        <input
          aria-label={`${takeLabel} playback position`}
          aria-valuetext={`${formatTime(currentTime)} of ${formatTime(displayedDuration)}`}
          className="voiceover-player-seek"
          disabled={!seekEnabled}
          max={mediaDuration || 1}
          min="0"
          onChange={seek}
          step="0.01"
          type="range"
          value={seekEnabled ? Math.min(currentTime, mediaDuration) : 0}
        />
      </div>

      <output
        aria-label={`${takeLabel} playback time`}
        aria-live="off"
        className="voiceover-player-time"
      >
        {formatTime(loaded ? currentTime : displayedDuration)}
      </output>

      <audio
        aria-label={takeLabel}
        className="voiceover-player-audio"
        onEnded={(event) => {
          syncMediaTime(event.currentTarget);
          setPlaying(false);
          onEnded();
        }}
        onError={() => {
          setPlaying(false);
          onError();
        }}
        onLoadedMetadata={(event) => syncMediaTime(event.currentTarget)}
        onPause={() => setPlaying(false)}
        onPlay={() => {
          setPlaying(true);
          onPlay();
        }}
        onTimeUpdate={(event) => syncMediaTime(event.currentTarget)}
        preload="none"
        ref={setAudioRef}
      />
    </div>
  );
}
