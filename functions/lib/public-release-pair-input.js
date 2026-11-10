"use strict";

const { isPublicDeploymentIdentifier } = require("./public-deployment-pointer");
const { parsePublicReleasePair, publicReleasePairReference, PublicReleaseProtocolError, publicReleaseDigest,
  exact, digest, positive, freeze } = require("./public-release-pair");

const INPUT_ROOT_BYTES_LIMIT = 8 * 1024 * 1024;
const INPUT_FILE_BYTES_LIMIT = 16 * 1024 * 1024;
const INPUT_FILE_LIMIT = 10_000;
const INPUT_TOTAL_BYTES_LIMIT = 100 * 1024 ** 3;
function refuse() { throw new PublicReleaseProtocolError(); }
function fileName(value) {
  return typeof value === "string" && value.length <= 256 &&
    /^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*\.json$/.test(value) &&
    value.split("/").every(part => ![".", ".."].includes(part));
}
function parsePublicReleasePairInputScope(value) {
  exact(value, ["kind", "sourceOperationId", "sourceVersion", "snapshotDigest", "contextSequence"]);
  if (!["accepted", "qualification", "recovery"].includes(value.kind) ||
      !isPublicDeploymentIdentifier(value.sourceOperationId) || !positive(value.sourceVersion) ||
      !digest(value.snapshotDigest) || !Number.isSafeInteger(value.contextSequence) || value.contextSequence < 0) refuse();
  return Object.freeze({ kind: value.kind, sourceOperationId: value.sourceOperationId, sourceVersion: value.sourceVersion,
    snapshotDigest: value.snapshotDigest, contextSequence: value.contextSequence });
}
function parsePublicReleasePairInputSource(value) {
  exact(value, ["kind", "id"]);
  if (!["post", "page", "record", "settings", "library", "media", "author", "provider", "schedule", "dataHub", "inventory"].includes(value.kind) ||
      !isPublicDeploymentIdentifier(value.id)) refuse();
  return Object.freeze({ kind: value.kind, id: value.id });
}
function publicReleasePairInputPrefix(rawPair) {
  const pair = parsePublicReleasePair(rawPair);
  return `release-pair-inputs/v2/${pair.pairId}/`;
}
function publicReleasePairInputObjectKey(pair, bodyDigest) {
  if (!digest(bodyDigest)) refuse();
  return `${publicReleasePairInputPrefix(pair)}objects/${bodyDigest}.json`;
}
function publicReleasePairInputRootKey(pair, manifestDigest) {
  if (!digest(manifestDigest)) refuse();
  return `${publicReleasePairInputPrefix(pair)}manifests/${manifestDigest}.json`;
}
function publicReleasePairInputScopeKey(rawPair, rawScope) {
  const pair = parsePublicReleasePair(rawPair), scope = parsePublicReleasePairInputScope(rawScope);
  return publicReleaseDigest({ schemaVersion: 2, pair: publicReleasePairReference(pair), ...scope });
}
function parsePublicReleasePairInputSlot(value, rawPair, rawScope, inputManifestDigest) {
  const pair = parsePublicReleasePair(rawPair), scope = parsePublicReleasePairInputScope(rawScope);
  exact(value, ["schemaVersion", "pairDigest", "scope", "inputManifestDigest", "receiptDigest"]);
  if (value.schemaVersion !== 2 || value.pairDigest !== publicReleaseDigest(pair) ||
      publicReleaseDigest(parsePublicReleasePairInputScope(value.scope)) !== publicReleaseDigest(scope) ||
      !digest(inputManifestDigest) || value.inputManifestDigest !== inputManifestDigest || !digest(value.receiptDigest)) refuse();
  return freeze({ ...value, scope });
}
function parsePublicReleasePairInputRoot(value, rawPair) {
  const pair = parsePublicReleasePair(rawPair);
  exact(value, ["schemaVersion", "kind", "pairDigest", "source", "scope", "cursor", "snapshotFile", "entryFiles", "files"]);
  const source = parsePublicReleasePairInputSource(value.source);
  const scope = parsePublicReleasePairInputScope(value.scope);
  exact(value.cursor, ["baselineDigest", "sequence", "lastDigest"]);
  if (value.schemaVersion !== 2 || value.kind !== "pair-render-input" || value.pairDigest !== publicReleaseDigest(pair) ||
      !digest(value.cursor.baselineDigest) || !digest(value.cursor.lastDigest) || value.cursor.sequence !== scope.contextSequence ||
      value.cursor.sequence === 0 && value.cursor.lastDigest !== value.cursor.baselineDigest ||
      !fileName(value.snapshotFile) || !Array.isArray(value.entryFiles) || value.entryFiles.length < 1 ||
      value.entryFiles.length > INPUT_FILE_LIMIT || !Array.isArray(value.files) ||
      value.files.length < 1 || value.files.length > INPUT_FILE_LIMIT) refuse();
  let total = 0, previous = "";
  const files = value.files.map(file => {
    exact(file, ["name", "digest", "bytes", "objectKey", "dependencies"]);
    if (!fileName(file.name) || file.name <= previous || !digest(file.digest) || !positive(file.bytes) ||
        file.bytes > INPUT_FILE_BYTES_LIMIT || file.objectKey !== publicReleasePairInputObjectKey(pair, file.digest) ||
        !Array.isArray(file.dependencies) || file.dependencies.length > INPUT_FILE_LIMIT || file.dependencies.some((name, index) =>
          !fileName(name) || index > 0 && file.dependencies[index - 1] >= name)) refuse();
    previous = file.name;
    total += file.bytes;
    return { name: file.name, digest: file.digest, bytes: file.bytes, objectKey: file.objectKey, dependencies: [...file.dependencies] };
  });
  if (total > INPUT_TOTAL_BYTES_LIMIT || value.entryFiles.some((name, index) => !fileName(name) ||
      index > 0 && value.entryFiles[index - 1] >= name)) refuse();
  const byName = new Map(files.map(file => [file.name, file]));
  if (byName.get(value.snapshotFile)?.digest !== scope.snapshotDigest ||
      !value.entryFiles.includes(value.snapshotFile) || value.entryFiles.some(name => !byName.has(name)) ||
      files.some(file => file.dependencies.some(name => !byName.has(name)))) refuse();
  const parsed = freeze({ schemaVersion: 2, kind: "pair-render-input", pairDigest: value.pairDigest,
    source, scope, cursor: { baselineDigest: value.cursor.baselineDigest, sequence: value.cursor.sequence, lastDigest: value.cursor.lastDigest },
    snapshotFile: value.snapshotFile, entryFiles: [...value.entryFiles], files });
  if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > INPUT_ROOT_BYTES_LIMIT) refuse();
  const visiting = new Set(), visited = new Set();
  const stack = parsed.entryFiles.map(name => ({ name, exit: false }));
  while (stack.length) {
    const { name, exit } = stack.pop();
    if (exit) { visiting.delete(name); visited.add(name); continue; }
    if (visiting.has(name)) refuse();
    if (visited.has(name)) continue;
    visiting.add(name); stack.push({ name, exit: true });
    for (const child of byName.get(name).dependencies) stack.push({ name: child, exit: false });
  }
  if (visited.size !== files.length) refuse();
  return parsed;
}

function parsePublicReleasePairInputReceipt(value, rawPair, rawScope, inputManifestDigest) {
  const pair = parsePublicReleasePair(rawPair), scope = parsePublicReleasePairInputScope(rawScope);
  exact(value, ["schemaVersion", "status", "pairDigest", "source", "scope", "inputManifestDigest", "manifestKey", "manifestBytes",
    "cursor", "fileCount", "inputBytes", "readbackDigest"]);
  const source = parsePublicReleasePairInputSource(value.source);
  exact(value.cursor, ["baselineDigest", "sequence", "lastDigest"]);
  if (value.schemaVersion !== 2 || value.status !== "captured" || value.pairDigest !== publicReleaseDigest(pair) ||
      publicReleaseDigest(parsePublicReleasePairInputScope(value.scope)) !== publicReleaseDigest(scope) ||
      !digest(inputManifestDigest) || value.inputManifestDigest !== inputManifestDigest ||
      value.manifestKey !== publicReleasePairInputRootKey(pair, inputManifestDigest) ||
      !positive(value.manifestBytes) || value.manifestBytes > INPUT_ROOT_BYTES_LIMIT ||
      !digest(value.cursor.baselineDigest) || !digest(value.cursor.lastDigest) || value.cursor.sequence !== scope.contextSequence ||
      value.cursor.sequence === 0 && value.cursor.lastDigest !== value.cursor.baselineDigest ||
      !positive(value.fileCount) || value.fileCount > INPUT_FILE_LIMIT ||
      !positive(value.inputBytes) || value.inputBytes > INPUT_TOTAL_BYTES_LIMIT || !digest(value.readbackDigest)) refuse();
  return freeze({ ...value, source, scope, cursor: { ...value.cursor } });
}

module.exports = { INPUT_ROOT_BYTES_LIMIT, INPUT_FILE_BYTES_LIMIT, INPUT_FILE_LIMIT, INPUT_TOTAL_BYTES_LIMIT,
  parsePublicReleasePairInputScope, parsePublicReleasePairInputSource, parsePublicReleasePairInputRoot, parsePublicReleasePairInputReceipt,
  publicReleasePairInputPrefix, publicReleasePairInputObjectKey, publicReleasePairInputRootKey,
  publicReleasePairInputScopeKey, parsePublicReleasePairInputSlot };
