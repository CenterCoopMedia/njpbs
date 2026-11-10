import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import firebase from "../../functions/lib/firebase.js";
import desktop from "../../functions/premiere-desktop.js";
import sessionModule from "../../functions/lib/premiere-desktop-session.js";
import cmsEdge from "../../functions/lib/cms-edge.js";

const { admin, db } = firebase;
const { createPremiereHandlers } = desktop;
const { createDesktopSessions, hash } = sessionModule;
const quiet = { info() {}, error() {} };
let clock;
let uid;
let idToken;
let handlers;
let pairs;
let assetIds;
const previousEmulator = process.env.FUNCTIONS_EMULATOR;

function request(body, token, headers = {}) {
  return { method: "POST", body, rawBody: Buffer.from(JSON.stringify(body)), headers: {
    "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers,
  } };
}

async function call(handler, body, token, headers) {
  const res = { statusCode: 200, headersSent: false, headers: new Map() };
  res.set = (name, value) => { res.headers.set(name, value); return res; };
  res.status = status => { res.statusCode = status; return res; };
  res.json = body => { res.body = body; res.headersSent = true; return res; };
  await handler(request(body, token, headers), res);
  return res;
}

async function start() {
  const response = await call(handlers.start, { deviceName: "Editing bay", hostVersion: "26.5.2" });
  expect(response.statusCode).toBe(200);
  pairs.push(response.body);
  return response.body;
}

async function signIn() {
  const pairing = await start();
  const approved = await call(handlers.approve, { action: "approve", userCode: pairing.userCode }, idToken);
  expect(approved.statusCode).toBe(200);
  const polled = await call(handlers.poll, { deviceCode: pairing.deviceCode });
  expect(polled.statusCode).toBe(200);
  expect(polled.body.status).toBe("approved");
  return { ...polled.body, pairing };
}

beforeAll(() => {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST ||
      !process.env.GCLOUD_PROJECT?.startsWith("demo-")) {
    throw new Error("Run this security test with the demo Firebase Auth and Firestore emulators");
  }
});

beforeEach(async () => {
  process.env.FUNCTIONS_EMULATOR = "true";
  clock = Date.now();
  uid = `premiere-test-${randomUUID()}`;
  pairs = [];
  assetIds = [];
  const email = `${uid}@example.test`;
  const created = await admin.auth().createUser({ uid, email, password: "local-test-password", displayName: "Test editor" });
  await db.collection("users").doc(uid).set({ active: true, role: "admin", displayName: "Test editor" });
  // The emulator sets the revocation time at account creation, and a sign-in in that same second
  // is refused. This account predates the sign-in.
  const backdated = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:update?key=local-test`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer owner" },
    body: JSON.stringify({ localId: uid, validSince: String(Math.floor(clock / 1000) - 60), targetProjectId: process.env.GCLOUD_PROJECT }),
  });
  if (!backdated.ok) throw new Error("Test account setup failed");
  const login = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=local-test`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer owner" },
    body: JSON.stringify({ email, password: "local-test-password", returnSecureToken: true, targetProjectId: process.env.GCLOUD_PROJECT }),
  });
  if (!login.ok) throw new Error("Test sign-in failed");
  idToken = (await login.json()).idToken;
  handlers = createPremiereHandlers({ firestore: db, now: () => clock, log: quiet });
});

afterEach(async () => {
  if (uid) {
    const sessions = await db.collection("premiereSessions").where("uid", "==", uid).get();
    await Promise.all(sessions.docs.map(doc => doc.ref.delete()));
    await Promise.all(pairs.flatMap(pair => [
      db.collection("premierePairings").doc(hash(pair.deviceCode)).delete(),
      db.collection("premierePairingCodes").doc(hash(pair.userCode.replaceAll("-", ""))).delete(),
    ]));
    await Promise.all(["approval", "read", "upload", "multipart", "metadata", "export"].map(category =>
      db.collection("premiereRequestLimits").doc(hash(`${uid}:${category}`)).delete()));
    await db.collection("users").doc(uid).delete();
    await Promise.all(assetIds.map(id => db.collection("mediaSourceAssets").doc(id).delete()));
    const audit = await db.collection("admin_logs").where("actorUid", "==", uid).get();
    await Promise.all(audit.docs.map(doc => doc.ref.delete()));
    await admin.auth().deleteUser(uid);
  }
  if (previousEmulator === undefined) delete process.env.FUNCTIONS_EMULATOR;
  else process.env.FUNCTIONS_EMULATOR = previousEmulator;
});

describe("Premiere browser-approved desktop sessions", () => {
  it("delegates a real HTTP request without losing inherited headers", async () => {
    const { sessionToken } = await signIn();
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      req.rawBody = Buffer.concat(chunks);
      req.body = JSON.parse(req.rawBody.toString());
      res.set = (name, value) => { res.setHeader(name, value); return res; };
      res.status = status => { res.statusCode = status; return res; };
      res.json = body => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body)); return res; };
      await handlers.request(req, res);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({ operation: "cmsListMediaSources", payload: {} }),
      });
      expect(await response.json()).toMatchObject({ success: true, sources: expect.any(Array) });
      expect(response.status).toBe(200);
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });

  it("ends a desktop session with the browser sign-in that approved it", async () => {
    const { sessionToken, expiresAt } = await signIn();
    const authTime = (await admin.auth().verifyIdToken(idToken)).auth_time;
    const limitMs = (authTime + 60 * 24 * 60 * 60) * 1_000;
    expect(Date.parse(expiresAt)).toBeLessThanOrEqual(limitMs);
    const list = { operation: "cmsListMediaSources", payload: {} };

    clock = limitMs - 60 * 60 * 1_000;
    await expect(createDesktopSessions({ firestore: db, now: () => clock }).activeActor(uid, authTime))
      .resolves.toMatchObject({ uid });

    clock = limitMs;
    const refused = await createDesktopSessions({ firestore: db, now: () => clock }).activeActor(uid, authTime)
      .catch(error => error);
    expect(refused).toMatchObject({ status: 401, code: "session_invalid" });
    expect((await call(handlers.request, list, sessionToken)).statusCode).toBe(401);
  });

  it("requires browser authentication and App Check; production defaults disabled", async () => {
    const pairing = await start();
    const body = { action: "approve", userCode: pairing.userCode };
    expect((await call(handlers.approve, body)).statusCode).toBe(401);
    expect((await call(handlers.approve, body, "forged-token")).statusCode).toBe(401);
    process.env.FUNCTIONS_EMULATOR = "false";
    const explicitlyEnabled = createPremiereHandlers({ enabled: () => true, firestore: db, log: quiet });
    expect((await call(explicitlyEnabled.approve, body, idToken)).statusCode).toBe(401);
    const disabled = createPremiereHandlers({ firestore: db, log: quiet });
    expect((await call(disabled.start, {})).statusCode).toBe(503);
  });

  it("requires explicit approval, throttles polls, and consumes the code once", async () => {
    const pairing = await start();
    expect(pairing.verificationUri).toBe("https://admin.njpbs.org/premiere/connect");
    expect(pairing.verificationUriComplete).toMatch(/^https:\/\/admin\.njpbs\.org\/premiere\/connect\?code=[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(new URL(pairing.verificationUriComplete).searchParams.get("code")).toBe(pairing.userCode);
    expect(pairing.expiresIn).toBe(600);
    expect(pairing.interval).toBe(5);
    const lookup = await call(handlers.approve, { action: "lookup", userCode: pairing.userCode }, idToken);
    expect(lookup.body.pairing).toMatchObject({ deviceName: "Editing bay", status: "pending" });
    expect((await call(handlers.poll, { deviceCode: pairing.deviceCode })).body.status).toBe("pending");
    expect((await call(handlers.poll, { deviceCode: pairing.deviceCode })).statusCode).toBe(429);
    await call(handlers.approve, { action: "approve", userCode: pairing.userCode }, idToken);
    clock += 5000;
    const results = await Promise.all([
      call(handlers.poll, { deviceCode: pairing.deviceCode }),
      call(handlers.poll, { deviceCode: pairing.deviceCode }),
    ]);
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 409]);
    expect((await call(handlers.approve, { action: "approve", userCode: pairing.userCode }, idToken)).statusCode).toBe(409);
  });

  it("allows revocation while desktop admission is disabled", async () => {
    const { sessionToken } = await signIn();
    const disabled = createPremiereHandlers({ enabled: () => false, firestore: db, now: () => clock, log: quiet });
    expect((await call(disabled.start, {})).statusCode).toBe(503);
    expect((await call(disabled.request, { operation: "session", payload: {} }, sessionToken)).statusCode).toBe(503);
    expect((await call(disabled.revoke, {})).statusCode).toBe(401);
    expect((await call(disabled.revoke, {}, sessionToken)).statusCode).toBe(200);
    expect((await call(handlers.request, { operation: "session", payload: {} }, sessionToken)).statusCode).toBe(401);
  });

  it("stores hashes only and resumes for 30 days across server restarts", async () => {
    const signedIn = await signIn();
    const sessionDoc = await db.collection("premiereSessions").doc(hash(signedIn.sessionToken)).get();
    expect(sessionDoc.exists).toBe(true);
    const stored = JSON.stringify(sessionDoc.data());
    expect(stored).not.toContain(signedIn.sessionToken);
    const pairDoc = await db.collection("premierePairings").doc(hash(signedIn.pairing.deviceCode)).get();
    expect(JSON.stringify(pairDoc.data())).not.toContain(signedIn.pairing.deviceCode);
    expect(Date.parse(signedIn.expiresAt) - clock).toBe(30 * 24 * 60 * 60 * 1000);
    clock += 29 * 24 * 60 * 60 * 1000;
    const restarted = createPremiereHandlers({ firestore: db, now: () => clock, log: quiet });
    expect(signedIn.user).toEqual({ uid, displayName: "Test editor" });
    expect((await call(restarted.request, { operation: "session", payload: {} }, signedIn.sessionToken)).body.user).toEqual({ uid, displayName: "Test editor" });
    clock += 24 * 60 * 60 * 1000;
    expect((await call(restarted.request, { operation: "session", payload: {} }, signedIn.sessionToken)).statusCode).toBe(401);
  });

  it("reloads permissions and denies a deactivated or disabled account", async () => {
    const { sessionToken } = await signIn();
    const body = { operation: "session", payload: {} };
    expect((await call(handlers.request, body, sessionToken)).body.capabilities)
      .toMatchObject({ canUpload: true, canEditMetadata: true });
    await db.collection("users").doc(uid).set({ active: true, grants: [{ role: "staff" }] });
    expect((await call(handlers.request, body, sessionToken)).body.capabilities)
      .toMatchObject({ canUpload: false, canEditMetadata: false });
    await db.doc("sections/news").set({ label: "News" });
    await db.collection("users").doc(uid).set({ active: true, grants: [{ role: "editor", sections: ["news"] }] });
    expect((await call(handlers.request, body, sessionToken)).body.capabilities)
      .toMatchObject({ canUpload: true, canEditMetadata: true });
    await db.doc("sections/news").delete();
    expect((await call(handlers.request, body, sessionToken)).body.capabilities)
      .toMatchObject({ canUpload: false, canEditMetadata: false });
    await db.collection("users").doc(uid).update({ active: false });
    expect((await call(handlers.request, body, sessionToken)).statusCode).toBe(403);
    await db.collection("users").doc(uid).update({ active: true });
    await admin.auth().updateUser(uid, { disabled: true });
    expect((await call(handlers.request, body, sessionToken)).statusCode).toBe(401);
  });

  it.each([-1, 0])("rejects sessions authenticated %i seconds from Firebase's revocation timestamp", async offset => {
    const sessions = sessionModule.createDesktopSessions({ firestore: db, auth: {
      getUser: async () => ({ uid, disabled: false, tokensValidAfterTime: new Date((Math.floor(clock / 1000) - 60) * 1000).toUTCString() }),
    } });
    await expect(sessions.activeActor(uid, (Math.floor(clock / 1000) - 60) + offset))
      .rejects.toMatchObject({ status: 401, code: "session_invalid" });
  });

  it.each([-1, 0])("rejects sessions authenticated %i seconds from the profile revocation watermark", async offset => {
    const watermark = (Math.floor(clock / 1000) - 60);
    await db.collection("users").doc(uid).update({ tokensValidAfter: watermark });
    const sessions = sessionModule.createDesktopSessions({ firestore: db, auth: {
      getUser: async () => ({ uid, disabled: false, tokensValidAfterTime: new Date((Math.floor(clock / 1000) - 120) * 1000).toUTCString() }),
    } });
    await expect(sessions.activeActor(uid, watermark + offset))
      .rejects.toMatchObject({ status: 401, code: "session_invalid" });
  });

  it("admits a session authenticated after both revocation watermarks", async () => {
    const watermark = (Math.floor(clock / 1000) - 60);
    await db.collection("users").doc(uid).update({ tokensValidAfter: watermark });
    const sessions = sessionModule.createDesktopSessions({ firestore: db, auth: {
      getUser: async () => ({ uid, disabled: false, tokensValidAfterTime: new Date((Math.floor(clock / 1000) - 60) * 1000).toUTCString() }),
    } });
    await expect(sessions.activeActor(uid, watermark + 1))
      .resolves.toMatchObject({ uid, authTime: watermark + 1, approvedActive: true });
  });

  it("keeps an existing desktop session revoked after account reactivation", async () => {
    const { sessionToken } = await signIn();
    const session = (await db.collection("premiereSessions").doc(hash(sessionToken)).get()).data();
    await db.collection("users").doc(uid).update({ active: false, tokensValidAfter: session.authTime });
    await db.collection("users").doc(uid).update({ active: true });
    const response = await call(handlers.request, { operation: "session", payload: {} }, sessionToken);
    expect(response.statusCode).toBe(401);
    expect(response.body.code).toBe("session_invalid");
  });

  it("applies both revocation watermarks at or before the revocation second", async () => {
    const revokedAt = Math.floor(clock / 1000) - 60;
    const sessions = tokensValidAfterTime => sessionModule.createDesktopSessions({ firestore: db, auth: {
      getUser: async () => ({ uid, disabled: false, emailVerified: true, tokensValidAfterTime }),
    } });
    const refused = { status: 401, code: "session_invalid" };

    // A new account's first session can share this second. It fails safe and signs in again.
    const firebaseWatermark = sessions(new Date(revokedAt * 1000).toUTCString());
    await expect(firebaseWatermark.activeActor(uid, revokedAt)).rejects.toMatchObject(refused);
    await expect(firebaseWatermark.activeActor(uid, revokedAt + 1)).resolves.toMatchObject({ uid });

    await db.collection("users").doc(uid).update({ tokensValidAfter: revokedAt });
    await expect(sessions(undefined).activeActor(uid, revokedAt - 1)).rejects.toMatchObject(refused);
    await expect(sessions(undefined).activeActor(uid, revokedAt)).rejects.toMatchObject(refused);
    await expect(sessions(undefined).activeActor(uid, revokedAt + 1)).resolves.toMatchObject({ uid });
  });

  it("delegates media metadata with current permissions, version checks, and redaction", async () => {
    const settings = {
      CMS_MEDIA_AWS_VIDEO_ENABLED: "true", CMS_MEDIA_AWS_VIDEO_ACCOUNT_ID: "111111111111",
      CMS_MEDIA_AWS_VIDEO_BUCKET: "synthetic-premiere-test", CMS_MEDIA_AWS_VIDEO_PREFIX: "",
      CMS_MEDIA_AWS_VIDEO_ROLE_ARN: "arn:aws:iam::111111111111:role/test-media",
    };
    const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
    Object.assign(process.env, settings);
    try {
      const { sessionToken } = await signIn();
      const assetId = `asset-${randomUUID()}`;
      assetIds.push(assetId);
      const timestamp = new Date(clock).toISOString();
      await db.collection("mediaSourceAssets").doc(assetId).set({
        sourceId: "video-library", lifecycle: "active", kind: "video", name: "Test footage",
        originalName: "test.mp4", nameSort: "test footage", updatedAtSort: timestamp,
        mimeType: "video/mp4", sizeBytes: 100, version: 1, preview: "browser", rightsStatus: "pending",
        objectKey: "private/test.mp4", objectVersionId: "private-test-version", tags: [],
        createdAt: timestamp, updatedAt: timestamp, createdBy: uid,
      });
      const sourceList = await call(handlers.request, { operation: "cmsListMediaSources", payload: {} }, sessionToken);
      expect(sourceList.body.sources.map(source => source.id)).toEqual(["video-library"]);
      const markers = Array.from({ length: 20 }, (_, index) => ({ startMs: index * 1000,
        endMs: index * 1000, name: "Interview", comment: "界".repeat(1000), type: "Comment", color: 0 }));
      const update = { operation: "cmsUpdateSourceMediaMetadata", payload: { assetId, expectedVersion: 1, changes: { name: "Edited footage", markers } } };
      const saved = await call(handlers.request, update, sessionToken);
      expect(saved.statusCode).toBe(200);
      expect(saved.body.asset).toMatchObject({ name: "Edited footage", version: 2, markers, parentSource: null });
      expect(saved.body.asset.objectKey).toBeUndefined();
      expect((await call(handlers.request, update, sessionToken)).statusCode).toBe(409);
      await db.collection("users").doc(uid).set({ active: true, grants: [{ role: "staff" }] });
      update.payload.expectedVersion = 2;
      expect((await call(handlers.request, update, sessionToken)).statusCode).toBe(403);
      const read = await call(handlers.request, { operation: "cmsListSourceMedia", payload: { assetId } }, sessionToken);
      expect(read.statusCode).toBe(200);
      expect(read.body.records[0].objectVersionId).toBeUndefined();
      expect(read.body.records[0].markers).toEqual(markers);
      expect(read.body.records[0].uploadedBy?.uid).toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("revokes a session without revoking the browser identity", async () => {
    const { sessionToken } = await signIn();
    expect((await call(handlers.revoke, {}, sessionToken)).statusCode).toBe(200);
    expect((await call(handlers.request, { operation: "session", payload: {} }, sessionToken)).statusCode).toBe(401);
    expect((await call(handlers.revoke, {}, sessionToken)).statusCode).toBe(200);
    expect((await admin.auth().verifyIdToken(idToken, true)).uid).toBe(uid);
  });

  it("requires the trusted CMS edge even with a valid desktop session", async () => {
    const { sessionToken } = await signIn();
    const body = { operation: "session", payload: {} };
    const throughEdge = cmsEdge.withCmsEdge(handlers.request);
    expect((await call(throughEdge, body, sessionToken)).statusCode).toBe(403);
    expect((await call(throughEdge, body, sessionToken, { "x-njpbs-cms-edge": "forged-edge" })).statusCode).toBe(403);
    expect((await call(throughEdge, body, sessionToken, { "x-njpbs-cms-edge": "local-cms-edge-only" })).statusCode).toBe(200);
  });

  it("denies expired, declined, forged, and cross-source requests", async () => {
    const declined = await start();
    await call(handlers.approve, { action: "deny", userCode: declined.userCode }, idToken);
    expect((await call(handlers.poll, { deviceCode: declined.deviceCode })).statusCode).toBe(403);
    const expired = await start();
    clock += 600000;
    expect((await call(handlers.poll, { deviceCode: expired.deviceCode })).statusCode).toBe(410);
    const { sessionToken } = await signIn();
    expect((await call(handlers.request, { operation: "cmsListSourceMedia", payload: { sourceId: "archive-originals" } }, sessionToken)).statusCode).toBe(403);
    expect((await call(handlers.request, { operation: "grantRole", payload: {} }, sessionToken)).statusCode).toBe(400);
    expect((await call(handlers.request, { operation: "session", payload: {} }, `pds_${"A".repeat(43)}`, { "x-desktop-uid": uid })).statusCode).toBe(401);
    expect((await call(handlers.request, { operation: "session", payload: {} }, idToken)).statusCode).toBe(401);
  });
});
