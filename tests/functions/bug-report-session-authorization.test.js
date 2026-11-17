import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import admin from "../helpers/firebase-admin.js";
import auth from "../../functions/lib/auth.js";
import triage from "../../functions/bug-report-triage.js";
import github from "../../functions/bug-report-github.js";
import contract from "../../functions/lib/bug-report-contract.js";

const project = "demo-njpbs";
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const actorUid = "report-session-admin";
const reportId = `br_${"c".repeat(32)}`;
const now = "2026-11-17T12:00:00.000Z";
const sessionTime = Math.floor(Date.now() / 1000);
const screenshot = Buffer.from("synthetic-private-image");
const issue = { number: 17, title: "Fixture report issue", state: "open",
  html_url: "https://github.com/example/reports/issues/17", body: "Fixture issue details" };
const githubClient = () => github.createGithubClient({ repository: "example/reports", repositoryId: 1000001,
  token: "synthetic-github-token", fetchFn: async input => {
    const path = new URL(input).pathname;
    if (path === "/repos/example/reports") return Response.json({ full_name: "example/reports", id: 1000001 });
    if (path === "/repos/example/reports/issues") return Response.json([issue]);
    if (path === "/repos/example/reports/issues/17") return Response.json(issue);
    if (path === "/repos/example/reports/issues/17/comments") return Response.json([]);
    throw new Error(`Unexpected synthetic GitHub request: ${path}`);
  } });
const mutation = { reportId, baseVersion: 1, mutationId: "33333333-3333-4333-8333-333333333333", action: "acknowledge" };
const operations = [
  { name: "list", create: triage.createCmsListBugReportsHandler, body: { view: "all" } },
  { name: "detail", create: triage.createCmsGetBugReportHandler, body: { reportId } },
  { name: "evidence", create: triage.createCmsGetBugReportEvidenceHandler, body: { reportId } },
  { name: "triage", create: triage.createCmsUpdateBugReportHandler, body: mutation },
  { name: "GitHub list", create: github.createCmsListGithubIssuesHandler, body: { state: "open" } },
  { name: "GitHub detail", create: github.createCmsGetGithubIssueHandler, body: { number: 17 } },
];
let db;

async function request(operation) {
  const response = { statusCode: null, body: null,
    set() { return this; }, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
  await operation.create({ now: () => now, createClient: githubClient })({ method: "POST",
    headers: { authorization: `Bearer ${actorUid}` }, body: operation.body }, response);
  return response;
}

beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(firestoreHost ?? "")) throw new Error("A local Firestore emulator is required");
  if (!admin.apps.length) admin.initializeApp({ projectId: project });
  db = admin.firestore();
});

beforeEach(async () => {
  await clearEmulatorFirestore(`http://${firestoreHost}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" });
  vi.stubEnv("CMS_BUG_REPORT_GITHUB_REPOSITORY", "example/reports");
  vi.stubEnv("CMS_BUG_REPORT_GITHUB_REPOSITORY_ID", "1000001");
  auth.resetAuthTokenCache();
  // Only the external token verifier and GitHub HTTP boundary are faked.
  // Authorization resolves the stored profile, activation and session watermark.
  vi.spyOn(admin.auth(), "verifyIdToken").mockResolvedValue({ uid: actorUid,
    email: "admin@example.org", email_verified: true, auth_time: sessionTime });
  await db.doc("system/staffAccessActivation").set({ schema: 1, state: "active", cleanScan: true });
  await db.collection("bug_reports").doc(reportId).set(contract.composeBugReport({
    severity: "work_impaired", area: "content_editing", tryingToDo: "Read a private report",
    happened: "Private report text", expected: "Read the report and screenshot",
    route: "/content/post/example/edit", correlationIds: [], clientContext: {
      browser: "Chrome 157", operatingSystem: "Linux", viewport: { width: 1280, height: 720 },
      online: true, timeZone: "America/New_York",
    },
  }, { reportId, nowIso: now, reporter: { uid: "reporter", email: "reporter@example.org", role: "editor" },
    buildRevision: "b".repeat(40), deploymentEnvironment: "emulator",
    requestId: "22222222-2222-4222-8222-222222222222" }));
  await db.collection("bugReportEvidence").doc(reportId).set({ reportId,
    mimeType: "image/webp", bytes: screenshot, width: 1, height: 1 });
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); auth.resetAuthTokenCache(); });
afterAll(async () => { await Promise.all(admin.apps.map(app => app.delete())); });

describe("report administration with stored session watermarks", () => {
  it.each(["admin", "owner"])("allows a fresh %s session through every report admin boundary", async accessTier => {
    await db.collection("users").doc(actorUid).set({ accessTier, active: true, tokensValidAfter: sessionTime - 1 });
    const list = await request(operations[0]);
    expect(list.statusCode).toBe(200);
    expect(list.body.repository).toBe("example/reports");
    expect(list.body.reports[0].happened).toBe("Private report text");
    const detail = await request(operations[1]);
    expect(detail.statusCode).toBe(200);
    expect(detail.body.canAdminister).toBe(true);
    expect(detail.body.report.happened).toBe("Private report text");
    const evidence = await request(operations[2]);
    expect(evidence.statusCode).toBe(200);
    expect(evidence.body.base64).toBe(screenshot.toString("base64"));
    const update = await request(operations[3]);
    expect(update.statusCode).toBe(200);
    expect(update.body.report.status).toBe("acknowledged");
    expect((await db.collection("bug_reports").doc(reportId).get()).data().version).toBe(2);
    const githubList = await request(operations[4]);
    expect(githubList.statusCode).toBe(200);
    expect(githubList.body.issues[0].number).toBe(17);
    const githubDetail = await request(operations[5]);
    expect(githubDetail.statusCode).toBe(200);
    expect(githubDetail.body.issue.body).toBe("Fixture issue details");
  });

  it("accepts the initial zero watermark after a fresh sign-in", async () => {
    await db.collection("users").doc(actorUid).set({ accessTier: "owner", active: true, tokensValidAfter: 0 });
    const response = await request(operations[2]);
    expect(response.statusCode).toBe(200);
    expect(response.body.base64).toBe(screenshot.toString("base64"));
  });

  it.each(operations)("refuses a revoked session at the $name boundary", async operation => {
    await db.collection("users").doc(actorUid).set({ accessTier: "owner", active: true, tokensValidAfter: sessionTime });
    const response = await request(operation);
    expect(response.statusCode).toBe(401);
    expect(response.body.error).toMatch(/session was revoked/i);
    expect((await db.collection("bug_reports").doc(reportId).get()).data().version).toBe(1);
  });

  it("keeps fresh non-admin sessions on the safe shared projection", async () => {
    await db.collection("users").doc(actorUid).set({ accessTier: "editor", active: true, tokensValidAfter: 0 });
    const list = await request(operations[0]);
    expect(list.statusCode).toBe(200);
    expect(list.body.reports[0].shared).toBe(true);
    expect(list.body).not.toHaveProperty("repository");
    const detail = await request(operations[1]);
    expect(detail.statusCode).toBe(200);
    expect(detail.body.canAdminister).toBe(false);
    expect(detail.body.report.shared).toBe(true);
    expect(detail.body.report).not.toHaveProperty("evidence");
    expect((await request(operations[2])).statusCode).toBe(404);
    expect((await request(operations[3])).statusCode).toBe(403);
    expect((await request(operations[4])).statusCode).toBe(403);
    expect((await request(operations[5])).statusCode).toBe(403);
    expect((await db.collection("bug_reports").doc(reportId).get()).data().version).toBe(1);
  });
});
