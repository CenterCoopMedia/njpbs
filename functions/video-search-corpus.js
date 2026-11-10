"use strict";

const { db } = require("./lib/firebase");
const { cmsOnRequest } = require("./lib/cms-edge");
const { requirePrincipal } = require("./lib/auth");
const { verifyAppCheckUnlessAutomation } = require("./lib/automation-accounts");
const { validateBoundedJsonRequest } = require("./lib/http-json");
const { hasCapability } = require("./lib/rbac");
const { presentSourceMediaAsset } = require("./lib/source-media-uploader");
const { authorizeMediaSource, objectKeyWithinSource } = require("./lib/media-sources");
const { parseSourceMediaAsset, sourceMediaAssetSummary, ID_PATTERN } = require("./lib/source-media-contract");
const { runtimeRegistry, FUNCTION_SERVICE_ACCOUNT } = require("./source-media");
const { transcriptConfig } = require("./video-transcripts");
const { TRANSCRIPT_JOBS, getTranscriptJob, assertTranscriptRevision } = require("./lib/video-transcript-job");
const { createVideoTranscriptProcessor } = require("./lib/video-transcript-processor");

const MAX_VARIANTS = 32;
const MAX_CHUNKS = 4000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
// A batch reads its videos two at a time. It returns whole videos in order until the byte budget
// is spent, always at least one, so one large transcript cannot push a response past 2 MiB plus one video.
const MAX_BATCH_ASSETS = 8;
const MAX_BATCH_BYTES = 2 * 1024 * 1024;
// Transcript reads in flight per request. With concurrency 2 an instance holds at most four.
const READ_POOL = 2;
const fail = (status, message) => Object.assign(new Error(message), { status });

function parseRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !["sourceId", "cursor", "limit"].includes(key)) || value.sourceId !== "video-library" ||
      (value.limit !== undefined && (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > MAX_BATCH_ASSETS))) {
    throw fail(400, "Video search request is invalid");
  }
  // Without limit, the response keeps the single-asset shape for Admin tabs opened before batching.
  const batch = value.limit === undefined ? {} : { limit: value.limit };
  if (value.cursor === undefined) return { sourceId: value.sourceId, after: null, ...batch };
  try {
    if (typeof value.cursor !== "string" || value.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value.cursor)) throw new Error();
    const cursor = JSON.parse(Buffer.from(value.cursor, "base64url").toString("utf8"));
    if (cursor.v !== 1 || cursor.sourceId !== value.sourceId || typeof cursor.after !== "string" || !ID_PATTERN.test(cursor.after)) throw new Error();
    return { sourceId: value.sourceId, after: cursor.after, ...batch };
  } catch { throw fail(400, "Video search cursor is invalid"); }
}

function preferredJobs(rows) {
  return rows.map(row => ({ ...row.data(), id: row.id })).filter(job => job.phase === "ready")
    .sort((a, b) => {
      const reviewed = job => job.reviewedRevision != null && job.reviewedRevision === (job.editRevision ?? 0);
      const corrected = job => (job.editRevision ?? 0) > 0;
      return Number(reviewed(b)) - Number(reviewed(a)) || Number(corrected(b)) - Number(corrected(a)) ||
        String(b.editedAt ?? b.createdAt ?? "").localeCompare(String(a.editedAt ?? a.createdAt ?? "")) || a.id.localeCompare(b.id);
    });
}

function searchChunks(asset, job, segments) {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (!segment || typeof segment.text !== "string" || !Number.isFinite(segment.startSeconds) ||
        !Number.isFinite(segment.endSeconds) || segment.startSeconds < 0 || segment.endSeconds < segment.startSeconds) {
      truncated = true;
      continue;
    }
    if (!segment.text.trim()) continue;
    // Overlap exceeds the 160-character search limit so phrases survive passage boundaries.
    // Prefer word boundaries and retain the original source timestamps.
    let partIndex = 0;
    for (let offset = 0; offset < segment.text.length;) {
      let end = Math.min(offset + 1400, segment.text.length);
      if (end < segment.text.length) {
        const boundary = segment.text.lastIndexOf(" ", end);
        if (boundary > offset + 1000) end = boundary + 1;
      }
      const last = segment.text.charCodeAt(end - 1);
      if (end < segment.text.length && last >= 0xD800 && last <= 0xDBFF) end--;
      const text = segment.text.slice(offset, end);
      offset = end === segment.text.length ? end : end - 200;
      const next = segment.text.charCodeAt(offset);
      if (next >= 0xDC00 && next <= 0xDFFF) offset--;
      const id = `${asset.id}/${job.id}/${job.editRevision ?? 0}/${index}${partIndex ? `/${partIndex}` : ""}`;
      const chunk = { id, assetId: asset.id, title: asset.name, transcriptId: job.id,
        editRevision: job.editRevision ?? 0, segmentIndex: index, partIndex: partIndex++,
        startSeconds: segment.startSeconds, endSeconds: segment.endSeconds, text };
      if (!text.trim()) continue;
      const size = Buffer.byteLength(JSON.stringify(chunk)) + 1;
      if (chunks.length === MAX_CHUNKS || bytes + size > MAX_OUTPUT_BYTES) return { chunks, truncated: true };
      chunks.push(chunk);
      bytes += size;
    }
  }
  return { chunks, truncated };
}

async function readAssetCorpus({ firestore, source, snapshot, config, processor, getJob = getTranscriptJob }) {
  const asset = parseSourceMediaAsset(snapshot.id, snapshot.data());
  if (!asset || asset.sourceId !== source.id || !objectKeyWithinSource(source, asset.objectKey)) return { unavailable: true };
  const result = { asset: sourceMediaAssetSummary(asset), chunks: [], revision: null, truncated: false };
  const rows = await firestore.collection(TRANSCRIPT_JOBS).where("assetId", "==", asset.id).orderBy("__name__").limit(MAX_VARIANTS + 1).get();
  result.truncated = rows.docs.length > MAX_VARIANTS;
  const candidates = preferredJobs(rows.docs.slice(0, MAX_VARIANTS));
  let selected;
  for (const candidate of candidates) {
    try {
      const job = await getJob({ firestore, source, request: { sourceId: source.id, assetId: asset.id, transcriptId: candidate.id }, renditionBucket: config.bucket });
      if (job?.phase === "ready") { selected = job; break; }
    } catch (error) { if (![404, 409].includes(error.status)) throw error; }
  }
  if (!selected) return result;
  // One bounded private object read per asset, not one full-object read per text page.
  const segments = await processor.read(selected);
  const current = await getJob({ firestore, source, request: { sourceId: source.id, assetId: asset.id, transcriptId: selected.id }, renditionBucket: config.bucket });
  assertTranscriptRevision(current, selected.editRevision ?? 0, selected.id);
  const content = searchChunks(asset, selected, segments);
  result.chunks = content.chunks;
  result.truncated ||= content.truncated;
  result.revision = { assetId: asset.id, assetVersion: asset.version, transcriptId: selected.id,
    editRevision: selected.editRevision ?? 0, languageCode: selected.languageCode,
    reviewed: selected.reviewedRevision != null && selected.reviewedRevision === (selected.editRevision ?? 0) };
  return result;
}

function createVideoSearchCorpusHandler(dependencies = {}) {
  const firestore = dependencies.firestore ?? db;
  const registry = dependencies.registryFn ?? runtimeRegistry;
  const authorize = dependencies.authorizeFn ?? authorizeMediaSource;
  let defaultProcessor;
  let shardStorage;
  // Storage phase: one private transcript read per video, at most READ_POOL at a time.
  async function readStored(snapshot, source) {
    try {
      const config = (dependencies.configFn ?? transcriptConfig)();
      const processor = dependencies.processor ?? (defaultProcessor ??= createVideoTranscriptProcessor(config, { firestore }));
      return { snapshot, config, read: await readAssetCorpus({ firestore, source, snapshot, config, processor, getJob: dependencies.getJob }) };
    } catch {
      return { snapshot, failed: true };
    }
  }
  // Freshness phase: runs for the whole batch after every read, immediately before the response,
  // so no video's text waits in memory after its last asset and transcript revision check.
  async function settle({ snapshot, config, read, failed }, source) {
    const coverage = { assetsScanned: 1, assetsIndexed: 0, assetsWithoutTranscript: 0, assetsUnavailable: 0, truncatedAssets: 0 };
    let content = { asset: null, chunks: [], revision: null };
    if (read?.unavailable) {
      coverage.assetsUnavailable++;
      return { id: snapshot.id, content, coverage };
    }
    try {
      if (failed) throw fail(503, "Video transcript read failed");
      // Refresh lifecycle and metadata after storage work. Deleted/replaced assets release no text.
      const fresh = parseSourceMediaAsset(snapshot.id, (await snapshot.ref.get()).data());
      if (!fresh || fresh.version !== read.asset.version || fresh.sourceId !== source.id || !objectKeyWithinSource(source, fresh.objectKey)) throw fail(409, "Video changed");
      if (read.revision) {
        const { transcriptId, editRevision } = read.revision;
        const current = await (dependencies.getJob ?? getTranscriptJob)({ firestore, source,
          request: { sourceId: source.id, assetId: snapshot.id, transcriptId }, renditionBucket: config.bucket });
        assertTranscriptRevision(current, editRevision, transcriptId);
      }
      content = { asset: sourceMediaAssetSummary(fresh), chunks: read.chunks, revision: read.revision };
      if (read.revision) coverage.assetsIndexed++; else coverage.assetsWithoutTranscript++;
      if (read.truncated) coverage.truncatedAssets++;
    } catch {
      coverage.assetsUnavailable++;
      // A transcript storage failure must not hide still-authorized video metadata.
      const fresh = parseSourceMediaAsset(snapshot.id, (await snapshot.ref.get()).data());
      if (fresh && fresh.sourceId === source.id && objectKeyWithinSource(source, fresh.objectKey)) {
        content = { asset: sourceMediaAssetSummary(fresh), chunks: [], revision: null };
      }
    }
    return { id: snapshot.id, content, coverage };
  }
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    try {
      validateBoundedJsonRequest(req, 8 * 1024);
      const actor = await (dependencies.requirePrincipalFn ?? requirePrincipal)(req);
      await verifyAppCheckUnlessAutomation(req, actor, { firestore, verifyAppCheckFn: dependencies.verifyAppCheckFn });
      const request = req.body?.action === undefined ? parseRequest(req.body)
        : require("./lib/video-search-delivery").parseShardRequest(req.body);
      const source = registry().get(request.sourceId);
      await authorize({ firestore, actor, source, operation: "browse" });
      if (request.action) {
        const config = (dependencies.configFn ?? transcriptConfig)();
        const body = await require("./lib/video-search-delivery").deliverVideoSearchShards({
          request, firestore, source, config, actor, bootstrap: dependencies.bootstrap,
          storage: dependencies.shardStorage ?? (shardStorage ??= require("./lib/video-search-shard-storage").createVideoSearchShardStorage(config)),
          reauthorize: async () => {
            const currentSource = registry().get(request.sourceId);
            // Re-read principal roles too: a users.view change must not release cached uploader IDs.
            const currentActor = await (dependencies.requirePrincipalFn ?? requirePrincipal)(req);
            await authorize({ firestore, actor: currentActor, source: currentSource, operation: "browse" });
            if (JSON.stringify(currentActor.principal) !== JSON.stringify(actor.principal) ||
                require("./lib/video-search-shards").sourceIdentity(currentSource, config) !==
                  require("./lib/video-search-shards").sourceIdentity(source, config)) throw fail(409, "Video source changed");
          },
        });
        return res.status(200).json(body);
      }
      // Only equality + document-ID pagination: no mutable title/date cursor and no new index.
      const pageSize = request.limit ?? 1;
      let query = firestore.collection("mediaSourceAssets").where("sourceId", "==", source.id).orderBy("__name__");
      if (request.after) query = query.startAfter(request.after);
      const page = await query.limit(pageSize + 1).get();
      const snapshots = page.docs.slice(0, pageSize);
      // Read in small rounds and stop starting reads once the byte budget is spent, so an instance
      // holds at most READ_POOL transcripts per request, whatever their size.
      const stored = [];
      let bytes = 0;
      for (let index = 0; index < snapshots.length && stored.length === index; index += READ_POOL) {
        const round = await Promise.all(snapshots.slice(index, index + READ_POOL).map(snapshot => readStored(snapshot, source)));
        for (const item of round) {
          const size = item.read?.chunks ? Buffer.byteLength(JSON.stringify(item.read.chunks)) : 0;
          if (stored.length && bytes + size > MAX_BATCH_BYTES) break;
          stored.push(item);
          bytes += size;
        }
      }
      const kept = await Promise.all(stored.map(item => settle(item, source)));
      // Access can change while S3 is being read. No principal/private corpus cache is shared.
      const currentSource = registry().get(request.sourceId);
      await authorize({ firestore, actor, source: currentSource, operation: "browse" });
      if (!currentSource || currentSource.bucket !== source.bucket || currentSource.prefix !== source.prefix) throw fail(409, "Video source changed");
      const coverage = { assetsScanned: 0, assetsIndexed: 0, assetsWithoutTranscript: 0, assetsUnavailable: 0, truncatedAssets: 0 };
      for (const read of kept) for (const key of Object.keys(coverage)) coverage[key] += read.coverage[key];
      const more = kept.length < snapshots.length || page.docs.length > pageSize;
      const nextCursor = more && kept.length
        ? Buffer.from(JSON.stringify({ v: 1, sourceId: source.id, after: kept.at(-1).id })).toString("base64url") : null;
      const users = hasCapability(actor?.principal, "users.view");
      const items = await Promise.all(kept.map(async ({ content, coverage }) => content.asset
        ? { ...content, asset: await presentSourceMediaAsset(firestore, content.asset, users), coverage } : { ...content, coverage }));
      if (request.limit === undefined) {
        const { asset = null, chunks = [], revision = null } = items[0] ?? {};
        return res.status(200).json({ success: true, asset, chunks, revision, coverage, nextCursor });
      }
      // Every scanned video is an item with its own coverage, so a browser that stops at its
      // search cap can count exactly the prefix it reached. Unavailable videos have no asset or text.
      return res.status(200).json({ success: true, items, coverage, nextCursor });
    } catch (error) {
      const status = [400, 401, 403, 404, 409, 413, 429].includes(error?.status) ? error.status : 503;
      return res.status(status).json({ error: "Video search corpus is unavailable" });
    }
  };
}

module.exports = { parseRequest, preferredJobs, searchChunks, readAssetCorpus, createVideoSearchCorpusHandler,
  cmsGetVideoSearchCorpus: cmsOnRequest({ cors: true, maxInstances: 3, concurrency: 2, cpu: 1, memory: "512MiB", timeoutSeconds: 60,
    serviceAccount: FUNCTION_SERVICE_ACCOUNT }, createVideoSearchCorpusHandler()) };
