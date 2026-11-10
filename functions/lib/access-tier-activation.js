"use strict";

const ACCESS_TIER_ACTIVATION_PATH = "system/staffAccessActivation";

// Only the approved operator creates this receipt after checking deployed rules
// and a complete clean user scan. Clients have no write path to it.
function validAccessTierActivation(value) {
  return value?.schema === 1 && value.state === "active" && value.cleanScan === true;
}

async function accessTierReadsActive(firestore, transaction) {
  const reference = firestore.collection("system").doc("staffAccessActivation");
  const snapshot = transaction ? await transaction.get(reference) : await reference.get();
  return snapshot.exists && validAccessTierActivation(snapshot.data());
}

async function userDocUsesAccessTier(firestore, profile, transaction) {
  return profile != null && Object.hasOwn(profile, "accessTier") &&
    await accessTierReadsActive(firestore, transaction);
}

module.exports = { ACCESS_TIER_ACTIVATION_PATH, validAccessTierActivation, accessTierReadsActive, userDocUsesAccessTier };
