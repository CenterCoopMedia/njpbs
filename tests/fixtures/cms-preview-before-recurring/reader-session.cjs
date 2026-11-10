// Regression fixture from aea5ec21d3c4b0622586b809c8a62132a8fc4200:functions/lib/cms-reader-session.js.
// Only the relative import is relocated; keep the legacy behavior intact.
"use strict";

// Inert versioned-reader boundary. An authenticated gateway issues these leases
// and checks them on every versioned request; a lease never replaces staff auth.
// Legacy endpoints remain supported until explicit adoption of this boundary.
const { randomUUID } = require("node:crypto");
const pairs = require("../../../functions/lib/cms-preview-pair");
const { digest, parseReader } = pairs;
const MAX_SESSION_MS = 24 * 60 * 60_000;
const READERS = "cmsReaderSessionWindows";
const SESSIONS = "cmsReaderSessions";
const PAIR_READERS = "cmsPreviewPairReaderWindows";
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
function readerSessionDigest(reader) {
  parseReader(reader);
  // Freshness changes are not new endpoint identities and cannot renew leases.
  const identity = { ...reader };
  delete identity.verifiedAt;
  return digest(identity);
}
function clock(now) { if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid CMS session clock"); }
function window(value, readerDigest) {
  if (typeof readerDigest !== "string" || !DIGEST.test(readerDigest) || !value || value.schemaVersion !== 2 || value.readerDigest !== readerDigest ||
      typeof value.closed !== "boolean" || !Number.isSafeInteger(value.maxExpiresAt) || value.maxExpiresAt < 0) {
    throw new Error("Invalid CMS reader session window");
  }
  if (value.pairDependencyVersion !== undefined && value.pairDependencyVersion !== 1) throw new Error("Unsupported CMS reader dependency window");
  if (value.pairDependencyVersion === 1 && readerSessionDigest(value.reader) !== readerDigest) throw new Error("Invalid CMS reader dependency identity");
  return value;
}
function dependency(value, pairId, readerDigest) {
  if (!value || value.schemaVersion !== 1 || value.pairId !== pairId || value.readerDigest !== readerDigest ||
      !Number.isSafeInteger(value.maxExpiresAt) || value.maxExpiresAt < 0) throw new Error("Invalid preview pair reader dependency");
  return value;
}
async function retainedPairs(firestore, transaction, runtime, reader) {
  const selector = pairs.parseSelector(runtime);
  const rows = await transaction.getAll(...[selector.selectedPairId, selector.recoveryPairId].map(id => firestore.collection(pairs.PAIRS).doc(id)));
  const values = rows.map(row => pairs.parsePair(row.data()));
  if (values[0].pairId !== selector.selectedPairId || values[1].pairId !== selector.recoveryPairId) throw new Error("Preview dependency identity changed");
  pairs.assertProjection(selector, values[0]); pairs.assertReaderSupports(reader, values);
  return values.map(value => value.pairId);
}
async function prepareDependencies(firestore, transaction, pairIds, readerDigest, expiresAt) {
  const refs = pairIds.map(pairId => firestore.collection(PAIR_READERS).doc(pairId).collection("readers").doc(readerDigest));
  const rows = await transaction.getAll(...refs);
  return rows.map((row, i) => ({ ref: refs[i], value: { schemaVersion: 1, pairId: pairIds[i], readerDigest,
    maxExpiresAt: Math.max(expiresAt, row.exists ? dependency(row.data(), pairIds[i], readerDigest).maxExpiresAt : 0) },
  changed: !row.exists || row.data().maxExpiresAt < expiresAt }));
}
async function openSession(firestore, { reader, principalId, sessionId = randomUUID(), ttlMs = MAX_SESSION_MS }, now = Date.now()) {
  parseReader(reader); clock(now);
  if (!ID.test(sessionId) || typeof principalId !== "string" || !principalId || principalId.length > 128 ||
      !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_SESSION_MS || !Number.isSafeInteger(now + ttlMs)) {
    throw new Error("Invalid CMS reader session");
  }
  const readerDigest = readerSessionDigest(reader);
  const ref = firestore.collection(SESSIONS).doc(sessionId), windowRef = firestore.collection(READERS).doc(readerDigest);
  return firestore.runTransaction(async tx => {
    const [existing, state, runtime] = await tx.getAll(ref, windowRef, firestore.doc(pairs.SELECTOR_PATH));
    const value = state.exists ? window(state.data(), readerDigest) : { schemaVersion: 2, readerDigest, closed: false, maxExpiresAt: 0 };
    if (existing.exists) {
      const session = existing.data();
      if (session.principalId !== principalId || session.readerDigest !== readerDigest || session.ttlMs !== ttlMs || now >= session.expiresAt) {
        throw new Error("CMS reader session retry conflicts or expired");
      }
      return session;
    }
    if (value.closed) throw new Error("CMS reader no longer issues sessions");
    // Never silently upgrade a legacy window: earlier leases have no scoped
    // dependency proof. The bridge retains that old window until closed/expired.
    const scoped = runtime.data()?.schemaVersion === 2 && (!state.exists || value.pairDependencyVersion === 1);
    const pairIds = scoped ? await retainedPairs(firestore, tx, runtime.data(), reader) : [];
    if (value.pairDependencyVersion === 1 && !scoped) throw new Error("Preview dependency authority is unavailable");
    const dependencies = scoped ? await prepareDependencies(firestore, tx, pairIds, readerDigest, now + ttlMs) : [];
    const session = { schemaVersion: 2, sessionId, readerDigest, principalId, ttlMs, issuedAt: now, expiresAt: now + ttlMs,
      ...(scoped ? { pairDependencyVersion: 1 } : {}) };
    tx.create(ref, session);
    tx.set(windowRef, { ...value, maxExpiresAt: Math.max(value.maxExpiresAt, session.expiresAt),
      ...(scoped ? { pairDependencyVersion: 1, reader } : {}) });
    for (const entry of dependencies) if (entry.changed) tx.set(entry.ref, entry.value);
    return session;
  });
}
async function assertSession(firestore, { sessionId, principalId, readerDigest }, now = Date.now()) {
  clock(now);
  if (!ID.test(sessionId) || !DIGEST.test(readerDigest)) throw new Error("Invalid CMS reader session identity");
  return firestore.runTransaction(async transaction => {
    const value = (await transaction.get(firestore.collection(SESSIONS).doc(sessionId))).data();
    if (!value || value.schemaVersion !== 2 || value.principalId !== principalId || value.readerDigest !== readerDigest ||
        value.sessionId !== sessionId || !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt) ||
        value.expiresAt <= value.issuedAt || value.expiresAt - value.issuedAt > MAX_SESSION_MS ||
        now < value.issuedAt || now >= value.expiresAt ||
        value.pairDependencyVersion !== undefined && value.pairDependencyVersion !== 1) throw new Error("CMS reader session is unavailable or expired");
    if (value.pairDependencyVersion === 1) {
      const [state, runtime] = await transaction.getAll(firestore.collection(READERS).doc(readerDigest), firestore.doc(pairs.SELECTOR_PATH));
      const owner = window(state.data(), readerDigest);
      if (owner.pairDependencyVersion !== 1 || owner.maxExpiresAt < value.expiresAt) throw new Error("Preview dependency history is incomplete");
      const pairIds = await retainedPairs(firestore, transaction, runtime.data(), owner.reader);
      const dependencies = await prepareDependencies(firestore, transaction, pairIds, readerDigest, value.expiresAt);
      // Observing a newly retained pair records only this lease's ORIGINAL
      // expiry. Refreshing an Admin tab never renews a lease or old dependency.
      for (const entry of dependencies) if (entry.changed) transaction.set(entry.ref, entry.value);
    }
    return value;
  });
}
async function closeReader(firestore, readerDigest) {
  if (!DIGEST.test(readerDigest)) throw new Error("Invalid CMS reader digest");
  const ref = firestore.collection(READERS).doc(readerDigest);
  return firestore.runTransaction(async tx => {
    const row = await tx.get(ref);
    const value = row.exists ? window(row.data(), readerDigest) : { schemaVersion: 2, readerDigest, maxExpiresAt: 0, closed: false };
    tx.set(ref, { ...value, closed: true });
  });
}
async function assertReaderExpired(firestore, readerDigest, now = Date.now()) {
  clock(now);
  if (!DIGEST.test(readerDigest)) throw new Error("Invalid CMS reader digest");
  const value = window((await firestore.collection(READERS).doc(readerDigest).get()).data(), readerDigest);
  if (!value.closed || value.maxExpiresAt > now) throw new Error("CMS reader still supports old Admin sessions");
  return { readerDigest, maxExpiresAt: value.maxExpiresAt };
}
async function assertPairReaderWindowsExpired(firestore, pairId, now = Date.now()) {
  clock(now);
  if (typeof pairId !== "string" || !/^preview-[a-z0-9][a-z0-9-]{0,31}$/.test(pairId)) throw new Error("Invalid preview pair reader expiry identity");
  return firestore.runTransaction(async transaction => {
    const [rows, dependencies] = await Promise.all([transaction.get(firestore.collection(READERS)),
      transaction.get(firestore.collection(PAIR_READERS).doc(pairId).collection("readers"))]);
    const values = rows.docs.map(row => window(row.data(), row.id));
    const relevant = dependencies.docs.map(row => dependency(row.data(), pairId, row.id));
    for (const entry of relevant) {
      const owner = values.find(value => value.readerDigest === entry.readerDigest);
      if (!owner || owner.pairDependencyVersion !== 1 || entry.maxExpiresAt > owner.maxExpiresAt) throw new Error("CMS reader expiry inventory is incomplete");
    }
    // Unscoped historical windows remain conservative obligations. New scoped
    // readers stay open and may issue leases for other retained pairs freely.
    const legacy = values.filter(value => value.pairDependencyVersion !== 1);
    if (legacy.some(value => !value.closed || value.maxExpiresAt > now) || relevant.some(value => value.maxExpiresAt > now)) throw new Error("CMS reader still supports old Admin sessions");
    return [...legacy, ...relevant].map(value => ({ readerDigest: value.readerDigest, maxExpiresAt: value.maxExpiresAt }));
  }, { readOnly: true });
}
module.exports = { MAX_SESSION_MS, readerSessionDigest, openSession, assertSession, closeReader, assertReaderExpired, assertPairReaderWindowsExpired };
