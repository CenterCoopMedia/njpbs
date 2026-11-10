import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import admin from "../helpers/firebase-admin.js";
import auth from "../../functions/lib/auth.js";
import triage from "../../functions/bug-report-triage.js";
import contract from "../../functions/lib/bug-report-contract.js";

const PROJECT = "demo-njpbs";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST;
const ACTOR_UID = "triage-admin";
const REPORT_ID = `br_${"1".repeat(32)}`;
const NOW = "2026-10-08T22:00:00.000Z";
const BODY = {
  reportId: REPORT_ID,
  baseVersion: 1,
  mutationId: "33333333-3333-4333-8333-333333333333",
  action: "create_github_issue_and_fix",
};
const COLLECTIONS = [
  "bug_reports", "admin_logs", "bugReportMutationReceipts",
  "bugReportDeliveryOutbox", "bugReportGithubOutbox",
];
let db;

async function update(firestore = db) {
  const response = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await triage.createCmsUpdateBugReportHandler({ firestore, now: () => NOW })({
    method: "POST",
    headers: { authorization: `Bearer ${ACTOR_UID}` },
    body: BODY,
  }, response);
  return response;
}

async function storedState() {
  return Promise.all(COLLECTIONS.map(async (collection) => {
    const snapshot = await db.collection(collection).orderBy("__name__").get();
    return snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
  }));
}

async function changeAccount(profile) {
  const ref = db.collection("users").doc(ACTOR_UID);
  if (profile === null) await ref.delete();
  else await ref.set(profile);
}

beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(FIRESTORE_HOST ?? "")) {
    throw new Error("A local Firestore emulator is required");
  }
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = admin.firestore();
});

beforeEach(async () => {
  await clearEmulatorFirestore(`http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  auth.resetAuthTokenCache();
  // Authentication's external token verifier is the only auth fake. Both
  // principal resolution and the administrator precheck read stored users.
  vi.spyOn(admin.auth(), "verifyIdToken").mockResolvedValue({
    uid: ACTOR_UID, email: "triage-admin@example.test", email_verified: true,
  });
  await changeAccount({ role: "admin", active: true });
  await db.collection("bug_reports").doc(REPORT_ID).set(contract.composeBugReport({
    severity: "work_impaired",
    area: "content_editing",
    tryingToDo: "Save a draft.",
    happened: "The save stopped.",
    expected: "The draft should save.",
    route: "/content/posts/example/edit",
    clientContext: {
      browser: "Chrome 140", operatingSystem: "Linux",
      viewport: { width: 1280, height: 720 }, online: true,
      timeZone: "America/New_York",
    },
    correlationIds: [],
  }, {
    reportId: REPORT_ID, nowIso: NOW,
    reporter: { uid: "reporter", email: "reporter@example.test", role: "editor" },
    buildRevision: "b".repeat(40), deploymentEnvironment: "emulator",
    requestId: "22222222-2222-4222-8222-222222222222",
  }));
});

afterEach(() => { vi.restoreAllMocks(); auth.resetAuthTokenCache(); });
afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("bug report triage authorization at the request and storage boundaries", () => {
  const accounts = [
    { account: "demoted", profile: { role: null, active: true, grants: [{ role: "editor" }] } },
    { account: "inactive", profile: { role: "admin", active: false } },
    { account: "deleted", profile: null },
    { account: "grant-only admin", profile: { role: null, active: true, grants: [{ role: "admin" }] } },
  ];

  it.each(accounts.flatMap((account) =>
    ["write", "replay", "retry"].map((phase) => ({ ...account, phase }))))(
    "refuses $phase after the admitted administrator becomes $account",
    async ({ phase, profile }) => {
      if (phase === "replay") expect((await update()).statusCode).toBe(200);
      const before = await storedState();
      let aborted = false;
      const firestore = {
        collection: db.collection.bind(db),
        runTransaction: (callback) => db.runTransaction(async (transaction) => {
          // Change the real stored account after the handler's prechecks. On
          // retry, inject Firestore's ABORTED result after the first attempt;
          // the SDK retries the transaction without committing its writes.
          if (phase !== "retry" || aborted) {
            await changeAccount(profile);
            return callback(transaction);
          }
          await callback(transaction);
          aborted = true;
          throw Object.assign(new Error("Transaction aborted"), { code: 10 });
        }),
      };

      const result = await update(firestore);

      expect(result.statusCode).toBe(403);
      expect(result.body).toEqual({ error: "Admin access required" });
      expect(await storedState()).toEqual(before);
      expect((await db.collection("users").doc(ACTOR_UID).get()).data())
        .toEqual(profile ?? undefined);
    },
  );

  it.each([
    { name: "admin", profile: { role: "admin", active: true } },
    { name: "super admin", profile: { role: "super_admin", active: true } },
    { name: "legacy admin", profile: { role: "admin" } },
  ])("allows a current $name to write and replay once", async ({ profile }) => {
    await changeAccount(profile);

    const result = await update();

    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({ changed: true, replayed: false, report: { version: 2 } });
    const beforeReplay = await storedState();
    expect(beforeReplay.map((rows) => rows.length)).toEqual([1, 1, 1, 1, 1]);
    const replay = await update();
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toMatchObject({ changed: false, replayed: true, report: { version: 2 } });
    expect(await storedState()).toEqual(beforeReplay);
  });
});
