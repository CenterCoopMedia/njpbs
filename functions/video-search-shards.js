"use strict";

const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { db } = require("./lib/firebase");
const { SEARCH_SHARDS, enqueueVideoSearchShard } = require("./lib/video-search-outbox");
const { buildVideoSearchShard, assetStamp, bootstrapSearchShards } = require("./lib/video-search-shards");
const { createVideoSearchShardStorage } = require("./lib/video-search-shard-storage");
const { createVideoTranscriptProcessor } = require("./lib/video-transcript-processor");
const { readAssetCorpus } = require("./video-search-corpus");
const { runtimeRegistry, FUNCTION_SERVICE_ACCOUNT } = require("./source-media");
const { transcriptConfig } = require("./video-transcripts");

function createSearchShardWorker(dependencies = {}) {
  const firestore = dependencies.firestore ?? db;
  let storage, processor;
  return async event => {
    if (!event.data?.after.data()?.pending) return;
    const config = (dependencies.configFn ?? transcriptConfig)();
    const source = (dependencies.registryFn ?? runtimeRegistry)().get("video-library");
    await buildVideoSearchShard({ firestore, ref: event.data.after.ref, source, config,
      storage: dependencies.storage ?? (storage ??= createVideoSearchShardStorage(config)),
      processor: dependencies.processor ?? (processor ??= createVideoTranscriptProcessor(config, { firestore })),
      readCorpus: dependencies.readCorpus ?? readAssetCorpus, getJob: dependencies.getJob });
    // Advance cold bootstrap from committed outbox events, not one user visit per page.
    await bootstrapSearchShards(firestore);
  };
}

// Import and maintenance writers may predate the outbox. Reconcile their current
// catalog state, never the event payload, so delayed events cannot restore old data.
async function reconcileSearchAsset(event, firestore = db) {
  const snapshot = event.data?.after ?? event.data?.before;
  if (!snapshot) return;
  const assetRef = firestore.collection("mediaSourceAssets").doc(snapshot.id);
  const ref = firestore.collection(SEARCH_SHARDS).doc(snapshot.id);
  await firestore.runTransaction(async tx => {
    const [current, descriptor] = await Promise.all([tx.get(assetRef), tx.get(ref)]);
    const asset = current.data();
    const previous = descriptor.data();
    if (asset?.sourceId !== "video-library" && previous?.sourceId !== "video-library") return;
    if (previous?.pending || (previous && previous.assetStamp === assetStamp(current))) return;
    enqueueVideoSearchShard(tx, firestore, snapshot.id);
  });
}
const workerOptions = { retry: true, serviceAccount: FUNCTION_SERVICE_ACCOUNT,
  maxInstances: 2, concurrency: 1, cpu: 1, memory: "512MiB", timeoutSeconds: 120 };

module.exports = { createSearchShardWorker, reconcileSearchAsset,
  onVideoSearchAssetWrite: onDocumentWritten({ ...workerOptions, document: "mediaSourceAssets/{assetId}" }, reconcileSearchAsset),
  onVideoSearchShardWrite: onDocumentWritten({ ...workerOptions, document: `${SEARCH_SHARDS}/{assetId}` }, createSearchShardWorker()) };
