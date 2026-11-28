import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import admin from "../helpers/firebase-admin.js";
import github from "../../functions/bug-report-github.js";
import contract from "../../functions/lib/bug-report-contract.js";
import audit from "../../functions/lib/audit.js";

const ISSUE = { repository: "example-owner/private-reports", repositoryId: 1000001 };
const FIX = { repository: "example-owner/public-code", repositoryId: 1000002 };
const NOW = new Date("2026-11-14T15:00:00.000Z");
const SHA = "b".repeat(40);
const PROJECT = process.env.GCLOUD_PROJECT || "demo-njpbs";
let db;

function record(overrides = {}) {
  return {
    id: "br_" + "d".repeat(32), status: "open", version: 1,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    reporter: { uid: "editor-1", role: "editor" },
    links: { githubIssueNumbers: [17], githubIssues: [], pullRequestNumbers: [29], pullRequests: [],
      workflowRunUrls: [], deploymentRunUrls: [] },
    githubDelivery: { state: "synced", fixStatus: "draft_pr_open", lastSyncedAt: NOW.toISOString() },
    ...overrides,
  };
}

function identityFields(identity) {
  return { fixPullRequestRepository: identity.repository, fixPullRequestRepositoryId: identity.repositoryId };
}

function pull(repository, number = 29, overrides = {}) {
  return { number, url: `https://github.com/${repository}/pull/${number}`, title: "Proposed fix",
    state: "open", draft: false, merged: false, reviewState: "none", checksState: "success",
    deploymentState: "none", updatedAt: NOW.toISOString(), ...overrides };
}

function boundary({ beforePullRead, timeline = [], metadata = {}, issueState = "open", pulls = {}, compare = "behind" } = {}) {
  const requests = [];
  const fetchFn = async (input, init) => {
    const url = new URL(input);
    requests.push({ method: init.method, path: url.pathname });
    for (const identity of [ISSUE, FIX]) {
      const base = `/repos/${identity.repository}`;
      if (url.pathname === base) return Response.json({ full_name: identity.repository,
        id: identity.repositoryId, ...metadata[identity.repository] });
      if (!url.pathname.startsWith(`${base}/`)) continue;
      const path = url.pathname.slice(base.length);
      if (path === "/issues/17") return Response.json({ number: 17, state: issueState, title: "Private incident",
        html_url: `https://github.com/${identity.repository}/issues/17`, updated_at: NOW.toISOString() });
      if (path === "/issues/17/timeline") return Response.json(timeline);
      const match = /^\/pulls\/(\d+)$/.exec(path);
      if (match) {
        const number = Number(match[1]);
        if (beforePullRead) await beforePullRead(identity, number);
        return Response.json({ number, state: "open", draft: false, merged: false,
          title: identity === FIX ? "Public proposed fix" : "Private proposed fix",
          head: { sha: SHA }, html_url: `https://github.com/${identity.repository}/pull/${number}`,
          updated_at: NOW.toISOString(), ...(identity === FIX ? pulls[number] : {}) });
      }
      if (identity === FIX && path.startsWith("/compare/")) {
        const status = typeof compare === "object" ? compare[path.split("...")[1]] : compare;
        return status === "error" ? Response.json({}, { status: 404 }) : Response.json({ status });
      }
      if (path.endsWith("/reviews") || path === "/deployments") return Response.json([]);
      if (path.endsWith("/check-runs")) return Response.json({ check_runs: [
        { status: "completed", conclusion: "success", details_url: `https://github.com/${identity.repository}/actions/runs/73` },
      ] });
      if (path.endsWith("/status")) return Response.json({ state: "success", statuses: [] });
    }
    throw new Error(`Unexpected synthetic HTTP request ${init.method} ${url.pathname}`);
  };
  return { fetchFn, requests };
}

async function seed(stored, operation = "sync", targetNumber = null) {
  const jobId = `${stored.id}--sync`;
  await db.collection("bug_reports").doc(stored.id).set(stored);
  await db.collection("bugReportGithubOutbox").doc(jobId).set({ reportId: stored.id,
    operation, targetNumber, state: "pending", attemptCount: 0, nextAttemptAt: NOW });
  return jobId;
}

function run(jobId, api, deps = {}) {
  return github.processGithubOutboxRow(jobId, { firestore: db, now: () => NOW,
    token: "synthetic-github-token", fetchFn: api.fetchFn, ...deps });
}

beforeAll(() => {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("bug-report-github-repositories.test.js");
});
beforeEach(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
  await clearEmulatorFirestore(`http://${host}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" }, db);
  vi.stubEnv("CMS_BUG_REPORT_GITHUB_REPOSITORY", ISSUE.repository);
  vi.stubEnv("CMS_BUG_REPORT_GITHUB_REPOSITORY_ID", String(ISSUE.repositoryId));
  vi.stubEnv("CMS_BUG_REPORT_FIX_GITHUB_REPOSITORY", FIX.repository);
  vi.stubEnv("CMS_BUG_REPORT_FIX_GITHUB_REPOSITORY_ID", String(FIX.repositoryId));
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await Promise.all(admin.apps.map((app) => app.delete())); });

describe("report issues and proposed fixes in separate repositories", () => {
  it.each([false, true])("reads the stored PR namespace (old record=%s)", async (oldRecord) => {
    const selected = oldRecord ? ISSUE : FIX;
    const stored = record(oldRecord ? {} : identityFields(FIX));
    const job = await seed(stored);
    const api = boundary();
    expect(await run(job, api)).toEqual({ state: "delivered" });
    const next = (await db.collection("bug_reports").doc(stored.id).get()).data();
    expect(next).toMatchObject(identityFields(selected));
    expect(next.links.githubIssues[0].url).toBe(`https://github.com/${ISSUE.repository}/issues/17`);
    expect(next.links.pullRequests[0].url).toBe(`https://github.com/${selected.repository}/pull/29`);
    expect(next.links.workflowRunUrls).toEqual([`https://github.com/${selected.repository}/actions/runs/73`]);
    expect(api.requests).toContainEqual({ method: "GET", path: `/repos/${ISSUE.repository}/issues/17` });
    expect(api.requests).toContainEqual({ method: "GET", path: `/repos/${selected.repository}/pulls/29` });
    expect(api.requests.every(({ method }) => method === "GET")).toBe(true);
    expect(api.requests.some(({ path }) => path === `/repos/${oldRecord ? FIX.repository : ISSUE.repository}/pulls/29`)).toBe(false);
  });

  it("discovers public fix references from the private issue timeline", async () => {
    const stored = record(identityFields(FIX));
    stored.links.pullRequestNumbers = [];
    const source = (repository, number) => ({ event: "cross-referenced", source: { issue: {
      number, pull_request: { url: `https://api.github.com/repos/${repository}/pulls/${number}` },
    } } });
    const api = boundary({ timeline: [source(FIX.repository, 29), source(ISSUE.repository, 30), source("other-owner/unapproved", 31)] });
    expect(await run(await seed(stored), api)).toEqual({ state: "delivered" });
    const next = (await db.collection("bug_reports").doc(stored.id).get()).data();
    expect(next.links.pullRequestNumbers).toEqual([29]);
    expect(next.links.discoveredPullRequestNumbers).toEqual([29]);
    expect(next.links.pullRequests[0].url).toBe(`https://github.com/${FIX.repository}/pull/29`);
  });

  it("attaches a new namespace atomically, retaining prior links and identity in audit", async () => {
    const stored = record(identityFields(ISSUE));
    stored.links.pullRequestNumbers = Array.from({ length: 10 }, (_, index) => 29 + index);
    stored.links.pullRequests = [pull(ISSUE.repository, 29, { state: "closed", merged: true })];
    const api = boundary();
    expect(await run(await seed(stored, "attach_pull_request", 29), api)).toEqual({ state: "delivered" });
    const next = (await db.collection("bug_reports").doc(stored.id).get()).data();
    expect(next).toMatchObject(identityFields(FIX));
    expect(next.links.pullRequestNumbers).toEqual([29]);
    expect(next.links.pullRequests).toEqual([expect.objectContaining({ number: 29, merged: false,
      url: `https://github.com/${FIX.repository}/pull/29` })]);
    const entries = await db.collection(audit.AUDIT_COLLECTIONS.adminLogs).get();
    expect(entries.docs.map((doc) => doc.data())).toEqual(expect.arrayContaining([
      expect.objectContaining({ before: expect.objectContaining({ ...identityFields(ISSUE),
        links: expect.objectContaining({ pullRequestNumbers: stored.links.pullRequestNumbers }) }),
      after: expect.objectContaining(identityFields(FIX)) }),
    ]));
  });

  it("ignores cached evidence from the writer's previous namespace before and during refresh", async () => {
    const stored = record(identityFields(FIX));
    stored.links.pullRequests = [pull(ISSUE.repository, 29, { state: "closed", merged: true })];
    stored.links.discoveredPullRequestNumbers = [29];
    // Evaluate freshness at the fixture time, then restore Date before Firestore.
    vi.setSystemTime(NOW);
    try {
      const visible = contract.reportForAdmin(stored);
      expect(visible.links.pullRequests).toEqual([]);
      expect(visible.progress.pullRequests).toEqual([]);
      expect(visible.progress.syncState).toBe("pending");
    } finally { vi.useRealTimers(); }
    expect(await run(await seed(stored), boundary())).toEqual({ state: "delivered" });
    const next = (await db.collection("bug_reports").doc(stored.id).get()).data();
    expect(next.links.pullRequests[0]).toMatchObject({ number: 29, merged: false,
      url: `https://github.com/${FIX.repository}/pull/29` });
  });

  it.each([false, true])("discards an old-namespace sync after a host-writer update (read failed=%s)", async (failed) => {
    const stored = record(identityFields(ISSUE));
    stored.links.pullRequests = [pull(ISSUE.repository)];
    const ref = db.collection("bug_reports").doc(stored.id);
    const job = await seed(stored);
    const api = boundary({ beforePullRead: async (identity) => {
      if (identity === ISSUE) {
        await ref.update({ ...identityFields(FIX), "links.pullRequestNumbers": [30] });
        if (failed) throw new Error("Synthetic old-namespace read failure");
      }
    } });
    expect(await run(job, api)).toEqual({ state: failed ? "pending" : "delivered" });
    const pending = (await ref.get()).data();
    expect(pending).toMatchObject({ ...identityFields(FIX), githubDelivery: { state: "pending" } });
    expect(pending.links.pullRequestNumbers).toEqual([30]);
    expect(contract.reportForAdmin(pending).links.pullRequests).toEqual([]);
    const queued = (await db.collection("bugReportGithubOutbox").doc(job).get()).data();
    expect(queued.state).toBe("pending");
    expect(queued.nextAttemptAt.toMillis()).toBe(NOW.getTime());
    expect(await run(job, boundary())).toEqual({ state: "delivered" });
    const next = (await ref.get()).data();
    expect(next.links.pullRequestNumbers).toEqual([30]);
    expect(next.links.pullRequests[0].url).toBe(`https://github.com/${FIX.repository}/pull/30`);
  });

  it.each([
    { fixPullRequestRepository: FIX.repository },
    { fixPullRequestRepositoryId: FIX.repositoryId },
    { ...identityFields(FIX), fixPullRequestRepositoryId: String(FIX.repositoryId) },
    { ...identityFields(FIX), fixPullRequestRepositoryId: ISSUE.repositoryId },
    { ...identityFields(FIX), fixPullRequestRepository: "other-owner/unapproved" },
  ])("refuses incomplete or unapproved stored identity before HTTP: %j", async (fields) => {
    const api = boundary();
    expect(await run(await seed(record(fields)), api)).toEqual({ state: "terminal_failed" });
    expect(api.requests).toEqual([]);
  });

  it.each([
    ["create_issue", { id: 1000099 }], ["create_issue", { full_name: "other-owner/unapproved" }],
    ["attach_pull_request", { id: 1000099 }], ["attach_pull_request", { full_name: "other-owner/unapproved" }],
  ])("refuses remote identity drift before %s: %j", async (operation, drift) => {
    const target = operation === "create_issue" ? ISSUE : FIX;
    const api = boundary({ metadata: { [target.repository]: drift } });
    expect(await run(await seed(record(), operation, operation === "attach_pull_request" ? 29 : null), api))
      .toEqual({ state: "terminal_failed" });
    expect(api.requests).toEqual([{ method: "GET", path: `/repos/${target.repository}` }]);
  });

  it.each([false, true])("finds a webhook target after 50 foreign-namespace rows (legacy target=%s)", async (legacy) => {
    const target = record({ id: "br_" + "f".repeat(32), ...(legacy ? {} : identityFields(FIX)) });
    const batch = db.batch();
    for (let index = 0; index < 50; index += 1) {
      const foreign = record({ id: "br_" + String(index).padStart(32, "0"), ...(legacy ? identityFields(FIX) : {}) });
      batch.set(db.collection("bug_reports").doc(foreign.id), foreign);
    }
    batch.set(db.collection("bug_reports").doc(target.id), target);
    await batch.commit();
    const identity = legacy ? ISSUE : FIX;
    const deliveryId = `paged-target-${legacy}`;
    expect(await github.queueGithubWebhookSync({ firestore: db, now: () => NOW,
      eventName: "pull_request", deliveryId,
      payload: { repository: { full_name: identity.repository, id: identity.repositoryId }, pull_request: { number: 29 } },
    })).toEqual({ state: "queued", count: 1 });
    const receipt = (await db.collection("bugReportGithubWebhookReceipts").doc(deliveryId).get()).data();
    expect(receipt.reportIds).toEqual([target.id]);
  });

  it("routes webhook targets by repository identity despite colliding PR numbers", async () => {
    const old = record();
    const current = record({ ...identityFields(FIX), id: "br_" + "e".repeat(32) });
    await db.collection("bug_reports").doc(old.id).set(old);
    await db.collection("bug_reports").doc(current.id).set(current);
    const event = (identity, deliveryId, eventName = "pull_request") => ({ firestore: db, now: () => NOW,
      eventName, deliveryId, payload: { repository: { full_name: identity.repository, id: identity.repositoryId },
        pull_request: { number: 29 }, issue: { number: 17 } } });
    expect(await github.queueGithubWebhookSync(event(FIX, "public-pull"))).toEqual({ state: "queued", count: 1 });
    expect((await db.collection("bugReportGithubWebhookReceipts").doc("public-pull").get()).data().reportIds).toEqual([current.id]);
    expect(await github.queueGithubWebhookSync(event(ISSUE, "private-pull"))).toEqual({ state: "queued", count: 1 });
    expect((await db.collection("bugReportGithubWebhookReceipts").doc("private-pull").get()).data().reportIds).toEqual([old.id]);
    expect(await github.queueGithubWebhookSync(event(FIX, "public-issue", "issues"))).toEqual({ state: "ignored", count: 0 });
    await expect(github.queueGithubWebhookSync(event({ ...FIX, repositoryId: ISSUE.repositoryId }, "wrong-id")))
      .rejects.toMatchObject({ kind: "terminal" });
    expect((await db.collection("bugReportGithubWebhookReceipts").doc("wrong-id").get()).exists).toBe(false);
  });
});

describe("public fix pull requests on a report filed in the private tracker", () => {
  const RELEASE = "c".repeat(40);
  const MERGE = "e".repeat(40);
  const reference = (repository, number) => ({ event: "cross-referenced", created_at: NOW.toISOString(),
    source: { issue: { number, pull_request: { url: `https://api.github.com/repos/${repository}/pulls/${number}` } } } });
  // A report filed before fixes moved: no namespace fields, a closed relay issue
  // and an earlier private pull request found on its timeline.
  function relayReport() {
    const stored = record({ status: "acknowledged", acknowledgedAt: NOW.toISOString() });
    stored.links = { ...stored.links, pullRequestNumbers: [30], discoveredPullRequestNumbers: [30],
      pullRequests: [pull(ISSUE.repository, 30, { state: "closed", merged: false })] };
    return stored;
  }
  const merged = { state: "closed", merged: true, merge_commit_sha: MERGE };
  async function sync(options, deps = { servedRevisions: async () => [RELEASE] }) {
    const stored = relayReport();
    const api = boundary({ issueState: "closed", timeline: [reference(ISSUE.repository, 30), reference(FIX.repository, 734)], ...options });
    expect(await run(await seed(stored), api, deps)).toEqual({ state: "delivered" });
    const next = (await db.collection("bug_reports").doc(stored.id).get()).data();
    return { next, api, view: contract.reportForReporter(next, "editor-1").progress };
  }

  it("moves to the fix repository and shows the open fix in review", async () => {
    const { next, view } = await sync({});
    expect(next).toMatchObject({ status: "acknowledged", ...identityFields(FIX) });
    expect(next.links.pullRequestNumbers).toEqual([734]);
    expect(next.links.pullRequests.map((row) => row.url)).toEqual([`https://github.com/${FIX.repository}/pull/734`]);
    expect(view).toMatchObject({ phase: "ready_for_review", stage: "review", label: "Fix ready for review" });
  });
  it("shows a merged fix that production does not contain as awaiting live verification", async () => {
    const { next, view, api } = await sync({ pulls: { 734: merged }, compare: "diverged" });
    expect(next.links.pullRequests[0]).toMatchObject({ merged: true, mergeCommitSha: MERGE });
    expect(next.links.pullRequests[0].live).toBeUndefined();
    expect(api.requests).toContainEqual({ method: "GET", path: `/repos/${FIX.repository}/compare/${MERGE}...${RELEASE}` });
    expect(view).toMatchObject({ phase: "merged", stage: "awaiting_live", label: "Merged; live verification pending",
      deployment: "unverified" });
  });
  it.each(["ahead", "identical"])("marks a merged fix live when production is %s of its merge commit", async (compare) => {
    const { next, view } = await sync({ pulls: { 734: merged }, compare });
    expect(next.status).toBe("acknowledged");
    expect(next.links.pullRequests[0]).toMatchObject({ live: true, liveRevisions: [RELEASE] });
    expect(view).toMatchObject({ phase: "live", stage: "live", label: "Fix live", deployment: "verified", active: true });
    expect((await db.collection("bugReportDeliveryOutbox").get()).docs.every((doc) => doc.data().channel !== "email")).toBe(true);
  });
  it("waits for the Functions release when only the live Admin build contains the fix", async () => {
    const admin = "a".repeat(40);
    const { next, view } = await sync({ pulls: { 734: merged }, compare: { [admin]: "ahead", [RELEASE]: "behind" } },
      { servedRevisions: async () => [admin, RELEASE] });
    expect(next.links.pullRequests[0].live).toBeUndefined();
    expect(view).toMatchObject({ phase: "merged", label: "Merged; live verification pending" });
  });
  it("keeps a verified fix live without another comparison", async () => {
    const { next } = await sync({ pulls: { 734: merged }, compare: "ahead" });
    await db.collection("bugReportGithubOutbox").doc(`${next.id}--sync`).set({ reportId: next.id,
      operation: "sync", targetNumber: null, state: "pending", attemptCount: 0, nextAttemptAt: NOW });
    const api = boundary({ issueState: "closed", timeline: [reference(FIX.repository, 734)], pulls: { 734: merged }, compare: "behind" });
    expect(await run(`${next.id}--sync`, api, { servedRevisions: async () => [RELEASE] })).toEqual({ state: "delivered" });
    const later = (await db.collection("bug_reports").doc(next.id).get()).data();
    expect(later.links.pullRequests[0]).toMatchObject({ live: true, liveRevisions: [RELEASE] });
    expect(api.requests.some(({ path }) => path.includes("/compare/"))).toBe(false);
  });
  it("clears live evidence after production rolls back to a build without the fix", async () => {
    const { next } = await sync({ pulls: { 734: merged }, compare: "ahead" });
    await db.collection("bugReportGithubOutbox").doc(`${next.id}--sync`).set({ reportId: next.id,
      operation: "sync", targetNumber: null, state: "pending", attemptCount: 0, nextAttemptAt: NOW });
    const rollback = "d".repeat(40);
    const api = boundary({ issueState: "closed", timeline: [reference(FIX.repository, 734)], pulls: { 734: merged }, compare: "behind" });
    expect(await run(`${next.id}--sync`, api, { servedRevisions: async () => [rollback] })).toEqual({ state: "delivered" });
    const later = (await db.collection("bug_reports").doc(next.id).get()).data();
    expect(later.links.pullRequests[0].live).toBeUndefined();
    expect(api.requests).toContainEqual({ method: "GET", path: `/repos/${FIX.repository}/compare/${MERGE}...${rollback}` });
    expect(contract.reportForReporter(later, "editor-1").progress)
      .toMatchObject({ phase: "merged", label: "Merged; live verification pending" });
  });
  it("shows a verified fix as pending when the new revision cannot be compared", async () => {
    const { next } = await sync({ pulls: { 734: merged }, compare: "ahead" });
    await db.collection("bugReportGithubOutbox").doc(`${next.id}--sync`).set({ reportId: next.id,
      operation: "sync", targetNumber: null, state: "pending", attemptCount: 0, nextAttemptAt: NOW });
    const api = boundary({ issueState: "closed", timeline: [reference(FIX.repository, 734)], pulls: { 734: merged }, compare: "error" });
    expect(await run(`${next.id}--sync`, api, { servedRevisions: async () => ["d".repeat(40)] })).toEqual({ state: "delivered" });
    const later = (await db.collection("bug_reports").doc(next.id).get()).data();
    expect(later.links.pullRequests[0].live).toBeUndefined();
    expect(contract.reportForReporter(later, "editor-1").progress.phase).toBe("merged");
  });
  it("skips the timeline when ten manual pull requests fill the links", async () => {
    const stored = relayReport();
    const numbers = Array.from({ length: 10 }, (_, index) => 30 + index);
    stored.links = { ...stored.links, pullRequestNumbers: numbers, discoveredPullRequestNumbers: [],
      pullRequests: numbers.map((number) => pull(ISSUE.repository, number)) };
    const api = boundary({ issueState: "closed", timeline: [reference(FIX.repository, 734)] });
    expect(await run(await seed(stored), api, { servedRevisions: async () => [RELEASE] })).toEqual({ state: "delivered" });
    expect(api.requests.some(({ path }) => path.endsWith("/timeline"))).toBe(false);
    expect((await db.collection("bug_reports").doc(stored.id).get()).data()).toMatchObject(identityFields(ISSUE));
  });
  it("leaves live verification pending when the production revision cannot be read", async () => {
    const { view } = await sync({ pulls: { 734: merged } }, { servedRevisions: async () => { throw new Error("offline"); } });
    expect(view).toMatchObject({ phase: "merged", label: "Merged; live verification pending" });
  });
  it("keeps a manually linked private pull request in its namespace", async () => {
    const stored = relayReport();
    stored.links.discoveredPullRequestNumbers = [];
    const api = boundary({ issueState: "closed", timeline: [reference(FIX.repository, 734)] });
    expect(await run(await seed(stored), api, { servedRevisions: async () => [RELEASE] })).toEqual({ state: "delivered" });
    const next = (await db.collection("bug_reports").doc(stored.id).get()).data();
    expect(next).toMatchObject(identityFields(ISSUE));
    expect(next.links.pullRequestNumbers).toEqual([30]);
    expect(api.requests.some(({ path }) => path.startsWith(`/repos/${FIX.repository}/`))).toBe(false);
  });
});
