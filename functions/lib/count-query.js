"use strict";

// One exact Firestore count() aggregation. It returns null when the client has no aggregation
// API or the answer is not a safe integer of 0 or more, so callers never report a guessed total.
async function aggregationCount(query) {
  if (typeof query?.count !== "function") return null;
  const snapshot = await query.count().get();
  const count = snapshot.data()?.count;
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

module.exports = { aggregationCount };
