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
import { deleteApp, initializeApp as initClient } from "firebase/app";
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";

const admin = adminPkg;
const PROJECT = "demo-njpbs";
const REGION = "us-central1";
const FUNCTIONS_HOST = process.env.FUNCTIONS_EMULATOR_HOST || "127.0.0.1:5001";
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9099";
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const fnUrl = (name) => `http://${FUNCTIONS_HOST}/${PROJECT}/${REGION}/${name}`;

let db;
let clientApp;
let clientAuth;

async function signInAs(email, { verified = true } = {}) {
  const credential = await createUserWithEmailAndPassword(
    clientAuth,
    email,
    "password123",
  );
  if (verified) {
    await admin.auth().updateUser(credential.user.uid, { emailVerified: true });
  }
  // Signup can cross the Auth emulator's validSince second boundary. A token
  // refresh retains auth_time; a password sign-in starts a valid new session.
  const token = await signInExisting(email);
  const result = {
    uid: credential.user.uid,
    email,
    token,
  };
  return result;
}

async function signInExisting(email) {
  const credential = await signInWithEmailAndPassword(
    clientAuth,
    email,
    "password123",
  );
  const token = await credential.user.getIdToken(true);
  await signOut(clientAuth);
  return token;
}

async function callFn(name, token, body = {}) {
  return fetch(fnUrl(name), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-NJPBS-CMS-Edge": "local-cms-edge-only",
    },
    body: JSON.stringify(body),
  });
}

async function seedUser(uid, data) {
  await db.collection("users").doc(uid).set({
    email: null,
    displayName: null,
    active: true,
    tokensValidAfter: 0,
    role: null,
    grants: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...data,
  });
}

describe("staff access request functions", () => {
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
  });

  afterAll(async () => {
    await Promise.all(admin.apps.map((app) => app.delete()));
    await deleteApp(clientApp);
  });

  it("accepts an outside email but keeps an unverified request permissionless", async () => {
    const requester = await signInAs("fixture-71afefb297@example.org", { verified: false });

    const response = await callFn("submitStaffAccessRequest", requester.token, {
      reason: "I edit station program pages.",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.request).toMatchObject({
      state: "email_verification",
      emailVerified: false,
      role: null,
    });
    await expect(db.collection("users").doc(requester.uid).get()).resolves.toMatchObject({
      exists: false,
    });
    const request = (
      await db.collection("staffAccessRequests").doc(requester.uid).get()
    ).data();
    expect(request).toMatchObject({
      email: "fixture-71afefb297@example.org",
      state: "email_verification",
      approvedRole: null,
    });
    expect(request.expireAt).toBeTruthy();
    await expect(
      db.collection("staffAccessRequestCounters").doc(requester.uid).get(),
    ).resolves.toMatchObject({ exists: true });
    const outbox = await db.collection("staffAccessEmailOutbox").get();
    expect(outbox.docs).toHaveLength(1);
    expect(outbox.docs[0].data()).toMatchObject({
      eventType: "verify",
      to: "fixture-71afefb297@example.org",
    });
    expect((await db.collection("staffAccessNotificationOutbox").get()).empty)
      .toBe(true);
  });

  it("sends password recovery through the server outbox without revealing account state", async () => {
    const requester = await signInAs("recovery@example.org");

    const existing = await callFn(
      "requestStaffPasswordReset",
      requester.token,
      { email: requester.email },
    );
    const missing = await callFn(
      "requestStaffPasswordReset",
      requester.token,
      { email: "missing@example.org" },
    );

    expect(existing.status).toBe(200);
    expect(missing.status).toBe(200);
    await expect(existing.json()).resolves.toEqual({ success: true });
    await expect(missing.json()).resolves.toEqual({ success: true });
    const outbox = await db.collection("staffAccessEmailOutbox").get();
    expect(outbox.docs).toHaveLength(1);
    expect(outbox.docs[0].data()).toMatchObject({
      eventType: "password_reset",
      to: requester.email,
    });
    expect(outbox.docs[0].data().passwordResetLink).toContain("oobCode=");
  });

  it("alerts Jules when a verified address enters the decision queue", async () => {
    const requester = await signInAs("verify-then-request@example.org", {
      verified: false,
    });
    const submitted = await callFn(
      "submitStaffAccessRequest",
      requester.token,
      { reason: "I prepare station program pages." },
    );
    expect(submitted.status).toBe(200);
    expect((await db.collection("staffAccessNotificationOutbox").get()).empty)
      .toBe(true);

    await admin.auth().updateUser(requester.uid, { emailVerified: true });
    const verifiedToken = await signInExisting(requester.email);
    const status = await callFn("getStaffAccessStatus", verifiedToken);

    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      request: { state: "pending", requestVersion: 1 },
    });
    const notifications = await db
      .collection("staffAccessNotificationOutbox")
      .get();
    expect(notifications.docs).toHaveLength(1);
    expect(notifications.docs[0].data()).toMatchObject({
      uid: requester.uid,
      requestVersion: 1,
      state: "pending",
    });
  });

  it("places any verified email in Jules's queue without granting access", async () => {
    const requester = await signInAs("contractor@example.org");

    const response = await callFn("submitStaffAccessRequest", requester.token, {
      reason: "I prepare approved event listings.",
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.request).toMatchObject({
      state: "pending",
      emailVerified: true,
      role: null,
    });
    const profile = await db.collection("users").doc(requester.uid).get();
    expect(profile.exists).toBe(false);
    const notification = await db
      .collection("staffAccessNotificationOutbox")
      .get();
    expect(notification.docs).toHaveLength(1);
    expect(notification.docs[0].data()).toMatchObject({
      eventType: "request_pending",
      uid: requester.uid,
      email: requester.email,
      reason: "I prepare approved event listings.",
      state: "pending",
      attemptCount: 0,
    });

    const repeated = await callFn("submitStaffAccessRequest", requester.token, {
      reason: "I prepare approved event listings.",
    });
    expect(repeated.status).toBe(200);
    expect((await db.collection("staffAccessNotificationOutbox").get()).docs)
      .toHaveLength(1);
  });

  it("limits alerts when a verified email is recreated with a new identity", async () => {
    const email = "recreated-requester@example.org";
    const first = await signInAs(email);
    const firstResponse = await callFn("submitStaffAccessRequest", first.token, {
      reason: "I prepare the first program request.",
    });
    expect(firstResponse.status).toBe(200);

    await admin.auth().deleteUser(first.uid);
    const recreated = await signInAs(email);
    expect(recreated.uid).not.toBe(first.uid);
    const secondResponse = await callFn(
      "submitStaffAccessRequest",
      recreated.token,
      { reason: "I prepare another program request." },
    );

    expect(secondResponse.status).toBe(200);
    await expect(secondResponse.json()).resolves.toMatchObject({
      request: { state: "pending" },
    });
    expect((await db.collection("staffAccessNotificationOutbox").get()).docs)
      .toHaveLength(1);
    expect(
      (await db.collection("staffAccessRequests").doc(recreated.uid).get()).exists,
    ).toBe(true);
    const cooldowns = await db
      .collection("staffAccessNotificationCooldowns")
      .get();
    expect(cooldowns.docs).toHaveLength(1);
    expect(cooldowns.docs[0].id).toMatch(/^[a-f0-9]{64}$/);
    expect(cooldowns.docs[0].id).not.toContain(email);
    expect(cooldowns.docs[0].data().expireAt).toBeTruthy();
  });

  it("rejects browser-selected identities and roles", async () => {
    const requester = await signInAs("forged@example.org");

    const response = await callFn("submitStaffAccessRequest", requester.token, {
      reason: "I prepare approved event listings.",
      targetEmail: "victim@example.org",
      role: "admin",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "forged_fields",
    });
    const request = await db
      .collection("staffAccessRequests")
      .doc(requester.uid)
      .get();
    expect(request.exists).toBe(false);
  });

  it("lets only the super admin list and approve an editorial request", async () => {
    const requester = await signInAs("editor@example.org");
    await callFn("submitStaffAccessRequest", requester.token, {
      reason: "I publish station news and program updates.",
    });
    await seedUser(requester.uid, {
      email: requester.email,
      role: null,
      grants: [],
    });

    const sasha = await signInAs("fixture-f5a060311f@example.org");
    await seedUser(sasha.uid, {
      email: sasha.email,
      role: "admin",
    });
    const deniedList = await callFn("listStaffAccessRequests", sasha.token);
    expect(deniedList.status).toBe(403);

    const jules = await signInAs("fixture-8687437e4c@example.org");
    await seedUser(jules.uid, {
      email: jules.email,
      role: "super_admin",
    });
    const listResponse = await callFn("listStaffAccessRequests", jules.token);
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json();
    expect(list.requests).toHaveLength(1);
    expect(list.requests[0]).toMatchObject({
      uid: requester.uid,
      email: requester.email,
      state: "pending",
    });

    const approveResponse = await callFn("decideStaffAccessRequest", jules.token, {
      targetUid: requester.uid,
      requestVersion: list.requests[0].requestVersion,
      decision: "approve",
      role: "editor",
    });
    expect(approveResponse.status).toBe(200);
    await expect(approveResponse.json()).resolves.toMatchObject({
      request: { state: "ready", role: "editor" },
    });
    const profile = (await db.collection("users").doc(requester.uid).get()).data();
    expect(profile).toMatchObject({
      active: true,
      email: requester.email,
      role: null,
      grants: [{ role: "editor" }],
    });
    const request = (
      await db.collection("staffAccessRequests").doc(requester.uid).get()
    ).data();
    expect(request).toMatchObject({
      state: "ready",
      approvedRole: "editor",
      decision: {
        outcome: "approve",
        actorUid: jules.uid,
      },
    });
  });

  it("approves an access request for staff guide access", async () => {
    const requester = await signInAs("orientation-staff@example.org");
    const submitResponse = await callFn(
      "submitStaffAccessRequest",
      requester.token,
      { reason: "I am starting work with NJ PBS." },
    );
    const submitted = await submitResponse.json();

    const jules = await signInAs("fixture-39ac0674ef@example.org");
    await seedUser(jules.uid, {
      email: jules.email,
      role: "super_admin",
    });
    const approveResponse = await callFn(
      "decideStaffAccessRequest",
      jules.token,
      {
        targetUid: requester.uid,
        requestVersion: submitted.request.requestVersion,
        decision: "approve",
        role: "staff",
      },
    );

    expect(approveResponse.status).toBe(200);
    await expect(approveResponse.json()).resolves.toMatchObject({
      request: { state: "ready", role: "staff" },
    });
    const profile = (await db.collection("users").doc(requester.uid).get()).data();
    expect(profile).toMatchObject({
      active: true,
      email: requester.email,
      role: null,
      grants: [{ role: "staff" }],
    });
    const request = (
      await db.collection("staffAccessRequests").doc(requester.uid).get()
    ).data();
    expect(request).toMatchObject({
      state: "ready",
      approvedRole: "staff",
      decision: {
        outcome: "approve",
        actorUid: jules.uid,
      },
    });
  });

  it("rejects escalation, self-approval, and stale decisions", async () => {
    const jules = await signInAs("fixture-8687437e4c@example.org");
    await seedUser(jules.uid, { email: jules.email, role: "super_admin" });
    const requester = await signInAs("requester@example.org");
    const submitResponse = await callFn("submitStaffAccessRequest", requester.token, {
      reason: "I prepare approved station content.",
    });
    const request = (await submitResponse.json()).request;

    const escalation = await callFn("decideStaffAccessRequest", jules.token, {
      targetUid: requester.uid,
      requestVersion: request.requestVersion,
      decision: "approve",
      role: "admin",
    });
    expect(escalation.status).toBe(400);

    const stale = await callFn("decideStaffAccessRequest", jules.token, {
      targetUid: requester.uid,
      requestVersion: request.requestVersion + 1,
      decision: "deny",
    });
    expect(stale.status).toBe(409);

    await callFn("submitStaffAccessRequest", jules.token, {
      reason: "Testing the self-approval guard.",
    });
    const selfRequest = (
      await db.collection("staffAccessRequests").doc(jules.uid).get()
    ).data();
    const selfDecision = await callFn("decideStaffAccessRequest", jules.token, {
      targetUid: jules.uid,
      requestVersion: selfRequest.requestVersion,
      decision: "approve",
      role: "editor",
    });
    expect(selfDecision.status).toBe(403);
  });

  it("refuses approval after Firebase Auth disables the requester", async () => {
    const requester = await signInAs("disabled-requester@example.org");
    const submitted = await callFn("submitStaffAccessRequest", requester.token, {
      reason: "I prepare station pages.",
    });
    const request = (await submitted.json()).request;
    await admin.auth().updateUser(requester.uid, { disabled: true });
    const jules = await signInAs("fixture-8687437e4c@example.org");
    await seedUser(jules.uid, { email: jules.email, role: "super_admin" });

    const response = await callFn("decideStaffAccessRequest", jules.token, {
      targetUid: requester.uid,
      requestVersion: request.requestVersion,
      decision: "approve",
      role: "editor",
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "identity_mismatch",
    });
    expect((await db.collection("users").doc(requester.uid).get()).exists).toBe(false);
  });

  it("records rejection without creating a CMS profile", async () => {
    const requester = await signInAs("rejected@example.org");
    const submitResponse = await callFn("submitStaffAccessRequest", requester.token, {
      reason: "I requested temporary access for an old project.",
    });
    const request = (await submitResponse.json()).request;
    const jules = await signInAs("fixture-8687437e4c@example.org");
    await seedUser(jules.uid, { email: jules.email, role: "super_admin" });

    const response = await callFn("decideStaffAccessRequest", jules.token, {
      targetUid: requester.uid,
      requestVersion: request.requestVersion,
      decision: "deny",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      request: { state: "denied", role: null },
    });
    expect((await db.collection("users").doc(requester.uid).get()).exists).toBe(false);
  });

  it("keeps request versions monotonic after Firestore TTL removes a terminal row", async () => {
    const requester = await signInAs("repeat-requester@example.org");
    const firstSubmit = await callFn("submitStaffAccessRequest", requester.token, {
      reason: "I need access for the first assignment.",
    });
    expect(firstSubmit.status).toBe(200);
    const first = (await firstSubmit.json()).request;
    const jules = await signInAs("fixture-8687437e4c@example.org");
    await seedUser(jules.uid, { email: jules.email, role: "super_admin" });
    const firstDecision = await callFn("decideStaffAccessRequest", jules.token, {
      targetUid: requester.uid,
      requestVersion: first.requestVersion,
      decision: "deny",
    });
    expect(firstDecision.status).toBe(200);

    await db.collection("staffAccessRequests").doc(requester.uid).delete();
    const secondSubmit = await callFn("submitStaffAccessRequest", requester.token, {
      reason: "I now need access for a different assignment.",
    });
    expect(secondSubmit.status).toBe(200);
    const second = (await secondSubmit.json()).request;
    expect(second.requestVersion).toBe(first.requestVersion + 1);

    const secondDecision = await callFn("decideStaffAccessRequest", jules.token, {
      targetUid: requester.uid,
      requestVersion: second.requestVersion,
      decision: "deny",
    });
    expect(secondDecision.status).toBe(200);
  });

  it("expires old pending requests while Jules loads the queue", async () => {
    const requester = await signInAs("old-request@example.org");
    await callFn("submitStaffAccessRequest", requester.token, {
      reason: "I requested access for an old assignment.",
    });
    await db.collection("staffAccessRequests").doc(requester.uid).update({
      requestedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
    });
    const jules = await signInAs("fixture-8687437e4c@example.org");
    await seedUser(jules.uid, { email: jules.email, role: "super_admin" });

    const response = await callFn("listStaffAccessRequests", jules.token);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ requests: [] });
    const request = (
      await db.collection("staffAccessRequests").doc(requester.uid).get()
    ).data();
    expect(request.state).toBe("expired");
    expect(request.expireAt).toBeTruthy();
  });
});
