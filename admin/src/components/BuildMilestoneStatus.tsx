import { useCallback, useEffect, useState } from "react";
import {
  classifyAdminStatus,
  milestoneForNumber,
  type AdminStatusDisplayState,
  type AdminStatusManifest,
} from "../lib/admin-status";
import { Button, StatusBadge, type StatusTone } from "./ui/Primitives";
import { LoadingIndicator } from "./ui/LoadingIndicator";

export type AdminStatusLoadState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; manifest: AdminStatusManifest; clock: number };

interface StatusModuleProps {
  onRetry: () => void;
  state: AdminStatusLoadState;
}

const statePresentation: Record<
  AdminStatusDisplayState,
  { label: string; tone: StatusTone }
> = {
  current: { label: "Current", tone: "success" },
  stale: { label: "Stale", tone: "pending" },
  unavailable: { label: "Unavailable", tone: "neutral" },
};

function displayTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function useAdminStatus(
  loadStatus: () => Promise<AdminStatusManifest>,
  enabled = true,
): { state: AdminStatusLoadState; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<AdminStatusLoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    if (!enabled) return () => {
      cancelled = true;
    };
    setState({ status: "loading" });
    loadStatus()
      .then((manifest) => {
        if (!cancelled) setState({ status: "ready", manifest, clock: Date.now() });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, enabled, loadStatus]);

  useEffect(() => {
    if (state.status !== "ready" || state.manifest.status !== "current") return;
    const remaining = Date.parse(state.manifest.refreshAfter) - Date.now();
    if (remaining <= 0) return;
    const timeout = window.setTimeout(
      () => setState((current) =>
        current.status === "ready" ? { ...current, clock: Date.now() } : current,
      ),
      Math.min(remaining, 2_147_483_647),
    );
    return () => window.clearTimeout(timeout);
  }, [state]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { state, retry };
}

function unavailableStatus(
  title: string,
  state: AdminStatusLoadState,
  onRetry: () => void,
): JSX.Element | null {
  const label = title.toLocaleLowerCase();
  if (state.status === "loading") {
    return (
      <div className="newsroom-build-line">
        <LoadingIndicator label={`Loading ${label}`} layout="inline" />
      </div>
    );
  }
  if (state.status === "failed") {
    return (
      <div className="newsroom-build-line" role="status">
        <StatusBadge className="newsroom-build-state" tone="failed">Failed</StatusBadge>
        <span className="newsroom-build-detail">Status could not be loaded.</span>
        <Button
          className="newsroom-build-retry"
          variant="ghost"
          onClick={onRetry}
        >
          Retry {label}
        </Button>
      </div>
    );
  }
  if (state.manifest.status === "unavailable") {
    return (
      <div className="newsroom-build-line" role="status">
        <StatusBadge className="newsroom-build-state" tone="neutral">Unavailable</StatusBadge>
        <span className="newsroom-build-detail">
          Status is not available in this environment.
        </span>
      </div>
    );
  }
  return null;
}

export function BuildStatus({ state, onRetry }: StatusModuleProps) {
  const unavailable = unavailableStatus("Build status", state, onRetry);
  if (unavailable) {
    return (
      <section
        className="newsroom-build-status"
        aria-label="Build status"
        aria-busy={state.status === "loading" || undefined}
        aria-live={state.status === "loading" ? undefined : "polite"}
        data-status={state.status === "ready" ? "unavailable" : state.status}
      >
        <h2>Build status</h2>
        {unavailable}
      </section>
    );
  }

  const ready = state as Extract<AdminStatusLoadState, { status: "ready" }>;
  const displayState = classifyAdminStatus(ready.manifest, ready.clock);
  const presentation = statePresentation[displayState];
  const manifest = ready.manifest as Extract<AdminStatusManifest, { status: "current" }>;
  return (
    <section
      className="newsroom-build-status"
      aria-label="Build status"
      aria-live="polite"
      data-status={displayState}
    >
      <h2>Build status</h2>
      <div className="newsroom-build-line">
        <StatusBadge className="newsroom-build-state" tone={presentation.tone}>
          {presentation.label}
        </StatusBadge>
        <span className="newsroom-build-detail">
          <strong>{manifest.environment}</strong>
          <span aria-hidden="true"> · </span>
          <code>{manifest.build.revision.slice(0, 7)}</code>
          <span aria-hidden="true"> · </span>
          {displayTimestamp(manifest.build.builtAt)}
        </span>
      </div>
    </section>
  );
}

export function MilestoneStatus({
  state,
  onRetry,
  milestoneNumber,
}: StatusModuleProps & { milestoneNumber?: number }) {
  const unavailable = unavailableStatus("Milestone status", state, onRetry);
  if (unavailable) {
    return (
      <section
        className="newsroom-build-status"
        aria-label="Milestone status"
        aria-busy={state.status === "loading" || undefined}
        aria-live={state.status === "loading" ? undefined : "polite"}
        data-status={state.status === "ready" ? "unavailable" : state.status}
      >
        <h2>Milestone</h2>
        {unavailable}
      </section>
    );
  }

  const ready = state as Extract<AdminStatusLoadState, { status: "ready" }>;
  const displayState = classifyAdminStatus(ready.manifest, ready.clock);
  const presentation = statePresentation[displayState];
  const manifest = ready.manifest as Extract<AdminStatusManifest, { status: "current" }>;
  const milestone = milestoneForNumber(manifest, milestoneNumber);
  const issueTotal = milestone.openIssues + milestone.closedIssues;
  return (
    <section
      className="newsroom-build-status"
      aria-label="Milestone status"
      aria-live="polite"
      data-status={displayState}
    >
      <h2>Milestone</h2>
      <div className="newsroom-build-line">
        <StatusBadge className="newsroom-build-state" tone={presentation.tone}>
          {presentation.label}
        </StatusBadge>
        <span className="newsroom-build-detail">
          <a
            className="newsroom-build-link"
            href={milestone.url}
            aria-label={`${milestone.title} milestone details`}
          >
            {milestone.title}
          </a>
          {" "}
          <span className="newsroom-milestone-count">{milestone.closedIssues} of {issueTotal} closed</span>
        </span>
      </div>
    </section>
  );
}
