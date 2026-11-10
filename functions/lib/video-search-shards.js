"use strict";

const { SEARCH_SHARDS, SEARCH_STATE, enqueueVideoSearchShards, bumpVideoSearchEpoch } = require("./video-search-outbox");
const { hash } = require("./video-search-shard-storage");
const { parseSourceMediaAsset, sourceMediaAssetSummary } = require("./source-media-contract");
const { objectKeyWithinSource } = require("./media-sources");
const { getTranscriptJob } = require("./video-transcript-job");
const { deletionRef } = require("./video-search-shard-cleanup");
const MAX_MANIFEST_ASSETS = 5000;
const FRESHNESS_MS = 60_000;
const fail = (status, message) => Object.assign(new Error(message), { status });
const sourceIdentity = (source, config) => hash(JSON.stringify([1, source.id, source.bucket, source.prefix, source.expectedBucketOwner ?? null, config.bucket, config.accountId ?? null]));
// Include all output/review selection fields, including alignment changes without editRevision.
const assetStamp = snapshot => snapshot.updateTime ? `${snapshot.updateTime.seconds}:${snapshot.updateTime.nanoseconds}` : null;
const jobIdentity = job => hash(JSON.stringify(job ?? null));

async function bootstrapSearchShards(firestore) {
  const ref = firestore.collection(SEARCH_STATE).doc("video-library");
  return firestore.runTransaction(async tx => {
    const state = (await tx.get(ref)).data();
    if (state?.complete) {
      if (/^[a-f0-9-]{36}$/.test(state.epoch ?? "")) return state;
      return { ...state, epoch: bumpVideoSearchEpoch(tx, firestore) };
    }
    let query = firestore.collection("mediaSourceAssets").where("sourceId", "==", "video-library").orderBy("__name__");
    if (state?.after) query = query.startAfter(state.after);
    const page = await tx.get(query.limit(101));
    const assets = page.docs.slice(0, 100);
    const previous = await Promise.all(assets.map(asset => tx.get(firestore.collection(SEARCH_SHARDS).doc(asset.id))));
    const missing = assets.filter((asset, index) => !previous[index].exists && asset.data().lifecycle === "active").map(asset => asset.id);
    const next = { complete: page.docs.length <= 100, after: assets.at(-1)?.id ?? state?.after ?? null };
    const epoch = enqueueVideoSearchShards(tx, firestore, missing, "video-library", next);
    return { ...next, epoch };
  });
}

async function buildVideoSearchShard({ firestore, ref, source, config, storage, processor, readCorpus, getJob = getTranscriptJob }) {
  const intent = (await ref.get()).data();
  if (!intent?.pending || intent.sourceId !== "video-library") return false;
  const assetRef = firestore.collection("mediaSourceAssets").doc(ref.id);
  const snapshot = await assetRef.get();
  const asset = parseSourceMediaAsset(snapshot.id, snapshot.data());
  const valid = source && asset && asset.sourceId === source.id && objectKeyWithinSource(source, asset.objectKey);
  let content;
  let selected;
  if (valid) {
    let read;
    let unavailable = false;
    try {
      read = await readCorpus({ firestore, source, snapshot, config, processor,
        getJob: async args => {
          const job = await getJob(args);
          if (selected && jobIdentity(selected) !== jobIdentity(job)) throw fail(409, "Transcript changed");
          if (job?.phase === "ready") selected = job;
          return job;
        } });
    } catch (error) {
      const permanent = ["transcript_output_too_large", "transcript_cache_missing", "transcript_cache_invalid",
        "transcript_alignment_identity_invalid"].includes(error.message) || error instanceof SyntaxError ||
        ["NoSuchKey", "NoSuchVersion"].includes(error.name);
      if (!permanent) throw error;
      // Keep catalog search usable, without releasing corrupt or missing text.
      unavailable = true;
      read = { asset: sourceMediaAssetSummary(asset), chunks: [], revision: null, truncated: false };
    }
    if (read.unavailable) throw fail(409, "Video changed");
    content = { schema: 1, asset: read.asset, chunks: read.chunks, revision: read.revision,
      coverage: { assetsScanned: 1, assetsIndexed: read.revision ? 1 : 0,
        assetsWithoutTranscript: !read.revision && !unavailable ? 1 : 0,
        assetsUnavailable: unavailable ? 1 : 0, truncatedAssets: read.truncated ? 1 : 0 } };
  }
  // Failed S3 work throws. The outbox remains pending and Firebase retries it.
  const descriptor = content ? await storage.put(content) : null;
  return firestore.runTransaction(async tx => {
    const current = (await tx.get(ref)).data();
    if (!current?.pending || current.generation !== intent.generation) return false;
    const fresh = await tx.get(assetRef);
    // Read the exact-version fence in the same transaction as promotion.
    // Cleanup claims that race this builder either see its reference or make
    // this callback retry/refuse. A later build writes a new S3 version.
    if (descriptor && (await tx.get(deletionRef(firestore, descriptor))).exists) throw fail(409, "Search shard cleanup claimed");
    if (!fresh.updateTime?.isEqual(snapshot.updateTime) && (fresh.exists || snapshot.exists)) throw fail(409, "Video changed");
    if (selected) {
      const job = (await tx.get(firestore.collection("mediaSourceTranscriptJobs").doc(selected.id))).data();
      if (jobIdentity(job) !== jobIdentity(selected)) throw fail(409, "Transcript changed");
    }
    if (!asset || asset.sourceId !== "video-library") {
      // Absence from a complete manifest is a tombstone; do not let deleted
      // history consume the active corpus limit indefinitely.
      tx.delete(ref);
      bumpVideoSearchEpoch(tx, firestore);
      return true;
    }
    tx.set(ref, { sourceId: intent.sourceId, generation: intent.generation, pending: false,
      tombstone: !descriptor, assetStamp: assetStamp(snapshot), identity: source ? sourceIdentity(source, config) : null,
      ...(descriptor ? { ...descriptor, coverage: content.coverage } : {}), builtAt: new Date().toISOString() });
    bumpVideoSearchEpoch(tx, firestore);
    return true;
  });
}

async function rearmPendingShards(firestore, rows, now) {
  const due = rows.filter(row => {
    const item = row.data();
    return item.pending && Date.parse(item.wakeAt ?? item.requestedAt) <= now - 5 * 60_000;
  }).slice(0, 8);
  for (const row of due) {
    await firestore.runTransaction(async tx => {
      const current = (await tx.get(row.ref)).data();
      if (current?.pending && current.generation === row.data().generation &&
          Date.parse(current.wakeAt ?? current.requestedAt) <= now - 5 * 60_000) {
        // Keep the generation: an in-flight builder may still finish this work.
        tx.update(row.ref, { wakeAt: new Date(now).toISOString() });
      }
    });
  }
}

async function videoSearchManifest({ firestore, source, config, bootstrap = bootstrapSearchShards }) {
  const state = await bootstrap(firestore);
  const identity = sourceIdentity(source, config);
  if (!state?.complete) return { schema: 1, identity, epoch: state?.epoch, initializing: true,
    shards: [], tombstones: [], freshnessMs: FRESHNESS_MS };
  const page = await firestore.collection(SEARCH_SHARDS).orderBy("__name__").limit(MAX_MANIFEST_ASSETS + 1).get();
  if (page.docs.length > MAX_MANIFEST_ASSETS) throw fail(413, "Video search manifest limit reached");
  await rearmPendingShards(firestore, page.docs, Date.now());
  const candidates = page.docs.filter(row => !row.data().pending && !row.data().tombstone);
  const catalog = new Map();
  for (let index = 0; index < candidates.length; index += 100) {
    const snapshots = await firestore.getAll(...candidates.slice(index, index + 100).map(row => firestore.collection("mediaSourceAssets").doc(row.id)),
      { fieldMask: ["sourceId", "lifecycle", "objectKey"] });
    for (const snapshot of snapshots) catalog.set(snapshot.id, snapshot);
  }
  const shards = [], tombstones = [], repairs = [];
  let pending = page.docs.filter(row => row.data().pending).length;
  for (const row of page.docs) {
    const item = row.data();
    if (item.sourceId !== source.id) continue;
    const snapshot = catalog.get(row.id);
    const asset = snapshot?.data();
    const changed = !item.tombstone && (!asset || asset.lifecycle !== "active" || asset.sourceId !== source.id ||
      !objectKeyWithinSource(source, asset.objectKey) || item.assetStamp !== assetStamp(snapshot));
    if (item.pending || item.tombstone || item.identity !== identity || changed) {
      tombstones.push(row.id);
      // Configuration changed: remove access to the old realm, then rebuild lazily.
      if (!item.pending && (item.identity !== identity || changed)) {
        repairs.push(row);
      }
    } else shards.push({ id: row.id, version: item.digest, coverage: item.coverage });
  }
  for (let index = 0; index < repairs.length; index += 100) {
    const batch = repairs.slice(index, index + 100);
    pending += await firestore.runTransaction(async tx => {
      const current = await Promise.all(batch.map(row => tx.get(row.ref)));
      const changed = batch.filter((row, offset) => current[offset].data()?.generation === row.data().generation);
      enqueueVideoSearchShards(tx, firestore, changed.map(row => row.id));
      return changed.length;
    });
  }
  return { schema: 1, initializing: false, identity, epoch: state.epoch, version: hash(JSON.stringify([shards, tombstones])),
    shards, tombstones, pending, freshnessMs: FRESHNESS_MS };
}

module.exports = { assetStamp, sourceIdentity, buildVideoSearchShard, bootstrapSearchShards, videoSearchManifest, FRESHNESS_MS };
