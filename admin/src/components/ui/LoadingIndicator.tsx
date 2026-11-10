import type { ReactNode } from "react";
import { BoardwalkTip } from "./BoardwalkTip";

// The one waiting state for the Admin app. Every place a person waits -- the bootstrap screen,
// a route download, a list or record fetch, a save, a publish stage -- renders this instead of
// its own bar, dots, or sentence, so the whole CMS waits the same way.
//
// The label is the live announcement. Stage details stay readable outside that
// live region. Decorative tips replace simulated progress; known progress follows
// activeStage. Tips never enter the live announcement.

export type SpinnerSize = "xs" | "sm" | "md" | "lg";

// Long enough to read a tip, matching the bootstrap note.
export const STAGE_CYCLE_MS = 4500;

interface SpinnerProps {
  size?: SpinnerSize;
  className?: string;
}

// Three arcs on three orbits, each turning at its own speed and the middle one against the
// others, around a pulsing core: a transmitter seen from above. Everything is stroke and
// opacity on currentColor, so one glyph serves every surface without a color prop.
export function Spinner({ size = "md", className }: SpinnerProps) {
  return (
    <svg
      aria-hidden="true"
      className={["spinner", `spinner-${size}`, className].filter(Boolean).join(" ")}
      focusable="false"
      viewBox="0 0 48 48"
    >
      <circle className="spinner-orbit spinner-orbit-outer" cx="24" cy="24" r="21" />
      <circle className="spinner-orbit spinner-orbit-middle" cx="24" cy="24" r="14.5" />
      <circle className="spinner-orbit spinner-orbit-inner" cx="24" cy="24" r="8" />
      <circle className="spinner-core" cx="24" cy="24" r="3" />
    </svg>
  );
}

export interface LoadingIndicatorProps {
  // The stable status sentence, read to assistive technology. No trailing period or ellipsis:
  // the visual treatment supplies the motion, the sentence supplies the fact.
  label: string;
  // A single detail or known progress stages. Multiple untracked stages show tips.
  stages?: readonly string[];
  // The real stage when the caller knows it. Otherwise use decorative tips.
  activeStage?: number;
  size?: SpinnerSize;
  // `inline` sits inside a sentence or a control row; `stack` centers the glyph over the copy
  // for a surface that is otherwise empty; `row` puts the glyph beside the copy at panel width.
  layout?: "inline" | "row" | "stack";
  className?: string;
  // Extra content under the label, for a hint or an action while the wait continues.
  children?: ReactNode;
}

export function LoadingIndicator({
  label,
  stages = [],
  activeStage,
  size,
  layout = "row",
  className,
  children,
}: LoadingIndicatorProps) {
  const showTips = activeStage === undefined && stages.length > 1;
  const stageIndex = Math.min(Math.max(activeStage ?? 0, 0), Math.max(stages.length - 1, 0));
  const stage = showTips ? undefined : stages[stageIndex];
  const resolvedSize = size ?? (layout === "inline" ? "xs" : layout === "stack" ? "lg" : "sm");
  const inline = layout === "inline";
  const Root = inline ? "span" : "div";

  return (
    <Root
      className={["loading-indicator", `loading-indicator-${layout}`, className]
        .filter(Boolean)
        .join(" ")}
      aria-label={label}
      role="status"
      aria-live="off"
    >
      <Spinner size={resolvedSize} />
      <span className="loading-indicator-copy">
        <span className="loading-indicator-label" aria-live="polite" aria-atomic="true">{label}</span>
        {stage ? (
          <span className="loading-indicator-stage" key={stageIndex}>
            {stage}
          </span>
        ) : null}
        {showTips ? <BoardwalkTip intervalMs={STAGE_CYCLE_MS} /> : null}
        {children}
      </span>
    </Root>
  );
}
