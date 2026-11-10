import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import {
  HttpError,
  cmsGetBugReport,
  cmsGetBugReportEvidence,
  cmsGetGithubIssue,
  cmsListBugReports,
  cmsListGithubIssues,
  cmsNudgeBugReport,
  type BugReportProgress,
  type BugReportNudge,
  type BugReportRecord,
  type BugReportResolution,
  type BugReportStatus,
  type BugReportSummary,
  type SharedBugReport,
  type GithubIssueRecord,
  type GithubIssueStateFilter,
  type GithubIssueSummary,
} from "../lib/functions";
import { canManageSettings, canViewReports } from "../lib/access";
import { RequireCapability } from "./RequireCapability";
import { reportsPath, ROUTE_PATHS } from "../lib/routes";
import { useShell } from "./ShellContext";
import {
  AsyncActionButton,
  Button,
  EmptyState,
  InlineMessage,
  StatusBadge,
  TableFrame,
} from "../components/ui/Primitives";
import { LoadingIndicator } from "../components/ui/LoadingIndicator";
import { ReportProgressSteps } from "../components/ReportProgressSteps";
import { ReportNudge, type ReportNudgeActionState } from "../components/ReportNudge";
const BoardwalkUsageRoute = lazy(() => import("./BoardwalkUsageRoute")
  .then(module => ({ default: module.BoardwalkUsageRoute })));

const STATUS_LABELS: Record<BugReportStatus, string> = {
  open: "Open",
  acknowledged: "Acknowledged",
  in_progress: "In progress",
  blocked: "Blocked",
  resolved: "Resolved",
  dismissed: "Dismissed",
};
const AREA_LABELS: Record<string, string> = {
  sign_in_access: "Sign-in or access",
  content_editing: "Content editing",
  save_revision: "Save or revision",
  review_publish: "Review or publish",
  media: "Media",
  navigation_ui: "Navigation or interface",
  other: "Other",
};
const ISSUE_STATE_FILTERS: GithubIssueStateFilter[] = ["open", "closed", "all"];
const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});
const SHORT_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", year: "numeric",
});
const SHORT_TIME_FORMAT = new Intl.DateTimeFormat("en-US", { timeStyle: "short" });
const BUG_REPORT_ID = /^br_[0-9a-f]{32}$/;
const GITHUB_ISSUE_NUMBER = /^[1-9][0-9]{0,9}$/;

function acceptNudge<T extends { id: string; nudge?: BugReportNudge; shared?: boolean }>(entry: T, cache: Map<string, BugReportNudge>): T {
  if (entry.shared || !entry.nudge) return entry;
  const known = cache.get(entry.id);
  if (known && known.version > entry.nudge.version) return { ...entry, nudge: known };
  cache.set(entry.id, entry.nudge);
  return entry;
}

function dateLabel(value: string | null | undefined): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? DATE_FORMAT.format(date) : "Not recorded";
}

function CompactTimestamp({ value }: { value: string | null | undefined }) {
  if (!value) return <>Not recorded</>;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return <>Not recorded</>;
  return (
    <time className="reports-compact-time" dateTime={value}>
      <span className="sr-only">{DATE_FORMAT.format(date)}</span>
      <span aria-hidden="true">{SHORT_DATE_FORMAT.format(date)}</span>
      <span aria-hidden="true">{SHORT_TIME_FORMAT.format(date)}</span>
    </time>
  );
}

function statusTone(status: BugReportStatus) {
  if (status === "resolved") return "success" as const;
  if (status === "dismissed") return "cancelled" as const;
  if (status === "blocked") return "failed" as const;
  if (status === "in_progress") return "publishing" as const;
  if (status === "acknowledged") return "brand" as const;
  return "pending" as const;
}

function progressTone(progress: BugReportProgress) {
  if (["needs_attention", "checks_failed", "changes_requested", "blocked"].includes(progress.phase)) return "failed" as const;
  if (progress.phase === "resolved") return "success" as const;
  if (["dismissed", "closed"].includes(progress.phase)) return "cancelled" as const;
  if (progress.phase === "in_progress") return "publishing" as const;
  if (["ready_for_review", "reopened", "acknowledged"].includes(progress.phase)) return "brand" as const;
  return "pending" as const;
}

function issueTone(state: "open" | "closed") {
  return state === "closed" ? ("success" as const) : ("pending" as const);
}

function addressedSegment(pathname: string): string | null {
  const prefix = `${ROUTE_PATHS.reports}/`;
  if (!pathname.startsWith(prefix)) return null;
  const encoded = pathname.slice(prefix.length).split("/")[0];
  try {
    return decodeURIComponent(encoded) || null;
  } catch {
    return null;
  }
}

function addressedReportId(pathname: string): string | null {
  const segment = addressedSegment(pathname);
  return segment && BUG_REPORT_ID.test(segment) ? segment : null;
}

function addressedGithubNumber(pathname: string): number | null {
  const segment = addressedSegment(pathname);
  if (!segment || !GITHUB_ISSUE_NUMBER.test(segment)) return null;
  const number = Number.parseInt(segment, 10);
  return Number.isSafeInteger(number) ? number : null;
}

function safeReturnPath(report: BugReportRecord): string | null {
  const path = report.route?.path;
  return typeof path === "string" && path.startsWith("/") && !path.startsWith("//")
    ? path
    : null;
}

function ReportRows({ reports, selectedId, onNudge, nudgeActions }: {
  reports: BugReportSummary[];
  selectedId: string | null;
  onNudge?: (reportId: string) => Promise<void>;
  nudgeActions: Record<string, ReportNudgeActionState>;
}) {
  if (reports.length === 0) {
    return <EmptyState title="No reports" description="No reports match this view." />;
  }
  return (
    <TableFrame>
      <table className="data-table reports-table">
        <thead>
          <tr>
            <th scope="col">Report</th>
            <th scope="col">Severity</th>
            <th scope="col">Status</th>
            <th scope="col">Created</th>
          </tr>
        </thead>
        <tbody>
          {reports.map((report) => (
            <tr
              className={report.severity === "blocker" ? "report-row-blocker" : undefined}
              data-selected={selectedId === report.id ? "true" : "false"}
              key={report.id}
            >
              <td data-label="Report">
                <Link to={reportsPath(report.id)}>
                  <strong>{report.tryingToDo || report.happened}</strong>
                  <span className="report-row-id">{report.id}</span>
                </Link>
              </td>
              <td data-label="Severity">{report.severity === "work_impaired" ? "Work impaired" : report.severity[0].toUpperCase() + report.severity.slice(1)}</td>
              <td data-label="Status"><StatusBadge tone={report.progress ? progressTone(report.progress) : statusTone(report.status)}>{report.progress?.label ?? STATUS_LABELS[report.status]}</StatusBadge>{report.progress ? <ReportProgressSteps progress={report.progress} /> : null}
                {onNudge && report.nudge ? <ReportNudge state={report.nudge} label={report.tryingToDo || report.id} action={nudgeActions[report.id]} onNudge={() => onNudge(report.id)} /> : null}</td>
              <td data-label="Created">{dateLabel(report.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableFrame>
  );
}

function IssueRows({ issues, selectedNumber }: {
  issues: GithubIssueSummary[];
  selectedNumber: number | null;
}) {
  if (issues.length === 0) {
    return <EmptyState title="No issues" description="No GitHub issues match this view." />;
  }
  return (
    <TableFrame>
      <table className="data-table reports-table reports-issue-table">
        <thead>
          <tr>
            <th scope="col">Issue</th>
            <th scope="col">Status</th>
            <th scope="col">Updated</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((issue) => (
            <tr
              data-selected={selectedNumber === issue.number ? "true" : "false"}
              key={issue.number}
            >
              <td data-label="Issue">
                <Link to={reportsPath(String(issue.number))}>
                  <strong>{issue.title}</strong>
                  <span className="report-row-id">#{issue.number}</span>
                </Link>
              </td>
              <td data-label="Status">
                <StatusBadge tone={issueTone(issue.state)}>{issue.state === "closed" ? "Closed" : "Open"}</StatusBadge>
              </td>
              <td data-label="Updated"><CompactTimestamp value={issue.updatedAt} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableFrame>
  );
}

function Facts({ report }: { report: BugReportRecord }) {
  const native = report.environment.native;
  return (
    <dl className="report-facts">
      <div><dt>Reporter</dt><dd>{report.reporter.email ?? report.reporter.uid} ({report.reporter.role})</dd></div>
      <div><dt>Area</dt><dd>{AREA_LABELS[report.area] ?? report.area}</dd></div>
      <div><dt>Created</dt><dd>{dateLabel(report.createdAt)}</dd></div>
      {native ? <>
        <div><dt>Source</dt><dd>Premiere native panel ({native.mode})</dd></div>
        <div><dt>Panel view</dt><dd>{native.view}</dd></div>
        <div><dt>Plugin</dt><dd>{native.pluginVersion}</dd></div>
        <div><dt>Premiere</dt><dd>{native.premiereVersion}</dd></div>
        <div><dt>UXP</dt><dd>{native.uxpVersion}</dd></div>
        <div><dt>System</dt><dd>{native.platform}</dd></div>
        {native.pluginRevision ? <div><dt>Plugin revision (client-reported)</dt><dd><code>{native.pluginRevision.slice(0, 12)}</code></dd></div> : null}
        {report.automatic ? <>
          <div><dt>Occurrences</dt><dd>{report.automatic.repeatCount} in this 15-minute incident</dd></div>
          <div><dt>Last seen</dt><dd>{dateLabel(report.automatic.lastSeenAt)}</dd></div>
        </> : null}
      </> : <div><dt>Route</dt><dd><code>{report.route?.path}</code></dd></div>}
      {report.category ? <div><dt>Category</dt><dd>{report.category === "bug" ? "Bug or error" : report.category === "suggestion" ? "Suggestion" : "Question"}</dd></div> : null}
      <div><dt>{native ? "Admin build" : "Build"}</dt><dd><code>{report.environment.buildRevision.slice(0, 12)}</code></dd></div>
      {!native ? <>
        <div><dt>Browser</dt><dd>{report.environment.browser}</dd></div>
        <div><dt>System</dt><dd>{report.environment.operatingSystem}</dd></div>
        <div><dt>Viewport</dt><dd>{report.environment.viewport?.width} × {report.environment.viewport?.height}</dd></div>
      </> : null}
    </dl>
  );
}

function ReportText({ report }: { report: BugReportRecord }) {
  return (
    <div className="report-provided-text">
      {report.tryingToDo && report.tryingToDo !== report.happened ? <section><h3>Trying to do</h3><p>{report.tryingToDo}</p></section> : null}
      <section><h3>What happened</h3><p>{report.happened}</p></section>
      {report.expected ? <section><h3>Expected result</h3><p>{report.expected}</p></section> : null}
      {report.steps ? <section><h3>Steps</h3><p>{report.steps}</p></section> : null}
      {report.workaround ? <section><h3>Workaround tried</h3><p>{report.workaround}</p></section> : null}
      {report.environment.diagnostics ? (
        <details className="report-browser-details">
          <summary>Browser and request details</summary>
          <pre>{JSON.stringify(report.environment.diagnostics, null, 2)}</pre>
        </details>
      ) : null}
      {(report.consoleLogs ?? []).length ? (
        <section>
          <h3>Console messages</h3>
          <ul>{report.consoleLogs?.map((entry, index) => (
            <li key={`${entry.timestamp}-${index}`}>
              <code className="report-console-message">[{entry.level}] {entry.message}</code>
            </li>
          ))}</ul>
        </section>
      ) : null}
    </div>
  );
}

function ResolutionView({ resolution }: { resolution: BugReportResolution }) {
  return (
    <div className="report-resolution-view">
      <h3>Approved resolution record</h3>
      <dl>
        <div><dt>Immediate safe action</dt><dd>{resolution.immediateSafeAction}</dd></div>
        <div><dt>Likely cause ({resolution.likelyCause.certainty})</dt><dd>{resolution.likelyCause.summary}</dd></div>
        <div><dt>Recommended resolution</dt><dd><ol>{resolution.recommendedResolution.map((step) => <li key={step}>{step}</li>)}</ol></dd></div>
        <div><dt>Verification</dt><dd>{resolution.verification}</dd></div>
        <div><dt>Fallback or rollback</dt><dd>{resolution.fallback}</dd></div>
        <div><dt>Needs admin input</dt><dd>{resolution.needsAdminInput}</dd></div>
        <div><dt>Missing evidence</dt><dd>{resolution.missingEvidence.length ? <ul>{resolution.missingEvidence.map((item) => <li key={item}>{item}</li>)}</ul> : "None"}</dd></div>
      </dl>
    </div>
  );
}

function WorkProgress({ progress, status }: { progress: BugReportProgress; status: BugReportStatus }) {
  const outdated = ["stale", "unavailable"].includes(progress.syncState);
  return (
    <section aria-labelledby="report-progress-title">
      <h3 id="report-progress-title">Work progress</h3>
      <ReportProgressSteps progress={progress} />
      <p role="status"><strong>{progress.label}</strong></p>
      <p>{progress.detail}</p>
      <p>Report status: {STATUS_LABELS[status]}</p>
      {outdated ? <InlineMessage tone="warning">Engineering updates are {progress.syncState === "unavailable" ? "unavailable" : "out of date"}. This is the last known progress.</InlineMessage> : null}
      {progress.lastSyncedAt ? <p>Engineering last checked: {dateLabel(progress.lastSyncedAt)}</p> : null}
      {progress.issues.length || progress.pullRequests.length ? (
        <ul aria-label="Linked engineering work">
          {progress.issues.map((item) => <li key={`issue-${item.number}`}>Issue #{item.number}: {item.state === "unavailable" ? "Status unavailable" : item.state === "closed" ? "Closed" : "Open"}</li>)}
          {progress.pullRequests.map((item) => <li key={`pull-${item.number}`}>Proposed fix #{item.number}: {item.state === "unavailable" ? "Status unavailable" : item.merged ? "Merged; live verification pending" : item.state === "closed" ? "Closed without merging" : item.draft ? "Draft in review" : "In review"}</li>)}
        </ul>
      ) : null}
    </section>
  );
}

function ReportDetail({ report, error, screenshot, screenshotPending, onLoadScreenshot, onNudge, nudgeAction }: {
  report: BugReportRecord | SharedBugReport;
  error: string | null;
  screenshot: string | null;
  screenshotPending: boolean;
  onLoadScreenshot: () => void;
  onNudge?: (reportId: string) => Promise<void>;
  nudgeAction?: ReportNudgeActionState;
}) {
  const returnPath = report.shared ? null : safeReturnPath(report);
  return (
    <article className="report-detail" aria-labelledby="report-detail-title">
      <header className="report-detail-head">
        <div><p className="report-kicker">{report.id}</p><h2 id="report-detail-title">{report.tryingToDo || report.happened}</h2></div>
        <StatusBadge tone={statusTone(report.status)}>{STATUS_LABELS[report.status]}</StatusBadge>
      </header>
      {report.severity === "blocker" ? <InlineMessage tone="error" title="Blocker">This report says work cannot continue.</InlineMessage> : null}
      {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}
      {report.progress ? <WorkProgress progress={report.progress} status={report.status} /> : null}
      {!report.shared && report.nudge && onNudge ? <ReportNudge state={report.nudge} label={report.tryingToDo || report.id} action={nudgeAction} onNudge={() => onNudge(report.id)} /> : null}
      {report.shared ? <p>Shared work progress. The reporter's original text, account details and private evidence are visible only to the reporter and administrators.</p> : <>
      {returnPath ? <p><Link to={returnPath}>Return to the affected CMS page</Link></p> : null}
      <section aria-labelledby="reported-facts-title"><h3 id="reported-facts-title">Observed facts</h3><Facts report={report} /></section>
      <section aria-labelledby="reporter-text-title"><h3 id="reporter-text-title">Reporter text</h3><ReportText report={report} /></section>
      {report.evidence.screenshot ? (
        <section aria-labelledby="report-screenshot-title" className="report-screenshot">
          <h3 id="report-screenshot-title">Screenshot</h3>
          {screenshot ? <img alt="Screenshot supplied with this problem report" src={screenshot} width={report.evidence.screenshot.width} height={report.evidence.screenshot.height} /> : <AsyncActionButton label="Show private screenshot" pending={screenshotPending} pendingLabel="Loading screenshot" onClick={onLoadScreenshot} />}
          <p>Private evidence expires after {dateLabel(report.evidence.screenshot.expiresAt)}.</p>
        </section>
      ) : null}
      <ResolutionView resolution={report.actionableResolution} />
      </>}
    </article>
  );
}

function IssueDetail({ issue, error }: { issue: GithubIssueRecord; error: string | null }) {
  return (
    <article className="report-detail" aria-labelledby="report-detail-title">
      <header className="report-detail-head">
        <div>
          <p className="report-kicker">#{issue.number}</p>
          <h2 id="report-detail-title">{issue.title}</h2>
        </div>
        <StatusBadge tone={issueTone(issue.state)}>{issue.state === "closed" ? "Closed" : "Open"}</StatusBadge>
      </header>
      {error ? <InlineMessage tone="error">{error}</InlineMessage> : null}
      <p>
        <a href={issue.htmlUrl} target="_blank" rel="noreferrer">Open on GitHub</a>
        {issue.author ? ` · ${issue.author}` : ""}
        {` · Updated ${dateLabel(issue.updatedAt)}`}
      </p>
      {issue.labels.length ? (
        <ul className="report-issue-labels">
          {issue.labels.map((label) => <li key={label}>{label}</li>)}
        </ul>
      ) : null}
      <section aria-labelledby="issue-body-title">
        <h3 id="issue-body-title">Description</h3>
        <div className="report-provided-text">
          <section>
            <p className="report-github-body">{issue.body || "No description."}</p>
          </section>
        </div>
      </section>
      <section aria-labelledby="issue-comments-title">
        <h3 id="issue-comments-title">Comments</h3>
        {issue.commentsTruncated ? (
          <InlineMessage tone="warning">Showing the first 50 comments.</InlineMessage>
        ) : null}
        {issue.comments.length === 0 ? <p>No comments.</p> : (
          <ol className="report-github-comments">
            {issue.comments.map((comment) => (
              <li key={comment.id}>
                <p className="report-kicker">{comment.author} · {dateLabel(comment.createdAt)}</p>
                <p className="report-github-body">{comment.body || "No comment text."}</p>
              </li>
            ))}
          </ol>
        )}
      </section>
    </article>
  );
}

function ConnectedReports() {
  const { principal, getIdToken } = useShell();
  const location = useLocation();
  const navigate = useNavigate();
  const admin = canManageSettings(principal);
  const selectedReportId = addressedReportId(location.pathname);
  const selectedIssueNumber = admin ? addressedGithubNumber(location.pathname) : null;
  const [listView, setListView] = useState<"all" | "github" | "mine">(selectedIssueNumber ? "github" : "mine");
  const [sharedReportsActive, setSharedReportsActive] = useState(false);
  const githubView = admin && listView === "github" && !selectedReportId;
  const reportListView = (admin || sharedReportsActive) && listView === "all" ? "all" : "mine";
  const [repository, setRepository] = useState<string | null>(null);
  const [issueState, setIssueState] = useState<GithubIssueStateFilter>("open");
  const [issues, setIssues] = useState<GithubIssueSummary[]>([]);
  const [issuesTruncated, setIssuesTruncated] = useState(false);
  const [issue, setIssue] = useState<GithubIssueRecord | null>(null);
  const [reports, setReports] = useState<BugReportSummary[]>([]);
  const [listTruncated, setListTruncated] = useState(false);
  const [report, setReport] = useState<BugReportRecord | SharedBugReport | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const loading = listLoading || detailLoading;
  const [listError, setListError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);
  const error = detailError || listError || screenshotError;
  const listPendingRef = useRef(false);
  const detailPendingRef = useRef(false);
  const lastReadAttemptRef = useRef(0);
  const viewedReportIdRef = useRef<string | null>(null);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [screenshotPending, setScreenshotPending] = useState(false);
  const selectedReportIdRef = useRef(selectedReportId);
  const selectedIssueNumberRef = useRef(selectedIssueNumber);
  const listRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const screenshotRequestRef = useRef(0);
  const nudgeRequestRef = useRef(0);
  const nudgeSnapshotsRef = useRef(new Map<string, BugReportNudge>());
  const nudgeActionsRef = useRef(new Map<string, { mutationId: string; requestedAt: string | null; promise?: Promise<void> }>());
  const [nudgeActions, setNudgeActions] = useState<Record<string, ReportNudgeActionState>>({});
  selectedReportIdRef.current = selectedReportId;
  selectedIssueNumberRef.current = selectedIssueNumber;

  const clearPrivateView = useCallback(() => {
    ++listRequestRef.current;
    ++detailRequestRef.current;
    ++screenshotRequestRef.current;
    ++nudgeRequestRef.current;
    listPendingRef.current = false;
    detailPendingRef.current = false;
    setListLoading(false);
    setDetailLoading(false);
    setReports([]);
    setIssues([]);
    setReport(null);
    setIssue(null);
    setScreenshot(null);
    setScreenshotPending(false);
    setSharedReportsActive(false);
    nudgeSnapshotsRef.current.clear();
    nudgeActionsRef.current.clear();
    setNudgeActions({});
  }, []);

  const loadList = useCallback(async () => {
    const requestNumber = ++listRequestRef.current;
    if (!getIdToken) return;
    listPendingRef.current = true;
    lastReadAttemptRef.current = Date.now();
    setListLoading(true);
    setListError(null);
    try {
      const token = await getIdToken();
      if (githubView) {
        const response = await cmsListGithubIssues(token, issueState);
        if (requestNumber !== listRequestRef.current) return;
        setRepository(response.repository);
        setIssues(response.issues);
        setIssuesTruncated(response.truncated);
        setReports([]);
        setListTruncated(false);
      } else {
        const response = await cmsListBugReports(token, reportListView);
        if (requestNumber !== listRequestRef.current) return;
        if (response.repository) setRepository(response.repository);
        setReports(response.reports.map((entry) => acceptNudge(entry, nudgeSnapshotsRef.current)));
        setSharedReportsActive(response.sharedReportsActive === true);
        setListTruncated(response.truncated);
        setIssues([]);
        setIssuesTruncated(false);
      }
    } catch (loadError) {
      if (requestNumber !== listRequestRef.current) return;
      if (loadError instanceof HttpError && [401, 403].includes(loadError.status)) clearPrivateView();
      setListError(loadError instanceof Error ? loadError.message : githubView
        ? "GitHub issues could not be loaded."
        : "Reports could not be loaded.");
    } finally {
      if (requestNumber === listRequestRef.current) {
        listPendingRef.current = false;
        setListLoading(false);
      }
    }
  }, [getIdToken, githubView, reportListView, issueState, clearPrivateView]);

  const loadDetail = useCallback(async () => {
    const requestNumber = ++detailRequestRef.current;
    const requestedReportId = selectedReportId;
    const requestedIssueNumber = selectedIssueNumber;
    if (!getIdToken) return;
    if (!requestedReportId && !requestedIssueNumber) {
      setReport(null);
      setIssue(null);
      setDetailLoading(false);
      detailPendingRef.current = false;
      setDetailError(null);
      return;
    }
    detailPendingRef.current = true;
    lastReadAttemptRef.current = Date.now();
    setDetailLoading(true);
    setDetailError(null);
    if (viewedReportIdRef.current !== requestedReportId) {
      viewedReportIdRef.current = requestedReportId;
      ++screenshotRequestRef.current;
      setScreenshotPending(false);
      setScreenshot(null);
      setScreenshotError(null);
    }
    setReport((previous) => previous?.id === requestedReportId ? previous : null);
    setIssue((previous) => previous?.number === requestedIssueNumber ? previous : null);
    try {
      const token = await getIdToken();
      if (requestedIssueNumber) {
        const response = await cmsGetGithubIssue(token, requestedIssueNumber);
        if (requestNumber !== detailRequestRef.current || selectedIssueNumberRef.current !== requestedIssueNumber) return;
        setIssue(response.issue);
        setReport(null);
      } else if (requestedReportId) {
        const response = await cmsGetBugReport(token, requestedReportId);
        if (requestNumber !== detailRequestRef.current || selectedReportIdRef.current !== requestedReportId) return;
        setReport(acceptNudge(response.report, nudgeSnapshotsRef.current));
        setIssue(null);
      }
    } catch (loadError) {
      if (requestNumber !== detailRequestRef.current) return;
      if (requestedIssueNumber && selectedIssueNumberRef.current !== requestedIssueNumber) return;
      if (requestedReportId && selectedReportIdRef.current !== requestedReportId) return;
      if (loadError instanceof HttpError && [401, 403].includes(loadError.status)) clearPrivateView();
      else if (loadError instanceof HttpError && loadError.status === 404) {
        setReport(null);
        setIssue(null);
        setReports((previous) => previous.filter((item) => item.id !== requestedReportId));
        setIssues((previous) => previous.filter((item) => item.number !== requestedIssueNumber));
        ++screenshotRequestRef.current;
        setScreenshot(null);
        setScreenshotPending(false);
      }
      setDetailError(loadError instanceof Error ? loadError.message : "The selected item could not be loaded.");
    } finally {
      if (requestNumber === detailRequestRef.current) {
        detailPendingRef.current = false;
        setDetailLoading(false);
      }
    }
  }, [getIdToken, selectedIssueNumber, selectedReportId, clearPrivateView]);

  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => { void loadDetail(); }, [loadDetail]);

  async function loadScreenshot() {
    if (!getIdToken || !report || report.shared) return;
    const requestedId = report.id;
    const requestNumber = ++screenshotRequestRef.current;
    setScreenshotPending(true);
    setScreenshotError(null);
    try {
      const token = await getIdToken();
      const response = await cmsGetBugReportEvidence(token, requestedId);
      if (requestNumber !== screenshotRequestRef.current || selectedReportIdRef.current !== requestedId) return;
      setScreenshot(`data:${response.mimeType};base64,${response.base64}`);
    } catch (loadError) {
      if (requestNumber !== screenshotRequestRef.current || selectedReportIdRef.current !== requestedId) return;
      if (loadError instanceof HttpError && [401, 403].includes(loadError.status)) clearPrivateView();
      setScreenshotError(loadError instanceof Error ? loadError.message : "The screenshot could not be loaded.");
    } finally {
      if (requestNumber === screenshotRequestRef.current && selectedReportIdRef.current === requestedId) {
        setScreenshotPending(false);
      }
    }
  }

  function nudgeReport(reportId: string): Promise<void> {
    if (!getIdToken || !sharedReportsActive) return Promise.resolve();
    let existing = nudgeActionsRef.current.get(reportId);
    if (existing?.promise) return existing.promise;
    const snapshot = nudgeSnapshotsRef.current.get(reportId);
    // A fresh read can confirm an uncertain prior send. Its next request needs
    // a new key once eligible, rather than replaying the accepted old receipt.
    if (snapshot?.requestedAt && snapshot.requestedAt !== existing?.requestedAt) existing = undefined;
    const action: { mutationId: string; requestedAt: string | null; promise?: Promise<void> } = existing ?? {
      mutationId: crypto.randomUUID(), requestedAt: snapshot?.requestedAt ?? null,
    };
    nudgeActionsRef.current.set(reportId, action);
    setNudgeActions((current) => ({ ...current, [reportId]: { pending: true, error: null } }));
    const request = nudgeRequestRef.current;
    action.promise = Promise.resolve().then(async () => {
      let error: string | null = null;
      let succeeded = false;
      try {
        const token = await getIdToken();
        if (request !== nudgeRequestRef.current) return;
        const response = await cmsNudgeBugReport(token, reportId, action.mutationId);
        succeeded = true;
        if (request !== nudgeRequestRef.current || response.nudge.version < (nudgeSnapshotsRef.current.get(reportId)?.version ?? 0)) return;
        nudgeSnapshotsRef.current.set(reportId, response.nudge);
        setReports((current) => current.map((entry) => entry.id === reportId ? { ...entry, nudge: response.nudge } : entry));
        setReport((current) => current?.id === reportId && !current.shared ? { ...current, nudge: response.nudge } : current);
      } catch (failure) {
        error = failure instanceof Error ? failure.message : "The nudge could not be queued. Try again.";
        if (request === nudgeRequestRef.current && failure instanceof HttpError && [401, 403].includes(failure.status)) clearPrivateView();
        throw failure;
      } finally {
        if (request === nudgeRequestRef.current && nudgeActionsRef.current.get(reportId) === action) {
          action.promise = undefined;
          if (succeeded) nudgeActionsRef.current.delete(reportId);
          setNudgeActions((current) => ({ ...current, [reportId]: { pending: false, error, version: snapshot?.version } }));
        }
      }
    });
    return action.promise;
  }

  const activeReports = reports.some((item) => item.progress?.active ?? !["resolved", "dismissed"].includes(item.status));
  const activeView = githubView ? issueState !== "closed" : activeReports || Boolean(report?.progress?.active);
  useEffect(() => {
    const refresh = (automatic = false) => {
      if (document.visibilityState !== "visible" || !navigator.onLine ||
          listPendingRef.current || detailPendingRef.current ||
          Date.now() - lastReadAttemptRef.current < 15_000 || (automatic && !activeView)) return;
      void Promise.all([loadList(), loadDetail()]);
    };
    const onFocus = () => refresh();
    const interval = window.setInterval(() => refresh(true), 60_000);
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [activeView, loadList, loadDetail]);

  useEffect(() => () => {
    ++listRequestRef.current;
    ++detailRequestRef.current;
    ++screenshotRequestRef.current;
    ++nudgeRequestRef.current;
  }, []);

  const selectedId = selectedReportId || (selectedIssueNumber ? String(selectedIssueNumber) : null);

  return (
    <div className="reports-route">
      <div className="surface-intro route-page-intro">
        <div>
          <h2>Reports</h2>
          <p>{admin
            ? `Follow your reports, all staff reports and GitHub issues${repository ? ` for ${repository}` : ""}.`
            : sharedReportsActive
              ? "Follow your problem reports and shared staff work progress."
              : "Follow your problem reports."}</p>
        </div>
      </div>
      <div className="reports-toolbar">
        <Link className="button" to={`${ROUTE_PATHS.reports}/usage`}>Boardwalk usage analytics</Link>
        {(admin || sharedReportsActive) ? (
          <div className="reports-view-tabs" role="group" aria-label="Report view">
            <span className="reports-toolbar-label" aria-hidden="true">View</span>
            <Button
              aria-pressed={!githubView && reportListView === "mine"}
              onClick={() => { setListView("mine"); navigate(reportsPath()); }}
            >My reports</Button>
            <Button
              aria-pressed={!githubView && reportListView === "all"}
              onClick={() => { setListView("all"); navigate(reportsPath()); }}
            >
              All reports
            </Button>
            {admin ? <Button
              aria-pressed={githubView}
              onClick={() => { setListView("github"); navigate(reportsPath()); }}
            >
              GitHub issues
            </Button> : null}
          </div>
        ) : null}
        {githubView ? (
          <div className="reports-view-tabs" role="group" aria-label="Issue status">
            <span className="reports-toolbar-label" aria-hidden="true">Status</span>
            {ISSUE_STATE_FILTERS.map((state) => (
              <Button
                key={state}
                aria-pressed={issueState === state}
                onClick={() => { setIssueState(state); navigate(reportsPath()); }}
              >
                {state === "all" ? "All" : state === "closed" ? "Closed" : "Open"}
              </Button>
            ))}
          </div>
        ) : null}
        <Button disabled={loading} onClick={() => void Promise.all([loadList(), loadDetail()])}>
          {loading ? "Refreshing" : "Refresh"}
        </Button>
      </div>
      {(listError || detailError) ? <InlineMessage tone="warning">Last shown information may be out of date. {listError || detailError} Use Refresh to try again.</InlineMessage> : null}
      {screenshotError && !report && !issue ? <InlineMessage tone="error">{screenshotError}</InlineMessage> : null}
      {loading && !report && !issue ? (
        <LoadingIndicator
          label={githubView ? "Loading GitHub issues" : "Loading reports"}
          stages={githubView
            ? ["Asking GitHub for issues", "Sorting by most recently updated"]
            : ["Asking the CMS for problem reports", "Sorting by most recent"]}
        />
      ) : null}
      <div className={selectedId ? "reports-layout reports-layout-detail" : "reports-layout"}>
        <section className="reports-list" aria-labelledby="reports-list-title">
          <div className="reports-list-heading">
            <h2 id="reports-list-title">{githubView ? "GitHub issues" : reportListView === "all" ? "All reports" : "My reports"}</h2>
            {!loading && !(githubView && issuesTruncated) ? (
              <span className="reports-list-count">
                {githubView ? `${issues.length} shown` : `${reports.length} shown`}
              </span>
            ) : null}
            {githubView && issuesTruncated && !loading ? (
              <span className="reports-list-limit">Showing the 100 most recently updated issues. Older issues are not shown.</span>
            ) : null}
          </div>
          {!githubView && listTruncated ? (
            <InlineMessage tone="warning">Showing the newest 100 reports. Older reports are not shown.</InlineMessage>
          ) : null}
          {githubView
            ? <IssueRows issues={issues} selectedNumber={selectedIssueNumber} />
            : <ReportRows reports={reports} selectedId={selectedReportId} nudgeActions={nudgeActions} onNudge={sharedReportsActive ? nudgeReport : undefined} />}
        </section>
        {selectedIssueNumber && issue ? <IssueDetail issue={issue} error={error} /> : null}
        {selectedReportId && report ? (
          <ReportDetail
            report={report}
            error={error}
            screenshot={screenshot}
            screenshotPending={screenshotPending}
            onLoadScreenshot={() => void loadScreenshot()}
            onNudge={sharedReportsActive ? nudgeReport : undefined}
            nudgeAction={nudgeActions[report.id]}
          />
        ) : null}
      </div>
    </div>
  );
}

function ReportsContents() {
  const usage = useLocation().pathname === `${ROUTE_PATHS.reports}/usage`;
  return usage ? <Suspense fallback={<LoadingIndicator label="Opening Boardwalk usage" />}>
    <BoardwalkUsageRoute />
  </Suspense> : <ConnectedReports />;
}

export function ReportsRoute() {
  const { principal, user } = useShell();
  const accessKey = `${user.uid}:${principal.id}:${canManageSettings(principal)}:${canViewReports(principal)}`;
  return (
    <RequireCapability allowed={canViewReports} notice="Your account does not have access to reports.">
      <ReportsContents key={accessKey} />
    </RequireCapability>
  );
}
