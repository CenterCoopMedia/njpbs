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
      role: null,
      grants: [],
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

// Every scoped grant is validated against the runtime section registry, so the desks a
// test grants must exist before it runs.
async function seedSections() {
  await Promise.all(
    ["watch", "support", "station", "compliance"].map((id) =>
      db.collection("sections").doc(id).set({ id, label: id, order: 1 }),
    ),
  );
}

async function seedSuperAdmin(prefix) {
  const s = await signInAs(`${prefix}-super@example.com`);
  await seedUser(s.uid, { email: s.email, role: "super_admin" });
  return s;
}

describe("role functions", () => {
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
    await seedSections();
  });

  afterAll(async () => {
    await Promise.all(admin.apps.map((app) => app.delete()));
    await deleteApp(clientApp);
  });

  it("super_admin grants an editor section grant", async () => {
    const s = await signInAs("super@example.com");
    await seedUser(s.uid, { email: s.email, role: "super_admin" });
    const t = await signInAs("target@example.com");
    await seedUser(t.uid, { email: t.email, role: null });

    const res = await callFn("grantRole", s.token, {
      targetUid: t.uid,
      role: "editor",
      sections: ["watch"],
    });

    expect(res.status).toBe(200);
    const user = (await db.collection("users").doc(t.uid).get()).data();
    expect(user.grants).toContainEqual({ role: "editor", sections: ["watch"] });
    const logs = await adminLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: "roles.grant",
      actorUid: s.uid,
      target: t.uid,
    });
    expect(logs[0].after.grants).toHaveLength(1);
  });

  it("refuses a grant naming a section outside the registry", async () => {
    const s = await seedSuperAdmin("unknown-section");
    const t = await signInAs("unknown-section-target@example.com");
    await seedUser(t.uid, { email: t.email, role: null });

    const res = await callFn("grantRole", s.token, {
      targetUid: t.uid,
      role: "editor",
      sections: ["news"],
    });

    // A typo would otherwise become a scope that matches no content, which reads in the
    // admin UI as a grant that worked.
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Unknown section: news/);
    const target = (await db.collection("users").doc(t.uid).get()).data();
    expect(target.grants).toEqual([]);
    await expect(adminLogs()).resolves.toEqual([]);
  });

  it("names every unregistered section in one refusal", async () => {
    const s = await seedSuperAdmin("unknown-sections");
    const t = await signInAs("unknown-sections-target@example.com");
    await seedUser(t.uid, { email: t.email, role: null });

    const res = await callFn("grantRole", s.token, {
      targetUid: t.uid,
      role: "contributor",
      sections: ["watch", "news", "arts"],
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Unknown section: news, arts/);
  });

  it("still revokes a stale grant that names an unregistered section", async () => {
    const s = await seedSuperAdmin("stale-revoke");
    const t = await signInAs("stale-revoke-target@example.com");
    await seedUser(t.uid, {
      email: t.email,
      role: null,
      grants: [{ role: "editor", sections: ["news"] }],
    });

    // A desk removed from the registry must stay cleanable. Blocking the revoke would
    // strand the grant with no way to take it back.
    const res = await callFn("revokeRole", s.token, {
      targetUid: t.uid,
      role: "editor",
      sections: ["news"],
    });

    expect(res.status).toBe(200);
    const target = (await db.collection("users").doc(t.uid).get()).data();
    expect(target.grants).toEqual([]);
  });

  it("still accepts a site-wide grant, which names no section to validate", async () => {
    const s = await seedSuperAdmin("sitewide-unvalidated");
    const t = await signInAs("sitewide-unvalidated-target@example.com");
    await seedUser(t.uid, { email: t.email, role: null });

    const res = await callFn("grantRole", s.token, {
      targetUid: t.uid,
      role: "editor",
      siteWide: true,
    });

    expect(res.status).toBe(200);
    const target = (await db.collection("users").doc(t.uid).get()).data();
    expect(target.grants).toEqual([{ role: "editor" }]);
  });

  it("inactive super_admin cannot grant a role", async () => {
    const s = await signInAs("inactive-super@example.com");
    await seedUser(s.uid, {
      email: s.email,
      active: false,
      tokensValidAfter: 1,
      role: "super_admin",
    });
    const t = await signInAs("inactive-super-target@example.com");
    await seedUser(t.uid, { email: t.email, role: null });

    const res = await callFn("grantRole", s.token, {
      targetUid: t.uid,
      role: "editor",
      sections: ["watch"],
    });

    expect(res.status).toBe(403);
    const target = (await db.collection("users").doc(t.uid).get()).data();
    expect(target.grants).toEqual([]);
    await expect(adminLogs()).resolves.toEqual([]);
  });

  it("does not grant latent authority to an inactive target", async () => {
    const s = await seedSuperAdmin("inactive-target");
    const t = await signInAs("inactive-target-user@example.com");
    await seedUser(t.uid, {
      email: t.email,
      active: false,
      tokensValidAfter: 1,
      role: null,
      grants: [],
    });

    const res = await callFn("grantRole", s.token, {
      targetUid: t.uid,
      role: "editor",
      sections: ["watch"],
    });

    expect(res.status).toBe(409);
    const target = (await db.collection("users").doc(t.uid).get()).data();
    expect(target.grants).toEqual([]);
    await expect(adminLogs()).resolves.toEqual([]);
  });

  it("grantRole creates a site-wide editor grant when siteWide is true", async () => {
    const s = await seedSuperAdmin("sitewide-create");
    const t = await signInAs("sitewide-create-target@example.com");
    await seedUser(t.uid, { email: t.email, role: null });

    const res = await callFn("grantRole", s.token, {
      targetUid: t.uid,
      role: "editor",
      siteWide: true,
    });

    expect(res.status).toBe(200);
    const user = (await db.collection("users").doc(t.uid).get()).data();
    expect(user.grants).toEqual([{ role: "editor" }]);
    expect(Object.hasOwn(user.grants[0], "sections")).toBe(false);
    const logs = await adminLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].before.grants).toEqual([]);
    expect(logs[0].after.grants).toEqual([{ role: "editor" }]);
    expect(Object.hasOwn(logs[0].after.grants[0], "sections")).toBe(false);
  });

  it("grantRole widens an existing scoped editor grant when siteWide is true", async () => {
    const s = await seedSuperAdmin("sitewide-widen");
    const t = await signInAs("sitewide-widen-target@example.com");
    await seedUser(t.uid, {
      email: t.email,
      role: null,
      grants: [{ role: "editor", sections: ["watch"] }],
    });

    const res = await callFn("grantRole", s.token, {
      targetUid: t.uid,
      role: "editor",
      siteWide: true,
    });

    expect(res.status).toBe(200);
    const user = (await db.collection("users").doc(t.uid).get()).data();
    expect(user.grants).toEqual([{ role: "editor" }]);
    expect(Object.hasOwn(user.grants[0], "sections")).toBe(false);
    const logs = await adminLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].before.grants).toEqual([
      { role: "editor", sections: ["watch"] },
    ]);
    expect(logs[0].after.grants).toEqual([{ role: "editor" }]);
    expect(Object.hasOwn(logs[0].after.grants[0], "sections")).toBe(false);
  });

  it("grantRole rejects siteWide true when sections are present", async () => {
    const s = await seedSuperAdmin("sitewide-ambiguous");
    const t = await signInAs("sitewide-ambiguous-target@example.com");
    await seedUser(t.uid, { email: t.email, role: null });

    const res = await callFn("grantRole", s.token, {
      targetUid: t.uid,
      role: "editor",
      siteWide: true,
      sections: ["watch"],
    });

    expect(res.status).toBe(400);
    const user = (await db.collection("users").doc(t.uid).get()).data();
    expect(user.grants).toEqual([]);
    await expect(adminLogs()).resolves.toEqual([]);
  });

  it("grantRole rejects non-boolean siteWide", async () => {
    const s = await seedSuperAdmin("sitewide-nonboolean");
    const t = await signInAs("sitewide-nonboolean-target@example.com");
    await seedUser(t.uid, { email: t.email, role: null });

    const res = await callFn("grantRole", s.token, {
      targetUid: t.uid,
      role: "editor",
      siteWide: "yes",
    });

    expect(res.status).toBe(400);
    const user = (await db.collection("users").doc(t.uid).get()).data();
    expect(user.grants).toEqual([]);
    await expect(adminLogs()).resolves.toEqual([]);
  });

  it("grantRole rejects editor grants without sections or siteWide true", async () => {
    const s = await seedSuperAdmin("grant-missing-scope");
    const t = await signInAs("grant-missing-scope-target@example.com");
    await seedUser(t.uid, { email: t.email, role: null });

    const res = await callFn("grantRole", s.token, {
      targetUid: t.uid,
      role: "editor",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("sections");
    expect(body.error).toContain("siteWide");
    const user = (await db.collection("users").doc(t.uid).get()).data();
    expect(user.grants).toEqual([]);
    await expect(adminLogs()).resolves.toEqual([]);
  });

  it("requires explicit siteWide true and gives staff no CMS content access", async () => {
    const s = await seedSuperAdmin("staff-missing-scope");
    const t = await signInAs("staff-missing-scope-target@example.com");
    await seedUser(t.uid, { email: t.email, role: null });

    const missingScope = await callFn("grantRole", s.token, {
      targetUid: t.uid,
      role: "staff",
    });

    expect(missingScope.status).toBe(400);
    await expect(missingScope.json()).resolves.toEqual({
      error: "Staff guide access must use siteWide: true",
    });
    expect(
      (await db.collection("users").doc(t.uid).get()).data().grants,
    ).toEqual([]);
    await expect(adminLogs()).resolves.toEqual([]);

    const falseScope = await callFn("grantRole", s.token, {
      targetUid: t.uid,
      role: "staff",
      siteWide: false,
    });

    expect(falseScope.status).toBe(400);
    await expect(falseScope.json()).resolves.toEqual({
      error: "Staff guide access must use siteWide: true",
    });
    expect(
      (await db.collection("users").doc(t.uid).get()).data().grants,
    ).toEqual([]);
    await expect(adminLogs()).resolves.toEqual([]);

    const explicitScope = await callFn("grantRole", s.token, {
      targetUid: t.uid,
      role: "staff",
      siteWide: true,
    });

    expect(explicitScope.status).toBe(200);
    const user = (await db.collection("users").doc(t.uid).get()).data();
    expect(user.grants).toEqual([{ role: "staff" }]);
    expect(Object.hasOwn(user.grants[0], "sections")).toBe(false);

    const contentResponse = await callFn("cmsListContent", t.token, {
      query: "v=1",
    });
    expect(contentResponse.status).toBe(403);
    await expect(contentResponse.json()).resolves.toEqual({
      error: "You do not have permission to list content.",
    });

    const logs = await adminLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: "roles.grant",
      target: t.uid,
      after: { grants: [{ role: "staff" }] },
    });
  });

  it("grantRole drops malformed persisted grants before adding a scoped grant", async () => {
    const s = await signInAs("malformed-grant-super@example.com");
    await seedUser(s.uid, { email: s.email, role: "super_admin" });
    const t = await signInAs("malformed-grant-target@example.com");
    await seedUser(t.uid, {
      email: t.email,
      role: null,
      grants: [null, { role: "editor", sections: ["watch"] }],
    });

    const res = await callFn("grantRole", s.token, {
      targetUid: t.uid,
      role: "contributor",
      sections: ["support"],
    });

    expect(res.status).toBe(200);
    const user = (await db.collection("users").doc(t.uid).get()).data();
    expect(user.grants).toEqual([
      { role: "editor", sections: ["watch"] },
      { role: "contributor", sections: ["support"] },
    ]);
  });

  it("grantRole preserves an omitted sections grant while adding another scoped grant", async () => {
    const s = await signInAs("preserve-sitewide-super@example.com");
    await seedUser(s.uid, { email: s.email, role: "super_admin" });
    const t = await signInAs("preserve-sitewide-target@example.com");
    await seedUser(t.uid, {
      email: t.email,
      role: null,
      grants: [{ role: "editor" }],
    });

    const res = await callFn("grantRole", s.token, {
      targetUid: t.uid,
      role: "contributor",
      sections: ["support"],
    });

    expect(res.status).toBe(200);
    const user = (await db.collection("users").doc(t.uid).get()).data();
    expect(user.grants).toEqual([
      { role: "editor" },
      { role: "contributor", sections: ["support"] },
    ]);
    expect(Object.hasOwn(user.grants[0], "sections")).toBe(false);
  });

  it("grantRole keeps an existing site-wide grant site-wide when granting a section", async () => {
    const s = await signInAs("sitewide-merge-super@example.com");
    await seedUser(s.uid, { email: s.email, role: "super_admin" });
    const t = await signInAs("sitewide-merge-target@example.com");
    await seedUser(t.uid, {
      email: t.email,
      role: null,
      grants: [{ role: "editor" }],
    });

    const res = await callFn("grantRole", s.token, {
      targetUid: t.uid,
      role: "editor",
      sections: ["watch"],
    });

    expect(res.status).toBe(200);
    const user = (await db.collection("users").doc(t.uid).get()).data();
    expect(user.grants).toEqual([{ role: "editor" }]);
    expect(Object.hasOwn(user.grants[0], "sections")).toBe(false);
  });

  it("grantRole keeps a null sections grant scoped to nothing after a write", async () => {
    const s = await signInAs("null-sections-super@example.com");
    await seedUser(s.uid, { email: s.email, role: "super_admin" });
    const t = await signInAs("null-sections-target@example.com");
    await seedUser(t.uid, {
      email: t.email,
      role: null,
      grants: [{ role: "editor", sections: null }],
    });

    const res = await callFn("grantRole", s.token, {
      targetUid: t.uid,
      role: "contributor",
      sections: ["support"],
    });

    expect(res.status).toBe(200);
    const user = (await db.collection("users").doc(t.uid).get()).data();
    expect(user.grants).toEqual([
      { role: "editor", sections: [] },
      { role: "contributor", sections: ["support"] },
    ]);
  });

  it("grantRole provisions an Auth user without a profile", async () => {
    const s = await seedSuperAdmin("preprovision");
    const target = await admin.auth().createUser({
      email: "PreProvision-Target@example.com",
      emailVerified: true,
      displayName: "Provisioned editor",
    });

    const res = await callFn("grantRole", s.token, {
      targetEmail: target.email.toLowerCase(),
      role: "editor",
      sections: ["watch"],
    });

    expect(res.status).toBe(200);
    const userSnapshot = await db.collection("users").doc(target.uid).get();
    expect(userSnapshot.exists).toBe(true);
    expect(userSnapshot.data()).toMatchObject({
      email: target.email,
      displayName: target.displayName,
      role: null,
      grants: [{ role: "editor", sections: ["watch"] }],
    });
    expect(userSnapshot.data().createdAt).toBeDefined();
    expect(userSnapshot.data().updatedAt).toBeDefined();

    const logs = await adminLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: "roles.provision",
      actorUid: s.uid,
      target: target.uid,
      before: null,
      after: { grants: [{ role: "editor", sections: ["watch"] }] },
    });
  });

  it("grantRole does not provision an unverified Auth user", async () => {
    const s = await seedSuperAdmin("unverified-preprovision");
    const target = await admin.auth().createUser({
      email: "unverified-preprovision-target@example.com",
      emailVerified: false,
      displayName: "Unverified target",
    });

    const res = await callFn("grantRole", s.token, {
      targetEmail: target.email,
      role: "editor",
      sections: ["watch"],
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: "Target user not found",
    });
    const userSnapshot = await db.collection("users").doc(target.uid).get();
    expect(userSnapshot.exists).toBe(false);
    await expect(adminLogs()).resolves.toEqual([]);
  });

  it("grantRole grants by email to an unverified Auth user with an existing profile", async () => {
    const s = await seedSuperAdmin("unverified-existing-profile");
    const target = await admin.auth().createUser({
      email: "unverified-existing-profile-target@example.com",
      emailVerified: false,
      displayName: "Unverified existing target",
    });
    await seedUser(target.uid, {
      email: "stored-unverified-profile@example.com",
      displayName: "Existing profile",
      createdAt: "existing-created-at",
    });

    const res = await callFn("grantRole", s.token, {
      targetEmail: target.email,
      role: "editor",
      sections: ["watch"],
    });

    expect(res.status).toBe(200);
    const user = (await db.collection("users").doc(target.uid).get()).data();
    expect(user).toMatchObject({
      email: "stored-unverified-profile@example.com",
      displayName: "Existing profile",
      createdAt: "existing-created-at",
      grants: [{ role: "editor", sections: ["watch"] }],
    });
    const logs = await adminLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: "roles.grant",
      actorUid: s.uid,
      target: target.uid,
    });
  });

  it("grantRole keeps the normal grant path for an existing profile", async () => {
    const s = await signInAs("email-resolve-super@example.com");
    await seedUser(s.uid, { email: s.email, role: "super_admin" });
    const victim = await signInAs("email-resolve-victim@example.com");
    await seedUser(victim.uid, {
      email: "stale-victim-profile@example.com",
      displayName: "Existing target",
      role: null,
      createdAt: "existing-created-at",
    });
    const attacker = await signInAs("email-resolve-attacker@example.com");
    await seedUser(attacker.uid, {
      email: victim.email,
      role: null,
    });

    const res = await callFn("grantRole", s.token, {
      targetEmail: victim.email,
      role: "editor",
      sections: ["watch"],
    });

    expect(res.status).toBe(200);
    const victimDoc = (await db.collection("users").doc(victim.uid).get()).data();
    expect(victimDoc.grants).toContainEqual({
      role: "editor",
      sections: ["watch"],
    });
    expect(victimDoc).toMatchObject({
      email: "stale-victim-profile@example.com",
      displayName: "Existing target",
      role: null,
      createdAt: "existing-created-at",
    });
    const attackerDoc = (
      await db.collection("users").doc(attacker.uid).get()
    ).data();
    expect(attackerDoc.grants).toEqual([]);
    const logs = await adminLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: "roles.grant",
      target: victim.uid,
    });
  });

  it("grantRole returns 404 when the Auth user does not exist", async () => {
    const s = await seedSuperAdmin("missing-auth-target");

    const res = await callFn("grantRole", s.token, {
      targetEmail: "missing-auth-target@example.com",
      role: "editor",
      sections: ["watch"],
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: "Target user not found",
    });
    const users = await db.collection("users").get();
    expect(users.docs.map((doc) => doc.id)).toEqual([s.uid]);
    await expect(adminLogs()).resolves.toEqual([]);
  });

  it("grantRole refuses a paired setup target whose Auth user was deleted", async () => {
    const s = await seedSuperAdmin("paired-missing-auth");
    const t = await signInAs("paired-missing-auth-target@example.com");
    await seedUser(t.uid, { email: t.email, role: null });
    await admin.auth().deleteUser(t.uid);

    const res = await callFn("grantRole", s.token, {
      targetUid: t.uid,
      targetEmail: t.email,
      role: "admin",
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Target user not found" });
    const target = (await db.collection("users").doc(t.uid).get()).data();
    expect(target.role).toBeNull();
    await expect(adminLogs()).resolves.toEqual([]);
  });

  it("an unverified tier Owner cannot grant legacy access", async () => {
    await db.doc("system/staffAccessActivation").set({ schema: 1, state: "active", cleanScan: true });
    const owner = await signInAs("tier-owner-unverified@example.test", { verified: false });
    await seedUser(owner.uid, { email: owner.email, role: "super_admin", accessTier: "owner", active: true });
    const target = await signInAs("tier-owner-target@example.test");
    await seedUser(target.uid, { email: target.email, role: null });
    const response = await callFn("grantRole", owner.token, { targetUid: target.uid, role: "admin" });
    expect(response.status).toBe(403);
    expect((await db.collection("users").doc(target.uid).get()).data().role).toBeNull();
    await expect(adminLogs()).resolves.toEqual([]);
  });

  it("grantRole accepts a matching Auth identity and existing profile pair", async () => {
    const s = await seedSuperAdmin("paired-match");
    const t = await signInAs("paired-match-target@example.com");
    await seedUser(t.uid, { email: t.email, role: null });

    const res = await callFn("grantRole", s.token, {
      targetUid: t.uid,
      targetEmail: t.email.toUpperCase(),
      role: "admin",
    });

    expect(res.status).toBe(200);
    const target = (await db.collection("users").doc(t.uid).get()).data();
    expect(target.role).toBe("admin");
    const logs = await adminLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: "roles.grant", target: t.uid });
  });

  it("grantRole refuses a paired setup target whose top-level role changed", async () => {
    const s = await seedSuperAdmin("paired-role-race");
    const t = await signInAs("paired-role-race-target@example.com");
    await seedUser(t.uid, { email: t.email, role: "super_admin" });

    const res = await callFn("grantRole", s.token, {
      targetUid: t.uid,
      targetEmail: t.email,
      role: "admin",
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: "Target staff access changed; review it in the staff table",
    });
    const target = (await db.collection("users").doc(t.uid).get()).data();
    expect(target.role).toBe("super_admin");
    await expect(adminLogs()).resolves.toEqual([]);
  });

  it("grantRole refuses a paired setup target whose scoped grants changed", async () => {
    const s = await seedSuperAdmin("paired-grant-race");
    const t = await signInAs("paired-grant-race-target@example.com");
    await seedUser(t.uid, {
      email: t.email,
      role: null,
      grants: [{ role: "editor", sections: ["watch"] }],
    });

    const res = await callFn("grantRole", s.token, {
      targetUid: t.uid,
      targetEmail: t.email,
      role: "admin",
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: "Target staff access changed; review it in the staff table",
    });
    const target = (await db.collection("users").doc(t.uid).get()).data();
    expect(target).toMatchObject({
      role: null,
      grants: [{ role: "editor", sections: ["watch"] }],
    });
    await expect(adminLogs()).resolves.toEqual([]);
  });

  it("grantRole does not provision a missing profile from a matching identity pair", async () => {
    const s = await seedSuperAdmin("paired-missing-profile");
    const t = await signInAs("paired-missing-profile-target@example.com");

    const res = await callFn("grantRole", s.token, {
      targetUid: t.uid,
      targetEmail: t.email,
      role: "admin",
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Target user not found" });
    await expect(db.collection("users").doc(t.uid).get()).resolves.toMatchObject({
      exists: false,
    });
    await expect(adminLogs()).resolves.toEqual([]);
  });

  it("grantRole refuses a paired setup target whose email belongs to another uid", async () => {
    const s = await seedSuperAdmin("paired-mismatch");
    const original = await signInAs("paired-original@example.com");
    const replacement = await signInAs("paired-replacement@example.com");
    await seedUser(original.uid, { email: original.email, role: null });
    await seedUser(replacement.uid, { email: replacement.email, role: null });

    const res = await callFn("grantRole", s.token, {
      targetUid: original.uid,
      targetEmail: replacement.email,
      role: "admin",
    });

    expect(res.status).toBe(409);
    const target = (await db.collection("users").doc(original.uid).get()).data();
    expect(target.role).toBeNull();
    await expect(adminLogs()).resolves.toEqual([]);
  });

  const targetValidationEndpoints = [
    { name: "grantRole", body: { role: "editor", sections: ["watch"] } },
    { name: "revokeRole", body: { role: "editor" } },
  ];

  const malformedTargetCases = [
    { label: "object targetUid", body: { targetUid: {} }, field: "targetUid" },
    { label: "numeric targetEmail", body: { targetEmail: 42 }, field: "targetEmail" },
    { label: "whitespace targetUid", body: { targetUid: "   " }, field: "targetUid" },
  ];

  for (const endpoint of targetValidationEndpoints) {
    for (const testCase of malformedTargetCases) {
      it(`${endpoint.name} rejects ${testCase.label} with 400`, async () => {
        const s = await seedSuperAdmin(
          `${endpoint.name.toLowerCase()}-${testCase.field.toLowerCase()}-bad-target`,
        );

        const res = await callFn(endpoint.name, s.token, {
          ...endpoint.body,
          ...testCase.body,
        });

        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error).toContain(testCase.field);
      });
    }
  }

  it("grantRole trims targetUid before resolving", async () => {
    const s = await seedSuperAdmin("grant-trim-target");
    const t = await signInAs("grant-trim-target@example.com");
    await seedUser(t.uid, { email: t.email, role: null });

    const res = await callFn("grantRole", s.token, {
      targetUid: `  ${t.uid}  `,
      role: "editor",
      sections: ["watch"],
    });

    expect(res.status).toBe(200);
    const user = (await db.collection("users").doc(t.uid).get()).data();
    expect(user.grants).toContainEqual({ role: "editor", sections: ["watch"] });
  });

  it("revokeRole trims targetUid before resolving", async () => {
    const s = await seedSuperAdmin("revoke-trim-target");
    const t = await signInAs("revoke-trim-target@example.com");
    await seedUser(t.uid, {
      email: t.email,
      role: null,
      grants: [{ role: "editor", sections: ["watch"] }],
    });

    const res = await callFn("revokeRole", s.token, {
      targetUid: `  ${t.uid}  `,
      role: "editor",
    });

    expect(res.status).toBe(200);
    const user = (await db.collection("users").doc(t.uid).get()).data();
    expect(user.grants).toEqual([]);
  });

  it("super_admin grants the admin top-level role", async () => {
    const s = await signInAs("super-top@example.com");
    await seedUser(s.uid, { email: s.email, role: "super_admin" });
    const t = await signInAs("target-top@example.com");
    await seedUser(t.uid, { email: t.email, role: null });

    const res = await callFn("grantRole", s.token, {
      targetUid: t.uid,
      role: "admin",
    });

    expect(res.status).toBe(200);
    const user = (await db.collection("users").doc(t.uid).get()).data();
    expect(user.role).toBe("admin");
    const logs = await adminLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("roles.grant");
  });

  it("admin cannot grant (403)", async () => {
    const a = await signInAs("adminonly@example.com");
    await seedUser(a.uid, { email: a.email, role: "admin" });
    const t = await signInAs("admin-target@example.com");
    await seedUser(t.uid, { email: t.email, role: null });

    const res = await callFn("grantRole", a.token, {
      targetUid: t.uid,
      role: "editor",
      sections: ["watch"],
    });

    expect(res.status).toBe(403);
    const user = (await db.collection("users").doc(t.uid).get()).data();
    expect(user.grants).toEqual([]);
    await expect(adminLogs()).resolves.toEqual([]);
  });

  it("rejects a scoped sections payload on a top-level grant (400)", async () => {
    const s = await signInAs("scoped-top-super@example.com");
    await seedUser(s.uid, { email: s.email, role: "super_admin" });
    const t = await signInAs("scoped-top-target@example.com");
    await seedUser(t.uid, { email: t.email, role: null });

    const res = await callFn("grantRole", s.token, {
      targetUid: t.uid,
      role: "admin",
      sections: "watch",
    });

    expect(res.status).toBe(400);
    const user = (await db.collection("users").doc(t.uid).get()).data();
    expect(user.role).toBeNull();
  });

  it("rejects a siteWide payload on a top-level grant (400)", async () => {
    const s = await signInAs("sitewide-top-super@example.com");
    await seedUser(s.uid, { email: s.email, role: "super_admin" });
    const t = await signInAs("sitewide-top-target@example.com");
    await seedUser(t.uid, { email: t.email, role: null });

    const res = await callFn("grantRole", s.token, {
      targetUid: t.uid,
      role: "admin",
      siteWide: true,
    });

    expect(res.status).toBe(400);
    const user = (await db.collection("users").doc(t.uid).get()).data();
    expect(user.role).toBeNull();
  });

  it("blocks a super_admin from self-demoting via grantRole (403)", async () => {
    const s = await signInAs("self-demote@example.com");
    await seedUser(s.uid, { email: s.email, role: "super_admin" });

    const res = await callFn("grantRole", s.token, {
      targetUid: s.uid,
      role: "admin",
    });

    expect(res.status).toBe(403);
    const user = (await db.collection("users").doc(s.uid).get()).data();
    expect(user.role).toBe("super_admin");
  });

  it("concurrent grants for different sections both persist", async () => {
    const s = await signInAs("concurrent-super@example.com");
    await seedUser(s.uid, { email: s.email, role: "super_admin" });
    const t = await signInAs("concurrent-target@example.com");
    await seedUser(t.uid, { email: t.email, role: null });

    const [r1, r2] = await Promise.all([
      callFn("grantRole", s.token, {
        targetUid: t.uid,
        role: "editor",
        sections: ["watch"],
      }),
      callFn("grantRole", s.token, {
        targetUid: t.uid,
        role: "editor",
        sections: ["support"],
      }),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const user = (await db.collection("users").doc(t.uid).get()).data();
    const editorGrant = user.grants.find((g) => g.role === "editor");
    expect(editorGrant.sections).toEqual(
      expect.arrayContaining(["watch", "support"]),
    );
  });

  it("revoking a mismatched top-level role does not strip a higher role (409)", async () => {
    const s = await signInAs("mismatch-super@example.com");
    await seedUser(s.uid, { email: s.email, role: "super_admin" });
    const t = await signInAs("mismatch-target@example.com");
    await seedUser(t.uid, { email: t.email, role: "super_admin" });

    const res = await callFn("revokeRole", s.token, {
      targetUid: t.uid,
      role: "admin",
    });

    expect(res.status).toBe(409);
    const user = (await db.collection("users").doc(t.uid).get()).data();
    expect(user.role).toBe("super_admin");
  });

  it("missing or invalid auth is 401", async () => {
    const res = await callFn("grantRole", null, {
      targetUid: "x",
      role: "admin",
    });

    expect(res.status).toBe(401);
  });

  it("self-revoke is blocked (403)", async () => {
    const s = await signInAs("self-revoke@example.com");
    await seedUser(s.uid, { email: s.email, role: "super_admin" });

    const res = await callFn("revokeRole", s.token, {
      targetUid: s.uid,
      role: "super_admin",
    });

    expect(res.status).toBe(403);
    const user = (await db.collection("users").doc(s.uid).get()).data();
    expect(user.role).toBe("super_admin");
  });

  it("keeps at least one super_admin under concurrent cross-revocation", async () => {
    const a = await signInAs("cross-a@example.com");
    await seedUser(a.uid, { email: a.email, role: "super_admin" });
    const b = await signInAs("cross-b@example.com");
    await seedUser(b.uid, { email: b.email, role: "super_admin" });

    const [ra, rb] = await Promise.all([
      callFn("revokeRole", a.token, { targetUid: b.uid, role: "super_admin" }),
      callFn("revokeRole", b.token, { targetUid: a.uid, role: "super_admin" }),
    ]);

    // Exactly one revoke succeeds. The loser is rejected either at the pre-transaction
    // super-admin gate (403, if it was demoted first) or by the last-super-admin guard
    // inside its transaction (409); both keep the invariant.
    const statuses = [ra.status, rb.status];
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    const loser = statuses.find((s) => s !== 200);
    expect([403, 409]).toContain(loser);
    const supers = await db
      .collection("users")
      .where("role", "==", "super_admin")
      .get();
    expect(supers.size).toBe(1);
  });

  it("revoke removes an editor grant", async () => {
    const s = await signInAs("revoke-super@example.com");
    await seedUser(s.uid, { email: s.email, role: "super_admin" });
    const t = await signInAs("revoke-target@example.com");
    await seedUser(t.uid, {
      email: t.email,
      role: null,
      grants: [{ role: "editor", sections: ["watch"] }],
    });

    const res = await callFn("revokeRole", s.token, {
      targetUid: t.uid,
      role: "editor",
    });

    expect(res.status).toBe(200);
    const user = (await db.collection("users").doc(t.uid).get()).data();
    expect(user.grants).toEqual([]);
    const logs = await adminLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("roles.revoke");
  });

  it("revokeRole rejects a section revoke from a site-wide grant", async () => {
    const s = await signInAs("sitewide-revoke-super@example.com");
    await seedUser(s.uid, { email: s.email, role: "super_admin" });
    const t = await signInAs("sitewide-revoke-target@example.com");
    await seedUser(t.uid, {
      email: t.email,
      role: null,
      grants: [{ role: "editor" }],
    });

    const res = await callFn("revokeRole", s.token, {
      targetUid: t.uid,
      role: "editor",
      sections: ["watch"],
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe(
      "Site-wide grant cannot be section-revoked; revoke the full grant instead",
    );
    const user = (await db.collection("users").doc(t.uid).get()).data();
    expect(user.grants).toEqual([{ role: "editor" }]);
    expect(Object.hasOwn(user.grants[0], "sections")).toBe(false);
    await expect(adminLogs()).resolves.toEqual([]);
  });

  it("revokeRole removes a site-wide grant when sections are omitted", async () => {
    const s = await signInAs("sitewide-full-revoke-super@example.com");
    await seedUser(s.uid, { email: s.email, role: "super_admin" });
    const t = await signInAs("sitewide-full-revoke-target@example.com");
    await seedUser(t.uid, {
      email: t.email,
      role: null,
      grants: [{ role: "editor" }],
    });

    const res = await callFn("revokeRole", s.token, {
      targetUid: t.uid,
      role: "editor",
    });

    expect(res.status).toBe(200);
    const user = (await db.collection("users").doc(t.uid).get()).data();
    expect(user.grants).toEqual([]);
  });

  it("revokeRole drops malformed persisted grants before removing a scoped grant", async () => {
    const s = await signInAs("malformed-revoke-super@example.com");
    await seedUser(s.uid, { email: s.email, role: "super_admin" });
    const t = await signInAs("malformed-revoke-target@example.com");
    await seedUser(t.uid, {
      email: t.email,
      role: null,
      grants: [null, { role: "editor", sections: ["watch"] }],
    });

    const res = await callFn("revokeRole", s.token, {
      targetUid: t.uid,
      role: "editor",
    });

    expect(res.status).toBe(200);
    const user = (await db.collection("users").doc(t.uid).get()).data();
    expect(user.grants).toEqual([]);
  });

  it("allowlisted email bootstraps the first super_admin exactly once", async () => {
    const b = await signInAs("editor-fixture-1@example.org");

    const res = await callFn("grantRole", b.token, { role: "super_admin" });

    expect(res.status).toBe(200);
    const user = (await db.collection("users").doc(b.uid).get()).data();
    expect(user.role).toBe("super_admin");
    const bootstrap = (
      await db.collection("system").doc("bootstrap").get()
    ).data();
    expect(bootstrap.completed).toBe(true);
    const logs = await adminLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("roles.bootstrap");

    const b2 = await signInAs("editor-fixture-2@example.org");
    const res2 = await callFn("grantRole", b2.token, { role: "super_admin" });

    expect(res2.status).toBe(403);
    const secondUserSnapshot = await db.collection("users").doc(b2.uid).get();
    expect(secondUserSnapshot.exists ? secondUserSnapshot.data().role : null).not.toBe(
      "super_admin",
    );
  });

  it("bootstrap is refused when a super_admin already exists without the sentinel", async () => {
    const existing = await signInAs("existing-super@example.com");
    await seedUser(existing.uid, { email: existing.email, role: "super_admin" });

    const b = await signInAs("editor-fixture-1@example.org");
    const res = await callFn("grantRole", b.token, { role: "super_admin" });

    expect(res.status).toBe(403);
    const snapshot = await db.collection("users").doc(b.uid).get();
    expect(snapshot.exists ? snapshot.data().role : null).not.toBe(
      "super_admin",
    );
  });

  it("non-allowlisted email cannot bootstrap (403)", async () => {
    const n = await signInAs("random@example.com");

    const res = await callFn("grantRole", n.token, { role: "super_admin" });

    expect(res.status).toBe(403);
    const snapshot = await db
      .collection("users")
      .where("role", "==", "super_admin")
      .get();
    expect(snapshot.empty).toBe(true);
  });

  it("allowlisted but unverified email cannot bootstrap (403)", async () => {
    const b = await signInAs("editor-fixture-1@example.org", { verified: false });

    const res = await callFn("grantRole", b.token, { role: "super_admin" });

    expect(res.status).toBe(403);
    const snapshot = await db
      .collection("users")
      .where("role", "==", "super_admin")
      .get();
    expect(snapshot.empty).toBe(true);
  });

  it("rejects a malformed section filter on revoke (400)", async () => {
    const s = await signInAs("badfilter-super@example.com");
    await seedUser(s.uid, { email: s.email, role: "super_admin" });
    const t = await signInAs("badfilter-target@example.com");
    await seedUser(t.uid, {
      email: t.email,
      role: null,
      grants: [{ role: "editor", sections: ["watch", "support"] }],
    });

    const stringFilter = await callFn("revokeRole", s.token, {
      targetUid: t.uid,
      role: "editor",
      sections: "watch",
    });
    expect(stringFilter.status).toBe(400);

    const nullFilter = await callFn("revokeRole", s.token, {
      targetUid: t.uid,
      role: "editor",
      sections: null,
    });
    expect(nullFilter.status).toBe(400);

    const user = (await db.collection("users").doc(t.uid).get()).data();
    expect(user.grants).toHaveLength(1);
  });

  it("deactivates staff authority, disables Auth, and records one audit row", async () => {
    const actor = await seedSuperAdmin("deactivate");
    const target = await signInAs("deactivate-target@example.com");
    await seedUser(target.uid, {
      email: target.email,
      role: "admin",
      grants: [{ role: "editor", sections: ["watch"] }],
    });

    const res = await callFn("deactivateStaff", actor.token, {
      targetUid: target.uid,
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      success: true,
      uid: target.uid,
      alreadyInactive: false,
    });
    const profile = (await db.collection("users").doc(target.uid).get()).data();
    expect(profile).toMatchObject({
      active: false,
      role: null,
      grants: [],
    });
    expect(profile.tokensValidAfter).toEqual(expect.any(Number));
    expect(profile.tokensValidAfter).toBeGreaterThan(0);
    await expect(admin.auth().getUser(target.uid)).resolves.toMatchObject({
      disabled: true,
    });
    await expect(admin.auth().verifyIdToken(target.token, true)).rejects.toMatchObject({
      code: expect.stringMatching(/^auth\/(id-token-revoked|user-disabled)$/),
    });
    const logs = await adminLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      action: "staff.deactivate",
      actorUid: actor.uid,
      target: target.uid,
      before: {
        active: true,
        role: "admin",
        grants: [{ role: "editor", sections: ["watch"] }],
      },
      after: { active: false, role: null, grants: [] },
    });
  });

  it("refuses self-deactivation", async () => {
    const actor = await seedSuperAdmin("deactivate-self");

    const res = await callFn("deactivateStaff", actor.token, {
      targetUid: actor.uid,
    });

    expect(res.status).toBe(403);
    const profile = (await db.collection("users").doc(actor.uid).get()).data();
    expect(profile.role).toBe("super_admin");
    expect(profile.active).not.toBe(false);
    await expect(admin.auth().getUser(actor.uid)).resolves.toMatchObject({
      disabled: false,
    });
    await expect(adminLogs()).resolves.toEqual([]);
  });

  it("is retry-safe after the profile is already inactive", async () => {
    const actor = await seedSuperAdmin("deactivate-retry");
    const target = await signInAs("deactivate-retry-target@example.com");
    await seedUser(target.uid, { email: target.email, role: "admin" });

    const first = await callFn("deactivateStaff", actor.token, {
      targetUid: target.uid,
    });
    expect(first.status).toBe(200);

    const second = await callFn("deactivateStaff", actor.token, {
      targetUid: target.uid,
    });

    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      success: true,
      uid: target.uid,
      alreadyInactive: true,
    });
    await expect(adminLogs()).resolves.toHaveLength(1);
  });

  it("keeps one active super_admin under concurrent cross-deactivation", async () => {
    const first = await seedSuperAdmin("deactivate-cross-first");
    const second = await seedSuperAdmin("deactivate-cross-second");

    const responses = await Promise.all([
      callFn("deactivateStaff", first.token, { targetUid: second.uid }),
      callFn("deactivateStaff", second.token, { targetUid: first.uid }),
    ]);

    const statuses = responses.map((response) => response.status).sort();
    expect(statuses[0]).toBe(200);
    expect([401, 403, 409]).toContain(statuses[1]);
    const activeSupers = await db
      .collection("users")
      .where("role", "==", "super_admin")
      .get();
    expect(activeSupers.docs.filter((doc) => doc.data().active !== false)).toHaveLength(1);
  });
});
