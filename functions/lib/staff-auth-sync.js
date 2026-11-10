"use strict";

// Firebase Auth follows the stored account state, not the intent of the request
// that last changed it. deactivateStaff and reactivateStaff commit `users/{uid}`
// first and then call this. It reads the current state, applies it to Auth, and
// reads again; a change in between is applied in another round. A delayed request
// therefore cannot leave Auth behind a newer Firestore change: the last Auth
// write is always followed by a read that confirms it.

const MAX_SYNC_ROUNDS = 5;

function revocationSeconds(userRecord) {
  const milliseconds = Date.parse(userRecord?.tokensValidAfterTime);
  if (!Number.isFinite(milliseconds)) {
    throw new Error("Firebase Auth returned no revocation watermark");
  }
  return Math.floor(milliseconds / 1_000);
}

// The stored watermark only moves forward, so a delayed request cannot bring
// back sessions that a later revocation already rejected.
async function storeWatermark(firestore, uid, seconds, now) {
  const ref = firestore.collection("users").doc(uid);
  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const stored = snapshot.exists ? snapshot.data().tokensValidAfter : undefined;
    if (Number.isFinite(stored) && stored >= seconds) return;
    transaction.update(ref, { tokensValidAfter: seconds, updatedAt: now() });
  });
}

async function signInAllowed(firestore, uid) {
  const snapshot = await firestore.collection("users").doc(uid).get();
  return snapshot.exists && snapshot.data().active === true;
}

// Returns true when the account ends active with sign-in on, false when it ends
// inactive with sign-in off and sessions revoked. Auth errors propagate.
async function syncStaffAuth({ firestore, authClient, uid, now }) {
  let allowed = await signInAllowed(firestore, uid);
  // A failed revocation matters only if the account stays inactive. If a newer
  // reactivation committed meanwhile, the loop still applies it; that
  // reactivation revoked sessions itself before its commit.
  let revocationFailure = null;
  for (let round = 0; round < MAX_SYNC_ROUNDS; round += 1) {
    if (allowed) {
      await authClient.updateUser(uid, { disabled: false });
    } else {
      await authClient.updateUser(uid, { disabled: true });
      try {
        await authClient.revokeRefreshTokens(uid);
        await storeWatermark(firestore, uid, revocationSeconds(await authClient.getUser(uid)), now);
        revocationFailure = null;
      } catch (error) {
        revocationFailure = error;
      }
    }
    const confirmed = await signInAllowed(firestore, uid);
    if (confirmed === allowed) {
      if (!allowed && revocationFailure) throw revocationFailure;
      return allowed;
    }
    allowed = confirmed;
  }
  throw new Error("Staff account state kept changing during Auth sync");
}

module.exports = { revocationSeconds, syncStaffAuth };
