"use strict";

const { randomUUID } = require("node:crypto");
const { DeleteObjectCommand } = require("@aws-sdk/client-s3");
const {
  publicCopies,
  publiclyVisible,
  previousVideoCopies,
  pendingPublicRevision,
  scheduledVideoAssetIds,
} = require("./public-video-references");
const {
  PUBLIC_VIDEO_COLLECTION,
  PUBLIC_VIDEO_OPERATION_LEASE_MS,
  PublicVideoError,
} = require("./public-video");
const { callOutside } = require("./release-wait");

const MAX_CONTENT_RECORDS = 5_000;
const REQUEST_COLLECTION = "cmsPublicVideoWithdrawals";
// Pacing only: the pause before recovery tries a pending withdrawal again.
const RETRY_MS = 15 * 60_000;
const RECOVERY_BATCH = 10;
const RECOVERY_URLS = 20;

function withdrawalRequest(current, urls, now) {
  return {
    revision: randomUUID(),
    urls: [...new Set([...(current?.urls ?? []), ...urls])],
    nextAttemptAt: now + RETRY_MS,
  };
}

// A separate record cannot be overwritten by an in-flight copy. Persist the
// entire event's intent before attempting any provider configuration or claim.
async function persistRequests({ firestore, removed, now, log }) {
  const requests = [];
  for (const [assetId, urls] of removed) {
    const ref = firestore.collection(REQUEST_COLLECTION).doc(assetId);
    const request = await firestore
      .runTransaction(async (tx) => {
        const current = (await tx.get(ref)).data();
        const next = withdrawalRequest(current, urls, now);
        tx.set(ref, next);
        return next;
      })
      .catch((error) => withdrawalFailure(log, assetId, "persist", error));
    requests.push({ ref, request });
  }
  return requests;
}

async function claimWithdrawal({
  firestore,
  assetId,
  urls,
  now,
  maxUrls = Infinity,
}) {
  const ref = firestore.collection(PUBLIC_VIDEO_COLLECTION).doc(assetId);
  return firestore.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const record = snapshot.data() ?? {};
    if (record.operation?.expiresAt > now) {
      throw new PublicVideoError(
        "This video's public copy is changing. Withdrawal will retry.",
        503,
      );
    }
    const candidates = new Set([
      ...urls,
      ...(record.pendingWithdrawalUrls ?? []),
      ...(record.operation?.kind === "withdraw" ? record.operation.urls : []),
    ]);
    const outstanding = [...candidates];
    if (candidates.size === 0) return { ref, remainingUrls: [] };
    let scheduledUse = false;
    for (const collection of ["cmsPosts", "cmsPages"]) {
      const content = await tx.get(
        firestore
          .collection(collection)
          .select(
            "type",
            "liveBlog",
            "blocks",
            "published.metadata.type",
            "published.metadata.liveBlog",
            "published.blocks",
            "leadMedia",
            "published.metadata.leadMedia",
            "published.sourceVersion",
            "publiclyVisible",
            "status",
            "deleted",
            "publishBuildPending",
            "publicSourceVersion",
            "published.previousVideoCopies",
          )
          .limit(MAX_CONTENT_RECORDS + 1),
      );
      if (content.size > MAX_CONTENT_RECORDS) {
        throw new PublicVideoError(
          "Public video reference verification is too large.",
          503,
        );
      }
      for (const document of content.docs) {
        const current = document.data();
        for (const copy of publicCopies(current)) candidates.delete(copy.url);
        if (scheduledVideoAssetIds(current).includes(assetId))
          scheduledUse = true;
      }
    }
    // Scheduling reads this same asset record transactionally, without storing
    // public URLs on the working draft. Retain only its usable current copy;
    // older withdrawn versions and already-revoked copies remain candidates.
    const deferred =
      scheduledUse && record.revoked !== true
        ? [record.media?.url, record.media?.posterUrl].filter((url) =>
            candidates.delete(url),
          )
        : [];
    const selected = [...candidates].slice(0, maxUrls);
    const remainingUrls = outstanding.filter((url) => !selected.includes(url));
    deferred.push(...[...candidates].slice(maxUrls));
    delete record.pendingWithdrawalUrls;
    if (deferred.length) record.pendingWithdrawalUrls = deferred;
    if (candidates.size === 0) {
      if (deferred.length || snapshot.data()?.pendingWithdrawalUrls)
        tx.set(ref, record);
      return { ref, remainingUrls };
    }
    const operation = {
      id: randomUUID(),
      kind: "withdraw",
      urls: selected,
      expiresAt: now + PUBLIC_VIDEO_OPERATION_LEASE_MS,
    };
    tx.set(ref, {
      ...record,
      operation,
      revoked:
        record.revoked === true ||
        candidates.has(record.media?.url) ||
        candidates.has(record.media?.posterUrl),
    });
    return { ref, operation, remainingUrls };
  });
}

function validatePurgeConfig(config) {
  if (!/^[a-f0-9]{32}$/.test(config?.zoneId ?? "") || !config?.token?.trim()) {
    throw new PublicVideoError(
      "Public video cache withdrawal is not configured.",
      503,
    );
  }
}

async function purgeCopies({ urls, config, fetchImpl, signal = undefined }) {
  for (let offset = 0; offset < urls.length; offset += 100) {
    const response = await callOutside("Cloudflare video cache purge", () => fetchImpl(
      `https://api.cloudflare.com/client/v4/zones/${config.zoneId}/purge_cache`,
      {
        method: "POST",
        redirect: "error",
        ...(signal ? { signal } : {}),
        headers: {
          Authorization: `Bearer ${config.token}`,
          "Content-Type": "application/json",
        },
        // An exact version path prefix also purges query/header cache variants.
        body: JSON.stringify({
          prefixes: urls
            .slice(offset, offset + 100)
            .map((url) => url.slice("https://".length)),
        }),
      },
    ), { signal });
    if (!response.ok || (await response.json())?.success !== true) {
      throw new PublicVideoError(
        "Public video cache withdrawal is pending.",
        503,
      );
    }
  }
}

function withdrawalFailure(log, assetId, stage, error) {
  // Retain durable intent. Provider errors can include credentials or headers.
  log.error("public video withdrawal pending", {
    assetId,
    stage,
    reason:
      error instanceof PublicVideoError ? error.message : "Withdrawal failure",
  });
  throw new PublicVideoError(
    "Public video withdrawal is pending. It will retry.",
    503,
  );
}

// Both event delivery and scheduled recovery run this one cleanup path.
function createWithdrawalAttempt({
  firestore,
  r2Fn,
  purgeConfigFn,
  fetchImpl = fetch,
  now = Date.now,
  log = console,
}) {
  return async (
    { ref: requestRef, request },
    { maxUrls = Infinity } = {},
  ) => {
    const assetId = requestRef.id;
    let stage = "configuration";
    let claim;
    try {
      const config = purgeConfigFn();
      validatePurgeConfig(config);
      const r2 = r2Fn();
      stage = "claim";
      claim = await claimWithdrawal({
        firestore,
        assetId,
        urls: request.urls,
        now: now(),
        maxUrls,
      });
      if (claim.operation) {
        stage = "delete";
        for (const url of claim.operation.urls) {
          await callOutside("R2 public video DeleteObject", () =>
            r2.client.send(
              new DeleteObjectCommand({
                Bucket: r2.bucket,
                Key: new URL(url).pathname.slice(1),
              }),
            ),
          );
        }
        stage = "purge";
        await purgeCopies({
          urls: claim.operation.urls,
          config,
          fetchImpl,
        });
        stage = "complete";
        await firestore.runTransaction(async (tx) => {
          const current = await tx.get(claim.ref);
          if (current.data()?.operation?.id !== claim.operation.id) {
            throw new PublicVideoError(
              "Public video withdrawal lost its operation.",
              503,
            );
          }
          const record = current.data();
          delete record.operation;
          tx.set(claim.ref, record);
        });
      }
      stage = "acknowledge";
      await firestore.runTransaction(async (tx) => {
        const current = (await tx.get(requestRef)).data();
        // A later content event owns its own revision, including a new request
        // for the same URL. Never acknowledge it with this older attempt.
        if (current?.revision !== request.revision) return;
        if (claim.remainingUrls.length)
          tx.update(requestRef, {
            urls: claim.remainingUrls,
            nextAttemptAt: now() + RETRY_MS,
          });
        else tx.delete(requestRef);
      });
      if (claim.operation)
        log.info("public video copies withdrawn", {
          assetId,
          count: claim.operation.urls.length,
        });
    } catch (error) {
      if (claim?.operation) await releaseWithdrawal(firestore, claim).catch(() => {});
      withdrawalFailure(log, assetId, stage, error);
    }
  };
}

// A failed attempt no longer holds its lease. Its withdraw operation stays on
// the record, so the next claim or copy carries its URLs forward.
function releaseWithdrawal(firestore, claim) {
  return firestore.runTransaction(async (tx) => {
    const current = (await tx.get(claim.ref)).data();
    if (current?.operation?.id !== claim.operation.id) return;
    tx.update(claim.ref, { "operation.expiresAt": 0 });
  });
}

function createPublicVideoWithdrawalRecoveryHandler(deps) {
  const { firestore, now = Date.now } = deps;
  const attempt = createWithdrawalAttempt(deps);
  return async () => {
    // One indexed due query; an empty pass does not scan content or call providers.
    const due = await firestore
      .collection(REQUEST_COLLECTION)
      .where("nextAttemptAt", "<=", now())
      .orderBy("nextAttemptAt")
      .limit(RECOVERY_BATCH)
      .get();
    for (const snapshot of due.docs) {
      const request = await firestore.runTransaction(async (tx) => {
        const current = (await tx.get(snapshot.ref)).data();
        if (!current || current.nextAttemptAt > now()) return null;
        // Reserve the retry interval before configuration, claim or process death.
        tx.update(snapshot.ref, { nextAttemptAt: now() + RETRY_MS });
        return current;
      });
      if (!request) continue;
      try {
        await attempt(
          { ref: snapshot.ref, request },
          { maxUrls: RECOVERY_URLS },
        );
      } catch {
        // The attempt emits a safe stage error. Leave intent for the next due pass.
      }
    }
  };
}

async function readSnapshotOwner(firestore, transaction, ref, snapshot) {
  if (ref.parent.id === "cmsPages") {
    if (!require("./public-page-contract").publicPageDefinition(ref.id)) return null;
    const { state } = await require("./no-build-page-ownership").readNoBuildPageOwner({ firestore, transaction, pageId: ref.id });
    return state;
  }
  if (["program", "event"].includes(snapshot?.metadata?.type)) {
    if (!require("./no-build-record-contract").validRecordId(ref.id)) return null;
    const { state } = await require("./no-build-record-ownership").readNoBuildRecordOwner({ firestore, transaction, documentId: ref.id });
    return state;
  }
  const { isNoBuildPostId, readNoBuildPostOwner } = require("./no-build-post-ownership");
  if (!isNoBuildPostId(ref.id)) return null;
  const { state } = await readNoBuildPostOwner({ firestore, transaction, postId: ref.id });
  return state;
}

/** Firestore event boundary: Only lost public references can revoke version keys. */
function createPublicVideoWithdrawalHandler(deps) {
  const { firestore, now = Date.now, log = console } = deps;
  const attempt = createWithdrawalAttempt(deps);
  return async (event) => {
    const before = publicCopies(
      event.data?.before?.data(),
      !publiclyVisible(event.data?.after?.data()),
    );
    const after = new Set(
      publicCopies(event.data?.after?.data()).map((copy) => copy.url),
    );
    const removed = new Map();
    for (const { assetId, url } of before) {
      if (after.has(url)) continue;
      if (!removed.has(assetId)) removed.set(assetId, new Set());
      removed.get(assetId).add(url);
    }
    const scheduledAfter = new Set(
      scheduledVideoAssetIds(event.data?.after?.data()),
    );
    for (const assetId of scheduledVideoAssetIds(event.data?.before?.data())) {
      // Cancellation, deletion or publication releases deferred cleanup. Read
      // only recorded withdrawal URLs, never inventory a newer prepared copy.
      if (!scheduledAfter.has(assetId) && !removed.has(assetId))
        removed.set(assetId, new Set());
    }
    const requests = await persistRequests({
      firestore,
      removed,
      now: now(),
      log,
    });
    for (const request of requests) await attempt(request);
    // Release completed private history when the snapshot has no serving seal.
    const contentRef = event.data?.after?.ref;
    if (removed.size && contentRef) {
      const released = new Set(
        [...removed.values()].flatMap((urls) => [...urls]),
      );
      await firestore.runTransaction(async (tx) => {
        const current = await tx.get(contentRef);
        const record = current.data();
        if (!record || pendingPublicRevision(record)) return;
        const previous = previousVideoCopies(record.published);
        const remaining = previous.filter((copy) => !released.has(copy.url));
        if (remaining.length !== previous.length) {
          const owner = await readSnapshotOwner(firestore, tx, contentRef, record.published);
          if (owner?.snapshotDigest || owner?.mode === "static") return;
          tx.update(contentRef, { "published.previousVideoCopies": remaining });
        }
      });
    }
  };
}

module.exports = {
  REQUEST_COLLECTION,
  withdrawalRequest,
  purgeCopies,
  createPublicVideoWithdrawalHandler,
  createPublicVideoWithdrawalRecoveryHandler,
};
