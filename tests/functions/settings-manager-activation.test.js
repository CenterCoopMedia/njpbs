import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteApp } from "firebase-admin/app";
import admin from "../helpers/firebase-admin.js";
import settingsPkg from "../../functions/settings.js";

const { createCmsSaveSettingsHandler } = settingsPkg;

// The handler's own Firestore is a second emulator project, so a read that
// falls back to the module database sees no activation receipt and no profile.
const DEFAULT_PROJECT = "demo-njpbs";
const HANDLER_PROJECT = "demo-njpbs-settings-owner";
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
const SETTINGS_SCHEMAS = Object.freeze({
  "site-brand": {
    currentVersion: 1,
    versions: { 1: { schemaVersion: 1, fields: { headline: { kind: "string", required: true, maxBytes: 120 } } } },
  },
});
const UID = "settings-actor";
let handlerApp;
let handlerDb;
let defaultDb;

function response() {
  const res = { statusCode: null, body: null };
  res.set = () => res;
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

async function save() {
  // The request principal is the stale view: an admin at sign-in time. The
  // transaction must decide from the stored profile and the activation receipt.
  const handler = createCmsSaveSettingsHandler({
    firestore: handlerDb,
    requirePrincipalFn: async () => ({ uid: UID, email: "actor@example.test", principal: { id: UID, grants: [{ role: "admin" }] } }),
    settingsSchemas: SETTINGS_SCHEMAS,
    log: { error: vi.fn(), warn: vi.fn() },
  });
  const body = { id: "site-brand", values: { headline: "Changed" }, createOnly: true };
  const res = response();
  await handler({ method: "POST", body, headers: { "content-type": "application/json" }, ip: "203.0.113.17",
    rawBody: Buffer.from(JSON.stringify(body)) }, res);
  return res;
}

beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(firestoreHost ?? "")) throw new Error("Local Firestore required");
  if (!admin.apps.length) admin.initializeApp({ projectId: DEFAULT_PROJECT });
  defaultDb = admin.firestore();
  handlerApp = admin.initializeApp({ projectId: HANDLER_PROJECT }, "settings-owner");
  handlerDb = admin.firestore(handlerApp);
});
beforeEach(async () => {
  await Promise.all([DEFAULT_PROJECT, HANDLER_PROJECT].map((project) =>
    clearEmulatorFirestore(`http://${firestoreHost}/emulator/v1/projects/${project}/databases/(default)/documents`, { method: "DELETE" })));
  await handlerDb.doc("system/staffAccessActivation").set({ schema: 1, state: "active", cleanScan: true });
});
afterAll(async () => { if (handlerApp) await deleteApp(handlerApp); });

describe("settings save decides from the stored profile in its own Firestore", () => {
  it("refuses a Viewer tier with stale legacy Owner fields after activation", async () => {
    await handlerDb.collection("users").doc(UID).set({ email: "actor@example.test", accessTier: "viewer", active: true,
      role: "super_admin", grants: [{ role: "editor" }] });
    const res = await save();
    expect(res.statusCode).toBe(403);
    expect((await handlerDb.collection("cmsSettings").doc("site-brand").get()).exists).toBe(false);
    expect((await defaultDb.collection("cmsSettings").doc("site-brand").get()).exists).toBe(false);
  });

  it("accepts an Admin tier after activation", async () => {
    await handlerDb.collection("users").doc(UID).set({ email: "actor@example.test", accessTier: "admin", active: true });
    const res = await save();
    expect(res.statusCode).toBe(200);
    expect((await handlerDb.collection("cmsSettings").doc("site-brand").get()).data().values).toEqual({ headline: "Changed" });
  });
});
