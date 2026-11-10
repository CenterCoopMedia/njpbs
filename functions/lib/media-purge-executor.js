"use strict";

const { randomUUID } = require("node:crypto");
const { adminLogEntry, AUDIT_COLLECTIONS } = require("./audit");
const { thumbnailObjectKey } = require("./media-contract");

const ENTRY_LEASE_MS = 2 * 60_000;
const IO_MARGIN_MS = 15_000;
const validHash = (value) => /^[a-f0-9]{64}$/.test(value || "");
const masterHash = (key) => /^masters\/([a-f0-9]{2})\/([a-f0-9]{64})\.[a-z0-9]+$/.exec(key || "");

function exactPublicKeys(entry, assetId, hash) {
  if (!validHash(hash)) return false;
  return entry.objects.filter((object) => object.store === "public").every(({ key }) => {
    const match = /^cms-media\/([a-z0-9-]+)\/([^/]+)\/(?:([a-f0-9]{64})\.(?:jpg|jpeg|png|webp|avif|gif)|thumbs\/([a-f0-9]{64})-w([1-9][0-9]*)\.webp)$/.exec(key);
    if (!match || match[2] !== assetId || (match[3] || match[4]) !== hash) return false;
    if (!match[5]) return true;
    try {
      return key === thumbnailObjectKey({ category: match[1], assetId, contentHash: hash, width: Number(match[5]) });
    } catch {
      return false;
    }
  });
}

async function ownedReceipt(transaction, firestore, assetId, hash, keys) {
  const root = firestore.doc(`system/media/hashOwners/${hash}`);
  const snapshot = await transaction.get(root);
  const matches = (data) => data?.assetId === assetId && keys.includes(data.finalKey) &&
    ["committed", "purging"].includes(data.state);
  if (matches(snapshot.data())) return snapshot;
  const historical = await transaction.get(root.collection("superseded").where("assetId", "==", assetId).limit(101));
  if (historical.size > 100) return null;
  const candidates = historical.docs.filter((doc) => matches(doc.data()));
  return candidates.length === 1 ? candidates[0] : null;
}

async function claimEntry({ transaction, firestore, entryRef, entry, assetRef, asset,
  result, runId, clock, configRef, readConfig, runDeadlineMs, inspectOnly = false }) {
  const defer = (reason) => ({ ...result, wouldDelete: [], deferred: reason });
  const config = await transaction.get(configRef);
  const billing = await transaction.get(firestore.doc("system/billing"));
  const at = clock();
  if (!readConfig(config.data()).enabled || (!inspectOnly && readConfig(config.data()).dryRun) ||
      billing.data()?.disabled === true || config.data()?.lease?.runId !== runId ||
      !(Date.parse(config.data()?.lease?.expiresAt) > at)) return defer("disabled_or_lease_lost");
  const hash = entryRef.id.startsWith("asset:") ? asset.contentHash : entryRef.id.split(":").at(-1);
  if (!exactPublicKeys(entry, entry.assetId, hash)) return defer("invalid_object_identity");
  const receipt = await ownedReceipt(transaction, firestore, entry.assetId, hash,
    entry.objects.filter((object) => object.store === "public").map((object) => object.key));
  if (!receipt) return defer("owner_receipt_missing");
  if (receipt.data().state === "purging" && receipt.data().purgeEntryId !== entryRef.id) {
    return defer("owner_fenced");
  }
  // A queue entry may retain a shared original while still deleting its public copies.
  let deleteMaster = result.wouldDelete.some((object) => object.store === "masters");
  let lockRef;
  let masterHoldReason;
  if (deleteMaster) {
    if (receipt.data().recordSeed?.master?.key !== entry.masterKey) return defer("master_receipt_mismatch");
    const match = masterHash(entry.masterKey);
    if (!match || match[1] !== match[2].slice(0, 2)) return defer("invalid_master_identity");
    lockRef = firestore.doc(`system/media/masterLocks/${match[2]}`);
    const lock = await transaction.get(lockRef);
    if (lock.exists && !(lock.data().state === "purging" && lock.data().purgeEntryId === entryRef.id)) {
      return defer("master_fenced");
    }
    // Protect every other receipt, including historical versions and unknown states.
    for (const collection of [firestore.collection("system/media/hashOwners"), firestore.collectionGroup("superseded")]) {
      const refs = await transaction.get(collection.where("recordSeed.master.key", "==", entry.masterKey).limit(101));
      if (refs.size > 100 || refs.docs.some((doc) => doc.ref.path !== receipt.ref.path && doc.data().state !== "purged")) {
        deleteMaster = false;
        masterHoldReason = refs.size > 100 ? "master_reference_limit" : (masterHoldReason || "master_referenced_receipt");
      }
    }
  }
  const checkedAt = clock();
  if (runDeadlineMs !== undefined && checkedAt >= runDeadlineMs) return defer("run_budget");
  const objects = result.wouldDelete.filter((object) => object.store !== "masters" || deleteMaster);
  const checked = { ...result, wouldDelete: objects,
    skips: [...result.skips, ...(entry.masterKey && result.wouldDelete.some((object) => object.store === "masters") && !deleteMaster
      ? [{ reason: masterHoldReason, key: entry.masterKey }] : [])] };
  if (inspectOnly) return checked;
  const token = randomUUID();
  const leaseExpiresAt = new Date(Math.min(checkedAt + ENTRY_LEASE_MS,
    runDeadlineMs === undefined ? Infinity : runDeadlineMs + IO_MARGIN_MS)).toISOString();
  // The durable fences remain on error; only the execution token has a deadline.
  transaction.update(entryRef, { state: "purging", runId, deleteToken: token, leaseExpiresAt,
    attempts: entry.attempts + 1, lastError: null, deleteObjects: objects, ownerPath: receipt.ref.path,
    retainedMasterKey: entry.masterKey && !deleteMaster ? entry.masterKey : null });
  transaction.update(receipt.ref, { state: "purging", purgeEntryId: entryRef.id });
  if (entryRef.id.startsWith("asset:")) transaction.update(assetRef, { lifecycle: "purging" });
  if (deleteMaster) transaction.set(lockRef, { state: "purging", key: entry.masterKey, purgeEntryId: entryRef.id });
  return { ...checked, claim: { token, objects, leaseExpiresAt, ownerPath: receipt.ref.path,
    masterLockPath: deleteMaster ? lockRef.path : null } };
}

async function executeClaim({ firestore, entryRef, claim, configRef, runId, storage, clock, readConfig }) {
  const deadlineMs = Date.parse(claim.leaseExpiresAt) - IO_MARGIN_MS;
  const stillOwned = async () => {
    const [entry, config, billing] = await Promise.all([
      entryRef.get(), configRef.get(), firestore.doc("system/billing").get(),
    ]);
    const switches = readConfig(config.data());
    if (entry.data()?.state !== "purging" || entry.data()?.deleteToken !== claim.token ||
        !switches.enabled || switches.dryRun || billing.data()?.disabled === true ||
        config.data()?.lease?.runId !== runId || !(Date.parse(config.data()?.lease?.expiresAt) > clock()) ||
        !(clock() < deadlineMs)) throw new Error("Purge execution fence changed");
  };
  try {
    const order = (object) => object.store === "masters" ? 2 : object.key.includes("/thumbs/") ? 0 : 1;
    for (const object of [...claim.objects].sort((a, b) => order(a) - order(b))) {
      await stillOwned();
      await storage.remove(object, deadlineMs);
    }
    await stillOwned();
    await firestore.runTransaction(async (transaction) => {
      const [entrySnapshot, config, billing, owner] = await Promise.all([
        transaction.get(entryRef), transaction.get(configRef), transaction.get(firestore.doc("system/billing")),
        transaction.get(firestore.doc(claim.ownerPath)),
      ]);
      const entry = entrySnapshot.data();
      const lock = claim.masterLockPath ? await transaction.get(firestore.doc(claim.masterLockPath)) : null;
      if (entry?.deleteToken !== claim.token || entry.state !== "purging" ||
          config.data()?.lease?.runId !== runId || !(clock() < deadlineMs) ||
          !readConfig(config.data()).enabled || readConfig(config.data()).dryRun || billing.data()?.disabled === true ||
          owner.data()?.state !== "purging" || owner.data()?.purgeEntryId !== entryRef.id ||
          lock && (lock.data()?.state !== "purging" || lock.data()?.purgeEntryId !== entryRef.id)) {
        throw new Error("Purge completion fence changed");
      }
      const timestamp = new Date(clock()).toISOString();
      transaction.update(entryRef, { state: "purged", purgedAt: timestamp, leaseExpiresAt: null, lastError: null });
      transaction.update(owner.ref, { state: "purged", purgedAt: timestamp });
      if (claim.masterLockPath) transaction.delete(firestore.doc(claim.masterLockPath));
      if (entryRef.id.startsWith("asset:")) transaction.update(firestore.doc(`media_assets/${entry.assetId}`), {
        lifecycle: "purged", purgedAt: timestamp, purgedBy: "system:mediaPurgeSweep",
      });
      transaction.create(firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(), adminLogEntry({
        actorUid: "system:mediaPurgeSweep", action: "media.purge", target: `media_assets/${entry.assetId}`,
        before: { entryId: entryRef.id, objects: entry.objects, masterKey: entry.masterKey || null },
        after: { state: "purged", runId, retainedMasterKey: entry.retainedMasterKey || null },
      }));
    });
    return { outcome: "purged" };
  } catch {
    // Provider exceptions may contain authorization data. Store only a fixed code.
    await firestore.runTransaction(async (transaction) => {
      const entry = await transaction.get(entryRef);
      if (entry.data()?.deleteToken === claim.token && entry.data()?.state === "purging") {
        transaction.update(entryRef, { lastError: "object_delete_or_receipt_failed" });
      }
    });
    return { outcome: "retry_required" };
  }
}

// Inventory only. No orphan result is ever queued or sent to the delete executor.
async function inventoryOrphanMasters({ firestore, storage, cursor, nowMs, clock = Date.now, deadlineMs, signal }) {
  const page = await storage.listMasters(cursor);
  const candidates = [];
  for (const object of page.objects) {
    // Preserve the incoming cursor on budget exhaustion. A later page can
    // repeat inventory reads safely; never advance past unchecked candidates.
    if (deadlineMs !== undefined && clock() >= deadlineMs) {
      return { candidates, cursor: cursor || null, scanned: 0, reportOnly: true, incomplete: true };
    }
    if (!masterHash(object.key) || !Number.isFinite(Date.parse(object.lastModified)) ||
        nowMs - Date.parse(object.lastModified) < 7 * 86400_000) continue;
    const referenced = await firestore.runTransaction(async (transaction) => {
      for (const collection of [firestore.collection("media_assets"), firestore.collection("mediaPurgeQueue"),
        firestore.collection("system/media/hashOwners"), firestore.collectionGroup("superseded")]) {
        signal?.throwIfAborted();
        const field = collection.id === "media_assets" ? "master.key" :
          collection.id === "mediaPurgeQueue" ? "masterKey" : "recordSeed.master.key";
        if (!(await transaction.get(collection.where(field, "==", object.key).limit(1))).empty) return true;
      }
      return false;
    });
    if (!referenced) candidates.push(object);
  }
  return { candidates, cursor: page.cursor, scanned: page.objects.length, reportOnly: true };
}

module.exports = { ENTRY_LEASE_MS, exactPublicKeys, ownedReceipt, claimEntry, executeClaim, inventoryOrphanMasters };
