import { useEffect, useState } from "react";
import { BOARDWALK_TIPS, pickBoardwalkTipIndex } from "../../lib/boardwalk-tips";

export function BoardwalkTip({ intervalMs, stopped = false, className = "" }: {
  intervalMs: number;
  stopped?: boolean;
  className?: string;
}) {
  const [index, setIndex] = useState(() => pickBoardwalkTipIndex());
  const [paused, setPaused] = useState(false);
  const [hidden, setHidden] = useState(() => document.hidden);
  const [reducedMotion, setReducedMotion] = useState(
    () => window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false,
  );

  useEffect(() => {
    const preference = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const onMotion = () => setReducedMotion(preference?.matches ?? false);
    const onVisibility = () => setHidden(document.hidden);
    preference?.addEventListener("change", onMotion);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      preference?.removeEventListener("change", onMotion);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => {
    if (stopped || paused || hidden || reducedMotion) return;
    const timer = window.setInterval(() => setIndex(pickBoardwalkTipIndex), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, stopped, paused, hidden, reducedMotion]);

  const tip = BOARDWALK_TIPS[index];
  return (
    <span className={`boardwalk-tip-copy ${className}`} data-paused={paused || reducedMotion || stopped}>
      <span className="loading-indicator-stage boardwalk-tip" key={index}>
        <span className="boardwalk-tip-label">{tip.label}</span>
        <span>{tip.text}</span>
      </span>
      {paused || (!stopped && !reducedMotion) ? (
        <button
          type="button"
          className="loading-indicator-pause"
          aria-pressed={paused}
          onClick={() => setPaused(!paused)}
        >
          {paused ? "Resume text" : "Pause text"}
        </button>
      ) : null}
    </span>
  );
}
