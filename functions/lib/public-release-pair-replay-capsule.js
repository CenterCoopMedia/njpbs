"use strict";
const { createHash } = require("node:crypto");
const protocol = require("./public-release-pair");
const work = require("./public-release-pair-work");
const history = require("./public-release-pair-replay-history");
const { exact, digest, positive, publicReleaseDigest: hash } = protocol;
const CHUNK_BYTES = 192 * 1024;
class ReplayCapsuleError extends Error {
  constructor(code = "replay-capsule-invalid") {
    super(code);
    this.name = "ReplayCapsuleError";
    this.code = code;
  }
}
function refuse(code) {
  throw new ReplayCapsuleError(code);
}
function same(a, b) {
  return hash(a) === hash(b);
}
function base(pair) {
  return work.publicReleasePairPath(pair.pairId);
}
/** The outside-transaction verifier uses actual database reads. It cannot write
 * or accidentally open one lifetime transaction through the existing guards. */
function outsideReplayRead(firestore) {
  return Object.freeze({ get: (ref) => ref.get(), getAll: (...refs) => firestore.getAll(...refs) });
}
async function writeReplayImmutable(firestore, path, value) {
  const ref = firestore.doc(path);
  try {
    await ref.create(value);
  } catch (error) {
    const row = await ref.get();
    if (!row.exists) throw error;
    if (!same(row.data(), value)) refuse("replay-immutable-conflict");
  }
}
function checkpointState(checkpoint) {
  return {
    pairBaselineDigest: checkpoint.pairBaselineDigest,
    cursor: checkpoint.cursor,
    history: checkpoint.history,
    coveredMembersDigest: checkpoint.coveredMembersDigest,
    contentViewDigest: checkpoint.contentViewDigest,
    codePackOverlayDigest: checkpoint.codePackOverlayDigest,
  };
}
function parseReplayCapsule(value) {
  exact(value, ["pageIndex", "pageDigest", "prevCapsuleDigest", "coveredEvidenceDigest", "verifiedAt"]);
  if (
    !Number.isSafeInteger(value.pageIndex) ||
    value.pageIndex < 0 ||
    !digest(value.pageDigest) ||
    !digest(value.coveredEvidenceDigest) ||
    !positive(value.verifiedAt) ||
    (value.pageIndex === 0 ? value.prevCapsuleDigest !== null : !digest(value.prevCapsuleDigest))
  )
    refuse();
  return value;
}
function parseReplayCapsuleEvidence(value, pair) {
  exact(value, [
    "schemaVersion",
    "pairDigest",
    "logBaselineDigest",
    "priorStateDigest",
    "state",
    "codePackView",
    "lastView",
    "lastViewProofDigest",
    "verifiedViewProofsDigest",
    "namespaceProof",
  ]);
  exact(value.state, [
    "pairBaselineDigest",
    "cursor",
    "history",
    "coveredMembersDigest",
    "contentViewDigest",
    "codePackOverlayDigest",
  ]);
  const state = value.state;
  const parsed = history.parseReplayHistoryDescriptor(state.history, pair);
  if (
    value.schemaVersion !== 2 ||
    value.pairDigest !== hash(pair) ||
    !digest(value.logBaselineDigest) ||
    !digest(value.lastViewProofDigest) ||
    !digest(value.verifiedViewProofsDigest) ||
    !(value.priorStateDigest === null || digest(value.priorStateDigest)) ||
    ![state.pairBaselineDigest, state.coveredMembersDigest, state.contentViewDigest, state.codePackOverlayDigest].every(
      digest,
    ) ||
    !same(state.cursor, parsed.headCursor)
  )
    refuse();
  parseReplayNamespaceProofDescriptor(value.namespaceProof, pair);
  return value;
}
async function readReplayCapsule({ firestore, transaction, pair, capsuleDigest, accepted = false }) {
  if (!digest(capsuleDigest)) refuse();
  const row = await transaction.get(firestore.doc(`${base(pair)}/replayCapsules/${capsuleDigest}`));
  const capsule = parseReplayCapsule(row.data());
  if (hash(capsule) !== capsuleDigest) refuse();
  const evidenceRow = await transaction.get(
    firestore.doc(`${base(pair)}/replayCapsuleEvidence/${capsule.coveredEvidenceDigest}`),
  );
  const evidence = parseReplayCapsuleEvidence(evidenceRow.data(), pair);
  if (
    hash(evidence) !== capsule.coveredEvidenceDigest ||
    evidence.state.history.pageCount !== capsule.pageIndex ||
    (capsule.pageIndex === 0 &&
      (capsule.pageDigest !== evidence.state.pairBaselineDigest || evidence.priorStateDigest !== null))
  )
    refuse();
  if (accepted) {
    const index = await transaction.get(firestore.doc(`${base(pair)}/replayCapsuleIndexes/${capsule.pageIndex}`));
    if (!same(index.data(), { schemaVersion: 2, pairDigest: hash(pair), pageIndex: capsule.pageIndex, capsuleDigest }))
      refuse();
  }
  return { capsule, evidence, capsuleDigest };
}
async function readReplayPageCapsule(options) {
  const { firestore, transaction, pair, pageDigest } = options;
  const row = await transaction.get(firestore.doc(`${base(pair)}/replayPageCapsules/${pageDigest}`));
  exact(row.data(), ["capsuleDigest"]);
  const result = await readReplayCapsule({ ...options, capsuleDigest: row.data().capsuleDigest });
  if (result.capsule.pageDigest !== pageDigest) refuse();
  return result;
}
async function prepareReplayCapsule({
  firestore,
  pair,
  pageIndex,
  pageDigest,
  prevCapsuleDigest,
  evidence: raw,
  verifiedAt = Date.now(),
}) {
  const evidence = parseReplayCapsuleEvidence(raw, pair),
    coveredEvidenceDigest = hash(evidence);
  await writeReplayImmutable(firestore, `${base(pair)}/replayCapsuleEvidence/${coveredEvidenceDigest}`, evidence);
  const proposed = parseReplayCapsule({ pageIndex, pageDigest, prevCapsuleDigest, coveredEvidenceDigest, verifiedAt });
  const proposedDigest = hash(proposed),
    mapping = firestore.doc(`${base(pair)}/replayPageCapsules/${pageDigest}`);
  if (!(await mapping.get()).exists) {
    await writeReplayImmutable(firestore, `${base(pair)}/replayCapsules/${proposedDigest}`, proposed);
    try {
      await mapping.create({ capsuleDigest: proposedDigest });
    } catch (error) {
      if (!(await mapping.get()).exists) throw error;
    }
  }
  const stored = await readReplayPageCapsule({
    firestore,
    transaction: outsideReplayRead(firestore),
    pair,
    pageDigest,
  });
  if (
    stored.capsule.pageIndex !== pageIndex ||
    stored.capsule.prevCapsuleDigest !== prevCapsuleDigest ||
    stored.capsule.coveredEvidenceDigest !== coveredEvidenceDigest
  )
    refuse("replay-capsule-conflict");
  return stored;
}
/** Membership is accepted atomically with the cursor. An abandoned prepared
 * tail page cannot reserve its views against a longer page on the next wake. */
async function prepareReplayCoveredViews({
  firestore,
  transaction,
  pair,
  pairBaselineDigest,
  references,
  pageIndex,
  capsuleDigest,
}) {
  const unique = new Map(references.map((reference) => [hash(reference), reference]));
  if (
    !unique.size ||
    unique.size > 101 ||
    !digest(pairBaselineDigest) ||
    !digest(capsuleDigest) ||
    !Number.isSafeInteger(pageIndex) ||
    pageIndex < 0
  )
    refuse();
  const entries = [...unique],
    refs = entries.map(([id]) => firestore.doc(`${base(pair)}/replayCoveredViews/${id}`));
  const rows = await transaction.getAll(...refs);
  const values = entries.map(([, reference]) => ({
    schemaVersion: 2,
    pairDigest: hash(pair),
    pairBaselineDigest,
    reference,
    pageIndex,
    capsuleDigest,
  }));
  for (const [index, row] of rows.entries())
    if (row.exists && !same(row.data(), values[index])) refuse("replay-capsule-conflict");
  return () => {
    for (const [index, ref] of refs.entries()) if (!rows[index].exists) transaction.create(ref, values[index]);
  };
}
async function prepareReplayCapsuleIndex({ firestore, transaction, pair, capsuleDigest, pageIndex }) {
  const ref = firestore.doc(`${base(pair)}/replayCapsuleIndexes/${pageIndex}`),
    row = await transaction.get(ref);
  const value = { schemaVersion: 2, pairDigest: hash(pair), pageIndex, capsuleDigest };
  if (row.exists && !same(row.data(), value)) refuse("replay-capsule-conflict");
  return () => {
    if (!row.exists) transaction.create(ref, value);
  };
}
async function writeReplayNamespaceProof({ firestore, pair, namespaces }) {
  const bytes = Buffer.from(JSON.stringify(namespaces));
  let previous = null,
    chunkCount = 0;
  for (let start = 0; start < bytes.length; start += CHUNK_BYTES) {
    const chunk = {
      schemaVersion: 2,
      pairDigest: hash(pair),
      index: chunkCount,
      prevChunkDigest: previous,
      body: bytes.subarray(start, start + CHUNK_BYTES).toString("base64"),
    };
    const digest = hash(chunk);
    await writeReplayImmutable(firestore, `${base(pair)}/replayNamespaceChunks/${digest}`, chunk);
    previous = digest;
    chunkCount++;
  }
  return {
    schemaVersion: 2,
    pairDigest: hash(pair),
    payloadDigest: hash(namespaces),
    bodyDigest: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    chunkCount,
    tailDigest: previous,
  };
}
function parseReplayNamespaceProofDescriptor(descriptor, pair) {
  exact(descriptor, [
    "schemaVersion",
    "pairDigest",
    "payloadDigest",
    "bodyDigest",
    "bytes",
    "chunkCount",
    "tailDigest",
  ]);
  if (
    descriptor.schemaVersion !== 2 ||
    descriptor.pairDigest !== hash(pair) ||
    ![descriptor.payloadDigest, descriptor.bodyDigest, descriptor.tailDigest].every(digest) ||
    !positive(descriptor.bytes) ||
    !positive(descriptor.chunkCount) ||
    descriptor.chunkCount !== Math.ceil(descriptor.bytes / CHUNK_BYTES)
  )
    refuse();
  return descriptor;
}
async function readReplayNamespaceProof({ firestore, pair, descriptor: raw }) {
  const descriptor = parseReplayNamespaceProofDescriptor(raw, pair);
  const chunks = [];
  let next = descriptor.tailDigest;
  for (let index = descriptor.chunkCount - 1; index >= 0; index--) {
    const row = await firestore.doc(`${base(pair)}/replayNamespaceChunks/${next}`).get(),
      chunk = row.data();
    exact(chunk, ["schemaVersion", "pairDigest", "index", "prevChunkDigest", "body"]);
    if (
      hash(chunk) !== next ||
      chunk.schemaVersion !== 2 ||
      chunk.pairDigest !== hash(pair) ||
      chunk.index !== index ||
      typeof chunk.body !== "string" ||
      (index === 0 ? chunk.prevChunkDigest !== null : !digest(chunk.prevChunkDigest))
    )
      refuse();
    const body = Buffer.from(chunk.body, "base64"),
      expected = index === descriptor.chunkCount - 1 ? descriptor.bytes - index * CHUNK_BYTES : CHUNK_BYTES;
    if (body.toString("base64") !== chunk.body || body.length !== expected) refuse();
    chunks.push(body);
    next = chunk.prevChunkDigest;
  }
  const bytes = Buffer.concat(chunks.reverse());
  if (createHash("sha256").update(bytes).digest("hex") !== descriptor.bodyDigest) refuse();
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!Array.isArray(value) || hash(value) !== descriptor.payloadDigest) refuse();
  return value;
}
module.exports = {
  ReplayCapsuleError,
  outsideReplayRead,
  writeReplayImmutable,
  checkpointState,
  parseReplayCapsule,
  parseReplayCapsuleEvidence,
  readReplayCapsule,
  readReplayPageCapsule,
  prepareReplayCapsule,
  prepareReplayCapsuleIndex,
  prepareReplayCoveredViews,
  writeReplayNamespaceProof,
  readReplayNamespaceProof,
  parseReplayNamespaceProofDescriptor,
};
