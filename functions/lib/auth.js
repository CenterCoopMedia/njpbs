"use strict";

// RBAC resolves from users/{uid}; server-only activation enables accessTier precedence.

const { admin, db } = require("./firebase");
const { principalFromUserDoc, registeredPrincipalFromUserDoc, administrativeRoleFromUserDoc } = require("./principal");
const { userDocUsesAccessTier } = require("./access-tier-activation");
const { isAccessTier } = require("./rbac");
const { isApprovedPreviewStaff } = require("./preview-access");
const { markSessionRefused, sessionOutlivedMaximum, SESSION_EXPIRED_CODE } = require("./session-refusal");

class AuthError extends Error {
  constructor(message, code = SESSION_EXPIRED_CODE, reason) {
    super(message);
    this.name = "AuthError";
    this.status = 401;
    this.code = code;
    this.reason = reason === "token_expired" ? reason : undefined;
  }
}

class ForbiddenError extends Error {
  constructor(message) {
    super(message);
    this.name = "ForbiddenError";
    this.status = 403;
  }
}

// Admin SDK error codes that mean the token itself is bad (so 401). Anything else
// from verifyIdToken (a misconfigured SDK, a transient Auth backend outage) is an
// infrastructure failure and must surface as 500, not a misleading 401.
const TOKEN_INVALID_CODES = new Set([
  "auth/id-token-expired",
  "auth/id-token-revoked",
  "auth/invalid-id-token",
  "auth/argument-error",
  "auth/user-disabled",
]);

// checkRevoked defaults on: these helpers gate privileged role endpoints, so a
// disabled account or a revoked refresh token must stop working immediately rather
// than at normal token expiry. Parallel reads on one instance share a short
// in-process cache of a successful revoked check so they do not each hop to Google.
const TOKEN_CACHE_TTL_MS = 5000;
const TOKEN_CACHE_MAX_ENTRIES = 256;
const verifiedTokenCache = new Map();
const inflightVerifications = new Map();

function resetAuthTokenCache() {
  verifiedTokenCache.clear();
  inflightVerifications.clear();
}

function cachedDecodedToken(token) {
  const entry = verifiedTokenCache.get(token);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    verifiedTokenCache.delete(token);
    return null;
  }
  return entry.decoded;
}

function rememberDecodedToken(token, decoded) {
  if (verifiedTokenCache.size >= TOKEN_CACHE_MAX_ENTRIES) {
    verifiedTokenCache.clear();
  }
  verifiedTokenCache.set(token, {
    decoded,
    expiresAt: Date.now() + TOKEN_CACHE_TTL_MS,
  });
}

function verifyIdTokenCached(token, checkRevoked) {
  if (!checkRevoked) {
    return admin.auth().verifyIdToken(token, false);
  }
  const cached = cachedDecodedToken(token);
  if (cached) return Promise.resolve(cached);
  const pending = inflightVerifications.get(token);
  if (pending) return pending;
  const request = admin.auth().verifyIdToken(token, true)
    .then((decoded) => {
      rememberDecodedToken(token, decoded);
      return decoded;
    })
    .finally(() => {
      inflightVerifications.delete(token);
    });
  inflightVerifications.set(token, request);
  return request;
}

async function verifyAuthToken(authHeader, { checkRevoked = true, cacheRevocation = true } = {}) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new AuthError("Missing or invalid authorization header");
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    throw new AuthError("Missing bearer token");
  }

  let decoded;
  try {
    decoded = await (cacheRevocation
      ? verifyIdTokenCached(token, checkRevoked)
      : admin.auth().verifyIdToken(token, checkRevoked));
  } catch (err) {
    if (err instanceof AuthError) throw err;
    if (TOKEN_INVALID_CODES.has(err?.code)) {
      throw new AuthError("Invalid or expired authentication token", SESSION_EXPIRED_CODE,
        err.code === "auth/id-token-expired" ? "token_expired" : undefined);
    }
    // Infrastructure or unknown failure: rethrow so the handler returns 500 rather
    // than telling a valid admin their token is bad.
    throw err;
  }

  if (sessionOutlivedMaximum(decoded.auth_time)) {
    throw new AuthError("This session ended. Sign in again");
  }

  return {
    uid: decoded.uid,
    email: decoded.email ?? null,
    emailVerified: decoded.email_verified === true,
    displayName: typeof decoded.name === "string" ? decoded.name : null,
    provider:
      typeof decoded.firebase?.sign_in_provider === "string"
        ? decoded.firebase.sign_in_provider
        : null,
    // When the person last authenticated, as distinct from when this token was
    // minted. It is the key the sign-in audit row is written under (#205), so one
    // session cannot record a row per refresh.
    authTime: Number.isFinite(decoded.auth_time) ? decoded.auth_time : null,
  };
}

async function verifyAppCheckToken(value) {
  if (process.env.FUNCTIONS_EMULATOR === "true" && !value) {
    return { appId: "local-emulator" };
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new AuthError("Missing App Check token", "app_check_failed");
  }
  try {
    return await admin.appCheck().verifyToken(value.trim());
  } catch (error) {
    if (error instanceof AuthError) throw error;
    // The SDK wraps JWKS transport failures as invalid-argument too. Preserve
    // those infrastructure errors; only known token failures are client errors.
    const invalidToken = error?.code === "app-check/app-check-token-expired" ||
      (error?.code === "app-check/invalid-argument" && (!error.cause ||
        ["invalid-argument", "token-expired", "invalid-token", "no-matching-kid-error", "no-kid-error"]
          .includes(error.cause.code)));
    if (invalidToken) throw new AuthError("Invalid App Check token", "app_check_failed");
    throw error;
  }
}

// Matches the Firestore rules: a stored `tokensValidAfter` rejects every
// session that signed in at or before it. A verified token may still be in the
// short revocation cache above, so restoring `active` must not restore it.
function sessionPredatesWatermark(authTime, profile) {
  if (!Number.isFinite(profile?.tokensValidAfter)) return false;
  return !(Number.isFinite(authTime) && authTime > profile.tokensValidAfter);
}

async function isSuperAdmin(uid, emailVerified = true, authTime = null) {
  const snapshot = await db.collection("users").doc(uid).get();
  if (!snapshot.exists) return false;
  const profile = snapshot.data();
  if (sessionPredatesWatermark(authTime, profile)) return false;
  const tiersActive = await userDocUsesAccessTier(db, profile);
  if (tiersActive && emailVerified !== true) return false;
  return administrativeRoleFromUserDoc(profile, tiersActive) === "super_admin";
}

async function isAdmin(uid, emailVerified = true, authTime = null) {
  const snapshot = await db.collection("users").doc(uid).get();
  if (!snapshot.exists) return false;
  const profile = snapshot.data();
  if (sessionPredatesWatermark(authTime, profile)) return false;
  const tiersActive = await userDocUsesAccessTier(db, profile);
  if (tiersActive && emailVerified !== true) return false;
  const role = administrativeRoleFromUserDoc(profile, tiersActive);
  return role === "admin" || role === "super_admin";
}

async function requireAuth(req, options = {}) {
  try {
    return await verifyAuthToken(req.headers.authorization, options);
  } catch (error) {
    if (error instanceof AuthError && error.code === SESSION_EXPIRED_CODE) markSessionRefused(req, error.reason);
    throw error;
  }
}

// Authenticate, then resolve what the caller may do. Capability enforcement is
// the caller's job: this returns the principal rather than a yes/no, because a
// real decision also needs the record being written.
async function requirePrincipal(req, options = {}) {
  const { includeAccountStatus = false, previewStaff = false, ...authOptions } = options;
  if (previewStaff) {
    authOptions.cacheRevocation = false;
    authOptions.checkRevoked = true;
  }
  const user = await requireAuth(req, authOptions);
  const snapshot = await db.collection("users").doc(user.uid).get();
  const profile = snapshot.exists ? snapshot.data() : null;
  if (sessionPredatesWatermark(user.authTime, profile)) {
    markSessionRefused(req);
    throw new AuthError("This session was revoked. Sign in again");
  }
  const tiersActive = await userDocUsesAccessTier(db, profile);
  if (tiersActive &&
      (user.emailVerified !== true || !isAccessTier(profile.accessTier) ||
        (profile.active !== undefined && profile.active !== true))) {
    throw new ForbiddenError("An active, verified staff access level is required");
  }
  const actor = { ...user, principal: await registeredPrincipalFromUserDoc(db, user.uid, profile, undefined, tiersActive) };
  if (previewStaff && !isApprovedPreviewStaff(user, profile, actor.principal)) {
    throw new ForbiddenError("An active, verified staff account is required");
  }
  return includeAccountStatus
    ? { ...actor, approvedActive: snapshot.exists && profile?.active !== false }
    : actor;
}

async function requireAdmin(req) {
  const user = await requireAuth(req);
  if (!(await isAdmin(user.uid, user.emailVerified, user.authTime))) {
    throw new ForbiddenError("Admin access required");
  }
  return user;
}

async function requireSuperAdmin(req) {
  const user = await requireAuth(req);
  if (!(await isSuperAdmin(user.uid, user.emailVerified, user.authTime))) {
    throw new ForbiddenError("Super admin access required");
  }
  return user;
}

module.exports = {
  AuthError,
  ForbiddenError,
  resetAuthTokenCache,
  verifyAuthToken,
  verifyAppCheckToken,
  isSuperAdmin,
  isAdmin,
  requireAuth,
  requireAdmin,
  requireSuperAdmin,
  principalFromUserDoc,
  requirePrincipal,
  sessionPredatesWatermark,
};
