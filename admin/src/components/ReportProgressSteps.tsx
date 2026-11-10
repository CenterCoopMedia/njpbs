import type { BugReportProgress } from "../lib/functions";

export function ReportProgressSteps({ progress }: { progress: BugReportProgress }) {
  const phase = progress.phase;
  const closed = ["resolved", "dismissed"].includes(phase);
  const review = ["ready_for_review", "changes_requested", "checks_failed"].includes(phase);
  const fixing = progress.stage === "fixing" || (phase === "in_progress" && progress.pullRequests.length > 0);
  const current = closed ? 5 : phase === "merged" ? 4 : review ? 3 : fixing ? 2 : phase === "received" ? 0 : 1;
  const blocked = ["blocked", "needs_attention", "changes_requested", "checks_failed", "closed"].includes(phase);
  const labels = ["Received", "Investigating", "Fix in progress", "Fix in review", "Live verification", "Fix released"];
  labels[current] = progress.label;
  return <ol className="report-progress-steps" aria-label="Report progress">
    {labels.map((label, index) => {
      // Terminal administrative closure is not evidence that earlier engineering
      // stages happened, nor that a deployment was verified.
      const state = index === current ? blocked ? "blocked" : closed ? "done" : "current"
        : index === 0 ? "done" : "ahead";
      const description = state === "done" ? "Complete" : state === "current" ? "Underway" : state === "blocked" ? "Needs attention" : "Not confirmed";
      return <li key={index} data-state={state} aria-current={index === current ? "step" : undefined}>
        <span className="report-progress-dot" aria-hidden="true" />
        <span>{label}<span className="sr-only">: {description}</span></span>
      </li>;
    })}
  </ol>;
}
