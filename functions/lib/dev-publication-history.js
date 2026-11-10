"use strict";

// This receipt is accepted only by the development pause drain. It grants no
// ordinary publisher, production writer or public-success authority.
const { createHash } = require("node:crypto");
const p = require("./public-release-pair");
const d = require("./public-deployment");
const uuid = value => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value ?? "");
const REASON = "dev_historical_reservation_below_active";
const refuse = () => { throw new p.PublicReleaseProtocolError(); };
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    if (typeof value.toMillis === "function") return { seconds: value.seconds, nanoseconds: value.nanoseconds };
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}
function digest(value) { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function parseRow(row, planning = false) {
  p.exact(row, ["buildBatchId", "queueId", "generation", "status", "owner", "batchDigest", "queueDigest",
    "inputsDigest", "candidatesDigest", "manifestsDigest", "verificationsDigest", "chunksDigest"]);
  if (!d.isPublicDeploymentIdentifier(row.buildBatchId) || !/^[A-Za-z0-9]{20}$/.test(row.queueId ?? "") ||
      !row.buildBatchId.startsWith(`cms-${row.queueId}`) || !p.positive(row.generation) || row.generation >= 125 ||
      !["reserved", "ready"].includes(row.status) || !["node-compute", "cloudflare"].includes(row.owner) ||
      ["batchDigest", "queueDigest"].some(key => !p.digest(row[key])) ||
      ["inputsDigest", "candidatesDigest", "manifestsDigest", "verificationsDigest", "chunksDigest"]
        .some(key => !p.digest(row[key]) && !(planning && row[key] === null))) refuse();
  return row;
}
function parseActive(active, planning = false) {
  p.exact(active, ["buildBatchId", "generation", "commitSha", "deploymentId", "versionId", "publicReceiptBytes",
    "pointerDigest", "batchDigest", "candidateDigest", "runtimeDigest"]);
  if (!d.isPublicDeploymentIdentifier(active.buildBatchId) || active.generation !== 125 ||
      active.commitSha !== "a85fe93e24f2c3f4664816d3c08311f20c804667" || !uuid(active.deploymentId) || !uuid(active.versionId) ||
      typeof active.publicReceiptBytes !== "string" || Buffer.byteLength(active.publicReceiptBytes) > 8192 ||
      ["pointerDigest", "batchDigest", "candidateDigest", "runtimeDigest"].some(key => !p.digest(active[key]) && !(planning && active[key] === null))) refuse();
  const proof = JSON.parse(active.publicReceiptBytes);
  p.exact(proof, ["schemaVersion", "digestAlgorithm", "buildBatchId", "generation", "commitSha", "artifactDigest",
    "artifactReceiptDigest", "mediaManifestDigest"]);
  if (proof.schemaVersion !== 1 || proof.digestAlgorithm !== "sha256" ||
      ["buildBatchId", "generation", "commitSha"].some(key => proof[key] !== active[key]) ||
      ["artifactDigest", "artifactReceiptDigest", "mediaManifestDigest"].some(key => !p.digest(proof[key]))) refuse();
  return active;
}
function parseRequest(value, { planning = false } = {}) {
  p.exact(value, ["schemaVersion", "operationId", "environment", "projectId", "active", "rows", "queuesDigest", "batchesDigest"]);
  if (value.schemaVersion !== 1 || !d.isPublicDeploymentIdentifier(value.operationId) || value.environment !== "development" ||
      value.projectId !== "njpbs-site-dev" || (!p.digest(value.queuesDigest) && !(planning && value.queuesDigest === null)) ||
      (!p.digest(value.batchesDigest) && !(planning && value.batchesDigest === null)) ||
      !Array.isArray(value.rows) || value.rows.length !== 10) refuse();
  parseActive(value.active, planning); value.rows.forEach(row => parseRow(row, planning));
  if (new Set(value.rows.map(row => row.buildBatchId)).size !== 10 || new Set(value.rows.map(row => row.queueId)).size !== 10 ||
      new Set(value.rows.map(row => row.generation)).size !== 10 || value.rows.filter(row => row.status === "reserved").length !== 9 ||
      value.rows.filter(row => row.status === "ready").length !== 1) refuse();
  return value;
}
function plan(request, operatorCommitSha) {
  parseRequest(request);
  if (!d.isCommitSha(operatorCommitSha)) refuse();
  return { schemaVersion: 1, kind: "dev-publication-history-plan", requestDigest: digest(request), operatorCommitSha,
    active: request.active, rows: request.rows.map(row => ({ ...row, action: row.status === "ready" ? "supersede" : "retire" })) };
}
function reservationIdentity(batch) {
  const reservation = d.projectPublicBuildReservation(batch, batch.buildBatchId);
  return { buildBatchId: reservation.buildBatchId, generation: reservation.generation, commitSha: reservation.commitSha,
    owner: reservation.runtime?.owner ?? "node-compute", reservedAgainstGeneration: reservation.reservedAgainstGeneration,
    reservedAgainstDeploymentId: reservation.reservedAgainstDeploymentId, reservedAgainstCommitSha: reservation.reservedAgainstCommitSha,
    cutoffAtMillis: d.timestampMillis(reservation.cutoffAt), reservedAtMillis: d.timestampMillis(reservation.reservedAt) };
}
function retirementReceipt(request, row, operatorCommitSha, batch) {
  return { schemaVersion: 1, reason: REASON, outcome: "historical_not_published", operationId: request.operationId,
    original: row, reservation: reservationIdentity(batch), active: request.active, request,
    requestDigest: digest(request), planDigest: digest(plan(request, operatorCommitSha)), operatorCommitSha };
}
function assertDevHistoricalRetiredBatch(value, buildBatchId) {
  const { retiredAt, retirementReceipt: receipt, ...original } = value ?? {};
  d.assertPublicDeploymentReservedBatch({ ...original, status: "reserved" }, buildBatchId);
  p.exact(receipt, ["schemaVersion", "reason", "outcome", "operationId", "original", "reservation", "active", "request", "requestDigest", "planDigest", "operatorCommitSha"]);
  const row = parseRow(receipt.original); parseActive(receipt.active);
  const request = parseRequest(receipt.request);
  if (value.status !== "retired" || value.noBuildStaticInput !== undefined || row.status !== "reserved" ||
      row.buildBatchId !== buildBatchId || row.generation !== value.generation ||
      row.owner !== (value.runtime?.owner ?? "node-compute") ||
      digest({ ...original, status: "reserved" }) !== row.batchDigest ||
      digest(receipt.reservation) !== digest(reservationIdentity({ ...original, status: "reserved" })) ||
      receipt.schemaVersion !== 1 || receipt.reason !== REASON ||
      receipt.outcome !== "historical_not_published" || !d.isPublicDeploymentIdentifier(receipt.operationId) ||
      ![receipt.requestDigest, receipt.planDigest].every(p.digest) || !d.isCommitSha(receipt.operatorCommitSha) ||
      receipt.operationId !== request.operationId || digest(receipt.active) !== digest(request.active) ||
      digest(row) !== digest(request.rows.find(item => item.buildBatchId === buildBatchId) ?? null) ||
      receipt.requestDigest !== digest(request) || receipt.planDigest !== digest(plan(request, receipt.operatorCommitSha)) ||
      d.timestampMillis(retiredAt) === null || d.timestampMillis(retiredAt) < d.timestampMillis(value.reservedAt)) refuse();
  return value;
}
module.exports = { REASON, refuse, canonical, digest, parseRequest, plan, retirementReceipt, assertDevHistoricalRetiredBatch };
