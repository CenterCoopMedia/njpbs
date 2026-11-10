"use strict";
const cms = require("./cms-preview-pair");
const sessions = require("./cms-reader-session");
const p = require("./public-release-pair");
function refuse() { throw new Error("Installed CMS reader proof is unavailable"); }
const FIRST_INSTALL_STAGE = "legacy-first-install";
const CONVERTED_STAGE = "public-converted";
function cmsReaderBridgeStage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse();
  if (!Object.hasOwn(value, "stage")) return CONVERTED_STAGE;
  if (value.stage !== FIRST_INSTALL_STAGE) refuse();
  return FIRST_INSTALL_STAGE;
}
function cmsReaderBridgeProofKey(readers, stage = CONVERTED_STAGE) {
  if (![FIRST_INSTALL_STAGE, CONVERTED_STAGE].includes(stage)) refuse();
  p.exact(readers, ["functions", "cmsApi"]);
  const readerIdentities = Object.fromEntries(["functions", "cmsApi"].map(component => {
    const reader = cms.parseReader(readers[component]);
    if (reader.component !== component) refuse();
    return [component, sessions.readerSessionDigest(reader)];
  }));
  return cms.digest({ schemaVersion: 2, kind: "installed-reader-identity", readerIdentities,
    ...(stage === FIRST_INSTALL_STAGE ? { stage } : {}) });
}
function parseInstalledCmsReaderProof(value, operationId, { stage = CONVERTED_STAGE } = {}) {
  p.exact(value, ["schemaVersion", "proof", "readerDigests"]);
  const proof = value.proof;
  if (![FIRST_INSTALL_STAGE, CONVERTED_STAGE].includes(stage) || cmsReaderBridgeStage(proof) !== stage) refuse();
  const first = stage === FIRST_INSTALL_STAGE;
  p.exact(proof, ["schemaVersion", "operationId", "requestDigest", "stateDigest", "readerIdentities", "readers", "results", "verifiedAt",
    ...(first ? ["stage", "refusals", "legacyPublicSelectorDigest"] : [])]);
  p.exact(proof.readers, ["functions", "cmsApi"]);
  p.exact(proof.readerIdentities, ["functions", "cmsApi"]);
  p.exact(value.readerDigests, ["functions", "cmsApi"]);
  if (value.schemaVersion !== 2 || proof.schemaVersion !== 2 || proof.operationId !== operationId ||
      typeof operationId !== "string" || !/^reader-[a-z0-9][a-z0-9-]{0,63}$/.test(operationId) ||
      !p.digest(proof.requestDigest) || !p.digest(proof.stateDigest) || typeof proof.verifiedAt !== "string" ||
      !Number.isFinite(Date.parse(proof.verifiedAt)) || new Date(proof.verifiedAt).toISOString() !== proof.verifiedAt ||
      !Array.isArray(proof.results) || proof.results.length !== (first ? 56 : 72) ||
      first && (!p.digest(proof.legacyPublicSelectorDigest) || !Array.isArray(proof.refusals) || proof.refusals.length !== 4)) refuse();
  for (const component of ["functions", "cmsApi"]) {
    const reader = cms.parseReader(proof.readers[component]);
    if (reader.component !== component || ![1, 2].every(version => reader.supported.adminSession.includes(version)) ||
        sessions.readerSessionDigest(reader) !== proof.readerIdentities[component] || !p.digest(value.readerDigests[component])) refuse();
  }
  const seen = new Set();
  const consumers = new Map(), sources = new Set();
  for (const row of [...proof.results, ...(first ? proof.refusals : [])]) {
    const refusal = first && proof.refusals.includes(row);
    p.exact(row, ["component", "scope", "version", "feature", "pairDigest", "status", "contentType", "bodyDigest",
      ...(first ? ["sourcePairDigest"] : [])]);
    const features = ["publicCode", "postChrome", "settings", "capabilities", ...(String(row.scope).startsWith("preview") ? ["previewRequest"] : [])];
    const key = `${row.component}:${row.scope}:${row.version}:${row.feature}`;
    const scopes = first ? refusal ? ["publicNew"] : ["publicOld", "previewOld", "previewNew"] : ["publicOld", "publicNew", "previewOld", "previewNew"];
    if (!["functions", "cmsApi"].includes(row.component) || !scopes.includes(row.scope) ||
        ![1, 2].includes(row.version) || !features.includes(row.feature) || row.status !== (refusal ? 503 : 200) ||
        refusal && (row.feature !== "publicCode" || row.bodyDigest !== require("node:crypto").createHash("sha256")
          .update(JSON.stringify({ error: "Private pair CODE unavailable" })).digest("hex")) ||
        row.contentType !== "application/json" || !p.digest(row.bodyDigest) || !p.digest(row.pairDigest) || seen.has(key)) refuse();
    if (first) {
      if (!p.digest(row.sourcePairDigest) || consumers.has(row.scope) && consumers.get(row.scope) !== row.pairDigest) refuse();
      consumers.set(row.scope, row.pairDigest);
      if (!refusal) sources.add(row.sourcePairDigest);
      if ((refusal || row.scope === "publicOld") && row.sourcePairDigest !== row.pairDigest) refuse();
    }
    seen.add(key);
  }
  if (first && (sources.size !== 1 || !sources.has(consumers.get("publicOld")) || new Set(consumers.values()).size !== 4)) refuse();
  return value;
}
module.exports = { FIRST_INSTALL_STAGE, CONVERTED_STAGE, cmsReaderBridgeStage, cmsReaderBridgeProofKey, parseInstalledCmsReaderProof };
