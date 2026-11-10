import { clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import { deleteApp, initializeApp as initClient } from "firebase/app";
import {
  connectAuthEmulator,
  signInWithEmailAndPassword,
  getAuth,
  signOut,
} from "firebase/auth";

const admin = adminPkg;
const PROJECT = "demo-njpbs";
const REGION = "us-central1";
const FUNCTIONS_HOST = process.env.FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001";
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const functionUrl = `http://${FUNCTIONS_HOST}/${PROJECT}/${REGION}/cmsListAudit`;

describe("cmsListAudit emulator wiring", () => {
  let db;
  let clientApp;
  let clientAuth;

  beforeAll(() => {
    if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
    db = admin.firestore();
    clientApp = initClient(
      { apiKey: "demo-key", projectId: PROJECT },
      "list-audit-test",
    );
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
    await fetch(`http://${AUTH_HOST}/emulator/v1/projects/${PROJECT}/accounts`, {
      method: "DELETE",
    });
  });

  afterAll(async () => {
    await deleteApp(clientApp);
    await Promise.all(admin.apps.map((app) => app.delete()));
  });

  it("serves an admin and refuses an editor through real auth and Firestore", async () => {
    // Finish account creation before password sign-in: refreshing a signup token
    // retains auth_time, which can precede the emulator's validSince.
    await admin.auth().createUser({
      email: "audit-admin@example.com",
      password: "password123",
      emailVerified: true,
    });
    const adminCredential = await signInWithEmailAndPassword(
      clientAuth, "audit-admin@example.com", "password123",
    );
    const adminUid = adminCredential.user.uid;
    await db.collection("users").doc(adminUid).set({ role: "admin", grants: [] });
    await db.collection("admin_logs").doc("log-1").set({
      actorUid: adminUid,
      actorEmail: "audit-admin@example.com",
      action: "cms.save",
      target: "cmsPages/home",
      before: { status: "draft" },
      after: { status: "in_review" },
      source: "emulator-test",
      at: "2026-08-12T20:15:00.000Z",
    });
    const adminToken = await adminCredential.user.getIdToken();
    await signOut(clientAuth);

    const adminResponse = await fetch(functionUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    expect(adminResponse.status).toBe(200);
    await expect(adminResponse.json()).resolves.toMatchObject({
      success: true,
      entries: [{ id: "log-1", action: "cms.save", target: "cmsPages/home" }],
      nextCursor: null,
    });

    await admin.auth().createUser({
      email: "audit-editor@example.com",
      password: "password123",
      emailVerified: true,
    });
    const editorCredential = await signInWithEmailAndPassword(
      clientAuth, "audit-editor@example.com", "password123",
    );
    const editorUid = editorCredential.user.uid;
    await db.collection("users").doc(editorUid).set({
      role: null,
      grants: [{ role: "editor" }],
    });
    const editorToken = await editorCredential.user.getIdToken();
    await signOut(clientAuth);

    const editorResponse = await fetch(functionUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${editorToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    expect(editorResponse.status).toBe(403);
    await expect(editorResponse.json()).resolves.toMatchObject({
      error: "You do not have permission to view administrative activity.",
    });
  }, 20_000);

  it("fails closed when Firestore ordering omits an audit row without at", async () => {
    await admin.auth().createUser({
      email: "audit-integrity@example.com",
      password: "password123",
      emailVerified: true,
    });
    const credential = await signInWithEmailAndPassword(
      clientAuth, "audit-integrity@example.com", "password123",
    );
    const uid = credential.user.uid;
    await db.collection("users").doc(uid).set({ role: "admin", grants: [] });
    await db.collection("admin_logs").doc("legacy-without-at").set({
      actorUid: uid,
      action: "cms.save",
      target: "cmsPages/legacy",
    });
    const token = await credential.user.getIdToken();
    await signOut(clientAuth);

    const response = await fetch(functionUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/missing.*timestamp/i),
    });
  }, 20_000);
});
