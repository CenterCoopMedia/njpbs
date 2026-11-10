"use strict";

const { SEARCH_SHARDS, SEARCH_STATE } = require("./video-search-outbox");
const { assetStamp, sourceIdentity, videoSearchManifest } = require("./video-search-shards");
const { ID_PATTERN, parseSourceMediaAsset } = require("./source-media-contract");
const { objectKeyWithinSource } = require("./media-sources");
const { presentSourceMediaAsset } = require("./source-media-uploader");
const { hasCapability } = require("./rbac");
const fail = status => Object.assign(new Error("Video search corpus is unavailable"), { status });

function parseShardRequest(value) {
  if (value?.sourceId !== "video-library" || !["manifest", "shards", "check"].includes(value.action) ||
      Object.keys(value).some(key => !["sourceId", "action", "shards", "epoch", "identity", "usersView"].includes(key))) throw fail(400);
  if (value.action === "check") {
    if (value.shards !== undefined || !/^[a-f0-9-]{36}$/.test(value.epoch) ||
        !/^[a-f0-9]{64}$/.test(value.identity) || typeof value.usersView !== "boolean") throw fail(400);
    return value;
  }
  if (["epoch", "identity", "usersView"].some(key => value[key] !== undefined)) throw fail(400);
  if (value.action === "manifest") {
    if (value.shards !== undefined) throw fail(400);
    return value;
  }
  if (!Array.isArray(value.shards) || !value.shards.length || value.shards.length > 8 ||
      value.shards.some(item => !item || Object.keys(item).some(key => !["id", "version"].includes(key)) ||
        typeof item.id !== "string" || !ID_PATTERN.test(item.id) || !/^[a-f0-9]{64}$/.test(item.version)) ||
      new Set(value.shards.map(item => item.id)).size !== value.shards.length) throw fail(400);
  return value;
}

async function deliverVideoSearchShards({ request, firestore, source, config, actor, storage, reauthorize, bootstrap }) {
  if (["manifest", "check"].includes(request.action)) {
    if (request.action === "check") {
      let state;
      try { state = (await firestore.collection(SEARCH_STATE).doc("video-library").get()).data(); }
      catch { /* A fresh manifest must pass its separate edge work budget. */ }
      if (/^[a-f0-9-]{36}$/.test(state?.epoch ?? "") && state.complete) {
        const identityChanged = request.identity !== sourceIdentity(source, config) ||
          request.usersView !== hasCapability(actor?.principal, "users.view");
        const unchanged = state.epoch === request.epoch && !identityChanged;
        await reauthorize();
        return { success: true, schema: 1, unchanged, identityChanged, freshnessMs: 60_000 };
      }
      // Never turn a cheap lease request into a full manifest scan. The client
      // must request the separately rate-limited manifest before using text.
      await reauthorize();
      return { success: true, schema: 1, unchanged: false, freshnessMs: 60_000 };
    }
    const manifest = await videoSearchManifest({ firestore, source, config, bootstrap });
    await reauthorize();
    return { success: true, unchanged: false, ...manifest, usersView: hasCapability(actor?.principal, "users.view") };
  }
  const identity = sourceIdentity(source, config);
  const items = [];
  let bytes = 0;
  for (let index = 0; index < request.shards.length; index += 2) {
    const round = await Promise.all(request.shards.slice(index, index + 2).map(async requested => {
      const ref = firestore.collection(SEARCH_SHARDS).doc(requested.id);
      const descriptor = (await ref.get()).data();
      if (!descriptor || descriptor.pending || descriptor.tombstone || descriptor.identity !== identity || descriptor.digest !== requested.version) throw fail(409);
      const content = await storage.read(descriptor);
      if (content.asset?.id !== requested.id || content.asset?.sourceId !== source.id) throw fail(409);
      return { id: requested.id, version: requested.version, generation: descriptor.generation, ...content };
    }));
    for (const item of round) {
      const size = Buffer.byteLength(JSON.stringify(item));
      if (items.length && bytes + size > 2 * 1024 * 1024) break;
      items.push(item); bytes += size;
    }
    if (items.length < index + round.length) break;
  }
  // Check AFTER the whole storage batch. Atomic outbox writes invalidate edits;
  // authoritative catalog checks also fail closed for direct administrative deletion.
  for (const item of items) {
    const [descriptor, snapshot] = await Promise.all([
      firestore.collection(SEARCH_SHARDS).doc(item.id).get(),
      firestore.collection("mediaSourceAssets").doc(item.id).get(),
    ]);
    const current = descriptor.data();
    const asset = parseSourceMediaAsset(snapshot.id, snapshot.data());
    if (!current || current.pending || current.tombstone || current.generation !== item.generation ||
        !asset || current.assetStamp !== assetStamp(snapshot) || asset.sourceId !== source.id || asset.version !== item.asset.version || !objectKeyWithinSource(source, asset.objectKey)) throw fail(409);
  }
  await reauthorize();
  const users = hasCapability(actor?.principal, "users.view");
  return { success: true, schema: 1, items: await Promise.all(items.map(async item =>
    ({ id: item.id, version: item.version, asset: await presentSourceMediaAsset(firestore, item.asset, users),
      chunks: item.chunks, revision: item.revision, coverage: item.coverage }))) };
}

module.exports = { parseShardRequest, deliverVideoSearchShards };
