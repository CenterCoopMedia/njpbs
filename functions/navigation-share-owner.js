"use strict";

const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { FieldValue, Timestamp } = require("firebase-admin/firestore");
const { db } = require("./lib/firebase");

function hasStaffProfile(snapshot) {
  if (!snapshot?.exists) return false;
  const profile = snapshot.data();
  return !Object.hasOwn(profile, "active") || profile.active === true;
}

async function removeOwnerShares(event) {
  if (!event.data || hasStaffProfile(event.data.after)) return;
  // CloudEvent time is the removal time, including submillisecond precision.
  const seconds = Math.floor(Date.parse(event.time) / 1000);
  const fraction = event.time.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1] ?? "";
  const removedAt = new Timestamp(seconds, Number(fraction.padEnd(9, "0")));
  const ownerRef = db.collection("users").doc(event.params.uid);
  const shares = db.collection("navigationShares")
    .where("ownerUid", "==", event.params.uid)
    .where("status", "==", "active");

  await db.runTransaction(async (transaction) => {
    // Events can arrive late or more than once. Read current authority in the
    // transaction so a restored account cannot lose newly shared items.
    if (hasStaffProfile(await transaction.get(ownerRef))) return;
    const owned = await transaction.get(shares);
    for (const share of owned.docs) {
      // A delayed removal only owns the shares that existed at that time.
      if (share.createTime > removedAt) continue;
      transaction.update(share.ref, {
        status: "removed",
        removedReason: "owner_removed",
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  });
}

const onNavigationShareOwnerWrite = onDocumentWritten(
  { document: "users/{uid}", retry: true, maxInstances: 10, timeoutSeconds: 60 },
  removeOwnerShares,
);

module.exports = { onNavigationShareOwnerWrite };
