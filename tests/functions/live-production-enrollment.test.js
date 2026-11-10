import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import api from "../../functions/live-production-enrollment.js";
import live from "../../functions/live-production.js";
import firebase from "../../functions/lib/firebase.js";
import { withCmsEdge } from "../../functions/lib/cms-edge.js";

const db = firebase.db;
const auth = firebase.admin.auth();
let now, actor;
const headers = { "content-type": "application/json" };
function response() {
  return { statusCode: 0, body: null, headers: {},
    set(name, value) { this.headers[name] = value; return this; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; } };
}
async function invoke(body, { redeem = false, user = actor, wrap = false, requestHeaders = headers, authClient = auth, firestoreClient = db, realStaff = false } = {}) {
  const res = response();
  let handler = api.createEnrollmentHandler({ firestore: firestoreClient, auth: authClient, clock: () => now,
    ...(realStaff ? {} : { requirePrincipalFn: async () => user }), redeem });
  if (wrap) handler = withCmsEdge(handler, { readSecret: () => "synthetic-edge" });
  await handler({ method: "POST", body, headers: requestHeaders }, res);
  return res;
}
async function issue() {
  const result = await invoke({ action: "create_pairing", name: "Synthetic studio PC" });
  expect(result.statusCode).toBe(200);
  return result.body;
}
async function exchange(customToken) {
  const result = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=synthetic-key`, {
    method: "POST", headers, body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  expect(result.status).toBe(200);
  return result.json();
}

describe("studio enrollment Firestore/Auth/HTTP boundary", () => {
  beforeAll(() => {
    if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error("Use Auth/Firestore emulators.");
  });
  beforeEach(async () => {
    now = 1_000_000;
    const uid = `enrollment-${randomUUID()}`;
    await auth.createUser({ uid, email: `${uid}@example.test`, emailVerified: true });
    await db.doc(`users/${uid}`).set({ active: true, grants: [{ role: "editor" }] });
    actor = { uid, emailVerified: true, approvedActive: true, principal: { id: uid, grants: [{ role: "editor" }] } };
  });
  it("issues a digest-only single-use code and device-only refresh credential; the next call refuses revocation", async () => {
    const issued = await issue();
    expect(issued.pairingCode).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){2}$/);
    const paired = await invoke({ code: issued.pairingCode }, { redeem: true });
    expect(paired.statusCode).toBe(200);
    const token = await exchange(paired.body.customToken);
    const decoded = await auth.verifyIdToken(token.idToken);
    expect(decoded.liveProductionDeviceId).toBe(issued.deviceId);
    expect(decoded.uid).toBe(`vmix_${issued.deviceId}`);
    // Persistent claims survive refresh, not only the first sign-in.
    const refresh = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/securetoken.googleapis.com/v1/token?key=synthetic-key`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token.refreshToken }),
    });
    expect(refresh.status).toBe(200);
    expect((await auth.verifyIdToken((await refresh.json()).id_token)).liveProductionDeviceId).toBe(issued.deviceId);
    const device = await live.requireDevice({ headers: { authorization: `Bearer ${token.idToken}` } });
    const staffCall = async body => {
      const res = response();
      await live.createLiveProductionHandler({ firestore: db, clock: () => now, requirePrincipalFn: async () => actor })(
        { method: "POST", headers, body }, res);
      expect(res.statusCode).toBe(200);
      return res.body;
    };
    let session = (await staffCall({ action: "create_session", requestId: randomUUID(), title: "Synthetic enrollment rehearsal", productionProgramId: "fixture-news" })).session;
    const mapped = await staffCall({ action: "set_mapping", requestId: randomUUID(), sessionId: session.id,
      baseMappingVersion: 1, deviceId: device.deviceId, titleFilesConfirmed: true,
      inputs: { headline: { key: "fixture-one", number: 1, title: "Fixture headline" },
        name_title: { key: "fixture-two", number: 2, title: "Fixture name" } } });
    session = mapped.session;
    const verified = response();
    await live.createLiveProductionHandler({ firestore: db, clock: () => now, agent: true,
      titleFiles: () => ({ headline: "synthetic-headline.gtzip", name_title: "synthetic-name-title.gtzip" }) })(
      { method: "POST", headers: { ...headers, authorization: `Bearer ${token.idToken}` },
        body: { action: "verify_mapping", deviceId: device.deviceId, sessionId: session.id,
          mappingVersion: session.mappingVersion, inputs: mapped.mapping.inputs,
          fields: { headline: ["TextBlock1.Text"], name_title: ["TextBlock1.Text", "TextBlock2.Text"] },
          inputTypes: { headline: "GT", name_title: "GT" }, titleFiles: { headline: null, name_title: null } } }, verified);
    expect(verified.statusCode).toBe(200);
    session = (await staffCall({ action: "set_session_state", requestId: randomUUID(), sessionId: session.id,
      baseGeneration: session.generation, state: "ready" })).session;
    session = (await staffCall({ action: "set_session_state", requestId: randomUUID(), sessionId: session.id,
      baseGeneration: session.generation, state: "active" })).session;
    const call = async () => {
      const res = response();
      await live.createLiveProductionHandler({ firestore: db, clock: () => now, agent: true,
      titleFiles: () => ({ headline: "synthetic-headline.gtzip", name_title: "synthetic-name-title.gtzip" }) })(
        { method: "POST", headers: { ...headers, authorization: `Bearer ${token.idToken}` },
          body: { action: "heartbeat", deviceId: device.deviceId, sessionId: session.id, timingId: "fixture-timing" } }, res);
      return res;
    };
    expect((await call()).statusCode).toBe(200);
    expect((await invoke({ action: "list_devices" }, { realStaff: true,
      requestHeaders: { ...headers, authorization: `Bearer ${token.idToken}` } })).statusCode).toBe(403);
    expect((await invoke({ action: "revoke_device", deviceId: issued.deviceId })).statusCode).toBe(200);
    expect((await call()).statusCode).toBe(403);
    expect((await invoke({ code: issued.pairingCode }, { redeem: true })).statusCode).toBe(410);
    const listing = await invoke({ action: "list_devices" });
    expect(listing.body.devices.find(value => value.id === issued.deviceId)).toMatchObject({ state: "revoked", active: false, sessionId: session.id });
    expect(listing.headers["Cache-Control"]).toBe("private, no-store");
    expect(JSON.stringify(listing.body)).not.toContain(issued.pairingCode);
    const records = await db.collection("liveProductionPairings").get();
    const record = records.docs.find(doc => doc.data().deviceId === issued.deviceId);
    expect(record.id).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(record.data())).not.toContain(issued.pairingCode.replaceAll("-", ""));
    expect(await db.doc(`users/${decoded.uid}`).get().then(doc => doc.exists)).toBe(false);
  });
  it("admits only one concurrent code redemption", async () => {
    const issued = await issue();
    const results = await Promise.all([invoke({ code: issued.pairingCode }, { redeem: true }), invoke({ code: issued.pairingCode }, { redeem: true })]);
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 410]);
  });
  it("projects expiry at the server deadline without changing the pending record", async () => {
    const issued = await issue();
    const ref = db.doc(`liveProductionDevices/${issued.deviceId}`);
    const stored = (await ref.get()).data();
    now = issued.expiresAtMs - 1;
    let listing = await invoke({ action: "list_devices" });
    expect(listing.body.devices.find(value => value.id === issued.deviceId)).toMatchObject({ state: "pending", active: false });
    now += 1;
    listing = await invoke({ action: "list_devices" });
    const summary = listing.body.devices.find(value => value.id === issued.deviceId);
    expect(summary).toEqual({ id: issued.deviceId, name: "Synthetic studio PC", active: false,
      state: "expired", createdAtMs: stored.createdAtMs, expiresAtMs: issued.expiresAtMs, sessionId: null });
    expect((await ref.get()).data()).toEqual(stored);
    expect((await invoke({ code: issued.pairingCode }, { redeem: true })).statusCode).toBe(410);
    expect((await invoke({ action: "revoke_device", deviceId: issued.deviceId })).statusCode).toBe(200);
    listing = await invoke({ action: "list_devices" });
    expect(listing.body.devices.find(value => value.id === issued.deviceId)).toMatchObject({ state: "revoked", active: false });
  });
  it("projects interrupted token issuance as failed only after the fixed server grace, without writing", async () => {
    const issued = await issue();
    const ref = db.doc(`liveProductionDevices/${issued.deviceId}`);
    // A stopped process can leave the consumed code's device in this state.
    await ref.update({ state: "enrolling" });
    const digest = createHash("sha256").update(issued.pairingCode.replaceAll("-", "")).digest("hex");
    await db.doc(`liveProductionPairings/${digest}`).update({ consumed: true });
    const stored = (await ref.get()).data();
    now = issued.expiresAtMs + 60_000 - 1;
    let listing = await invoke({ action: "list_devices" });
    expect(listing.body.devices.find(value => value.id === issued.deviceId)).toMatchObject({ state: "enrolling", active: false });
    now += 1;
    listing = await invoke({ action: "list_devices" });
    expect(listing.body.devices.find(value => value.id === issued.deviceId)).toMatchObject({ state: "failed", active: false });
    expect((await ref.get()).data()).toEqual(stored);
    expect((await invoke({ code: issued.pairingCode }, { redeem: true })).statusCode).toBe(410);
  });
  it("keeps a slow token issue in progress inside the server grace and preserves enrolled status afterward", async () => {
    const issued = await issue();
    const authClient = {
      getUser: uid => auth.getUser(uid), createUser: fields => auth.createUser(fields),
      setCustomUserClaims: (uid, claims) => auth.setCustomUserClaims(uid, claims),
      updateUser: (uid, fields) => auth.updateUser(uid, fields),
      createCustomToken: async uid => {
        now = issued.expiresAtMs + 59_999;
        const listing = await invoke({ action: "list_devices" });
        expect(listing.body.devices.find(value => value.id === issued.deviceId)).toMatchObject({ state: "enrolling", active: false });
        return auth.createCustomToken(uid);
      },
    };
    expect((await invoke({ code: issued.pairingCode }, { redeem: true, authClient })).statusCode).toBe(200);
    now += 60_000;
    const listing = await invoke({ action: "list_devices" });
    expect(listing.body.devices.find(value => value.id === issued.deviceId)).toMatchObject({ state: "enrolled", active: true });
  });
  it("does not activate an enrollment revoked while Auth issues its token", async () => {
    const issued = await issue();
    const authClient = {
      getUser: uid => auth.getUser(uid), createUser: fields => auth.createUser(fields),
      setCustomUserClaims: (uid, claims) => auth.setCustomUserClaims(uid, claims),
      updateUser: (uid, fields) => auth.updateUser(uid, fields),
      createCustomToken: async uid => {
        const token = await auth.createCustomToken(uid);
        expect((await invoke({ action: "revoke_device", deviceId: issued.deviceId })).statusCode).toBe(200);
        return token;
      },
    };
    expect((await invoke({ code: issued.pairingCode }, { redeem: true, authClient })).statusCode).toBe(403);
    expect((await db.doc(`liveProductionDevices/${issued.deviceId}`).get()).data()).toMatchObject({ state: "revoked", active: false });
    now = issued.expiresAtMs + 60_000;
    const listing = await invoke({ action: "list_devices" });
    expect(listing.body.devices.find(value => value.id === issued.deviceId)).toMatchObject({ state: "revoked", active: false });
    expect((await auth.getUser(`vmix_${issued.deviceId}`)).disabled).toBe(true);
  });
  it.each([false, true])("logs only a safe Auth error code and burns a failed token issuance (status write unavailable: %s)", async unavailable => {
    const issued = await issue();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let statusWriteUnavailable = false;
    const firestoreClient = {
      collection: name => db.collection(name),
      runTransaction: callback => statusWriteUnavailable
        ? Promise.reject(new Error("synthetic-storage-error")) : db.runTransaction(callback),
    };
    try {
      const authClient = {
        getUser: uid => auth.getUser(uid), createUser: fields => auth.createUser(fields),
        setCustomUserClaims: (uid, claims) => auth.setCustomUserClaims(uid, claims),
        updateUser: (uid, fields) => auth.updateUser(uid, fields),
        createCustomToken: async () => {
          statusWriteUnavailable = unavailable;
          throw Object.assign(new Error("synthetic-sensitive-message"), { code: "auth/insufficient-permission" });
        },
      };
      const result = await invoke({ code: issued.pairingCode }, { redeem: true, authClient, firestoreClient });
      expect(result.statusCode).toBe(500);
      expect(result.body).toEqual({ error: "Device enrollment is unavailable. Create a new pairing code." });
      expect(log.mock.calls).toEqual([["Live production enrollment failed", { code: "auth/insufficient-permission" }]]);
      const listing = await invoke({ action: "list_devices" });
      const summary = listing.body.devices.find(value => value.id === issued.deviceId);
      expect(summary).toEqual({ id: issued.deviceId, name: "Synthetic studio PC", active: false,
        state: unavailable ? "enrolling" : "failed", createdAtMs: now, expiresAtMs: issued.expiresAtMs, sessionId: null });
      expect((await db.doc(`liveProductionDevices/${issued.deviceId}`).get()).data()).toMatchObject({ state: unavailable ? "enrolling" : "failed", active: false });
      expect((await auth.getUser(`vmix_${issued.deviceId}`)).disabled).toBe(true);
      expect((await invoke({ code: issued.pairingCode }, { redeem: true })).statusCode).toBe(410);
      now = issued.expiresAtMs + 60_000;
      const recovered = await invoke({ action: "list_devices" });
      expect(recovered.body.devices.find(value => value.id === issued.deviceId)).toMatchObject({ state: "failed", active: false });
    } finally { log.mockRestore(); }
  });
  it("refuses expired, revoked, malformed and over-budget pairings", async () => {
    const issued = await issue();
    now += 5 * 60 * 1000;
    expect((await invoke({ code: issued.pairingCode }, { redeem: true })).statusCode).toBe(410);
    const second = await issue();
    await invoke({ action: "revoke_device", deviceId: second.deviceId });
    expect((await invoke({ code: second.pairingCode }, { redeem: true })).statusCode).toBe(410);
    expect((await invoke({ code: "bad" }, { redeem: true })).statusCode).toBe(400);
    expect((await invoke({ code: "x".repeat(2100) }, { redeem: true })).statusCode).toBe(413);
    expect((await invoke({ code: "ABCD-EFGH-JKLM", authUid: "forged" }, { redeem: true })).statusCode).toBe(400);
    expect((await invoke(null)).statusCode).toBe(400);
  });
  it("rechecks issuer permissions at consumption and refuses stale UI authority and rapid issuance", async () => {
    const issued = await issue();
    expect((await invoke({ action: "create_pairing", name: "Another" })).statusCode).toBe(429);
    await db.doc(`users/${actor.uid}`).update({ active: false });
    expect((await invoke({ code: issued.pairingCode }, { redeem: true })).statusCode).toBe(403);
    expect((await invoke({ action: "revoke_device", deviceId: issued.deviceId })).statusCode).toBe(403);
    expect((await invoke({ action: "list_devices" })).statusCode).toBe(403);
  });
  it("refuses other product credentials and direct-origin calls", async () => {
    expect((await invoke({ action: "list_devices" }, { user: { ...actor, principal: { id: actor.uid, grants: [] } } })).statusCode).toBe(403);
    expect((await invoke({ code: "pds_synthetic-premiere-token" }, { redeem: true })).statusCode).toBe(400);
    expect((await invoke({ action: "list_devices" }, { wrap: true })).statusCode).toBe(403);
    expect((await invoke({ code: "ABCD-EFGH-JKLM" }, { redeem: true, wrap: true })).statusCode).toBe(403);
  });
  it.each(["revoked", "failed"])("deletes an unreferenced %s device, pairings and private audit while retaining admin audit", async state => {
    const issued = await issue();
    const ref = db.doc(`liveProductionDevices/${issued.deviceId}`);
    await ref.update({ state, active: false });
    await auth.createUser({ uid: `vmix_${issued.deviceId}` });
    const result = await invoke({ action: "delete_device", deviceId: issued.deviceId });
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ success: true, deleted: true });
    expect((await ref.get()).exists).toBe(false);
    expect((await ref.collection("audit").get()).empty).toBe(true);
    expect((await db.collection("liveProductionPairings").where("deviceId", "==", issued.deviceId).get()).empty).toBe(true);
    await expect(auth.getUser(`vmix_${issued.deviceId}`)).rejects.toMatchObject({ code: "auth/user-not-found" });
    const logs = await db.collection("admin_logs").where("actorUid", "==", actor.uid).get();
    expect(logs.size).toBe(1);
    expect(logs.docs[0].data()).toMatchObject({ actorUid: actor.uid, action: "delete_live_production_device",
      target: `liveProductionDevices/${issued.deviceId}`,
      before: { state, active: false }, after: { deleted: true, atMs: now } });
    expect(logs.docs[0].data().timestamp).toBeTruthy();
  });
  it("tolerates an absent Auth user and keeps unrelated device records", async () => {
    const issued = await issue();
    await db.doc(`liveProductionDevices/${issued.deviceId}`).update({ state: "revoked" });
    const other = db.doc(`liveProductionDevices/other-${randomUUID()}`);
    await other.set({ state: "enrolled", active: true });
    expect((await invoke({ action: "delete_device", deviceId: issued.deviceId })).statusCode).toBe(200);
    expect((await other.get()).data()).toEqual({ state: "enrolled", active: true });
  });
  it.each(["pending", "enrolling", "enrolled", "expired"])("refuses deleting a %s device", async state => {
    const issued = await issue();
    const ref = db.doc(`liveProductionDevices/${issued.deviceId}`);
    await ref.update({ state, active: state === "enrolled" });
    const result = await invoke({ action: "delete_device", deviceId: issued.deviceId });
    expect(result.statusCode).toBe(409);
    expect(result.body.code).toBe("device_not_deletable");
    expect((await ref.get()).exists).toBe(true);
  });
  it.each(["session", "historical mapping", "orphaned mapping"])("refuses deleting a device referenced by a %s", async reference => {
    const issued = await issue();
    const ref = db.doc(`liveProductionDevices/${issued.deviceId}`);
    await ref.update({ state: "revoked" });
    await auth.createUser({ uid: `vmix_${issued.deviceId}` });
    const session = db.collection("liveProductionSessions").doc();
    await session.set({ state: "ended", deviceId: reference === "session" ? issued.deviceId : "another-device" });
    if (reference !== "session") await session.collection("mappings").doc("1").set({ deviceId: issued.deviceId });
    if (reference === "orphaned mapping") await session.delete();
    const result = await invoke({ action: "delete_device", deviceId: issued.deviceId });
    expect(result.statusCode).toBe(409);
    expect(result.body).toEqual({ error: "This device is used by a studio session or mapping and cannot be deleted.", code: "device_referenced" });
    expect((await ref.get()).exists).toBe(true);
    expect((await auth.getUser(`vmix_${issued.deviceId}`)).uid).toBe(`vmix_${issued.deviceId}`);
  });
  it("rechecks staff authority and leaves all records when Auth deletion fails", async () => {
    const issued = await issue();
    const ref = db.doc(`liveProductionDevices/${issued.deviceId}`);
    await ref.update({ state: "revoked" });
    await db.doc(`users/${actor.uid}`).update({ active: false });
    expect((await invoke({ action: "delete_device", deviceId: issued.deviceId })).statusCode).toBe(403);
    await db.doc(`users/${actor.uid}`).update({ active: true });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await invoke({ action: "delete_device", deviceId: issued.deviceId }, {
        authClient: { deleteUser: async () => { throw Object.assign(new Error("synthetic-private-error"), { code: "auth/internal-error" }); } },
      });
      expect(result.statusCode).toBe(500);
      expect(JSON.stringify(result.body)).not.toContain("synthetic-private-error");
      expect((await ref.get()).exists).toBe(true);
      expect((await ref.collection("audit").get()).empty).toBe(false);
      expect((await db.collection("liveProductionPairings").where("deviceId", "==", issued.deviceId).get()).empty).toBe(false);
    } finally { log.mockRestore(); }
  });
});
