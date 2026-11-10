"use strict";

const { randomBytes, randomUUID, createHash } = require("node:crypto");
const { db, admin } = require("./lib/firebase");
const { cmsOnRequest } = require("./lib/cms-edge");
const { requirePrincipal } = require("./lib/auth");
const { assertStaffAuthority } = require("./lib/live-production-authority");
const { can } = require("./lib/rbac");
const { validateBoundedJsonRequest } = require("./lib/http-json");
const { fail, fields, validId } = require("./lib/live-production-requests");
const { adminLogEntry } = require("./lib/audit");

const TTL_MS = 5 * 60 * 1000;
const ENROLLMENT_GRACE_MS = 60 * 1000;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const digest = value => createHash("sha256").update(value).digest("hex");
function pairingCode(value) {
  if (typeof value !== "string") fail("Enter the pairing code.");
  const code = value.trim().toUpperCase().replaceAll("-", "");
  if (!/^[A-HJ-NP-Z2-9]{12}$/.test(code)) fail("Enter the 12-character pairing code.");
  return code;
}
function publicDevice(snapshot, now) {
  const value = snapshot.data();
  let state = value.state;
  if (state === "pending" && value.expiresAtMs <= now) state = "expired";
  // Status only: allow a slow token issue a minute beyond the code deadline.
  if (state === "enrolling" && value.expiresAtMs + ENROLLMENT_GRACE_MS <= now) state = "failed";
  return { id: snapshot.id, name: value.name, active: value.active === true,
    state, createdAtMs: value.createdAtMs, expiresAtMs: value.expiresAtMs,
    sessionId: value.activeSessionId ?? null };
}
function audit(transaction, ref, actorId, action, now) {
  transaction.create(ref.collection("audit").doc(), { actorId, action, atMs: now });
}

function createEnrollmentHandler({ firestore = db, auth = admin.auth(), requirePrincipalFn = requirePrincipal,
  clock = Date.now, redeem = false } = {}) {
  const devices = firestore.collection("liveProductionDevices");
  const pairings = firestore.collection("liveProductionPairings");

  async function assertDeletable(transaction, ref, actor) {
    await assertStaffAuthority(firestore, transaction, actor);
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) fail("Device not found.", 404);
    const device = snapshot.data();
    if (!["revoked", "failed"].includes(device.state) || device.active === true) {
      fail("Revoke the device before deleting it.", 409, undefined, "device_not_deletable");
    }
    // Historical and orphaned mapping versions count too. Indexed, bounded
    // queries avoid locking unrelated live sessions while staff delete a row.
    const sessions = await transaction.get(firestore.collection("liveProductionSessions").where("deviceId", "==", ref.id).limit(1));
    const mappings = await transaction.get(firestore.collectionGroup("mappings").where("deviceId", "==", ref.id).limit(1));
    if (!sessions.empty || !mappings.empty) fail("This device is used by a studio session or mapping and cannot be deleted.", 409, undefined, "device_referenced");
    return device;
  }

  async function deleteDevice(ref, actor, now) {
    await firestore.runTransaction(transaction => assertDeletable(transaction, ref, actor));
    // Auth cannot participate in the Firestore transaction. Keep the inactive
    // device and its records if Auth fails; a missing user makes retry safe.
    try { await auth.deleteUser(`vmix_${ref.id}`); }
    catch (error) { if (error.code !== "auth/user-not-found") throw error; }
    await firestore.runTransaction(async transaction => {
      const device = await assertDeletable(transaction, ref, actor);
      const records = await transaction.get(ref.collection("audit"));
      const codes = await transaction.get(pairings.where("deviceId", "==", ref.id));
      transaction.create(firestore.collection("admin_logs").doc(), adminLogEntry({
        actorUid: actor.uid, action: "delete_live_production_device",
        target: `liveProductionDevices/${ref.id}`,
        before: { state: device.state, active: device.active === true },
        after: { deleted: true, atMs: now },
      }));
      for (const record of [...records.docs, ...codes.docs]) transaction.delete(record.ref);
      transaction.delete(ref);
    });
    return { deleted: true };
  }

  async function staff(request, actor) {
    const now = clock();
    if (request.action === "list_devices") {
      fields(request, ["action", "cursor"]);
      if (request.cursor !== undefined && !validId(request.cursor)) fail("Invalid device cursor.");
      return firestore.runTransaction(async transaction => {
        await assertStaffAuthority(firestore, transaction, actor);
        let query = devices.orderBy("__name__").limit(101);
        if (request.cursor) query = query.startAfter(request.cursor);
        const snapshot = await transaction.get(query);
        const serverNow = clock();
        return { devices: snapshot.docs.slice(0, 100).map(device => publicDevice(device, serverNow)),
          nextCursor: snapshot.size > 100 ? snapshot.docs[99].id : null };
      });
    }
    if (request.action === "create_pairing") {
      fields(request, ["action", "name"]);
      if (typeof request.name !== "string" || !request.name.trim() || request.name.length > 80) fail("Enter a device name of 1 to 80 characters.");
      // Twelve unbiased base-32 characters; only the digest is persisted.
      const code = [...randomBytes(12)].map(value => ALPHABET[value & 31]).join("");
      const ref = devices.doc(randomUUID());
      const limit = firestore.collection("liveProductionEnrollmentLimits").doc(actor.uid);
      const expiresAtMs = now + TTL_MS;
      await firestore.runTransaction(async transaction => {
        await assertStaffAuthority(firestore, transaction, actor);
        const last = (await transaction.get(limit)).data();
        if (last && now - last.issuedAtMs < 5000) fail("Wait five seconds before creating another pairing code.", 429);
        transaction.set(limit, { issuedAtMs: now });
        transaction.create(ref, { name: request.name.trim(), active: false, state: "pending",
          authUid: `vmix_${ref.id}`, createdAtMs: now, expiresAtMs, createdBy: actor.uid });
        transaction.create(pairings.doc(digest(code)), { deviceId: ref.id, actorId: actor.uid,
          expiresAtMs, consumed: false, purgeAt: new Date(expiresAtMs) });
        audit(transaction, ref, actor.uid, "create_pairing", now);
      });
      return { deviceId: ref.id, pairingCode: code.match(/.{4}/g).join("-"), expiresAtMs, expiresInMs: Math.max(0, expiresAtMs - clock()) };
    }
    if (!["revoke_device", "delete_device"].includes(request.action)) fail("Choose a device enrollment action.");
    fields(request, ["action", "deviceId"]);
    if (!validId(request.deviceId)) fail("Choose a valid device.");
    const ref = devices.doc(request.deviceId);
    if (request.action === "delete_device") return deleteDevice(ref, actor, now);
    await firestore.runTransaction(async transaction => {
      await assertStaffAuthority(firestore, transaction, actor);
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) fail("Device not found.", 404);
      transaction.update(ref, { active: false, state: "revoked", revokedAtMs: now, revokedBy: actor.uid });
      audit(transaction, ref, actor.uid, "revoke_device", now);
    });
    // The authoritative Firestore flag gates every agent call, including existing ID tokens.
    return { revoked: true };
  }

  async function consume(request) {
    fields(request, ["code"]);
    const ref = pairings.doc(digest(pairingCode(request.code)));
    const candidate = (await ref.get()).data();
    if (!candidate || candidate.consumed || candidate.expiresAtMs <= clock()) fail("Pairing code is expired or already used.", 410);
    const user = await auth.getUser(candidate.actorId);
    if (user.disabled) fail("Pairing issuer is inactive.", 403);
    const actor = { uid: user.uid, emailVerified: user.emailVerified };
    const deviceRef = devices.doc(candidate.deviceId);
    const authUid = `vmix_${candidate.deviceId}`;
    await firestore.runTransaction(async transaction => {
      await assertStaffAuthority(firestore, transaction, actor);
      const pairing = (await transaction.get(ref)).data();
      const device = (await transaction.get(deviceRef)).data();
      if (!pairing || pairing.consumed || pairing.expiresAtMs <= clock() || device?.state !== "pending") fail("Pairing code is expired or already used.", 410);
      transaction.update(ref, { consumed: true });
      transaction.update(deviceRef, { state: "enrolling" });
    });
    // External Auth operations cannot run inside a retried Firestore transaction.
    // A failure burns the code; the operator revokes the pending device and starts again.
    try {
      await auth.createUser({ uid: authUid });
      await auth.setCustomUserClaims(authUid, { liveProductionDeviceId: candidate.deviceId });
      const customToken = await auth.createCustomToken(authUid);
      await firestore.runTransaction(async transaction => {
        await assertStaffAuthority(firestore, transaction, actor);
        const device = (await transaction.get(deviceRef)).data();
        if (device?.state !== "enrolling") fail("Device enrollment was revoked.", 403);
        transaction.update(deviceRef, { state: "enrolled", active: true, enrolledAtMs: clock() });
        audit(transaction, deviceRef, actor.uid, "enroll_device", clock());
      });
      return { deviceId: candidate.deviceId, customToken };
    } catch (error) {
      // A failed or concurrently revoked enrollment never leaves a usable device.
      await auth.updateUser(authUid, { disabled: true }).catch(() => {});
      await firestore.runTransaction(async transaction => {
        const device = (await transaction.get(deviceRef)).data();
        if (device?.state === "enrolling") transaction.update(deviceRef, { state: "failed", active: false });
      }).catch(() => {}); // Status is best-effort; preserve the original enrollment error.
      throw error;
    }
  }

  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    try {
      validateBoundedJsonRequest(req, 2048);
      if (Buffer.byteLength(JSON.stringify(req.body) ?? "") > 2048) fail("Enrollment request exceeds 2 KiB.", 413);
      fields(req.body, redeem ? ["code"] : ["action", "name", "cursor", "deviceId"]);
      let result;
      if (redeem) result = await consume(req.body);
      else {
        const actor = await requirePrincipalFn(req, { includeAccountStatus: true });
        if (actor.approvedActive !== true || !can(actor.principal, "content.edit.any", {})) fail("Existing global editorial access is required.", 403);
        result = await staff(req.body, actor);
      }
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      const status = error.status ?? 500;
      // Log a stable operation signal only; Auth bodies and credentials stay private.
      if (status >= 500) console.error("Live production enrollment failed", { code: typeof error.code === "string" && /^auth\/[a-z-]+$/.test(error.code) ? error.code : "internal" });
      return res.status(status).json({ error: status >= 500 ? "Device enrollment is unavailable. Create a new pairing code." : error.message,
        ...(status === 409 && ["device_not_deletable", "device_referenced"].includes(error.code) ? { code: error.code } : {}) });
    }
  };
}
module.exports = { createEnrollmentHandler,
  cmsLiveProductionDevices: cmsOnRequest({ cors: true }, createEnrollmentHandler()),
  cmsPairLiveProductionDevice: cmsOnRequest({ cors: true }, createEnrollmentHandler({ redeem: true })),
};
