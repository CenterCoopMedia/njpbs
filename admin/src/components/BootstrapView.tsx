import { useEffect, useState, type ReactNode } from "react";
import { BrandLockup } from "./BrandLockup";
import { BootstrapWaitNote } from "./BootstrapWaitNote";
import { Icon } from "./ui/Icon";
import { LoadingIndicator } from "./ui/LoadingIndicator";
import { Panel } from "./ui/Primitives";
import {
  BOOTSTRAP_SLOW_AFTER_MS,
  bootstrapPhase,
  bootstrapPhaseViews,
  type BootstrapStage,
} from "../lib/bootstrap-phases";
import "./AuthFrame.css";

// The signed-out frame and bootstrap screen stay independent of App's router/auth startup,
// so the design gallery can render them without opening a session or requesting CMS data.
export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <main className="auth-screen">
      <div className="auth-scene" aria-hidden="true">
        <span className="auth-dots auth-dots-start" />
        <span className="auth-dots auth-dots-end" />
        <p className="auth-margin-copy auth-margin-copy-start">
          <span>People</span><span>Stories</span><span>Communities</span><span>A brighter NJ</span>
        </p>
        <p className="auth-margin-copy auth-margin-copy-end">
          <span>New Jersey</span><span>A stronger</span><span>Tomorrow</span><span>Informs here</span>
        </p>
      </div>
      <div className="auth-layout">
        <div className="auth-brand-column">
          <div className="auth-brand-copy">
            <BrandLockup />
            <p>
              Plan, write, and publish the stories and pages that keep New Jersey informed.
            </p>
          </div>
          <p className="auth-brand-caption" aria-hidden="true">
            <span>Inform</span><span>Educate</span><span>Engage</span><span>Together</span>
          </p>
        </div>
        <Panel className="auth-panel">{children}</Panel>
      </div>
    </main>
  );
}

function useElapsed(afterMs: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setElapsed(true), afterMs);
    return () => window.clearTimeout(timer);
  }, [afterMs]);
  return elapsed;
}

// Presentation only: completion still comes exclusively from bootstrapPhaseViews(stage).
// In particular, a pending workspace is not labelled ready or given a made-up percentage.
const phaseNotes: Record<BootstrapStage, { active: string; done: string; pending: string }> = {
  session: { active: "Checking for a saved session", done: "Session retrieved successfully", pending: "Waiting to restore your sign-in" },
  admission: { active: "Checking your staff profile and access", done: "Staff access confirmed", pending: "Starts after sign-in is restored" },
  profile: { active: "Retrieving your profile and permissions", done: "Profile and permissions loaded", pending: "Starts after staff access is confirmed" },
  workspace: { active: "Loading your workspace", done: "Workspace ready", pending: "Up next" },
};

export function BootstrapView({ stage }: { stage: BootstrapStage }) {
  const phases = bootstrapPhaseViews(stage);
  const active = bootstrapPhase(stage);
  const slow = useElapsed(BOOTSTRAP_SLOW_AFTER_MS);

  return (
    <AuthFrame>
      <div className="auth-copy">
        <h1>Preparing your workspace</h1>
        <p className="muted">Your account and permissions are being checked.</p>
      </div>
      <div className="bootstrap-status">
        <LoadingIndicator label={active.title} size="lg">
          <BootstrapWaitNote slow={slow} />
        </LoadingIndicator>
        <ol aria-label="Sign-in progress" className="bootstrap-phases">
          {phases.map((phase) => (
            <li
              aria-current={phase.state === "active" ? "step" : undefined}
              className="bootstrap-phase"
              data-state={phase.state}
              key={phase.stage}
            >
              <span aria-hidden="true" className="bootstrap-phase-mark">
                {phase.state === "done" ? <Icon name="check" /> : null}
              </span>
              <span className="bootstrap-phase-copy">
                <span>{phase.title}</span>
                <span className="bootstrap-phase-detail">{phaseNotes[phase.stage][phase.state]}</span>
              </span>
              <span className="sr-only">
                {phase.state === "done" ? ", done" : phase.state === "active" ? ", in progress" : ", waiting"}
              </span>
            </li>
          ))}
        </ol>
        {slow ? <p className="bootstrap-slow" role="status">
          This is taking longer than usual. The current check is still pending.
        </p> : null}
      </div>
    </AuthFrame>
  );
}
