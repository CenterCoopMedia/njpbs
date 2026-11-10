import type { ReactNode } from "react";
import { videoTime } from "../../lib/video-production";
import "./VideoReviewSeek.css";

/** A seek line with the comment lane immediately above it, independent of native controls. */
export function VideoReviewSeek({ children, currentSeconds, durationMs, disabled, onSeek }: {
  children: ReactNode;
  currentSeconds: number;
  durationMs: number;
  disabled: boolean;
  onSeek: (seconds: number) => void;
}) {
  const duration = durationMs / 1000;
  // Media clocks can report 8.119999 for 8.12. Keep native stepUp on its step grid.
  const position = Math.round(Math.min(currentSeconds, duration) * 100) / 100;
  return <div className="video-review-seek" data-viewer-keys="off">
    {children}
    <input aria-label="Review video position" aria-valuetext={`${videoTime(currentSeconds)} of ${videoTime(duration)}`}
      type="range" min={0} max={duration} step={0.01} value={position}
      disabled={disabled || duration <= 0} onChange={event => onSeek(Number(event.target.value))} />
  </div>;
}
