import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import github from "../../functions/bug-report-github.js";
import admin from "../helpers/firebase-admin.js";
import progress from "../../functions/lib/bug-report-progress.js";

const project = "demo-njpbs";
let db;
const repo = "example-owner/private-reports";
const at = "2026-10-13T16:00:00Z";
const sha = "a".repeat(40);
const source = (number, repository = repo) => ({
  type: "issue",
  issue: { number, repository_url: `https://api.github.com/repos/${repository}`,
    html_url: `https://github.com/${repository}/pull/${number}`,
    pull_request: { url: `https://api.github.com/repos/${repository}/pulls/${number}`, merged_at: at } },
});
function boundary(pages, { timelineStatus = 200, existing = [], beforePullRead, connectionErrors, connectionErrorType } = {}) {
  const requests = [];
  const client = github.createGithubClient({ token: "synthetic-http-token", repository: repo,
    fetchFn: async (input, init) => {
      const url = new URL(input);
      const path = url.pathname.replace(`/repos/${repo}`, "");
      requests.push(`${init.method} ${path}${url.search}`);
      if (path === "/issues/3390") return Response.json({ number: 3390, state: "open", html_url: `https://github.com/${repo}/issues/3390`, updated_at: at });
      if (path === "/issues/3390/timeline") return Response.json(pages[Number(url.searchParams.get("page")) - 1] ?? [], { status: timelineStatus });
      if (path === "/graphql") {
        const body = JSON.parse(init.body);
        expect(body.query).toContain("... on ConnectedEvent");
        expect(body.query).not.toContain("mutation");
        const number = body.variables.id === "CE_foreign" ? 9 : 3401;
        const repository = body.variables.id === "CE_foreign" ? "other/repo" : repo;
        return Response.json(connectionErrors ? { errors: [{ message: "Unavailable", ...(connectionErrorType ? { type: connectionErrorType } : {}) }] } : { data: { node: {
          source: { __typename: "PullRequest", number, repository: { nameWithOwner: repository } },
          subject: { __typename: "Issue", number: 3390, repository: { nameWithOwner: repo } },
        } } });
      }
      if (/^\/pulls\/\d+$/.test(path)) {
        const number = Number(path.split("/").at(-1));
        if (beforePullRead) await beforePullRead(number);
        return Response.json({ number, state: "closed", merged: true, head: { sha }, html_url: `https://github.com/${repo}/pull/${number}`, updated_at: at });
      }
      if (path.endsWith("/reviews") || path === "/deployments") return Response.json([]);
      if (path.endsWith("/check-runs")) return Response.json({ check_runs: [] });
      if (path.endsWith("/status")) return Response.json({ state: "success", statuses: [] });
      throw new Error(`Unexpected HTTP request ${path}`);
    },
  });
  const record = { status: "open", links: { githubIssueNumbers: [3390], pullRequestNumbers: existing } };
  return { client, requests, record, sync: () => github.executeGithubOperation({ operation: "sync", record }, client) };
}
describe("GitHub timeline sync through the HTTP boundary", () => {
  it("discovers Refs PRs across pages, deduplicates and persists their authoritative merged state", async () => {
    const first = Array.from({ length: 100 }, () => ({ event: "commented", body: "Unrelated comment" }));
    first[0] = { event: "cross-referenced", source: source(3400), created_at: at };
    const api = boundary([first, [
      { event: "cross-referenced", source: source(3400) },
      { event: "connected", node_id: "CE_sidebar", commit_id: null, commit_url: null, created_at: at },
      { event: "cross-referenced", source: source(99, "other/repo") },
      { event: "cross-referenced", source: { type: "issue", issue: { number: 42 } } },
      { event: "commented", source: source(3402) },
    ]], { existing: [3399] });
    const result = await api.sync();
    const links = progress.mergeGithubLinks(api.record.links, result);
    expect(links.pullRequestNumbers).toEqual([3399, 3400, 3401]);
    expect(links.pullRequests).toEqual(expect.arrayContaining([expect.objectContaining({ number: 3400, merged: true })]));
    expect(api.requests).toContain("GET /issues/3390/timeline?per_page=100&page=2");
    expect(api.requests.every((request) => request.startsWith("GET ") || request === "POST /graphql")).toBe(true);
    expect(progress.reportProgress({ ...api.record, links, githubDelivery: { fixStatus: "running" } }).phase).toBe("merged");
    expect(api.record.status).toBe("open");
  });
  it("resolves real-shaped sidebar connections and rejects a foreign repository PR", async () => {
    const api = boundary([[
      { id: 1, node_id: "CE_sidebar", url: `https://api.github.com/repos/${repo}/issues/events/1`, actor: { login: "fixture" }, event: "connected", commit_id: null, commit_url: null, created_at: at, performed_via_github_app: null },
      { id: 2, node_id: "CE_foreign", event: "connected", commit_id: null, commit_url: null, created_at: at },
    ]]);
    expect((await api.sync()).pullRequests.map((pull) => pull.number)).toEqual([3401]);
    expect(api.requests.filter((request) => request === "POST /graphql")).toHaveLength(2);
  });
  it("propagates GraphQL errors instead of claiming connected links were refreshed", async () => {
    const api = boundary([[{ event: "connected", node_id: "CE_sidebar", commit_id: null, commit_url: null, created_at: at }]], { connectionErrors: true });
    await expect(api.sync()).rejects.toMatchObject({ kind: "retryable" });
  });
  it("cancels a disconnected sidebar link but retains an independent Refs mention", async () => {
    const connection = { event: "connected", node_id: "CE_sidebar", commit_id: null, commit_url: null, created_at: at };
    const disconnected = { ...connection, event: "disconnected", node_id: "DE_sidebar", created_at: "2026-10-13T17:00:00Z" };
    const removed = boundary([[connection, disconnected]]);
    expect((await removed.sync()).pullRequests).toEqual([]);
    const mentioned = boundary([[{ event: "cross-referenced", source: source(3401), created_at: at }, connection, disconnected]]);
    expect((await mentioned.sync()).pullRequests.map((pull) => pull.number)).toEqual([3401]);
    const reconnected = boundary([[connection, disconnected, { ...connection, created_at: "2026-10-13T18:00:00Z" }]]);
    expect((await reconnected.sync()).pullRequests.map((pull) => pull.number)).toEqual([3401]);
  });
  it.each(["FORBIDDEN", "NOT_FOUND"])("skips an inaccessible %s node while syncing issue and manual PR state", async (connectionErrorType) => {
    const api = boundary([[{ event: "connected", node_id: "CE_sidebar", commit_id: null, commit_url: null, created_at: at }]],
      { connectionErrors: true, connectionErrorType, existing: [3399] });
    const result = await api.sync();
    expect(result.issues.map((issue) => issue.number)).toEqual([3390]);
    expect(result.pullRequests.map((pull) => pull.number)).toEqual([3399]);
    expect(result.discoveredPullRequestNumbers).toEqual([]);
  });
  it("keeps existing links and the ten-link bound", async () => {
    const existing = Array.from({ length: 9 }, (_, i) => 3200 + i);
    const api = boundary([[{ event: "cross-referenced", source: source(3400) }, { event: "cross-referenced", source: source(3401) }]], { existing });
    expect((await api.sync()).pullRequests.map((pull) => pull.number)).toEqual([...existing, 3401]);
  });
  it("prefers the newest references after more than ten older PRs across pages", async () => {
    const first = Array.from({ length: 100 }, (_, index) => ({ event: "cross-referenced", source: source(3400 + index), created_at: "2026-10-12T16:00:00Z" }));
    const api = boundary([first, [{ event: "cross-referenced", source: source(3500), created_at: at }]], { existing: [3399] });
    const result = await api.sync();
    const links = progress.mergeGithubLinks(api.record.links, result);
    expect(links.pullRequestNumbers).toContain(3399);
    expect(links.pullRequestNumbers).toContain(3500);
    expect(links.pullRequestNumbers).not.toContain(3400);
    expect(links.pullRequestNumbers).toHaveLength(10);
    expect(links.discoveredPullRequestNumbers[0]).toBe(3500);
    const fresh = progress.mergeGithubLinks(links, { issues: result.issues,
      discoveredPullRequestNumbers: [3600, ...links.discoveredPullRequestNumbers],
      pullRequests: [{ number: 3600, state: "open", updatedAt: at }, ...result.pullRequests] });
    expect(fresh.pullRequestNumbers).toContain(3399);
    expect(fresh.pullRequestNumbers).toContain(3600);
    expect(fresh.pullRequestNumbers).not.toContain(links.discoveredPullRequestNumbers.at(-1));
    expect(fresh.pullRequestNumbers).toHaveLength(10);
  });
  it("allows manual attachment when discovered PRs already fill the cap", async () => {
    const api = boundary([[]]);
    const auto = Array.from({ length: 10 }, (_, index) => 3400 + index);
    api.record.links.pullRequestNumbers = auto;
    api.record.links.discoveredPullRequestNumbers = auto;
    const result = await github.executeGithubOperation({ operation: "attach_pull_request", targetNumber: 3600, record: api.record }, api.client);
    const links = progress.mergeGithubLinks(api.record.links, result);
    expect(links.pullRequestNumbers).toContain(3600);
    expect(links.pullRequestNumbers).toHaveLength(10);
    expect(links.discoveredPullRequestNumbers).not.toContain(3600);
    expect(links.discoveredPullRequestNumbers).toHaveLength(9);
  });
  it("propagates a timeline outage so sync cannot claim fresh evidence", async () => {
    const api = boundary([[]], { timelineStatus: 503 });
    await expect(api.sync()).rejects.toMatchObject({ kind: "retryable", status: 503 });
  });
});


describe("first-time PR discovery notification boundary", () => {
  beforeAll(() => {
    if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) throw new Error("A local Firestore emulator is required");
    if (!admin.apps.length) admin.initializeApp({ projectId: project });
    db = isolatedFirestore("bug-report-github-timeline.test.js");
  });
  beforeEach(async () => {
    await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" }, db);
  });
  afterAll(async () => { await Promise.all(admin.apps.map((app) => app.delete())); });
  it("rechecks manual capacity in settlement when another attachment completes during its HTTP read", async () => {
    const id = `br_${"e".repeat(32)}`;
    const manual = Array.from({ length: 9 }, (_, index) => 3300 + index);
    const ref = db.collection("bug_reports").doc(id);
    const api = boundary([[]], { beforePullRead: async () => {
      await ref.update({ "links.pullRequestNumbers": [...manual, 3601] });
    } });
    await ref.set({ ...api.record, id, version: 1, createdAt: at, updatedAt: at,
      githubDelivery: { state: "synced" }, links: { githubIssueNumbers: [3390], pullRequestNumbers: manual, pullRequests: [] } });
    await db.collection("bugReportGithubOutbox").doc("manual-job").set({ reportId: id, operation: "attach_pull_request", targetNumber: 3600, state: "pending", attemptCount: 0, nextAttemptAt: new Date(at) });
    expect(await github.processGithubOutboxRow("manual-job", { firestore: db, client: api.client, now: () => new Date(at) })).toEqual({ state: "terminal_failed" });
    expect((await ref.get()).data().links.pullRequestNumbers).toEqual([...manual, 3601]);
  });
  it("notifies for first evidence of a manual link while keeping discovery alone silent", async () => {
    const api = boundary([[{ event: "cross-referenced", source: source(3400), created_at: at }]]);
    const id = `br_${"f".repeat(32)}`;
    const ref = db.collection("bug_reports").doc(id);
    await ref.set({ ...api.record, id, version: 1, createdAt: at, updatedAt: at,
      githubDelivery: { state: "synced" },
      links: { ...api.record.links, githubIssues: [{ number: 3390, state: "open", updatedAt: at }] } });
    async function sync(jobId) {
      await db.collection("bugReportGithubOutbox").doc(jobId).set({ reportId: id, operation: "sync", state: "pending", attemptCount: 0, nextAttemptAt: new Date(at) });
      expect(await github.processGithubOutboxRow(jobId, { firestore: db, client: api.client, now: () => new Date(at) })).toEqual({ state: "delivered" });
    }
    await sync("first-discovery");
    expect((await db.collection("bugReportDeliveryOutbox").get()).size).toBe(0);
    await ref.update({ "links.pullRequestNumbers": [3400, 3500] });
    await sync("first-manual-state");
    expect((await ref.get()).data().links.discoveredPullRequestNumbers).toEqual([3400]);
    expect((await db.collection("bugReportDeliveryOutbox").get()).size).toBe(1);
  });
  it.each(["open", "closed"])("silences discovery when the previously linked issue was %s", async (previousState) => {
    const api = boundary([[{ event: "cross-referenced", source: source(3400) }]]);
    const id = `br_${"c".repeat(32)}`;
    const report = { ...api.record, id, version: 1, createdAt: at, updatedAt: at,
      githubDelivery: { state: "synced", fixStatus: "running" },
      links: { ...api.record.links, githubIssues: [{ number: 3390, state: previousState, updatedAt: at }] } };
    await db.collection("bug_reports").doc(id).set(report);
    await db.collection("bugReportGithubOutbox").doc("discovery-job").set({ reportId: id, operation: "sync", state: "pending", attemptCount: 0, nextAttemptAt: new Date(at) });
    expect(await github.processGithubOutboxRow("discovery-job", { firestore: db, client: api.client, now: () => new Date(at) })).toEqual({ state: "delivered" });
    const stored = (await db.collection("bug_reports").doc(id).get()).data();
    expect(stored.links.pullRequestNumbers).toEqual([3400]);
    expect(stored.links.pullRequests[0].merged).toBe(true);
    expect(stored.status).toBe("open");
    // The HTTP issue is open. A real existing issue transition still refreshes
    // its card; the discovery alone never queues a Telegram or email entry.
    expect((await db.collection("bugReportDeliveryOutbox").get()).size).toBe(previousState === "open" ? 0 : 1);
    const rows = (await db.collection("bugReportDeliveryOutbox").get()).docs.map((doc) => doc.data());
    expect(rows.every((row) => row.channel === "telegram")).toBe(true);
    expect((await db.collection("admin_logs").get()).size).toBe(1);
  });
});


it("preserves a manual attachment made during discovery without filling all manual slots", async () => {
  // Pure settlement contract: the latest stored manual link outranks the older
  // sync snapshot, even when its authoritative PR read has not arrived yet.
  const auto = Array.from({ length: 9 }, (_, index) => 3400 + index);
  const current = { pullRequestNumbers: [3399, 3600, ...auto.slice(0, 8)],
    discoveredPullRequestNumbers: auto.slice(0, 8),
    pullRequests: auto.slice(0, 8).map((number) => ({ number, state: "closed", merged: true })) };
  const links = progress.mergeGithubLinks(current, { issues: [], discoveredPullRequestNumbers: [3500, ...auto],
    pullRequests: [3399, 3500, ...auto.slice(0, 8)].map((number) => ({ number, state: "closed", merged: true })) });
  expect(links.pullRequestNumbers).toContain(3399);
  expect(links.pullRequestNumbers).toContain(3600);
  expect(links.pullRequestNumbers).toHaveLength(10);
  expect(links.discoveredPullRequestNumbers).not.toContain(3600);
  expect(links.discoveredPullRequestNumbers).toHaveLength(8);
});
