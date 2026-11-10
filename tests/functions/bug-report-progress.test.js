import { describe, expect, it } from "vitest";
import progress from "../../functions/lib/bug-report-progress.js";
import contract from "../../functions/lib/bug-report-contract.js";
import nudges from "../../functions/lib/bug-report-nudge.js";

const NOW = new Date("2026-10-08T16:00:00.000Z");
const at = NOW.toISOString();
function report(overrides = {}) {
  return { id: `br_${"a".repeat(32)}`, status: "open", createdAt: at, updatedAt: at,
    reporter: { uid: "staff-1", email: "private@example.test", role: "editor" },
    githubDelivery: { state: "synced", lastSyncedAt: at, fixStatus: "not_requested" },
    links: { githubIssues: [], pullRequests: [] }, ...overrides };
}
const read = (value) => progress.reportProgress(value, { now: NOW });
const issue = (state = "open") => ({ number: 2835, state, updatedAt: at });
const pull = (overrides = {}) => ({ number: 2845, state: "open", draft: true, merged: false,
  reviewState: "none", checksState: "pending", deploymentState: "none", updatedAt: at, ...overrides });

describe("staff-safe report progress", () => {
  it.each(["attach_issue", "attach_pull_request", "create_issue"])("tracks new %s intent before hydration, without counting retries or sync bookkeeping", (operation) => {
    const before = report({ createdAt: "2026-10-01T16:00:00.000Z", progressChangedAt: "2026-10-02T16:00:00.000Z" });
    const queued = { ...before, githubDelivery: { ...before.githubDelivery, state: "pending", lastOperation: operation, lastTargetNumber: operation === "create_issue" ? null : 2835 } };
    Object.assign(queued, progress.progressChangeFields(before, queued, at));
    expect(queued.progressChangedAt).toBe(at);
    expect(nudges.nudgeForReporter(queued, NOW).eligible).toBe(false);
    const later = "2026-10-09T16:00:00.000Z";
    const failed = { ...queued, githubDelivery: { ...queued.githubDelivery, state: "retryable_failed" } };
    expect(progress.progressChangeFields(failed, queued, later).progressChangedAt).toBe(at);
    const sync = { ...queued, githubDelivery: { ...queued.githubDelivery, lastOperation: "sync", lastTargetNumber: null } };
    expect(progress.progressChangeFields(queued, sync, later).progressChangedAt).toBe(at);
  });
  it.each(["open", "acknowledged"])("keeps %s shared progress detail neutral about who filed it", (status) => {
    const shared = contract.reportForStaff(report({ status }));
    expect(shared.progress.detail).not.toMatch(/your report/i);
    expect(shared.progress.detail).toContain("The report");
  });
  it("does not restart the no-progress clock for identical syncs or notifications", () => {
    const before = report({ createdAt: "2026-10-01T16:00:00.000Z", progressChangedAt: "2026-10-02T16:00:00.000Z" });
    const after = { ...before, updatedAt: at, githubDelivery: { ...before.githubDelivery, lastSyncedAt: at } };
    expect(progress.progressChangeFields(before, after, at).progressChangedAt).toBe(before.progressChangedAt);
    expect(read(after).updatedAt).toBe(before.progressChangedAt);
    expect(progress.progressChangeFields(before, { ...after, status: "acknowledged" }, at).progressChangedAt).toBe(at);
  });
  it.each([["pending", "queued"], ["running", "in_progress"], ["draft_pr_open", "in_progress"], ["failed", "needs_attention"]])(
    "shows File + fix %s without changing the report lifecycle", (fixStatus, phase) => {
      const record = report({ githubDelivery: { fixStatus, state: "synced", lastSyncedAt: at } });
      expect(read(record).phase).toBe(phase);
      expect(record.status).toBe("open");
    });
  it("does not turn a merged fix or a successful deployment entry into a live resolution", () => {
    const result = read(report({ links: { githubIssues: [issue("closed")], pullRequests: [pull({ state: "closed", merged: true, deploymentState: "success" })] } }));
    expect(result).toMatchObject({ phase: "merged", deployment: "unverified", active: true });
    expect(result.detail).toMatch(/live.*not.*verified/i);
  });
  it("shows closed engineering work separately from a resolved staff report", () => {
    const record = report({ links: { githubIssues: [issue("closed")], pullRequests: [] } });
    expect(read(record).phase).toBe("closed");
    expect(read({ ...record, status: "resolved", resolvedAt: at }).phase).toBe("resolved");
    const shared = contract.reportForStaff({ ...record, status: "resolved", resolvedAt: at,
      actionableResolution: "PRIVATE-RESOLUTION" });
    expect(shared.progress.detail).not.toMatch(/see the report|PRIVATE-RESOLUTION/i);
    expect(shared.progress.phase).toBe("resolved");
  });
  it("reopening a linked issue resumes progress rather than inheriting an old resolution", () => {
    const record = report({ status: "resolved", resolvedAt: "2026-10-07T16:00:00.000Z",
      links: { githubIssues: [{ ...issue(), reopenedAt: at }], pullRequests: [] } });
    expect(read(record)).toMatchObject({ phase: "reopened", active: true });
    expect(record.status).toBe("resolved");
  });
  it("does not suppress active work when another linked issue is closed", () => {
    expect(read(report({ links: { githubIssues: [issue("closed"), { ...issue(), number: 2837 }], pullRequests: [pull()] } })).phase).toBe("in_progress");
  });
  it.each([["failure", "none", "checks_failed"], ["success", "changes_requested", "changes_requested"]])(
    "keeps actionable review and check state", (checksState, reviewState, phase) => {
      expect(read(report({ links: { githubIssues: [issue()], pullRequests: [pull({ checksState, reviewState })] } })).phase).toBe(phase);
    });
  it("labels old and failed synchronization without inventing newer work", () => {
    expect(read(report({ githubDelivery: { state: "synced", lastSyncedAt: "2026-10-06T16:00:00.000Z" }, links: { githubIssues: [issue()], pullRequests: [] } })).syncState).toBe("stale");
    expect(read(report({ githubDelivery: { state: "retryable_failed", lastSyncedAt: at }, links: { githubIssues: [issue()], pullRequests: [] } })).syncState).toBe("unavailable");
  });
  it("projects only closed vocabulary and numbered states, never private source fields", () => {
    const secret = "PRIVATE-CANARY";
    const record = report({ happened: secret, consoleLogs: [secret], ownerUid: secret,
      links: { githubIssues: [{ ...issue(), title: secret, body: secret, url: secret }],
        pullRequests: [pull({ title: secret, url: secret, headSha: secret })] },
      githubDelivery: { state: "synced", lastSyncedAt: at, lastError: secret, fixSessionName: secret, fixPullRequestUrl: secret } });
    const output = JSON.stringify(read(record));
    expect(output).not.toContain(secret);
    expect(output).not.toContain("private@example.test");
    expect(read(record).issues).toEqual([{ number: 2835, state: "open" }]);
  });
  it("adds the same safe progress to reporter detail, administrator detail and list", () => {
    const record = report({ githubDelivery: { state: "pending", fixStatus: "running" }, links: {} });
    const reporter = contract.reportForReporter(record, "staff-1");
    expect(reporter.progress.phase).toBe("in_progress");
    expect(reporter).not.toHaveProperty("links");
    expect(reporter.reporter).not.toHaveProperty("email");
    expect(contract.reportForAdmin(record).progress).toEqual(reporter.progress);
    expect(contract.reportForList(reporter).progress).toEqual(reporter.progress);
    expect(() => contract.reportForReporter(record, "other-staff")).toThrow();
  });
});


describe("ordered GitHub evidence", () => {
  it("ignores a delayed read that would roll closed state back to open", () => {
    const current = [{ ...issue("closed"), updatedAt: at }];
    expect(progress.mergeGithubEvidence(current, [{ ...issue(), updatedAt: "2026-10-07T16:00:00.000Z" }], { trackReopen: true })).toEqual(current);
  });
  it("records a reopening once and preserves it across duplicate reads", () => {
    const current = [{ ...issue("closed"), updatedAt: "2026-10-07T16:00:00.000Z" }];
    const next = progress.mergeGithubEvidence(current, [issue()], { trackReopen: true });
    expect(next[0].reopenedAt).toBe(at);
    expect(progress.mergeGithubEvidence(next, [issue()], { trackReopen: true })).toEqual(next);
  });
  it("projects shared issue progress independently for each report", () => {
    const first = report({ links: { githubIssues: [issue("closed")], pullRequests: [] } });
    const second = report({ id: `br_${"b".repeat(32)}`, status: "resolved", resolvedAt: at,
      links: { githubIssues: [issue("closed")], pullRequests: [] } });
    expect(read(first).phase).toBe("closed");
    expect(read(second).phase).toBe("resolved");
  });
});


describe("concurrent report linkage", () => {
  it("retains a PR attached by File + fix after an older sync began", () => {
    const links = progress.mergeGithubLinks({ githubIssueNumbers: [2835], githubIssues: [issue()],
      pullRequestNumbers: [2845], pullRequests: [] }, { issues: [issue()], pullRequests: [] });
    expect(links.pullRequestNumbers).toEqual([2845]);
    expect(read(report({ links })).syncState).toBe("pending");
  });
});


describe("freshness and unavailable links", () => {
  it.each(["githubIssues", "pullRequests"])("resets nudge timing for %s availability changes, not duplicate reads", (kind) => {
    const row = kind === "githubIssues" ? issue("closed") : pull({ state: "closed", merged: true });
    const before = report({ createdAt: "2026-10-01T16:00:00.000Z", progressChangedAt: "2026-10-02T16:00:00.000Z", links: { [kind]: [row] } });
    expect(nudges.nudgeForReporter(before, NOW).eligible).toBe(true);
    // An omitted flag and explicit false describe the same available work.
    expect(progress.progressChangeFields(before, { ...before, links: { [kind]: [{ ...row, unavailable: false }] } }, at).progressChangedAt).toBe(before.progressChangedAt);
    const unavailable = { ...before, links: { [kind]: [{ ...row, unavailable: true }] } };
    Object.assign(unavailable, progress.progressChangeFields(before, unavailable, at));
    expect(read(unavailable).phase).toBe("needs_attention");
    expect(unavailable.progressChangedAt).toBe(at);
    expect(nudges.nudgeForReporter(unavailable, NOW).eligible).toBe(false);
    const later = "2026-10-09T16:00:00.000Z";
    expect(progress.progressChangeFields(unavailable, { ...unavailable, updatedAt: later }, later).progressChangedAt).toBe(at);
    expect(progress.progressChangeFields(unavailable, before, later).progressChangedAt).toBe(later);
  });
  it("orders independent check results by read start even when PR updatedAt is unchanged", () => {
    const newer = [{ ...pull({ checksState: "failure" }), observedAt: at }];
    const result = progress.mergeGithubEvidence(newer, [pull({ checksState: "success" })], { observedAt: "2026-10-08T15:59:00.000Z" });
    expect(result).toEqual(newer);
  });
  it("never presents an unavailable issue as confirmed closed work", () => {
    const result = read(report({ links: { githubIssues: [{ ...issue("closed"), unavailable: true }], pullRequests: [] } }));
    expect(result).toMatchObject({ phase: "needs_attention", syncState: "unavailable", issues: [{ number: 2835, state: "unavailable" }] });
  });
});


it("lets active work and manual blockers supersede historical reopening evidence", () => {
  const record = report({ status: "in_progress", links: { githubIssues: [{ ...issue(), reopenedAt: at }],
    pullRequests: [pull({ reviewState: "changes_requested" })] } });
  expect(read(record).phase).toBe("changes_requested");
  expect(read({ ...record, status: "blocked" }).phase).toBe("blocked");
});


it("does not revive a closed, unmerged proposal from the old File + fix result", () => {
  const record = report({ githubDelivery: { fixStatus: "draft_pr_open", state: "synced", lastSyncedAt: at },
    links: { githubIssues: [issue()], pullRequestNumbers: [2845], pullRequests: [pull({ state: "closed", merged: false })] } });
  expect(read(record).phase).toBe("needs_attention");
});


it("retains a verified reopen hint when a newer ordinary sync finished first", () => {
  const current = [{ ...issue(), observedAt: "2026-10-08T16:03:00.000Z" }];
  const merged = progress.mergeGithubEvidence(current, [{ ...issue(), reopenedAt: at }],
    { trackReopen: true, observedAt: "2026-10-08T16:02:00.000Z" });
  expect(merged[0]).toMatchObject({ observedAt: "2026-10-08T16:03:00.000Z", reopenedAt: at });
  expect(read(report({ status: "resolved", resolvedAt: "2026-10-08T15:00:00.000Z", links: { githubIssues: merged } })).phase).toBe("reopened");
});
it("does not invent a reopening when access to an unavailable issue returns", () => {
  const previous = [{ ...issue("closed"), unavailable: true, updatedAt: "2026-10-08T14:00:00.000Z" }];
  const merged = progress.mergeGithubEvidence(previous, [issue()], { trackReopen: true });
  expect(merged[0]).not.toHaveProperty("reopenedAt");
  expect(read(report({ status: "resolved", resolvedAt: "2026-10-08T15:00:00.000Z", links: { githubIssues: merged } })).phase).toBe("resolved");
});


it("accepts a genuinely newer GitHub source state even from a slower earlier read", () => {
  const current = [{ ...issue(), updatedAt: "2026-10-08T16:00:00.000Z", observedAt: "2026-10-08T16:00:03.000Z" }];
  const merged = progress.mergeGithubEvidence(current, [{ ...issue("closed"), updatedAt: "2026-10-08T16:00:04.000Z" }], { observedAt: "2026-10-08T16:00:02.000Z" });
  expect(merged[0].state).toBe("closed");
});


it("distinguishes a draft proposal from a non-draft review without claiming readiness or deployment", () => {
  expect(read(report({ links: { pullRequests: [pull()] } })).phase).toBe("in_progress");
  expect(read(report({ links: { pullRequests: [pull({ draft: false })] } })).phase).toBe("ready_for_review");
  expect(read(report({ links: { pullRequests: [pull({ draft: false, reviewState: "approved", checksState: "success" })] } })))
    .toMatchObject({ phase: "ready_for_review", deployment: "unverified" });
});


it.each(["pending", "running", "failed", "draft_pr_open"])(
  "ranks merged evidence above a stale autofix %s result", (fixStatus) => {
    const record = report({ githubDelivery: { fixStatus, state: "synced", lastSyncedAt: at },
      links: { githubIssues: [issue()], pullRequests: [pull({ state: "closed", merged: true })] } });
    expect(read(record)).toMatchObject({ phase: "merged", deployment: "unverified" });
    expect(record.status).toBe("open");
    expect(read({ ...record, status: "resolved" }).phase).toBe("resolved");
    expect(read({ ...record, status: "blocked" }).phase).toBe("blocked");
  },
);


it("promotes an explicitly attached discovered PR to a permanent manual link", () => {
  const links = progress.mergeGithubLinks({ pullRequestNumbers: [2845], discoveredPullRequestNumbers: [2845], pullRequests: [pull()] },
    { issues: [], pullRequests: [pull()], manualPullRequestNumber: 2845 });
  expect(links.pullRequestNumbers).toEqual([2845]);
  expect(links.discoveredPullRequestNumbers).toEqual([]);
  const next = progress.mergeGithubLinks(links, { issues: [], pullRequests: [], discoveredPullRequestNumbers: [] });
  expect(next.pullRequestNumbers).toEqual([2845]);
});


it("keeps newer discovery when a slower older sync settles later", () => {
  const current = { pullRequestNumbers: [2845, 3000], discoveredPullRequestNumbers: [3000],
    discoveryObservedAt: "2026-10-08T16:03:00.000Z", pullRequests: [pull(), { ...pull(), number: 3000 }] };
  const merged = progress.mergeGithubLinks(current, { issues: [], discoveredPullRequestNumbers: [2900],
    pullRequests: [{ ...pull(), number: 2900 }] }, { observedAt: "2026-10-08T16:02:00.000Z" });
  expect(merged.pullRequestNumbers).toEqual([2845, 3000]);
  expect(merged.discoveredPullRequestNumbers).toEqual([3000]);
  expect(merged.discoveryObservedAt).toBe("2026-10-08T16:03:00.000Z");
  expect(merged.pullRequests.map((pull) => pull.number)).toEqual([2845, 3000]);
});
