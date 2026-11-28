import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import { initializeApp as initClient, deleteApp } from "firebase/app";
import {
  getAuth,
  connectAuthEmulator,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";

const admin = adminPkg;
const PROJECT = "demo-njpbs";
const REGION = "us-central1";
const FUNCTIONS_HOST = process.env.FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001";
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
const FIRESTORE_HOST =
  process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const fnUrl = (name) => `http://${FUNCTIONS_HOST}/${PROJECT}/${REGION}/${name}`;

let db;
let clientApp;
let clientAuth;

async function signInAs(email, { verified = true, password = "password123" } = {}) {
  // Finish account creation before signing in: the emulator can record validSince
  // a second after sign-up's auth_time, and a token refresh keeps that auth_time.
  await admin.auth().createUser({ email, password, emailVerified: verified });
  const cred = await signInWithEmailAndPassword(clientAuth, email, password);
  const uid = cred.user.uid;
  const token = await cred.user.getIdToken();
  await signOut(clientAuth);
  return { uid, email, token };
}

async function seedUser(uid, data) {
  await db
    .collection("users")
    .doc(uid)
    .set({
      email: null,
      displayName: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...data,
    });
}

async function callFn(name, token, body) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(fnUrl(name), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function adminLogs() {
  const snapshot = await db.collection("admin_logs").get();
  return snapshot.docs.map((doc) => doc.data());
}

async function seedOwner(prefix) {
  const owner = await signInAs(`${prefix}-owner@example.com`);
  await seedUser(owner.uid, { email: owner.email, accessTier: "owner", active: true });
  return owner;
}

// Moved from roles.test.js when the role grant Functions were removed (#746).
describe("staff deactivation through Auth and the deployed Function", () => {
  beforeAll(() => {
    admin.initializeApp({ projectId: PROJECT });
    db = admin.firestore();
    clientApp = initClient({ apiKey: "demo-key", projectId: PROJECT });
    clientAuth = getAuth(clientApp);
    connectAuthEmulator(clientAuth, `http://${AUTH_HOST}`, {
      disableWarnings: true,
    });
  });

  beforeEach(async () => {
    await clearEmulatorFirestore(
      `http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
      { method: "DELETE" },
    );
    await fetch(
      `http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`,
      { method: "DELETE" },
    );
    await db.doc("system/staffAccessActivation").set({ schema: 1, state: "active", cleanScan: true });
  });

  afterAll(async () => {
    await Promise.all(admin.apps.map((app) => app.delete()));
    await deleteApp(clientApp);
  });

  it("lets an Owner deactivate staff, disables Auth, and records one audit row", async () => {
    const actor = await seedOwner("deactivate");
    const target = await signInAs("deactivate-target@example.com");
    await seedUser(target.uid, { email: target.email, accessTier: "admin", active: true });

    const res = await callFn("deactivateStaff", actor.token, { targetUid: target.uid });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      uid: target.uid,
      alreadyInactive: false,
    });
    const profile = (await db.collection("users").doc(target.uid).get()).data();
    expect(profile).toMatchObject({ active: false });
    expect(profile).not.toHaveProperty("accessTier");
    expect(profile.tokensValidAfter).toEqual(expect.any(Number));
    expect(profile.tokensValidAfter).toBeGreaterThan(0);
    await expect(admin.auth().getUser(target.uid)).resolves.toMatchObject({ disabled: true });
    await expect(admin.auth().verifyIdToken(target.token, true)).rejects.toMatchObject({
      code: expect.stringMatching(/^auth\/(id-token-revoked|user-disabled)$/),
    });
    const logs = await adminLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: "staff.deactivate",
      actorUid: actor.uid,
      target: target.uid,
      before: { active: true, accessTier: "admin" },
      after: { active: false },
    });
  });

  it("refuses an Owner's self-deactivation through the deployed Function", async () => {
    const actor = await seedOwner("deactivate-self");

    const res = await callFn("deactivateStaff", actor.token, { targetUid: actor.uid });

    expect(res.status).toBe(403);
    const profile = (await db.collection("users").doc(actor.uid).get()).data();
    expect(profile).toMatchObject({ accessTier: "owner", active: true });
    await expect(admin.auth().getUser(actor.uid)).resolves.toMatchObject({ disabled: false });
    expect(await adminLogs()).toHaveLength(0);
  });
});
