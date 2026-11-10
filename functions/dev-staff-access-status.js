"use strict";

// Dev identities are provisioned directly. The request/email workflow is not
// deployed, so the status endpoint only reports the caller's dev account state.
const { cmsOnRequest } = require("./lib/cms-edge");
const { requireAuth, verifyAppCheckToken, AuthError, ForbiddenError } = require("./lib/auth");
const { db } = require("./lib/firebase");
const { principalFromStoredUserDoc } = require("./lib/principal");
const { ALL_CAPABILITIES, hasCapability } = require("./lib/rbac");
const logger = require("firebase-functions/logger");

const getStaffAccessStatus = cmsOnRequest({ cors: true }, async (req, res) => {
  res.set("Cache-Control", "private, no-store");
  if (req.method !== "POST" || !req.body || Object.keys(req.body).length) {
    res.status(400).json({ error: "Invalid status request" });
    return;
  }
  try {
    const caller = await requireAuth(req);
    await verifyAppCheckToken(req.headers["x-firebase-appcheck"]);
    const user = await db.collection("users").doc(caller.uid).get();
    const profile = user.data();
    const principal = await principalFromStoredUserDoc(db, caller.uid, profile);
    const authorized = ALL_CAPABILITIES.some((capability) => hasCapability(principal, capability));
    const storedEmail = profile?.email;
    const active = user.exists && profile?.active !== false && authorized &&
      caller.emailVerified === true && typeof storedEmail === "string" &&
      storedEmail.trim().toLowerCase() === caller.email?.trim().toLowerCase();
    if (!active) {
      res.status(403).json({ error: "Development access must be provisioned by an administrator" });
      return;
    }
    res.status(200).json({
      success: true,
      request: {
        state: "ready",
        requestVersion: null,
        reference: null,
        role: null,
        requestedAt: null,
        decidedAt: null,
        emailVerified: caller.emailVerified === true,
      },
      mailState: "not_queued",
    });
  } catch (error) {
    if (error instanceof AuthError || error instanceof ForbiddenError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    logger.error("Dev staff access status failed", error);
    res.status(500).json({ error: "Staff access status is unavailable. Try again." });
  }
});

module.exports = { getStaffAccessStatus };
