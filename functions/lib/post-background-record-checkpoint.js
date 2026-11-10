"use strict";

const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { CHECKPOINT_MANIFEST_BYTES_MAX, CHECKPOINT_FILES_MAX, outputLimits, recordOutputForPath } = require("./no-build-record-namespace");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function requireValue(value) { if (!value) throw new Error("Prepared record checkpoint is unavailable"); }
async function readPreparedRecordManifest({ firestore, artifacts, task, reference, signal }) {
  requireValue(task.contextOnly === true && ["programs", "events"].includes(task.output) && reference &&
    Object.keys(reference).length === 2 && /^[A-Za-z0-9]{20}$/.test(reference.operationId ?? "") &&
    /^[a-f0-9]{64}$/.test(reference.checkpointDigest ?? ""));
  const preparation = await firestore.runTransaction(async transaction => {
    const [current, prepared] = await transaction.getAll(firestore.doc("system/publicDeployment/aggregateContexts/current"),
      firestore.doc(`cmsPublishQueue/${reference.operationId}/backgroundPreparation/${task.contextDigest}`));
    const context = current.data(), stored = prepared.data();
    requireValue(context?.preparationOperationId === reference.operationId && context.contextDigest === task.contextDigest &&
      context.runtime?.owner === "cloudflare" && context.runtime.release === task.rendererSha &&
      stored?.status === "verified" && stored.preparedDigest === reference.checkpointDigest &&
      stored.contextDigest === task.contextDigest && stored.runtime?.owner === "cloudflare" && stored.runtime.release === task.rendererSha &&
      stored.reservation?.commitSha === task.rendererSha);
    return stored;
  }, { readOnly: true });
  const prefix = `post-background-v1/preparation/${reference.operationId}/${task.contextDigest}`;
  const checkpointBytes = await artifacts.get(`${prefix}/prepared.json`, { signal, maxBytes: CHECKPOINT_MANIFEST_BYTES_MAX });
  requireValue(checkpointBytes instanceof Uint8Array && checkpointBytes.length <= CHECKPOINT_MANIFEST_BYTES_MAX && hash(checkpointBytes) === reference.checkpointDigest);
  const checkpoint = JSON.parse(Buffer.from(checkpointBytes).toString("utf8"));
  requireValue(checkpoint.schemaVersion === 1 && isDeepStrictEqual(checkpoint.identity, {
    operationId: reference.operationId, contextDigest: task.contextDigest, commitSha: task.rendererSha, owner: "cloudflare",
    cutoffMillis: preparation.reservation.cutoffAt?.toMillis(), admissionRevision: preparation.admissionRevision,
  }) && Array.isArray(checkpoint.files) && checkpoint.files.length <= CHECKPOINT_FILES_MAX &&
    ["receipt.json", "artifact-inventory.json", "public-context.json"].every(path => checkpoint.files.some(file => file.path === path)));
  const receipts = checkpoint.files.filter(file => file.path === "receipt.json");
  requireValue(receipts.length === 1 && /^[a-f0-9]{64}$/.test(receipts[0].digest ?? ""));
  const receiptBytes = await artifacts.get(`${prefix}/bytes/${receipts[0].digest}`, { signal, maxBytes: CHECKPOINT_MANIFEST_BYTES_MAX });
  requireValue(receiptBytes instanceof Uint8Array && receiptBytes.length === receipts[0].size && hash(receiptBytes) === receipts[0].digest);
  const receipt = JSON.parse(Buffer.from(receiptBytes).toString("utf8"));
  requireValue(receipt.schemaVersion === 2 && receipt.contextDigest === task.contextDigest && Array.isArray(receipt.files) && receipt.files.length <= CHECKPOINT_FILES_MAX - 8 && Array.isArray(receipt.routes));
  const selected = receipt.files.filter(file => Array.isArray(file.outputs) && file.outputs.includes(task.output));
  requireValue(selected.length > 0 && selected.length <= outputLimits(task.output).files);
  const paths = new Set(), byPath = new Map(checkpoint.files.map(file => [file.path, file]));
  requireValue(byPath.size === checkpoint.files.length);
  let size = 0;
  const manifest = selected.map(file => {
    const stored = byPath.get(`files/${file.file}`);
    requireValue(typeof file.path === "string" && file.path.length <= 512 && !/[%?#\\\s]/.test(file.path) &&
      file.path.startsWith("/") && !file.path.includes("//") && new URL(file.path, "https://background.invalid").pathname === file.path &&
      (recordOutputForPath(file.path) === task.output || /^\/_astro\/[A-Za-z0-9_./-]+$/.test(file.path)) && !paths.has(file.path) &&
      stored?.digest === file.digest && stored.size === file.size && /^[a-f0-9]{64}$/.test(file.digest ?? "") &&
      Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= 16 * 1024 * 1024 &&
      typeof file.contentType === "string" && file.contentType.length <= 128 && /^[a-z]+\/[a-z0-9.+-]+(?:; charset=utf-8)?$/.test(file.contentType));
    paths.add(file.path); size += file.size; requireValue(size <= outputLimits(task.output).bytes);
    return { path: file.path, key: `${prefix}/bytes/${file.digest}`, digest: file.digest, size: file.size, contentType: file.contentType };
  });
  requireValue((task.output === "programs" ? ["/programs/", "/shows/"] : ["/events/"]).every(path => paths.has(path)));
  return { manifest, routes: receipt.routes };
}
module.exports = { readPreparedRecordManifest };
