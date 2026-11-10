import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReportsRoute } from "../src/routes/ReportsRoute";
import { ShellProvider, type ShellData } from "../src/routes/ShellContext";
import { HttpError, type BugReportRecord, type GithubIssueRecord } from "../src/lib/functions";

const mocks = vi.hoisted(() => ({
  cmsListBugReports: vi.fn(),
  cmsGetBugReport: vi.fn(),
  cmsGetBugReportEvidence: vi.fn(),
  cmsListGithubIssues: vi.fn(),
  cmsGetGithubIssue: vi.fn(),
  cmsNudgeBugReport: vi.fn(),
}));
vi.mock("../src/lib/functions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/functions")>()),
  ...mocks,
}));

const ID = `br_${"a".repeat(32)}`;
const report: BugReportRecord = {
  apiVersion: 1,
  id: ID,
  severity: "blocker",
  area: "content_editing",
  tryingToDo: "Update the homepage lead",
  happened: "The save stopped.",
  expected: "The draft should save.",
  steps: "Open Home.\nSelect Save.",
  workaround: "Kept the editor open.",
  route: { path: "/content/pages/home/edit", url: "https://admin.njpbs.org/content/pages/home/edit" },
  affectedRecord: { kind: "page", id: "home", lifecycle: "draft", version: 7 },
  reporter: { uid: "editor-1", email: "account-9@example.org", role: "editor" },
  evidence: { screenshot: { id: ID, mimeType: "image/webp", sizeBytes: 20, width: 10, height: 10, sha256: "b".repeat(64), expiresAt: "2026-11-26T22:30:00.000Z" } },
  environment: { buildRevision: "c".repeat(40), deploymentEnvironment: "production", browser: "Chrome 140", operatingSystem: "Windows 11", viewport: { width: 1280, height: 720 }, online: true, timeZone: "America/New_York" },
  correlationIds: [],
  status: "open",
  actionableResolution: {
    immediateSafeAction: "Keep the editor open.",
    likelyCause: { certainty: "unknown", summary: "No cause is confirmed." },
    recommendedResolution: ["Compare the stored version."],
    verification: "The save succeeds.",
    fallback: "Keep the content unchanged.",
    needsAdminInput: "Choose the next diagnostic.",
    missingEvidence: ["No reproduction result."],
  },
  acknowledgedAt: null,
  assignedAt: null,
  resolvedAt: null,
  dismissedAt: null,
  version: 1,
  createdAt: "2026-08-28T22:30:00.000Z",
  updatedAt: "2026-08-28T22:30:00.000Z",
  ownerUid: null,
  acknowledgedBy: null,
  resolvedBy: null,
  dismissedBy: null,
  deliveryStatus: "pending",
  githubDelivery: { state: "not_linked", attemptCount: 0, lastAttemptAt: null, lastError: null, lastOperation: null, lastTargetNumber: null, lastSyncedAt: null, fixRequestedAt: null, fixStatus: "not_requested", fixSessionName: null, fixPullRequestUrl: null },
  links: { relatedReportIds: [], githubIssueNumbers: [], pullRequestNumbers: [], workflowRunUrls: [], deploymentRunUrls: [], githubIssues: [], pullRequests: [] },
};

const issue: GithubIssueRecord = {
  number: 1966,
  title: "Tighten broadcast schedule column alignment",
  state: "open",
  htmlUrl: "https://github.com/CenterCoopMedia/njpbs/issues/1966",
  updatedAt: "2026-09-18T13:46:43.000Z",
  createdAt: "2026-09-18T13:00:00.000Z",
  commentCount: 1,
  labels: ["type:bug"],
  author: "example-user",
  body: "The alignment of the columns is all over the place.",
  comments: [{
    id: 1,
    author: "example-user",
    createdAt: "2026-09-18T14:00:00.000Z",
    body: "This is still open.",
  }],
  commentsTruncated: false,
};

function shell(role: "admin" | "editor"): ShellData {
  return {
    principal: { id: `${role}-1`, grants: [{ role }] },
    user: { uid: `${role}-1`, email: `${role}@njpbs.org` } as ShellData["user"],
    userDoc: role === "admin" ? { role: "admin" } : { grants: [{ role: "editor" }] },
    signOut: vi.fn(),
    getIdToken: vi.fn(async () => "id-token"),
  } as ShellData;
}

function renderRoute(role: "admin" | "editor", path = "/reports") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ShellProvider value={shell(role)}>
        <ReportsRoute />
      </ShellProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cmsListBugReports.mockResolvedValue({ success: true, view: "mine", reports: [report], truncated: false, sharedReportsActive: true });
  mocks.cmsGetBugReport.mockResolvedValue({ success: true, report, audit: [], auditTruncated: false, canAdminister: false });
  mocks.cmsGetBugReportEvidence.mockResolvedValue({ success: true, mimeType: "image/webp", base64: "cHJpdmF0ZQ==", width: 10, height: 10 });
  mocks.cmsListGithubIssues.mockResolvedValue({ success: true, state: "open", issues: [issue], truncated: false });
  mocks.cmsGetGithubIssue.mockResolvedValue({ success: true, issue });
});

describe("ReportsRoute", () => {
  it("shares pending, retry identity and success across row and detail nudge controls", async () => {
    const initial = { version: 1, eligible: true, eligibleAt: report.createdAt, progressAt: report.createdAt, requestedAt: null, history: [], historyTruncated: false };
    const queued = { ...initial, version: 2, eligible: false, requestedAt: "2026-10-05T00:00:00Z", history: [{ requestedAt: "2026-10-05T00:00:00Z", delivery: "pending", decision: null, decidedAt: null }] };
    mocks.cmsListBugReports.mockResolvedValue({ reports: [{ ...report, nudge: initial }], sharedReportsActive: true, truncated: false });
    mocks.cmsGetBugReport.mockResolvedValue({ report: { ...report, nudge: initial }, audit: [], canAdminister: false });
    let fail!: (reason: Error) => void;
    mocks.cmsNudgeBugReport.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    renderRoute("editor", `/reports/${ID}`);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Nudge for Update the homepage lead" })).toHaveLength(2));
    const controls = screen.getAllByRole("button", { name: "Nudge for Update the homepage lead" });
    fireEvent.click(controls[0]);
    expect(controls.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    fireEvent.click(controls[1]);
    await waitFor(() => expect(mocks.cmsNudgeBugReport).toHaveBeenCalledOnce());
    const firstKey = mocks.cmsNudgeBugReport.mock.calls[0][2];
    await act(async () => fail(new Error("Temporary failure")));
    expect(screen.getAllByText(/Temporary failure/)).toHaveLength(2);
    expect(controls.every((button) => !(button as HTMLButtonElement).disabled)).toBe(true);
    mocks.cmsNudgeBugReport.mockResolvedValueOnce({ success: true, nudge: queued });
    fireEvent.click(controls[1]);
    await waitFor(() => expect(screen.queryAllByRole("button", { name: /Nudge for/ })).toHaveLength(0));
    expect(mocks.cmsNudgeBugReport).toHaveBeenCalledTimes(2);
    expect(mocks.cmsNudgeBugReport.mock.calls[1][2]).toBe(firstKey);
    expect(screen.queryByText(/Temporary failure|Use Nudge to retry/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/Nudge queued/)).toHaveLength(2);
    const eligibleAgain = { ...queued, version: 3, eligible: true };
    mocks.cmsListBugReports.mockResolvedValue({ reports: [{ ...report, nudge: eligibleAgain }], sharedReportsActive: true, truncated: false });
    mocks.cmsGetBugReport.mockResolvedValue({ report: { ...report, nudge: eligibleAgain }, audit: [], canAdminister: false });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Nudge for/ })).toHaveLength(2));
    mocks.cmsNudgeBugReport.mockResolvedValueOnce({ success: true, nudge: { ...queued, version: 4, requestedAt: "2026-10-09T00:00:00Z", history: [...queued.history, { ...queued.history[0], requestedAt: "2026-10-09T00:00:00Z" }] } });
    fireEvent.click(screen.getAllByRole("button", { name: /Nudge for/ })[0]);
    await waitFor(() => expect(mocks.cmsNudgeBugReport).toHaveBeenCalledTimes(3));
    expect(mocks.cmsNudgeBugReport.mock.calls[2][2]).not.toBe(firstKey);
  });
  it("uses a fresh key after a read confirms an uncertain request and hides its stale error", async () => {
    const initial = { version: 1, eligible: true, eligibleAt: report.createdAt, progressAt: report.createdAt, requestedAt: null, history: [], historyTruncated: false };
    const queued = { ...initial, version: 2, eligible: false, requestedAt: "2026-10-05T00:00:00Z", history: [{ requestedAt: "2026-10-05T00:00:00Z", delivery: "pending", decision: null, decidedAt: null }] };
    mocks.cmsListBugReports.mockResolvedValue({ reports: [{ ...report, nudge: initial }], sharedReportsActive: true, truncated: false });
    mocks.cmsGetBugReport.mockResolvedValue({ report: { ...report, nudge: initial }, audit: [], canAdminister: false });
    let fail!: (reason: Error) => void;
    mocks.cmsNudgeBugReport.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    renderRoute("editor", `/reports/${ID}`);
    fireEvent.click((await screen.findAllByRole("button", { name: /Nudge for/ }))[0]);
    await waitFor(() => expect(mocks.cmsNudgeBugReport).toHaveBeenCalledOnce());
    const firstKey = mocks.cmsNudgeBugReport.mock.calls[0][2];
    mocks.cmsListBugReports.mockResolvedValue({ reports: [{ ...report, nudge: queued }], sharedReportsActive: true, truncated: false });
    mocks.cmsGetBugReport.mockResolvedValue({ report: { ...report, nudge: queued }, audit: [], canAdminister: false });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
    await act(async () => fail(new Error("Uncertain response")));
    expect(screen.getAllByText(/Nudge queued/)).toHaveLength(2);
    expect(screen.queryByText(/Uncertain response|Use Nudge to retry/)).not.toBeInTheDocument();
    const eligibleAgain = { ...queued, version: 3, eligible: true };
    mocks.cmsListBugReports.mockResolvedValue({ reports: [{ ...report, nudge: eligibleAgain }], sharedReportsActive: true, truncated: false });
    mocks.cmsGetBugReport.mockResolvedValue({ report: { ...report, nudge: eligibleAgain }, audit: [], canAdminister: false });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Nudge for/ })).toHaveLength(2));
    expect(screen.queryByText(/Uncertain response|Use Nudge to retry/)).not.toBeInTheDocument();
    mocks.cmsNudgeBugReport.mockResolvedValueOnce({ success: true, nudge: { ...queued, version: 4, requestedAt: "2026-10-09T00:00:00Z", history: [...queued.history, { ...queued.history[0], requestedAt: "2026-10-09T00:00:00Z" }] } });
    fireEvent.click(screen.getAllByRole("button", { name: /Nudge for/ })[1]);
    await waitFor(() => expect(mocks.cmsNudgeBugReport).toHaveBeenCalledTimes(2));
    expect(mocks.cmsNudgeBugReport.mock.calls[1][2]).not.toBe(firstKey);
  });
  it("keeps newer delivery and decisions when an older nudge response or list arrives late", async () => {
    const initial = { version: 1, eligible: true, eligibleAt: report.createdAt, progressAt: report.createdAt, requestedAt: null, history: [], historyTruncated: false };
    const pending = { ...initial, version: 2, eligible: false, requestedAt: "2026-10-05T00:00:00Z", history: [{ requestedAt: "2026-10-05T00:00:00Z", delivery: "pending", decision: null, decidedAt: null }] };
    const approved = { ...pending, version: 4, history: [{ ...pending.history[0], delivery: "delivered", decision: "approved", decidedAt: "2026-10-05T00:01:00Z" }] };
    mocks.cmsListBugReports.mockResolvedValue({ reports: [{ ...report, nudge: initial }], sharedReportsActive: true, truncated: false });
    mocks.cmsGetBugReport.mockResolvedValue({ report: { ...report, nudge: initial }, audit: [], canAdminister: false });
    let finish!: (value: unknown) => void;
    mocks.cmsNudgeBugReport.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    renderRoute("editor", `/reports/${ID}`);
    fireEvent.click((await screen.findAllByRole("button", { name: "Nudge for Update the homepage lead" }))[0]);
    mocks.cmsListBugReports.mockResolvedValue({ reports: [{ ...report, nudge: approved }], sharedReportsActive: true, truncated: false });
    mocks.cmsGetBugReport.mockResolvedValue({ report: { ...report, nudge: approved }, audit: [], canAdminister: false });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
    await act(async () => finish({ success: true, nudge: pending }));
    expect(screen.getAllByText(/Follow-up approved and requested/)).toHaveLength(2);
    mocks.cmsListBugReports.mockResolvedValue({ reports: [{ ...report, nudge: pending }], sharedReportsActive: true, truncated: false });
    mocks.cmsGetBugReport.mockResolvedValue({ report: { ...report, nudge: pending }, audit: [], canAdminister: false });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
    expect(screen.getAllByText(/Follow-up approved and requested/)).toHaveLength(2);
  });
  it("offers shared All reports after the gate and keeps other staff's detail private", async () => {
    const progress = { phase: "merged" as const, label: "Merged; live verification pending", detail: "Live verification is pending.", active: true,
      updatedAt: report.createdAt, lastSyncedAt: report.createdAt, syncState: "current" as const, issues: [], pullRequests: [], deployment: "unverified" as const };
    const shared = { shared: true, id: ID, severity: "minor", status: "open", createdAt: report.createdAt,
      tryingToDo: "Content editing report", happened: "", progress };
    mocks.cmsListBugReports.mockResolvedValue({ reports: [shared], sharedReportsActive: true, truncated: false });
    mocks.cmsGetBugReport.mockResolvedValue({ report: shared, audit: [], canAdminister: false });
    renderRoute("editor", `/reports/${ID}`);
    expect(await screen.findByRole("heading", { name: "Content editing report" })).toBeVisible();
    expect(screen.queryByText(report.happened)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show private screenshot" })).not.toBeInTheDocument();
    expect(screen.queryByText(report.reporter.email!)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Observed facts" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("list", { name: "Report progress" })).toHaveLength(2);
    expect(screen.getAllByText("Fix released").every((label) => label.closest("li")?.dataset.state === "ahead")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "All reports" }));
    await waitFor(() => expect(mocks.cmsListBugReports).toHaveBeenCalledWith("id-token", "all"));
    expect(mocks.cmsGetBugReportEvidence).not.toHaveBeenCalled();
  });
  it("defaults administrators to My reports and defers GitHub until requested", async () => {
    renderRoute("admin");
    expect(await screen.findByRole("heading", { name: "My reports" })).toBeVisible();
    expect(await screen.findByRole("link", { name: /Update the homepage lead/ })).toBeVisible();
    expect(screen.getByText("Follow your reports, all staff reports and GitHub issues.")).toBeVisible();
    expect(screen.queryByText(/configured-owner\/configured-repo/)).not.toBeInTheDocument();
    expect(mocks.cmsListBugReports).toHaveBeenCalledWith("id-token", "mine");
    expect(mocks.cmsListGithubIssues).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "My reports" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "GitHub issues" }));
    expect(await screen.findByRole("link", { name: /Tighten broadcast schedule column alignment/ })).toBeVisible();
    expect(mocks.cmsListGithubIssues).toHaveBeenCalledWith("id-token", "open");
  });

  it("loads administrator All reports and shows its actual repository", async () => {
    renderRoute("admin");
    await screen.findByRole("heading", { name: "My reports" });
    await screen.findByRole("link", { name: /Update the homepage lead/ });
    mocks.cmsListBugReports.mockResolvedValue({ success: true, view: "all", reports: [report], truncated: false,
      sharedReportsActive: true, repository: "configured-owner/configured-repo" });
    fireEvent.click(screen.getByRole("button", { name: "All reports" }));
    await waitFor(() => expect(mocks.cmsListBugReports).toHaveBeenCalledWith("id-token", "all"));
    expect(await screen.findByText(/GitHub issues for configured-owner\/configured-repo/)).toBeVisible();
    expect(screen.getByRole("heading", { name: "All reports" })).toBeVisible();
  });

  it("describes only own reports before shared access is activated", async () => {
    mocks.cmsListBugReports.mockResolvedValue({ success: true, view: "mine", reports: [report], truncated: false, sharedReportsActive: false });
    renderRoute("editor");
    await screen.findByRole("link", { name: /Update the homepage lead/ });
    expect(screen.getByText("Follow your problem reports.")).toBeVisible();
    expect(screen.queryByText(/shared staff work progress/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "All reports" })).not.toBeInTheDocument();
  });

  it("does not load reports or evidence without reports.view", () => {
    // Viewers have reports.view under #2867; an account without grants remains denied.
    const denied = { ...shell("editor"), principal: { id: "unapproved-1", grants: [] } };
    render(<MemoryRouter initialEntries={[`/reports/${ID}`]}>
      <ShellProvider value={denied}><ReportsRoute /></ShellProvider>
    </MemoryRouter>);
    expect(mocks.cmsListBugReports).not.toHaveBeenCalled();
    expect(mocks.cmsGetBugReport).not.toHaveBeenCalled();
    expect(mocks.cmsGetBugReportEvidence).not.toHaveBeenCalled();
    expect(mocks.cmsListGithubIssues).not.toHaveBeenCalled();
  });
  it("shows open GitHub issues and their description and comments for administrators", async () => {
    renderRoute("admin", "/reports/1966");

    expect(await screen.findByRole("heading", { name: "Tighten broadcast schedule column alignment" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Open on GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/CenterCoopMedia/njpbs/issues/1966",
    );
    expect(screen.getByText("The alignment of the columns is all over the place.")).toBeVisible();
    expect(screen.getByText("This is still open.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("heading", { name: "Administrator actions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "File issue" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Acknowledge" })).not.toBeInTheDocument();
    expect(mocks.cmsListGithubIssues).toHaveBeenCalledWith("id-token", "open");
    expect(mocks.cmsGetGithubIssue).toHaveBeenCalledWith("id-token", 1966);
    expect(mocks.cmsListBugReports).not.toHaveBeenCalled();
  });

  it("lets an administrator open their own filed reports", async () => {
    renderRoute("admin");
    expect(await screen.findByRole("heading", { name: "My reports" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "My reports" }));

    expect(await screen.findByRole("heading", { name: "My reports" })).toBeVisible();
    expect(await screen.findByRole("link", { name: /Update the homepage lead/ })).toBeVisible();
    expect(mocks.cmsListBugReports).toHaveBeenCalledWith("id-token", "mine");
  });

  it("does not replace a newer GitHub filter with an older in-flight list", async () => {
    let resolveOpen: ((value: unknown) => void) | undefined;
    const openResponse = new Promise((resolve) => { resolveOpen = resolve; });
    mocks.cmsListGithubIssues.mockImplementation((_token, state) => {
      if (state === "open") return openResponse;
      return Promise.resolve({
        success: true,
        state: "closed",
        issues: [{ ...issue, number: 1874, title: "Widen the video modal", state: "closed" as const }],
        truncated: false,
      });
    });
    renderRoute("admin");
    fireEvent.click(screen.getByRole("button", { name: "GitHub issues" }));

    fireEvent.click(await screen.findByRole("button", { name: "Closed" }));
    expect(await screen.findByRole("link", { name: /Widen the video modal/ })).toBeVisible();
    resolveOpen?.({ success: true, state: "open", issues: [issue], truncated: false });

    await waitFor(() => expect(screen.queryByRole("link", {
      name: /Tighten broadcast schedule column alignment/,
    })).not.toBeInTheDocument());
  });

  it("loads closed GitHub issues when that status is selected", async () => {
    mocks.cmsListGithubIssues.mockResolvedValue({
      success: true,
      state: "closed",
      issues: [{ ...issue, number: 1874, title: "Widen the video modal", state: "closed" as const }],
      truncated: false,
    });
    renderRoute("admin");
    fireEvent.click(screen.getByRole("button", { name: "GitHub issues" }));

    fireEvent.click(await screen.findByRole("button", { name: "Closed" }));

    expect(await screen.findByRole("link", { name: /Widen the video modal/ })).toBeVisible();
    expect(mocks.cmsListGithubIssues).toHaveBeenLastCalledWith("id-token", "closed");
  });

  it("keeps non-admin staff on their own reports without GitHub or triage controls", async () => {
    const { ownerUid: _ownerUid, ...reporterReport } = report;
    mocks.cmsGetBugReport.mockResolvedValue({
      success: true,
      report: { ...reporterReport, reporter: { uid: "editor-1", role: "editor" } },
      audit: [],
      auditTruncated: false,
      canAdminister: false,
    });
    renderRoute("editor", `/reports/${ID}`);

    expect(await screen.findByRole("heading", { name: "Update the homepage lead" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "My reports" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Admin queue" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Administrator actions" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Approved resolution record" })).toBeVisible();
    expect(mocks.cmsListBugReports).toHaveBeenCalledWith("id-token", "mine");
    expect(mocks.cmsListGithubIssues).not.toHaveBeenCalled();
  });

  it("preserves and wraps multiline console evidence on a filed report", async () => {
    const withConsole = {
      ...report,
      consoleLogs: [{
        level: "error" as const,
        message: `First line\n${"long-token".repeat(60)}`,
        timestamp: report.createdAt,
      }],
    };
    mocks.cmsGetBugReport.mockResolvedValue({
      success: true,
      report: withConsole,
      audit: [],
      auditTruncated: false,
      canAdminister: false,
    });

    renderRoute("editor", `/reports/${ID}`);

    const consoleMessage = await screen.findByText(/\[error\] First line/);
    expect(consoleMessage).toHaveClass("report-console-message");
  });

  it("explains the bounded GitHub window beside the list heading", async () => {
    mocks.cmsListGithubIssues.mockResolvedValue({ success: true, state: "open", issues: [issue], truncated: true });
    renderRoute("admin");
    fireEvent.click(screen.getByRole("button", { name: "GitHub issues" }));

    const limit = await screen.findByText("Showing the 100 most recently updated issues. Older issues are not shown.");
    expect(limit).toBeVisible();
    expect(limit.closest('[role="status"], [role="alert"], [aria-live="polite"], [aria-live="assertive"]')).toBeNull();
    expect(screen.queryByText("1 shown")).not.toBeInTheDocument();
  });

  it("shows an accessible two-line issue update and labeled view controls", async () => {
    renderRoute("admin");
    fireEvent.click(screen.getByRole("button", { name: "GitHub issues" }));
    const issueRow = await screen.findByRole("row", { name: /Tighten broadcast schedule column alignment/ });
    const updated = issueRow.querySelector<HTMLTableCellElement>('td[data-label="Updated"]')!;
    const timestamp = updated.querySelector("time")!;
    expect(timestamp).toHaveAttribute("datetime", issue.updatedAt);
    const spokenTimestamp = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(new Date(issue.updatedAt!));
    expect(within(timestamp).getByText(spokenTimestamp, { exact: true })).not.toHaveAttribute("aria-hidden", "true");
    expect(timestamp).toHaveTextContent("Sep 18, 2026");
    expect(timestamp).toHaveTextContent(new Intl.DateTimeFormat("en-US", { timeStyle: "short" }).format(new Date(issue.updatedAt!)));
    expect(screen.getByRole("group", { name: "Report view" })).toHaveTextContent("View");
    expect(screen.getByRole("group", { name: "Issue status" })).toHaveTextContent("Status");
  });

  it("refreshes the selected GitHub issue and the list together", async () => {
    renderRoute("admin", "/reports/1966");
    expect(await screen.findByRole("heading", { name: "Tighten broadcast schedule column alignment" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(mocks.cmsListGithubIssues).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mocks.cmsGetGithubIssue).toHaveBeenCalledTimes(2));
  });

  it("does not replace a newly selected issue with an older response", async () => {
    const second = { ...issue, number: 1696, title: "Add more donate paths" };
    let resolveFirst: ((value: unknown) => void) | undefined;
    const firstResponse = new Promise((resolve) => { resolveFirst = resolve; });
    mocks.cmsListGithubIssues.mockResolvedValue({
      success: true,
      state: "open",
      issues: [issue, second],
      truncated: false,
    });
    mocks.cmsGetGithubIssue.mockImplementation((_token, number) => {
      if (number === 1966) return firstResponse;
      return Promise.resolve({ success: true, issue: second });
    });
    renderRoute("admin", "/reports/1966");

    fireEvent.click(await screen.findByRole("link", { name: /Add more donate paths/ }));
    expect(await screen.findByRole("heading", { name: "Add more donate paths" })).toBeVisible();
    resolveFirst?.({ success: true, issue });

    await waitFor(() => expect(screen.queryByRole("heading", {
      name: "Tighten broadcast schedule column alignment",
    })).not.toBeInTheDocument());
  });
});


const safeProgress = {
  phase: "merged", label: "Merged; live verification pending",
  detail: "The code change is merged. The live fix has not been verified.",
  active: true, updatedAt: report.updatedAt, lastSyncedAt: report.updatedAt,
  syncState: "current", issues: [{ number: 2835, state: "closed" }],
  pullRequests: [{ number: 2845, state: "closed", draft: false, merged: true, reviewState: "approved", checksState: "success" }],
  deployment: "unverified",
} as const;

describe("report progress and freshness", () => {
  afterEach(() => vi.useRealTimers());
  it("shows safe engineering progress without replacing the report resolution", async () => {
    mocks.cmsGetBugReport.mockResolvedValue({ success: true, report: { ...report, progress: safeProgress }, audit: [], canAdminister: false });
    renderRoute("editor", `/reports/${ID}`);
    expect(await screen.findByRole("heading", { name: "Work progress" })).toBeVisible();
    expect(within(screen.getByRole("status")).getByText(safeProgress.label)).toBeVisible();
    expect(screen.getByText(safeProgress.detail)).toBeVisible();
    expect(screen.getByText("Report status: Open")).toBeVisible();
    expect(screen.queryByRole("link", { name: /GitHub/ })).not.toBeInTheDocument();
  });
  it("keeps the last report visible and marks a failed refresh as stale", async () => {
    renderRoute("editor", `/reports/${ID}`);
    expect(await screen.findByRole("heading", { name: "Update the homepage lead" })).toBeVisible();
    mocks.cmsGetBugReport.mockRejectedValue(new Error("Report service unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(/Last shown information may be out of date/)).toBeVisible();
    expect(screen.getByRole("heading", { name: "Update the homepage lead" })).toBeVisible();
  });
  it("refreshes visible work once per minute and coalesces focus events", async () => {
    vi.useFakeTimers();
    await act(async () => { renderRoute("editor", `/reports/${ID}`); });
    expect(mocks.cmsListBugReports).toHaveBeenCalledTimes(1);
    expect(mocks.cmsGetBugReport).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(mocks.cmsListBugReports).toHaveBeenCalledTimes(2);
    expect(mocks.cmsGetBugReport).toHaveBeenCalledTimes(2);
    await act(async () => { fireEvent.focus(window); fireEvent.focus(window); });
    expect(mocks.cmsListBugReports).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); fireEvent.focus(window); });
    expect(mocks.cmsListBugReports).toHaveBeenCalledTimes(3);
    expect(mocks.cmsGetBugReport).toHaveBeenCalledTimes(3);
  });
  it("does not poll while hidden or reload private screenshot evidence", async () => {
    vi.useFakeTimers();
    await act(async () => { renderRoute("editor", `/reports/${ID}`); });
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(mocks.cmsListBugReports).toHaveBeenCalledTimes(1);
    expect(mocks.cmsGetBugReportEvidence).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    await act(async () => { fireEvent(document, new Event("visibilitychange")); });
    expect(mocks.cmsListBugReports).toHaveBeenCalledTimes(2);
    visibility.mockRestore();
  });
});


describe("report account boundary", () => {
  it("clears prior administrator details and rejects a pending screenshot after a permission change", async () => {
    let resolveEvidence: ((value: unknown) => void) | undefined;
    mocks.cmsGetBugReportEvidence.mockImplementation(() => new Promise((resolve) => { resolveEvidence = resolve; }));
    const adminShell = shell("admin");
    const view = render(<MemoryRouter initialEntries={[`/reports/${ID}`]}><ShellProvider value={adminShell}><ReportsRoute /></ShellProvider></MemoryRouter>);
    expect(await screen.findByRole("heading", { name: "Update the homepage lead" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Show private screenshot" }));
    await waitFor(() => expect(mocks.cmsGetBugReportEvidence).toHaveBeenCalledTimes(1));
    mocks.cmsGetBugReport.mockRejectedValue(new Error("Report access denied"));
    const editorShell = { ...shell("editor"), user: adminShell.user, principal: { id: adminShell.principal.id, grants: [{ role: "editor" as const }] } };
    view.rerender(<MemoryRouter initialEntries={[`/reports/${ID}`]}><ShellProvider value={editorShell}><ReportsRoute /></ShellProvider></MemoryRouter>);
    await act(async () => { resolveEvidence?.({ success: true, mimeType: "image/webp", base64: "cHJpdmF0ZQ==", width: 10, height: 10 }); });
    expect(await screen.findByText(/Last shown information may be out of date/)).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Update the homepage lead" })).not.toBeInTheDocument();
    expect(screen.queryByText(/account-9@example.org/)).not.toBeInTheDocument();
    expect(screen.queryByAltText("Screenshot supplied with this problem report")).not.toBeInTheDocument();
  });
});


it.each([401, 403, 404])("clears a retained report when refresh refuses access with %s", async (status) => {
  renderRoute("editor", `/reports/${ID}`);
  expect(await screen.findByRole("heading", { name: "Update the homepage lead" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Show private screenshot" }));
  expect(await screen.findByAltText("Screenshot supplied with this problem report")).toBeVisible();
  mocks.cmsGetBugReport.mockRejectedValue(new HttpError(status, "Report is unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByText(/Last shown information may be out of date/)).toBeVisible();
  expect(screen.queryByRole("heading", { name: "Update the homepage lead" })).not.toBeInTheDocument();
  expect(screen.queryByAltText("Screenshot supplied with this problem report")).not.toBeInTheDocument();
});
