import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import admin from "../helpers/firebase-admin.js";
import triage from "../../functions/bug-report-triage.js";
import auth from "../../functions/lib/auth.js";

const project = "demo-njpbs";
const repository = "reports-authorization/fixture";
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
let db;
let uid;
let token;
const owned = `br_${"a".repeat(32)}`;
const other = `br_${"b".repeat(32)}`;
async function list(body) {
  const response = { headers: {}, set(name, value) { this.headers[name] = value; return this; }, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  await triage.createCmsListBugReportsHandler()({ method: "POST", headers: { authorization: `Bearer ${token}` }, body }, response);
  return response;
}
beforeAll(() => {
  for (const host of [firestoreHost, authHost]) {
    if (!/^127\.0\.0\.1:\d+$/.test(host ?? "")) throw new Error("Local Auth and Firestore emulators are required");
  }
  if (!admin.apps.length) admin.initializeApp({ projectId: project });
  db = admin.firestore();
});
beforeEach(async () => {
  vi.stubEnv("CMS_BUG_REPORT_GITHUB_REPOSITORY", repository);
  auth.resetAuthTokenCache();
  await clearEmulatorFirestore(`http://${firestoreHost}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" });
  const email = `reports-${crypto.randomUUID()}@example.test`;
  const credentials = { email, password: "synthetic-emulator-password", returnSecureToken: true };
  const signup = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=synthetic`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(credentials) });
  uid = (await signup.json()).localId;
  await admin.auth().updateUser(uid, { emailVerified: true });
  const signin = await fetch(`http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=synthetic`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(credentials) });
  token = (await signin.json()).idToken;
  for (const [id, reporterUid] of [[owned, uid], [other, "other-reporter"]]) {
    await db.collection("bug_reports").doc(id).set({ id, reporter: { uid: reporterUid, email: "private@example.test", role: "editor" },
      status: "open", severity: "minor", category: "bug", tryingToDo: "Save a draft", happened: "Save stopped", createdAt: "2026-10-13T16:00:00Z",
      ownerUid: "private-owner", consoleLogs: [{ message: "Private diagnostic" }], environment: { browser: "Private context" } });
  }
});
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => { await Promise.all(admin.apps.map((app) => app.delete())); });

describe("report list authorization with real Auth and Firestore", () => {
  it.each(["admin", "super_admin"])("allows %s all reports but keeps mine scoped", async (role) => {
    await db.collection("users").doc(uid).set({ role, active: true });
    const all = await list({ view: "all" });
    expect(all.statusCode).toBe(200);
    expect(all.headers["Cache-Control"]).toBe("private, no-store");
    expect(all.body.repository).toBe(repository);
    expect(all.body.reports.map((report) => report.id).sort()).toEqual([owned, other]);
    for (const report of all.body.reports) {
      expect(report).not.toHaveProperty("reporter");
      expect(report).not.toHaveProperty("consoleLogs");
      expect(report).not.toHaveProperty("ownerUid");
      expect(report).not.toHaveProperty("environment");
    }
    expect((await list({ view: "mine" })).body.reports.map((report) => report.id)).toEqual([owned]);
  });
  it.each(["editor", "staff"])("keeps %s own-only and refuses all", async (role) => {
    await db.collection("users").doc(uid).set({ grants: [{ role }], active: true });
    expect((await list({})).body.reports.map((report) => report.id)).toEqual([owned]);
    expect((await list({ view: "mine" })).body.reports.map((report) => report.id)).toEqual([owned]);
    expect((await list({ view: "all" })).statusCode).toBe(403);
  });
  it.each([
    ["legacy editor", { grants: [{ role: "editor" }] }],
    ["legacy staff", { grants: [{ role: "staff" }] }],
    ...["viewer", "contributor", "editor", "publisher"].map((accessTier) => [accessTier, { accessTier }]),
  ])("gives activated %s only the safe shared projection with real authentication", async (_label, access) => {
    await db.doc("system/staffAccessActivation").set({ schema: 1, state: "active", cleanScan: true });
    await db.collection("users").doc(uid).set({ ...access, active: true });
    const all = await list({ view: "all" });
    expect(all.statusCode).toBe(200);
    expect(all.body).not.toHaveProperty("repository");
    expect(all.headers["Cache-Control"]).toBe("private, no-store");
    const shared = all.body.reports.find((report) => report.id === other);
    expect(shared.shared).toBe(true);
    expect(Object.keys(shared).sort()).toEqual(["shared", "id", "category", "severity", "status", "createdAt", "tryingToDo", "happened", "progress"].sort());
    expect(shared.tryingToDo).toBe("Other report");
    expect(shared.happened).toBe("");
    expect(JSON.stringify(shared)).not.toMatch(/private@example|private-owner|Private diagnostic|Private context|Save a draft|Save stopped/);
    expect((await list({ view: "mine" })).body.reports.map((report) => report.id)).toEqual([owned]);
  });
  it("checks the current stored role on every all-reports read", async () => {
    const account = db.collection("users").doc(uid);
    await account.set({ role: "admin", active: true });
    expect((await list({ view: "all" })).statusCode).toBe(200);
    await account.set({ grants: [{ role: "editor" }], active: true });
    expect((await list({ view: "all" })).statusCode).toBe(403);
    expect((await list({ view: "mine" })).body.reports.map((report) => report.id)).toEqual([owned]);
  });
});
