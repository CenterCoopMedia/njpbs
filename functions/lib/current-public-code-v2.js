"use strict";

const { createHash } = require("node:crypto");
const p = require("./public-release-pair");
const code = require("./public-release-pair-code-reference");
const { assertPublicationTarget } = require("./publication-target");
const MAX_BYTES = 20 * 1024 * 1024;
const WIRE_BYTES = Math.ceil(MAX_BYTES / 3) * 4 + 64 * 1024;
function refuse() { throw Object.assign(new Error("Versioned current CODE is unavailable"), { status: 409 }); }
function refreshing() { throw Object.assign(new Error("Paired editorial source is refreshing"), { code: "pair_editorial_context_refreshing" }); }
const same = (a, b) => p.publicReleaseDigest(a) === p.publicReleaseDigest(b);
const hash = value => createHash("sha256").update(value).digest("hex");

function parsePairCodeSelection(value) {
  p.exact(value, ["pair", "expectedPublicSelectorDigest", "previewPairId", "previewCandidateReceiptId"]);
  const pair = p.parsePublicReleasePairReference(value.pair);
  if (!p.digest(value.expectedPublicSelectorDigest) || typeof value.previewPairId !== "string" ||
      !/^preview-[a-z0-9][a-z0-9-]{0,31}$/.test(value.previewPairId) || value.previewCandidateReceiptId !== null &&
      (typeof value.previewCandidateReceiptId !== "string" || !/^renderer-[0-9]{1,20}-[0-9]{1,4}$/.test(value.previewCandidateReceiptId))) refuse();
  return p.freeze({ ...value, pair });
}
function parsePairCodeRequest(value) {
  p.exact(value, ["schemaVersion", "mode", "rendererSha", "selection"]);
  if (value.schemaVersion !== 2 || !["current-code-v2", "current-code-reference-v2", "current-editorial-v2", "current-editorial-reference-v2"].includes(value.mode) ||
      typeof value.rendererSha !== "string" || !/^[a-f0-9]{40}$/.test(value.rendererSha)) refuse();
  return { ...value, selection: parsePairCodeSelection(value.selection) };
}
function verifyQualified(value) {
  const reference = require("./current-public-code-source").validateCurrentCodeReference(value?.reference);
  if (!same(value.publication, reference.publication) || !value.publicContext ||
      ["buildBatchId", "generation", "commitSha", "mediaManifestDigest"].some(key =>
        value.publicContext.receipt?.[key] !== value.publication[key])) refuse();
  return value;
}
function createPairCurrentCodeTransport({ target, rendererSha, pairSelection, request = fetch, readSecret }) {
  target = assertPublicationTarget(target);
  const selection = parsePairCodeSelection(pairSelection);
  parsePairCodeRequest({ schemaVersion: 2, mode: "current-code-v2", rendererSha, selection });
  if ((process.env.FUNCTIONS_EMULATOR === "true" || process.env.FIRESTORE_EMULATOR_HOST) && request === fetch) refuse();
  const origin = target.environment === "development" ? "https://dev-api.example.org" : "https://api.example.org";
  async function read(mode) {
    const secret = readSecret?.(); if (typeof secret !== "string" || !secret || /[\r\n]/.test(secret)) refuse();
    let response;
    try { response = await request(`${origin}/_internal/record-code`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { "content-type": "application/json", "x-njpbs-cms-edge": secret },
      body: JSON.stringify({ schemaVersion: 2, mode, rendererSha, selection }) }); }
    catch (error) {
      if (mode.startsWith("current-editorial") && ["TimeoutError", "AbortError"].includes(error?.name)) refreshing();
      refuse();
    }
    if (!response.ok || !response.body || !response.headers.get("content-type")?.startsWith("application/json")) {
      if (mode.startsWith("current-editorial") && response.status === 503 && response.body && response.headers.get("content-type")?.startsWith("application/json")) {
        const reader = response.body.getReader(); let length = 0; const chunks = [];
        try { for (;;) { const row = await reader.read(); if (row.done) break;
          length += row.value.length; if (length > 4096) refuse(); chunks.push(row.value); }
        } finally { await reader.cancel(); }
        if (JSON.parse(Buffer.concat(chunks, length).toString("utf8"))?.code === "pair_editorial_context_refreshing") refreshing();
      } else await response.body?.cancel();
      refuse();
    }
    const reader = response.body.getReader(), chunks = []; let length = 0;
    try { for (;;) { const row = await reader.read(); if (row.done) break;
      length += row.value.length; if (length > (mode.includes("reference") ? 64 * 1024 : WIRE_BYTES)) refuse(); chunks.push(row.value); }
    } finally { await reader.cancel(); }
    const result = JSON.parse(Buffer.concat(chunks, length).toString("utf8")), reference = result?.reference;
    if (mode.startsWith("current-editorial")) {
      p.exact(reference, ["schemaVersion", "kind", "rendererSha", "selection", "pairDigest", "readerDigests", "contentHead", "manifest"]);
      p.exact(reference.readerDigests, ["functions", "cmsApi"]);
      const manifest = reference.manifest;
      // The registered pair is not sent by a client. Validate its full digest
      // and wire shape here; the server binds it to the selected physical G.
      p.exact(manifest, ["schemaVersion", "kind", "pairDigest", "identity", "claimDigest", "viewManifestDigest", "cursor", "bodyDigest", "bodyBytes", "chunks"]);
      p.exact(reference.contentHead, ["pairId", "viewId", "manifestDigest", "contextSequence"]);
      p.exact(manifest.identity, ["schemaVersion", "pair", "kind", "sourceOperationId", "sourceVersion", "snapshotDigest", "contextSequence", "inputManifestDigest"]);
      require("./public-release-pair-view").parsePublicReleasePairViewCursor(manifest.cursor, manifest.identity);
      const identifier = require("./public-deployment-pointer").isPublicDeploymentIdentifier;
      if (result.schemaVersion !== 2 || reference.schemaVersion !== 2 || reference.kind !== "pair-current-editorial" ||
          reference.rendererSha !== rendererSha || !same(parsePairCodeSelection(reference.selection), selection) || !p.digest(reference.pairDigest) ||
          Object.values(reference.readerDigests).some(value => !p.digest(value)) || manifest.schemaVersion !== 2 ||
          manifest.kind !== "pair-editorial-context-manifest" || manifest.pairDigest !== reference.pairDigest || !p.digest(manifest.bodyDigest) ||
          !p.digest(manifest.viewManifestDigest) || !p.digest(manifest.claimDigest) || !Number.isSafeInteger(manifest.bodyBytes) || manifest.bodyBytes < 1 || manifest.bodyBytes > MAX_BYTES ||
          !Array.isArray(manifest.chunks) || manifest.chunks.length !== Math.ceil(manifest.bodyBytes / (400 * 1024)) || manifest.chunks.some(value => !p.digest(value)) ||
          reference.contentHead?.pairId !== selection.pair.pairId || reference.contentHead?.contextSequence !== manifest.cursor?.sequence ||
          !identifier(reference.contentHead.viewId) || !p.digest(reference.contentHead.manifestDigest) ||
          manifest.identity.schemaVersion !== 2 || !["accepted", "qualification", "recovery"].includes(manifest.identity.kind) ||
          !identifier(manifest.identity.sourceOperationId) || !p.positive(manifest.identity.sourceVersion) || !p.digest(manifest.identity.snapshotDigest) ||
          !p.digest(manifest.identity.inputManifestDigest) || !Number.isSafeInteger(manifest.identity.contextSequence) || manifest.identity.contextSequence < 0 ||
          !same(p.parsePublicReleasePairReference(manifest.identity.pair), selection.pair) || manifest.identity.contextSequence !== manifest.cursor.sequence) refuse();
      if (mode === "current-editorial-reference-v2") {
        p.exact(result, ["schemaVersion", "kind", "reference"]);
        if (result.kind !== "pair-current-editorial-reference") refuse();
        return { reference };
      }
      p.exact(result, ["schemaVersion", "kind", "reference", "sourceBase64"]);
      if (result.kind !== "pair-current-editorial" || typeof result.sourceBase64 !== "string") refuse();
      const bytes = Buffer.from(result.sourceBase64, "base64");
      if (bytes.length !== manifest.bodyBytes || bytes.toString("base64") !== result.sourceBase64 || hash(bytes) !== manifest.bodyDigest) refuse();
      const source = JSON.parse(bytes.toString("utf8"));
      p.exact(source, ["schemaVersion", "kind", "pair", "pairDigest", "identity", "claimDigest", "viewManifestDigest", "cursor", "renderedAt", "sourcePair", "originalCode", "documents", "homeSources"]);
      p.exact(source.originalCode, ["reference", "qualifiedCodeDigest", ...(Object.hasOwn(source.originalCode ?? {}, "programImageDescriptors") ? ["programImageDescriptors"] : [])]);
      const original = require("./current-public-code-source").validateCurrentCodeReference(source.originalCode.reference);
      const originalPair = p.parsePublicReleasePairReference(source.sourcePair);
      if (source?.schemaVersion !== 2 || source.kind !== "pair-editorial-context-source" || !same(source.pair, selection.pair) ||
          source.pairDigest !== reference.pairDigest || !same(source.identity, manifest.identity) || source.claimDigest !== manifest.claimDigest ||
          source.viewManifestDigest !== manifest.viewManifestDigest || !same(source.cursor, manifest.cursor) || !p.digest(source.originalCode.qualifiedCodeDigest) ||
          original.publication.commitSha !== originalPair.commitSha || source.homeSources?.publication?.commitSha !== originalPair.commitSha ||
          typeof source.renderedAt !== "string" || !Number.isFinite(Date.parse(source.renderedAt)) || new Date(source.renderedAt).toISOString() !== source.renderedAt ||
          !Array.isArray(source.documents) || source.documents.length > 20_000) refuse();
      let previous = "";
      for (const row of source.documents) {
        p.exact(row, ["path", "data"]);
        if (typeof row.path !== "string" || row.path <= previous ||
            !/^(?:cmsPages|cmsPosts|cmsAuthorProfilesPublic|cmsSettings|media_assets_public|cmsVersionHistory)\/[A-Za-z0-9_.:-]+(?:\/[A-Za-z0-9_.:-]+\/[A-Za-z0-9_.:-]+)*$/.test(row.path) ||
            !row.data || typeof row.data !== "object" || Array.isArray(row.data)) refuse();
        previous = row.path;
      }
      return { reference, source };
    }
    p.exact(reference, ["schemaVersion", "kind", "rendererSha", "selection", "source", "pairDigest", "readerDigests", "qualifiedCodeDigest", "qualifiedCodeBytes"]);
    const source = code.parsePairCodeReference(reference.source);
    p.exact(reference.readerDigests, ["functions", "cmsApi"]);
    if (result.schemaVersion !== 2 || reference.schemaVersion !== 2 || reference.kind !== "pair-current-code" ||
        reference.rendererSha !== rendererSha || !same(parsePairCodeSelection(reference.selection), selection) ||
        !same(source.side, selection.pair) || !p.digest(reference.pairDigest) || !p.digest(reference.qualifiedCodeDigest) ||
        Object.values(reference.readerDigests).some(value => !p.digest(value)) ||
        !Number.isSafeInteger(reference.qualifiedCodeBytes) || reference.qualifiedCodeBytes < 1 || reference.qualifiedCodeBytes > MAX_BYTES) refuse();
    if (mode === "current-code-reference-v2") {
      p.exact(result, ["schemaVersion", "kind", "reference"]);
      if (result.kind !== "pair-current-code-reference") refuse();
      return { reference };
    }
    p.exact(result, ["schemaVersion", "kind", "reference", "qualifiedCodeBase64"]);
    if (result.kind !== "pair-current-code" || typeof result.qualifiedCodeBase64 !== "string") refuse();
    const bytes = Buffer.from(result.qualifiedCodeBase64, "base64");
    if (bytes.length !== reference.qualifiedCodeBytes || bytes.toString("base64") !== result.qualifiedCodeBase64 || hash(bytes) !== reference.qualifiedCodeDigest) refuse();
    const qualifiedCode = verifyQualified(JSON.parse(bytes.toString("utf8")));
    if (qualifiedCode.publication.commitSha !== source.commitSha) refuse();
    return { reference, qualifiedCode };
  }
  const safeRead = async mode => { try { return await read(mode); } catch (error) {
    if (error?.code === "pair_editorial_context_refreshing" || mode.startsWith("current-editorial") &&
        ["TimeoutError", "AbortError"].includes(error?.name)) refreshing();
    refuse();
  } };
  return { async readPairCodeReference() { return (await safeRead("current-code-reference-v2")).reference; },
    readPairCodeContext: () => safeRead("current-code-v2"),
    async readPairEditorialReference() { return (await safeRead("current-editorial-reference-v2")).reference; },
    readPairEditorialContext: () => safeRead("current-editorial-v2") };
}

module.exports = { MAX_BYTES, WIRE_BYTES, parsePairCodeSelection, parsePairCodeRequest, createPairCurrentCodeTransport };
