"use strict";

/**
 * Whether a uid names an approved, active CMS account.
 *
 * Self-service profile-photo upload and browsing use the same admission rule.
 * Keep it here so those two boundaries cannot drift apart.
 */
async function isApprovedActiveAccount(firestore, uid) {
  if (typeof uid !== "string" || uid.trim().length === 0) return false;
  const snapshot = await firestore.collection("users").doc(uid).get();
  if (!snapshot.exists) return false;
  return snapshot.data()?.active !== false;
}

module.exports = { isApprovedActiveAccount };
