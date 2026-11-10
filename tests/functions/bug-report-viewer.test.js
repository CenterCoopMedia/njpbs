import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import admin from "../helpers/firebase-admin.js";
import auth from "../../functions/lib/auth.js";
import intake from "../../functions/bug-report.js";
import devIntake from "../../functions/dev-bug-report.js";
import sharp from "sharp";
import triage from "../../functions/bug-report-triage.js";
import contract from "../../functions/lib/bug-report-contract.js";

const PROJECT = "demo-njpbs";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST;
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const CLIENT_REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const OWN_ID = `br_${"1".repeat(32)}`;
const OTHER_ID = `br_${"2".repeat(32)}`;
const MISSING_ID = `br_${"3".repeat(32)}`;
const NOW = "2026-10-08T20:00:00.000Z";
const submission = {
  severity: "work_impaired",
  area: "other",
  tryingToDo: "Read the staff guide.",
  happened: "The guide did not open.",
  expected: "The guide should open.",
  route: "/guide",
  clientContext: {
    browser: "Chrome 140",
    operatingSystem: "Linux",
    viewport: { width: 1280, height: 720 },
    online: true,
    timeZone: "America/New_York",
  },
  correlationIds: [],
};
let db;

function response() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
  };
}

function jsonRequest(uid, body = {}) {
  return { method: "POST", headers: { authorization: `Bearer ${uid}` }, body };
}

async function submit(uid = "viewer", { handler = intake.createCmsSubmitBugReportHandler(), report = submission, clientRequestId = CLIENT_REQUEST_ID, screenshot, adminBuildRevision } = {}) {
  const form = new FormData();
  form.set("report", JSON.stringify(report));
  form.set("clientRequestId", clientRequestId);
  if (adminBuildRevision !== undefined) form.set("adminBuildRevision", adminBuildRevision);
  if (screenshot) form.set("screenshot", new Blob([screenshot], { type: "image/png" }), "capture.png");
  form.set("website", "");
  const request = new Request("https://cms.example.test/report", { method: "POST", body: form });
  const result = response();
  await handler({
    method: "POST",
    headers: {
      ...Object.fromEntries(request.headers),
      authorization: `Bearer ${uid}`,
      "x-njpbs-request-id": REQUEST_ID,
    },
    rawBody: Buffer.from(await request.arrayBuffer()),
  }, result);
  return result;
}

async function read(handler, uid, body) {
  const result = response();
  await handler(jsonRequest(uid, body), result);
  return result;
}

beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(FIRESTORE_HOST ?? "")) {
    throw new Error("A local Firestore emulator is required");
  }
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = admin.firestore();
  vi.stubEnv("CMS_ADMIN_BUILD_REVISION", "b".repeat(40));
  vi.stubEnv("CMS_DEPLOYMENT_ENVIRONMENT", "emulator");
});

beforeEach(async () => {
  vi.stubEnv("CMS_DEPLOYMENT_ENVIRONMENT", "emulator");
  await clearEmulatorFirestore(`http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  auth.resetAuthTokenCache();
  // Only token verification crosses a fake boundary. Principal resolution,
  // multipart parsing, authorization, projections and persistence stay real.
  vi.spyOn(admin.auth(), "verifyIdToken").mockImplementation(async (uid) => ({
    uid, email: `${uid}@example.test`, email_verified: uid !== "unverified",
  }));
  for (const uid of ["viewer", "other", "inactive", "unverified"]) {
    await db.collection("users").doc(uid).set({
      active: uid !== "inactive", role: null, grants: [{ role: "staff" }],
    });
  }
  await db.collection("users").doc("empty-scope").set({
    active: true, role: null, grants: [{ role: "editor", sections: [] }],
  });
});

describe("isolated development report intake", () => {
  let handler;
  let fetchStatus;
  function submitDev(uid = "viewer", options = {}) {
    return submit(uid, { handler, adminBuildRevision: "b".repeat(40), ...options });
  }
  beforeEach(async () => {
    vi.stubEnv("GCLOUD_PROJECT", "njpbs-site-dev");
    vi.stubEnv("CMS_DEPLOYMENT_ENVIRONMENT", "development");
    vi.stubEnv("CMS_DEV_REPORT_INTAKE_MODE", "stored-only");
    vi.stubEnv("CMS_ADMIN_BUILD_REVISION", "b".repeat(40));
    fetchStatus = vi.fn(() => { throw new Error("Production status fetch forbidden"); });
    // The target gate sees the dev tuple; all durable writes use the local demo DB.
    handler = devIntake.createDevCmsSubmitBugReportHandler({ firestore: db, fetchFn: fetchStatus });
    for (const role of ["contributor", "editor", "admin", "super_admin"]) {
      await db.collection("users").doc(role).set(["admin", "super_admin"].includes(role)
        ? { active: true, role, grants: [] }
        : { active: true, role: null, grants: [{ role }] });
    }
  });
  afterEach(() => {
    expect(fetchStatus).not.toHaveBeenCalled();
    vi.stubEnv("GCLOUD_PROJECT", PROJECT);
  });

  it.each(["viewer", "empty-scope", "contributor", "editor", "admin", "super_admin"])("stores a private durable %s receipt and normalized evidence without delivery jobs", async (uid) => {
    const screenshot = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#abcdef" } }).png().toBuffer();
    const first = await submitDev(uid, { screenshot, report: {
      ...submission, route: "/guide?token=never-store-this#private", happened: "Contact user@example.test about the guide error.",
    } });
    expect(first.statusCode).toBe(201);
    expect(first.headers["cache-control"]).toBe("private, no-store");
    expect(first.body.report).toMatchObject({ route: { path: "/guide", url: null }, environment: {
      deploymentEnvironment: "development", buildRevision: "b".repeat(40),
    }, evidence: { screenshot: { mimeType: "image/webp", width: 1600, height: 800 } } });
    expect(first.body.report.happened).not.toContain("user@example.test");
    expect(first.body.report).not.toHaveProperty("delivery");
    expect(first.body.report).not.toHaveProperty("deliveryStatus");
    const record = (await db.collection("bug_reports").doc(first.body.report.id).get()).data();
    expect(record.deliveryStatus).toBe("not_queued");
    const evidence = (await db.collection("bugReportEvidence").doc(record.id).get()).data();
    expect(evidence).toMatchObject({ reporterUid: uid, mimeType: "image/webp", width: 1600 });
    expect((await sharp(Buffer.from(evidence.bytes)).metadata()).format).toBe("webp");
    const replay = await submitDev(uid);
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toMatchObject({ idempotent: true, report: { id: record.id } });
    for (const collection of ["bug_reports", "bugReportEvidence", "admin_logs", "bugReportRateLimits"]) {
      expect((await db.collection(collection).get()).size).toBe(1);
    }
    for (const collection of ["bugReportDeliveryOutbox", "bugReportGithubOutbox", "bugReportAutofixOutbox"]) {
      expect((await db.collection(collection).get()).size).toBe(0);
    }
  });

  it.each(["inactive", "unverified", "raw"])("refuses %s without creating durable state", async (uid) => {
    expect((await submitDev(uid)).statusCode).toBe(403);
    for (const collection of ["bug_reports", "bugReportEvidence", "admin_logs", "bugReportRateLimits", "bugReportDeliveryOutbox"]) {
      expect((await db.collection(collection).get()).size).toBe(0);
    }
  });

  it.each([
    ["CMS_DEV_REPORT_INTAKE_MODE", undefined], ["CMS_DEV_REPORT_INTAKE_MODE", ""],
    ["CMS_DEV_REPORT_INTAKE_MODE", "send"], ["GCLOUD_PROJECT", "njpbs-site"],
    ["CMS_DEPLOYMENT_ENVIRONMENT", "production"], ["CMS_ADMIN_BUILD_REVISION", undefined],
    ["CMS_ADMIN_BUILD_REVISION", "bad-revision"],
  ])("fails closed before writes or replay when %s is %s", async (name, value) => {
    const saved = await submitDev();
    expect(saved.statusCode).toBe(201);
    vi.stubEnv(name, value);
    expect((await submitDev("raw")).statusCode).toBe(503);
    const refused = await submitDev();
    expect(refused.statusCode).toBe(503);
    expect(refused.headers["cache-control"]).toBe("private, no-store");
    expect((await db.collection("bug_reports").get()).size).toBe(1);
    expect((await db.collection("admin_logs").get()).size).toBe(1);
    expect((await db.collection("bugReportDeliveryOutbox").get()).size).toBe(0);
  });

  it.each([undefined, "", "a".repeat(40), "B".repeat(40), ` ${"b".repeat(40)}`, "bad-revision"])("requires the exact client Admin revision before creating durable state (%s)", async (adminBuildRevision) => {
    const refused = await submitDev("viewer", { adminBuildRevision });
    expect(refused.statusCode).toBe(409);
    expect(refused.body).toEqual({ error: "This Boardwalk version is out of date. Reload Boardwalk to send your report." });
    expect(refused.headers["cache-control"]).toBe("private, no-store");
    for (const collection of ["bug_reports", "bugReportEvidence", "admin_logs", "bugReportRateLimits", "bugReportDeliveryOutbox"]) {
      expect((await db.collection(collection).get()).size).toBe(0);
    }
  });

  it("refuses an old Admin before replay after the Function revision changes", async () => {
    const saved = await submitDev();
    expect(saved.statusCode).toBe(201);
    vi.stubEnv("CMS_ADMIN_BUILD_REVISION", "c".repeat(40));
    const refused = await submitDev();
    expect(refused.statusCode).toBe(409);
    expect(refused.body.error).toContain("Reload Boardwalk");
    const replay = await submitDev("viewer", { adminBuildRevision: "c".repeat(40) });
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toMatchObject({ idempotent: true, report: { id: saved.body.report.id, environment: { buildRevision: "b".repeat(40) } } });
    for (const collection of ["bug_reports", "admin_logs", "bugReportRateLimits"]) {
      expect((await db.collection(collection).get()).size).toBe(1);
    }
    expect((await db.collection("bugReportDeliveryOutbox").get()).size).toBe(0);
  });

  it("retains the five-new-reports quota while allowing a stored retry", async () => {
    for (let i = 1; i <= 5; i++) {
      expect((await submitDev("viewer", { clientRequestId: `${String(i).repeat(8)}-1111-4111-8111-111111111111` })).statusCode).toBe(201);
    }
    expect((await submitDev("viewer", { clientRequestId: "66666666-1111-4111-8111-111111111111" })).statusCode).toBe(429);
    expect((await submitDev()).statusCode).toBe(200);
    expect((await db.collection("bug_reports").get()).size).toBe(5);
    expect((await db.collection("bugReportDeliveryOutbox").get()).size).toBe(0);
  });
});

afterEach(() => { vi.restoreAllMocks(); auth.resetAuthTokenCache(); });
afterAll(async () => {
  vi.unstubAllEnvs();
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("Viewer problem reports at the HTTP and storage boundaries", () => {
  it("retains the production multipart contract without the dev revision field", async () => {
    const refused = await submit("viewer", { adminBuildRevision: "b".repeat(40) });
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toEqual({ error: "Unknown report field adminBuildRevision" });
    expect((await db.collection("bug_reports").get()).size).toBe(0);
    expect((await db.collection("bugReportDeliveryOutbox").get()).size).toBe(0);
  });

  it("persists a Viewer report and returns the same receipt on retry", async () => {
    const first = await submit();
    expect(first.statusCode).toBe(201);
    expect(first.body).toMatchObject({
      success: true, idempotent: false,
      report: { reporter: { uid: "viewer", role: "staff" }, tryingToDo: submission.tryingToDo },
    });
    const stored = await db.collection("bug_reports").doc(first.body.report.id).get();
    expect(stored.data().reporter).toMatchObject({ uid: "viewer", role: "staff" });
    const retry = await submit();
    expect(retry.statusCode).toBe(200);
    expect(retry.body).toMatchObject({ idempotent: true, report: { id: first.body.report.id } });
    expect((await db.collection("bug_reports").get()).size).toBe(1);
    expect((await db.collection("admin_logs").get()).size).toBe(1);
    expect((await db.collection("bugReportDeliveryOutbox").get()).size).toBe(2);
  });

  it("lists and opens only the Viewer's own reports without administration access", async () => {
    for (const [reportId, uid] of [[OWN_ID, "viewer"], [OTHER_ID, "other"]]) {
      // A report remains readable after its author moves from Editor to Viewer.
      await db.collection("bug_reports").doc(reportId).set(contract.composeBugReport(submission, {
        reportId, nowIso: NOW, reporter: { uid, email: `${uid}@example.test`, role: "editor" },
        buildRevision: "b".repeat(40), deploymentEnvironment: "emulator", requestId: REQUEST_ID,
      }));
    }
    const list = await read(triage.createCmsListBugReportsHandler(), "viewer", { view: "mine" });
    expect(list.statusCode).toBe(200);
    expect(list.body.reports.map((report) => report.id)).toEqual([OWN_ID]);
    expect(list.body.reports[0]).not.toHaveProperty("reporter");
    const detail = await read(triage.createCmsGetBugReportHandler(), "viewer", { reportId: OWN_ID });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).toMatchObject({ report: { id: OWN_ID }, audit: [], canAdminister: false });
    expect(detail.body.report).not.toHaveProperty("delivery");
    const other = await read(triage.createCmsGetBugReportHandler(), "viewer", { reportId: OTHER_ID });
    const missing = await read(triage.createCmsGetBugReportHandler(), "viewer", { reportId: MISSING_ID });
    expect(other.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(other.body).toEqual(missing.body);
  });

  it("accepts an empty-scope Editor report without granting report-reading access", async () => {
    const created = await submit("empty-scope");
    expect(created.statusCode).toBe(201);
    expect(created.body.report.reporter).toMatchObject({ uid: "empty-scope", role: "editor" });
    expect((await read(triage.createCmsListBugReportsHandler(), "empty-scope", { view: "mine" })).statusCode).toBe(403);
    expect((await read(triage.createCmsGetBugReportHandler(), "empty-scope", { reportId: created.body.report.id })).statusCode).toBe(403);
    expect((await db.collection("bug_reports").get()).size).toBe(1);
    expect((await db.collection("bugReportDeliveryOutbox").get()).size).toBe(2);
  });

  it.each(["inactive", "unverified", "raw"])("refuses %s accounts without persisting a report", async (uid) => {
    expect((await submit(uid)).statusCode).toBe(403);
    expect((await read(triage.createCmsListBugReportsHandler(), uid, {})).statusCode).toBe(403);
    expect((await db.collection("bug_reports").get()).size).toBe(0);
    expect((await db.collection("bugReportDeliveryOutbox").get()).size).toBe(0);
  });
});
