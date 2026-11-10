"use strict";

const { HttpsError } = require("firebase-functions/v2/https");

const BILLING_DOC_PATH = "system/billing";

async function assertBillingEnabled(db) {
  const snap = await db.doc(BILLING_DOC_PATH).get();

  if (snap.exists && snap.data().disabled === true) {
    const reason =
      snap.data().reason ||
      "application spending halted by the billing kill switch";
    throw new HttpsError(
      "failed-precondition",
      `billing is disabled: ${reason}`,
    );
  }

  return true;
}

module.exports = {
  assertBillingEnabled,
  BILLING_DOC_PATH,
};
