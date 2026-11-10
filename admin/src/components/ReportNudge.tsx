import { useRef } from "react";
import type { BugReportNudge } from "../lib/functions";
import { Button, InlineMessage } from "./ui/Primitives";

export interface ReportNudgeActionState { pending: boolean; error: string | null; version?: number }

export function ReportNudge({ state, label, action = { pending: false, error: null }, onNudge }: {
  state: BugReportNudge; label: string; action?: ReportNudgeActionState; onNudge: () => Promise<void>;
}) {
  const { pending, error } = action;
  const result = useRef<HTMLDivElement>(null);
  const last = state.history.at(-1);
  async function submit() {
    if (pending) return;
    try { await onNudge(); result.current?.focus(); }
    catch { /* The shared per-report action state presents the failure. */ }
  }
  return <div className="report-nudge" aria-busy={pending}>
    {state.eligible ? <><p>No recorded progress for more than three days. Ask for a follow-up; this does not start work automatically.</p>
      <Button aria-label={`Nudge for ${label}`} disabled={pending} onClick={() => void submit()}>{pending ? "Queuing nudge" : "Nudge"}</Button></> : null}
    <div ref={result} role="status" tabIndex={-1}>{pending ? "Queuing your follow-up request." : last ? <p>
      {last.delivery === "delivered" ? "Nudge sent" : last.delivery === "unknown" ? "Nudge delivery is unconfirmed" : last.delivery === "terminal_failed" ? "Nudge delivery needs administrator attention" : last.delivery === "cancelled" ? "Nudge cancelled because progress or access changed" : "Nudge queued"}
      {` · ${new Date(last.delivery === "delivered" ? last.deliveredAt ?? last.requestedAt : last.requestedAt).toLocaleString("en-US")}. `}
      {last.decision === "approved" ? "Follow-up approved and requested. Check Work progress for updates." : last.decision === "ignored" ? "Nudge ignored; report unchanged."
        : last.delivery === "delivered" ? "Awaiting a decision." : last.delivery === "pending" ? "Awaiting delivery."
          : last.delivery === "cancelled" ? "No message or follow-up is expected from this request." : "Ask an administrator to check delivery before trying again."}
    </p> : null}</div>
    {error && state.eligible && action.version === state.version ? <InlineMessage tone="error">{error} Use Nudge to retry.</InlineMessage> : null}
    {state.history.length ? <details><summary>Nudge history</summary><ol>{state.history.map((entry) => <li key={entry.requestedAt}>
      {new Date(entry.requestedAt).toLocaleString("en-US")} · {entry.delivery.replace("_", " ")} · {entry.decision ?? "no decision"}{entry.decidedAt ? ` (${new Date(entry.decidedAt).toLocaleString("en-US")})` : ""}
    </li>)}</ol>{state.historyTruncated ? <p>Showing the latest 20 nudges. Earlier requests and decisions remain in the administrator audit history.</p> : null}</details> : null}
  </div>;
}
