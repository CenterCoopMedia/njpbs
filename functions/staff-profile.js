"use strict";

// Validate a verified Firebase session against its approved CMS profile. An administrator's
// request decision creates a profile with an approved staff or editorial grant.

// This endpoint is also the trusted sign-in seam (#205). The Admin app validates
// every verified Firebase session here before it trusts a users/{uid} profile, so
// this is where the server first decides whether an identity is admitted staff --
// the decision a sign-in audit row is evidence of. The stronger seam is a
// `beforeUserSignedIn` Auth blocking function, which no client can skip; it needs
// the Identity Platform upgrade this project has not taken, and until then the
// guarantee is "every sign-in that uses the CMS API", not "every sign-in": the
// CMS API Worker also calls this endpoint for a client that skips it (#4624).
// `functions/lib/login-audit.js` holds the writer so both seams can share it, and
// Profile changes do not provide stronger authorization guarantees.

const { cmsOnRequest } = require("./lib/cms-edge");
const { db } = require("./lib/firebase");
const { verifyAuthToken, ForbiddenError, sessionPredatesWatermark } = require("./lib/auth");
const { sessionRefusalFields } = require("./lib/session-refusal");
const { recordStaffSignIn } = require("./lib/login-audit");

function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || null
  );
}

function refusal(message, reason) {
  const error = new ForbiddenError(message);
  error.signInReason = reason;
  error.code = reason;
  return error;
}

function approvalRequired() {
  const error = refusal("Account approval required", "approval_required");
  error.code = "approval_required";
  return error;
}

function createRegisterStaffProfileHandler(deps = {}) {
  const {
    firestore = db,
    verifyAuthTokenFn = verifyAuthToken,
    recordStaffSignInFn = recordStaffSignIn,
    log = console,
  } = deps;

  return async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    let caller = null;
    // The CMS API Worker retries a session whose audit row could not be written (#4624).
    const auditField = (outcome) => (outcome?.reason === "write_failed" ? { auditPending: true } : {});
    try {
      caller = await verifyAuthTokenFn(req.headers.authorization);
      const normalizedEmail =
        typeof caller.email === "string"
          ? caller.email.trim().toLowerCase()
          : "";
      if (caller.emailVerified !== true || !normalizedEmail) {
        throw refusal(
          "A verified email account is required",
          "unverified_email",
        );
      }

      const userRef = firestore.collection("users").doc(caller.uid);
      const snapshot = await userRef.get();
      if (!snapshot.exists) throw approvalRequired();
      if (snapshot.data()?.active === false) {
        throw refusal("Staff account is inactive", "inactive_account");
      }
      if (sessionPredatesWatermark(caller.authTime, snapshot.data())) {
        throw refusal("This session was revoked. Sign in again", "session_revoked");
      }
      const storedEmail =
        typeof snapshot.data()?.email === "string"
          ? snapshot.data().email.trim().toLowerCase()
          : "";
      if (!storedEmail || storedEmail !== normalizedEmail) {
        throw refusal("The approved account email changed", "email_changed");
      }

      const outcome = await recordStaffSignInFn({
        firestore,
        actor: caller,
        admitted: true,
        source: getClientIp(req),
        log,
      });

      res.status(200).json({
        success: true,
        uid: caller.uid,
        created: false,
        ...auditField(outcome),
      });
    } catch (error) {
      const status = typeof error?.status === "number" ? error.status : 500;
      const message =
        status < 500 ? error.message : "Unable to register staff profile";
      let outcome = null;
      if (status >= 500) {
        log.error("registerStaffProfile failed", error);
      } else if (caller?.uid) {
        outcome = await recordStaffSignInFn({
          firestore,
          actor: caller,
          admitted: false,
          reason: error?.signInReason ?? null,
          source: getClientIp(req),
          log,
        });
      }
      res.status(status).json({
        error: message,
        ...(status < 500 && typeof error?.code === "string"
          ? { code: error.code }
          : {}),
        ...sessionRefusalFields(error),
        ...auditField(outcome),
      });
    }
  };
}

const registerStaffProfile = cmsOnRequest(
  { cors: true, cpu: 1, concurrency: 1 },
  createRegisterStaffProfileHandler(),
);

module.exports = {
  registerStaffProfile,
  createRegisterStaffProfileHandler,
};
