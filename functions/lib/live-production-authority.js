"use strict";

const { registeredPrincipalFromUserDoc } = require("./principal");
const { userDocUsesAccessTier } = require("./access-tier-activation");
const { can } = require("./rbac");
const { fail } = require("./live-production-requests");

async function assertStaffAuthority(db, transaction, actor) {
  if (typeof actor?.uid !== "string") fail("Existing global editorial access is required.", 403);
  const snapshot = await transaction.get(db.collection("users").doc(actor.uid));
  const profile = snapshot.data();
  const tiersActive = await userDocUsesAccessTier(db, profile, transaction);
  if (!snapshot.exists || profile?.active === false || (tiersActive && actor.emailVerified !== true)) {
    fail("Existing global editorial access is required.", 403);
  }
  const principal = await registeredPrincipalFromUserDoc(db, actor.uid, profile, transaction, tiersActive);
  if (!can(principal, "content.edit.any", {})) fail("Existing global editorial access is required.", 403);
}
module.exports = { assertStaffAuthority };
