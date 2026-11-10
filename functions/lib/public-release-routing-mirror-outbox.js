"use strict";
const { randomUUID } = require("node:crypto");
const p = require("./public-release-pair");
const work = require("./public-release-pair-work");
const { assertPublicationDatabase, publicationTarget } = require("./publication-target");
const ROOT = "system/publicReleaseRoutingMirrors";
const fail = () => { throw new p.PublicReleaseProtocolError(); };
const same = (a, b) => p.publicReleaseDigest(a) === p.publicReleaseDigest(b);
function request(value) {
  p.exact(value, ["schemaVersion", "environment", "operationId", "minimumSequence", "entryDigest", "pairRefs", "withdrawal"]);
  if (value.schemaVersion !== 1 || !["production", "development"].includes(value.environment) ||
      !require("./public-deployment-pointer").isPublicDeploymentIdentifier(value.operationId) || !Number.isSafeInteger(value.minimumSequence) || value.minimumSequence < 1 ||
      !p.digest(value.entryDigest) || typeof value.withdrawal !== "boolean" || !Array.isArray(value.pairRefs) || value.pairRefs.length !== 2) fail();
  const pairRefs = value.pairRefs.map(p.parsePublicReleasePairReference);
  if (pairRefs[0].pairId === pairRefs[1].pairId) fail();
  return p.freeze({ ...value, pairRefs });
}
function reference(value) {
  const parsed = request(value), requestDigest = p.publicReleaseDigest(parsed);
  return { requestId: requestDigest, requestDigest, withdrawal: parsed.withdrawal };
}
function job(value, digest) {
  p.exact(value, ["schemaVersion", "requestDigest", "state", "attempts", "nextAttemptAt", "leaseToken", "leaseUntil", "resultDigest", "lastFailure"]);
  if (value.schemaVersion !== 1 || value.requestDigest !== digest || !["pending", "running", "done"].includes(value.state) ||
      !Number.isSafeInteger(value.attempts) || value.attempts < 0 || !Number.isSafeInteger(value.nextAttemptAt) || value.nextAttemptAt < 0 ||
      !Number.isSafeInteger(value.leaseUntil) || value.leaseUntil < 0 ||
      (value.state === "running" ? !/^[a-f0-9-]{36}$/.test(value.leaseToken ?? "") : value.leaseToken !== null) ||
      (value.state === "done" ? !p.digest(value.resultDigest) : value.resultDigest !== null) ||
      ![null, "mirror-unavailable"].includes(value.lastFailure)) fail();
  return value;
}
/** Read before source writes; invoke this closure with the actual log commit.
 * No storage/provider I/O occurs inside the caller's original transaction. */
async function preparePublicReleaseRoutingMirrorOutboxInTransaction({ firestore, transaction, operationId, minimumSequence,
  entryDigest, pairRefs, environment, withdrawal }) {
  assertPublicationDatabase(firestore, publicationTarget(environment));
  const value = request({ schemaVersion: 1, operationId, minimumSequence, entryDigest, pairRefs, environment, withdrawal });
  const ref = reference(value), requestRef = firestore.doc(`${ROOT}/requests/${ref.requestId}`), jobRef = firestore.doc(`${ROOT}/jobs/${ref.requestId}`);
  const [prior, pending] = await transaction.getAll(requestRef, jobRef);
  if (prior.exists !== pending.exists || prior.exists && (!same(prior.data(), value) || !job(pending.data(), ref.requestDigest))) fail();
  const write = () => {
    if (!prior.exists) {
      transaction.create(requestRef, value);
      transaction.create(jobRef, { schemaVersion: 1, requestDigest: ref.requestDigest, state: "pending", attempts: 0,
        nextAttemptAt: 0, leaseToken: null, leaseUntil: 0, resultDigest: null, lastFailure: null });
    }
    return ref;
  };
  return Object.freeze(Object.assign(write, ref));
}
/** A single leased attempt. Failures retain durable retry state; they never
 * replay the public mutation. Result is advisory mirror evidence only. */
async function drainPublicReleaseRoutingMirrorOutbox({ firestore, store, requestId, fallbackPaths = [], now = Date.now, signal,
  sync }) {
  if (!p.digest(requestId) || typeof sync !== "function") fail(); signal?.throwIfAborted();
  const requestRef = firestore.doc(`${ROOT}/requests/${requestId}`), jobRef = firestore.doc(`${ROOT}/jobs/${requestId}`);
  const receiptRef = firestore.doc(`${ROOT}/receipts/${requestId}`), leaseToken = randomUUID();
  const claim = await firestore.runTransaction(async tx => {
    const [source, row, receipt] = await tx.getAll(requestRef, jobRef, receiptRef);
    const input = request(source.data()), state = job(row.data(), requestId);
    assertPublicationDatabase(firestore, publicationTarget(input.environment));
    if (p.publicReleaseDigest(input) !== requestId) fail();
    if (state.state === "done") {
      if (!receipt.exists || p.publicReleaseDigest(receipt.data()) !== state.resultDigest || receipt.data().requestDigest !== requestId) fail();
      return { done: true, receipt: receipt.data() };
    }
    if (state.state === "running" && state.leaseUntil > now() || state.nextAttemptAt > now()) return null;
    signal?.throwIfAborted();
    tx.set(jobRef, { ...state, state: "running", attempts: state.attempts + 1, leaseToken, leaseUntil: now() + 60_000, nextAttemptAt: now() + 60_000 });
    return { input, attempts: state.attempts + 1 };
  });
  if (!claim) return { state: "pending", requestId };
  if (claim.done) return { state: "done", requestId, receipt: claim.receipt };
  let result;
  try {
    signal?.throwIfAborted();
    const rows = await firestore.getAll(...claim.input.pairRefs.map(pair => firestore.doc(work.publicReleasePairPath(pair.pairId))));
    const pairs = rows.map((row, index) => { const pair = p.parsePublicReleasePair(row.data());
      if (!same(p.publicReleasePairReference(pair), claim.input.pairRefs[index]) || pair.environment !== claim.input.environment) fail(); return pair; });
    result = await sync({ firestore, store, pairs, operationId: claim.input.operationId,
      minimumSequence: claim.input.minimumSequence, fallbackPaths, dryRun: false, signal });
    if (!result || result.dryRun !== false || result.operationId !== claim.input.operationId ||
        !Number.isSafeInteger(result.sequence) || result.sequence < claim.input.minimumSequence ||
        !Array.isArray(result.pairs) || result.pairs.length !== pairs.length) fail();
    for (const [index, pair] of pairs.entries()) if (result.pairs[index].pairDigest !== p.publicReleaseDigest(pair)) fail();
    // This is advisory mirror completion, not publication success. Positive
    // gaps remain in the receipt and the runner reconciles them independently;
    // keeping every source job due would create an unbounded retry backlog.
  } catch {
    await firestore.runTransaction(async tx => {
      const state = job((await tx.get(jobRef)).data(), requestId);
      if (state.state !== "running" || state.leaseToken !== leaseToken) return;
      tx.set(jobRef, { ...state, state: "pending", leaseToken: null, leaseUntil: 0,
        nextAttemptAt: now() + Math.min(30_000, 1_000 * 2 ** Math.min(state.attempts, 5)), lastFailure: "mirror-unavailable" });
    });
    return { state: "pending", requestId };
  }
  const receipt = { schemaVersion: 1, requestDigest: requestId, result };
  const completed = await firestore.runTransaction(async tx => {
    const [row, prior] = await tx.getAll(jobRef, receiptRef), state = job(row.data(), requestId);
    // Expiry permits reclamation; only an actual new token revokes this
    // result. Slow real storage work can finish after its initial lease.
    if (state.state !== "running" || state.leaseToken !== leaseToken) return false;
    if (prior.exists && !same(prior.data(), receipt)) fail();
    if (!prior.exists) tx.create(receiptRef, receipt);
    tx.set(jobRef, { ...state, state: "done", leaseToken: null, leaseUntil: 0,
      resultDigest: p.publicReleaseDigest(receipt), nextAttemptAt: Number.MAX_SAFE_INTEGER, lastFailure: null }); return true;
  });
  return completed ? { state: "done", requestId, receipt } : { state: "pending", requestId };
}
/** Withdrawals may report pending after a short bound, but cannot ACK success
 * until the durable mirror job is done. New/update ACKs never await this. */
async function flushPublicReleaseRoutingMirrorWithdrawal(input) {
  const budgetMs = input.budgetMs ?? 2_000;
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 3_000) fail();
  const controller = new AbortController(), pending = { state: "pending", requestId: input.requestId };
  let timer;
  try {
    return await Promise.race([
      drainPublicReleaseRoutingMirrorOutbox({ ...input, signal: controller.signal }).catch(() => pending),
      new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(pending); }, budgetMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
/** Bounded durable polling; expired running leases share the same indexed
 * due-time field as pending work. Completed jobs are never selected again. */
async function drainDuePublicReleaseRoutingMirrorOutbox(input) {
  const { firestore, environment, now = Date.now, limit = 10, signal } = input;
  assertPublicationDatabase(firestore, publicationTarget(environment));
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20 || typeof input.sync !== "function") fail();
  signal?.throwIfAborted();
  const rows = await firestore.collection(`${ROOT}/jobs`).where("nextAttemptAt", "<=", now()).limit(limit).get();
  const results = [];
  for (const row of rows.docs) {
    signal?.throwIfAborted();
    results.push(await drainPublicReleaseRoutingMirrorOutbox({ ...input, requestId: row.id }));
  }
  return { results, fullBatch: rows.size === limit };
}
module.exports = { preparePublicReleaseRoutingMirrorOutboxInTransaction, drainPublicReleaseRoutingMirrorOutbox,
  flushPublicReleaseRoutingMirrorWithdrawal, drainDuePublicReleaseRoutingMirrorOutbox };
