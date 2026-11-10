"use strict";

const { createHash, randomBytes } = require("node:crypto");
const { admin, db } = require("./firebase");
const { sessionPredatesWatermark } = require("./auth");
const { userDocUsesAccessTier } = require("./access-tier-activation");
const { registeredPrincipalFromUserDoc } = require("./principal");
const { MAX_SESSION_AGE_SECONDS, sessionOutlivedMaximum } = require("./session-refusal");

const PAIRING_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;
const SESSION_PATTERN = /^pds_[A-Za-z0-9_-]{43}$/;
const DEVICE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function problem(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function userCode(value) {
  if (typeof value !== "string") throw problem(400, "Enter the code shown in Premiere");
  const code = value.trim().toUpperCase().replaceAll("-", "");
  if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) throw problem(400, "Enter the code shown in Premiere");
  return code;
}

function sessionToken(req) {
  const header = req.headers?.authorization;
  const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!SESSION_PATTERN.test(token)) throw problem(401, "Sign in to Boardwalk from Premiere", "session_invalid");
  return token;
}

function publicPairing(pairing) {
  return {
    deviceName: pairing.deviceName,
    hostVersion: pairing.hostVersion,
    expiresAt: new Date(pairing.expiresAtMs).toISOString(),
    status: pairing.status,
  };
}

function createDesktopSessions({ firestore = db, auth = admin.auth(), now = Date.now } = {}) {
  const pairings = firestore.collection("premierePairings");
  const codes = firestore.collection("premierePairingCodes");
  const sessions = firestore.collection("premiereSessions");

  async function start({ deviceName = "Premiere", hostVersion = "" }) {
    const deviceCode = randomBytes(32).toString("base64url");
    const code = [...randomBytes(8)].map(value => CODE_ALPHABET[value % CODE_ALPHABET.length]).join("");
    const pairingId = hash(deviceCode);
    const expiresAtMs = now() + PAIRING_TTL_MS;
    const batch = firestore.batch();
    batch.create(pairings.doc(pairingId), {
      deviceName, hostVersion, expiresAtMs, status: "pending", lastPollAtMs: 0,
      purgeAt: new Date(expiresAtMs),
    });
    batch.create(codes.doc(hash(code)), { pairingId, expiresAtMs, purgeAt: new Date(expiresAtMs) });
    await batch.commit();
    const displayedCode = `${code.slice(0, 4)}-${code.slice(4)}`;
    const verificationUri = "https://admin.njpbs.org/premiere/connect";
    return {
      deviceCode, userCode: displayedCode, verificationUri,
      verificationUriComplete: `${verificationUri}?code=${encodeURIComponent(displayedCode)}`,
      expiresIn: PAIRING_TTL_MS / 1000, interval: POLL_INTERVAL_MS / 1000,
    };
  }

  async function approval(action, code, actor) {
    const codeSnapshot = await codes.doc(hash(userCode(code))).get();
    const link = codeSnapshot.data();
    if (!link || link.expiresAtMs <= now()) throw problem(410, "This sign-in code expired. Start again in Premiere.", "expired_token");
    const ref = pairings.doc(link.pairingId);
    return firestore.runTransaction(async transaction => {
      const pairing = (await transaction.get(ref)).data();
      if (!pairing || pairing.expiresAtMs <= now()) throw problem(410, "This sign-in code expired. Start again in Premiere.", "expired_token");
      if (action === "lookup") return publicPairing(pairing);
      if (pairing.status !== "pending") throw problem(409, "This sign-in code was already used");
      const changes = action === "approve"
        ? { status: "approved", uid: actor.uid, authTime: actor.authTime, approvedAtMs: now() }
        : { status: "denied" };
      transaction.update(ref, changes);
      return publicPairing({ ...pairing, ...changes });
    });
  }

  async function activeActor(uid, authTime) {
    let user;
    try { user = await auth.getUser(uid); }
    catch (error) {
      if (error.code === "auth/user-not-found") throw problem(401, "This account is no longer available", "session_invalid");
      throw error;
    }
    // A desktop session rests on one browser sign-in, so it ends when that sign-in does.
    if (user.disabled || !Number.isFinite(authTime) || sessionOutlivedMaximum(authTime, now()) ||
        sessionPredatesWatermark(authTime, { tokensValidAfter: Date.parse(user.tokensValidAfterTime ?? "") / 1000 })) {
      throw problem(401, "Sign in again to Boardwalk", "session_invalid");
    }
    const profile = (await firestore.collection("users").doc(uid).get()).data();
    if (sessionPredatesWatermark(authTime, profile)) {
      throw problem(401, "Sign in again to Boardwalk", "session_invalid");
    }
    const tiersActive = await userDocUsesAccessTier(firestore, profile);
    if (!profile || profile.active === false ||
        (tiersActive && user.emailVerified !== true)) {
      throw problem(403, "An active, verified Boardwalk staff account is required");
    }
    return {
      uid, email: user.email ?? null, emailVerified: user.emailVerified === true, authTime,
      displayName: profile.displayName || user.displayName || "Staff account",
      principal: await registeredPrincipalFromUserDoc(firestore, uid, profile, undefined, tiersActive), approvedActive: true,
    };
  }

  async function poll(deviceCode) {
    if (typeof deviceCode !== "string" || !DEVICE_PATTERN.test(deviceCode)) throw problem(400, "Invalid sign-in request");
    const ref = pairings.doc(hash(deviceCode));
    const candidate = (await ref.get()).data();
    const actor = candidate?.status === "approved"
      ? await activeActor(candidate.uid, candidate.authTime) : null;
    const token = `pds_${randomBytes(32).toString("base64url")}`;
    const expiresAtMs = Math.min(
      now() + SESSION_TTL_MS,
      ((actor?.authTime ?? 0) + MAX_SESSION_AGE_SECONDS) * 1000,
    );
    const result = await firestore.runTransaction(async transaction => {
      const pairing = (await transaction.get(ref)).data();
      if (!pairing || pairing.expiresAtMs <= now()) throw problem(410, "Sign-in expired. Start again.", "expired_token");
      if (pairing.status === "denied") throw problem(403, "Sign-in was declined", "access_denied");
      if (pairing.status === "consumed") throw problem(409, "Sign-in was already completed. Start again.", "code_consumed");
      if (pairing.lastPollAtMs && now() - pairing.lastPollAtMs < POLL_INTERVAL_MS) {
        throw problem(429, "Wait before checking sign-in again", "slow_down");
      }
      if (!actor || pairing.status !== "approved") {
        transaction.update(ref, { lastPollAtMs: now() });
        return { status: "pending", interval: POLL_INTERVAL_MS / 1000 };
      }
      if (pairing.uid !== actor.uid || pairing.authTime !== actor.authTime) throw problem(409, "Sign-in changed. Start again.");
      transaction.create(sessions.doc(hash(token)), {
        uid: actor.uid, authTime: actor.authTime, createdAtMs: now(), expiresAtMs,
        revoked: false, sourceId: "video-library", purgeAt: new Date(expiresAtMs),
      });
      transaction.update(ref, { status: "consumed", lastPollAtMs: now() });
      return {
        status: "approved", sessionToken: token, expiresAt: new Date(expiresAtMs).toISOString(),
        user: { uid: actor.uid, displayName: actor.displayName }, sourceId: "video-library",
      };
    });
    return result;
  }

  async function authenticate(req) {
    const token = sessionToken(req);
    const ref = sessions.doc(hash(token));
    const session = (await ref.get()).data();
    if (!session || session.revoked !== false || !Number.isSafeInteger(session.expiresAtMs) ||
        session.expiresAtMs <= now() || session.sourceId !== "video-library") {
      throw problem(401, "Sign in again to Boardwalk", "session_invalid");
    }
    return { actor: await activeActor(session.uid, session.authTime), session, ref };
  }

  async function revoke(req) {
    const ref = sessions.doc(hash(sessionToken(req)));
    await firestore.runTransaction(async transaction => {
      if ((await transaction.get(ref)).exists) transaction.update(ref, { revoked: true });
    });
  }

  // Account-level buckets prevent additional desktop sessions from multiplying quotas.
  async function consume(uid, category, capacity, windowMs) {
    const ref = firestore.collection("premiereRequestLimits").doc(hash(`${uid}:${category}`));
    await firestore.runTransaction(async transaction => {
      const existing = (await transaction.get(ref)).data();
      const current = existing?.resetAtMs > now() ? existing : { count: 0, resetAtMs: now() + windowMs };
      if (current.count >= capacity) throw problem(429, "Too many requests. Try again later.", "rate_limited");
      transaction.set(ref, { count: current.count + 1, resetAtMs: current.resetAtMs, purgeAt: new Date(current.resetAtMs) });
    });
  }

  return { start, approval, poll, authenticate, revoke, consume, activeActor };
}

module.exports = { createDesktopSessions, hash, problem, userCode, SESSION_PATTERN, PAIRING_TTL_MS, SESSION_TTL_MS };
