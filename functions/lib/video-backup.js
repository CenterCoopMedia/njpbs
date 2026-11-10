"use strict";

// Independent worker library. Deliberately absent from the Functions manifest
// and the upload, playback and preview-completion paths.
const { createHash } = require("node:crypto");
const { createReadStream, createWriteStream } = require("node:fs");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { FieldPath } = require("firebase-admin/firestore");
const { parseSourceMediaAsset } = require("./source-media-contract");

const PREFIX = "viewing-copies-v1";
const MAX_PAGE = 20;
const MAX_FILE_BYTES = 16 * 1024 ** 3;

class BackupError extends Error {}
function fault(code) { return new BackupError(code); }
function bounded(value, max, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw fault(label);
}
function archiveId(assetId, source, sizeBytes) {
  return createHash("sha256").update(JSON.stringify([
    1, "video-library", assetId, source.bucket, source.key, source.versionId, sizeBytes,
  ])).digest("hex");
}
function archiveKeys(id) {
  if (!/^[a-f0-9]{64}$/.test(id)) throw fault("invalid_archive_id");
  return { mp4: `${PREFIX}/${id}.mp4`, sidecar: `${PREFIX}/${id}.json` };
}

async function inventoryPage({ db, source, sourceBucket, after = null, limit = MAX_PAGE, recordsOnly = false }) {
  bounded(limit, MAX_PAGE, "invalid_page_limit");
  if (typeof recordsOnly !== "boolean") throw fault("invalid_inventory_mode");
  if (typeof sourceBucket !== "string" || !sourceBucket) throw fault("missing_source_bucket");
  // Firestore document IDs can be invalid assets: still allow their exact scan
  // cursor so a malformed record cannot wedge the inventory.
  if (after !== null && (typeof after !== "string" || !after || after.includes("/"))) {
    throw fault("invalid_cursor");
  }
  let query = db.collection("mediaSourceAssets").where("sourceId", "==", "video-library")
    .orderBy(FieldPath.documentId()).limit(limit);
  if (after !== null) query = query.startAfter(after);
  const page = await query.get();
  const entries = [], gaps = [];
  for (const doc of page.docs) {
    const raw = doc.data();
    const asset = parseSourceMediaAsset(doc.id, raw);
    let reason = null;
    if (!asset) reason = "invalid_or_inactive_asset";
    else if (!raw.rendition) reason = "missing_viewing_copy";
    else if (!asset.rendition) reason = "invalid_rendition";
    else if (asset.rendition.state !== "ready") reason = `rendition_${asset.rendition.state}`;
    if (reason) { gaps.push({ assetId: doc.id, reason }); continue; }
    const web = asset.rendition.web;
    const identity = { bucket: sourceBucket, key: web.objectKey, versionId: web.objectVersionId };
    try {
      // Cost planning can use the app's recorded identities and sizes without
      // AWS credentials. Only the transfer runner performs source HEAD checks.
      if (!recordsOnly) {
        const head = await source.head(identity);
        if (head.versionId !== identity.versionId || head.sizeBytes !== web.sizeBytes) {
          throw fault("source_identity_mismatch");
        }
      }
    } catch (error) {
      gaps.push({ assetId: doc.id, reason: error instanceof BackupError ? error.message : "source_unreadable" });
      continue;
    }
    entries.push({ archiveId: archiveId(asset.id, identity, web.sizeBytes), assetId: asset.id,
      title: asset.name, originalFilename: asset.originalName, uploadedAt: asset.createdAt,
      source: identity, sizeBytes: web.sizeBytes,
      ...(web.durationSeconds === undefined ? {} : { durationSeconds: web.durationSeconds }),
      ...(web.width === undefined ? {} : { width: web.width }),
      ...(web.height === undefined ? {} : { height: web.height }) });
  }
  return { scanned: page.size, sourceVerified: !recordsOnly, eligibleFiles: entries.length,
    eligibleBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    entries, gaps, nextCursor: page.size === limit ? page.docs.at(-1).id : null };
}

async function digest(body, expectedBytes) {
  if (!body) throw fault("backup_missing");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of body) {
    bytes += chunk.length;
    if (bytes > expectedBytes) throw fault("byte_count_mismatch");
    hash.update(chunk);
  }
  if (bytes !== expectedBytes) throw fault("byte_count_mismatch");
  return hash.digest("hex");
}

async function readSidecar(destination, key) {
  const body = await destination.read(key);
  if (!body) return null;
  const chunks = [];
  let bytes = 0;
  for await (const chunk of body) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw fault("invalid_sidecar");
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw fault("invalid_sidecar"); }
}

function validSidecar(value, entry) {
  return value && value.schemaVersion === 1 && value.archiveId === entry.archiveId &&
    value.assetId === entry.assetId && value.sourceId === "video-library" &&
    value.sizeBytes === entry.sizeBytes && /^[a-f0-9]{64}$/.test(value.sha256) &&
    typeof value.backedUpAt === "string" && Number.isFinite(Date.parse(value.backedUpAt)) &&
    typeof value.title === "string" && typeof value.originalFilename === "string" &&
    (value.uploadedAt === null || typeof value.uploadedAt === "string") &&
    ["bucket", "key", "versionId"].every(key => value.source?.[key] === entry.source[key]);
}

async function copyViewingCopy({ entry, source, destination, state, maxFileBytes = MAX_FILE_BYTES,
  verifyExisting = true, stagingDirectory = tmpdir(), now = () => new Date().toISOString() }) {
  const keys = archiveKeys(entry.archiveId);
  const stateKey = `jobs/${entry.archiveId}`;
  const previous = await state.read(stateKey);
  const pending = { entry, status: "pending", attempts: (previous?.attempts || 0) + 1, updatedAt: now() };
  // A crash from this point remains pending; a failed transfer never erases a
  // completed destination object or becomes a success receipt.
  await state.write(stateKey, pending);
  let directory;
  try {
    bounded(maxFileBytes, MAX_FILE_BYTES, "invalid_file_limit");
    if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 1 || entry.sizeBytes > maxFileBytes) {
      throw fault("copy_limit_exceeded");
    }
    if (entry.archiveId !== archiveId(entry.assetId, entry.source, entry.sizeBytes)) {
      throw fault("archive_identity_mismatch");
    }
    let sidecar = await readSidecar(destination, keys.sidecar);
    const reused = sidecar !== null;
    let checkedBytes = entry.sizeBytes;
    let verifiedAt = now();
    if (reused) {
      if (!validSidecar(sidecar, entry)) throw fault("invalid_sidecar");
      const priorVerification = previous?.status === "verified" && previous.entry?.archiveId === entry.archiveId &&
        previous.sha256 === sidecar.sha256 && Number.isFinite(Date.parse(previous.verifiedAt));
      if (!verifyExisting && priorVerification) {
        checkedBytes = 0;
        verifiedAt = previous.verifiedAt;
      } else {
        if (await digest(await destination.read(keys.mp4), entry.sizeBytes) !== sidecar.sha256) {
          throw fault("digest_mismatch");
        }
      }
    } else {
      directory = await mkdtemp(join(stagingDirectory, "viewing-copy-backup-"));
      const file = join(directory, "copy.mp4");
      const response = await source.read(entry.source);
      if (response.sizeBytes !== entry.sizeBytes || response.versionId !== entry.source.versionId) {
        response.body?.destroy?.();
        throw fault("source_identity_mismatch");
      }
      const hash = createHash("sha256");
      let bytes = 0;
      const meter = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > entry.sizeBytes) return callback(fault("byte_count_mismatch"));
        hash.update(chunk);
        callback(null, chunk);
      } });
      await pipeline(response.body, meter, createWriteStream(file, { flags: "wx", mode: 0o600 }));
      if (bytes !== entry.sizeBytes) throw fault("byte_count_mismatch");
      const sha256 = hash.digest("hex");
      const body = createReadStream(file);
      try {
        await destination.putIfAbsent(keys.mp4, body, { sizeBytes: bytes, contentType: "video/mp4" });
      } finally { body.destroy(); }
      // Read back the actual destination bytes, including an orphan from an
      // interrupted prior attempt. ETags/provider metadata are not SHA-256 proof.
      if (await digest(await destination.read(keys.mp4), bytes) !== sha256) throw fault("digest_mismatch");
      const proposed = { schemaVersion: 1, sourceId: "video-library", ...entry, sha256, backedUpAt: now() };
      const json = Buffer.from(JSON.stringify(proposed));
      await destination.putIfAbsent(keys.sidecar, json, { sizeBytes: json.length, contentType: "application/json" });
      sidecar = await readSidecar(destination, keys.sidecar);
      if (!validSidecar(sidecar, entry) || sidecar.sha256 !== sha256) throw fault("invalid_sidecar");
    }
    const verified = { ...pending, status: "verified", sha256: sidecar.sha256,
      updatedAt: now(), verifiedAt, checkedBytes, reused };
    await state.write(stateKey, verified);
    return verified;
  } catch (error) {
    // Provider exception messages can contain URLs, headers or credentials.
    const failed = { ...pending, status: "failed", errorCode: error instanceof BackupError ? error.message : "copy_failed", updatedAt: now() };
    await state.write(stateKey, failed);
    return failed;
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

module.exports = { MAX_PAGE, MAX_FILE_BYTES, archiveId, archiveKeys, inventoryPage, copyViewingCopy, digest };
