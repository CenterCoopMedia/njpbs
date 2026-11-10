import { ELECTION_RACE_STATUSES, type ElectionRaceApproval } from "../../../packages/content-core/src/election-results";
import "./ElectionResultsHistory.css";

function approvalTime(value: string): string {
  return new Date(value).toLocaleString("en-US", { timeZone: "America/New_York", timeZoneName: "short" });
}
/** Private workflow evidence remains readable while the content editor is locked. */
export function ElectionResultsHistory({ approvals }: { approvals?: readonly ElectionRaceApproval[] }) {
  if (!approvals?.length) return null;
  return <details className="election-results-history"><summary>Race approval history</summary>
    {approvals.map(approval => <section key={`${approval.blockId}/${approval.raceId}`}>
      <h3>{approval.race.office}: {approval.race.district}</h3>
      <p>Latest approved revision {approval.revision}: {approval.approvedBy.displayName} ({approval.approvedBy.uid}), {approvalTime(approval.approvedAt)}.</p>
      <ol>{approval.statusHistory.map(entry => <li key={entry.revision}>{ELECTION_RACE_STATUSES[entry.status]}: Revision {entry.revision}, {entry.approvedBy.displayName} ({entry.approvedBy.uid}), {approvalTime(entry.approvedAt)}.</li>)}</ol>
    </section>)}
    <p>The record's Revision history retains every approved set of values.</p>
  </details>;
}
