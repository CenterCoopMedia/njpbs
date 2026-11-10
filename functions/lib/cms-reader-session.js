"use strict";

// Inert versioned-reader boundary. An authenticated gateway issues these leases
// and checks them on every versioned request; a lease never replaces staff auth.
// Legacy endpoints remain supported until explicit adoption of this boundary.
const { randomUUID } = require("node:crypto");
const pairs = require("./cms-preview-pair");
const { digest, parseReader } = pairs;
const MAX_SESSION_MS = 24 * 60 * 60_000;
// Three installer rounds use 24 UUIDs. A quota of 32 per 15 minutes leaves eight
// for staff opens and bounds churn; 128 live leases allow 64 two-reader tabs.
const MAX_PRINCIPAL_SESSIONS = 128;
const MAX_SESSION_ISSUANCES = 32;
const SESSION_ISSUANCE_WINDOW_MS = 15 * 60_000;
// One transaction's deletes. An operator repeats the sweep until it is complete.
const MAX_SWEPT_SESSIONS = 200;
// Admin rotates its UUIDs only on this typed reply. See the bridge guide.
const SESSION_EXPIRED = "cms-reader-session-expired";
const READERS = "cmsReaderSessionWindows";
const SESSIONS = "cmsReaderSessions";
const closures = require("./cms-preview-pair-reader-closure");
const PAIR_READERS = closures.COLLECTION;
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
  if (value.recoveryClosureVersion !== undefined && (value.recoveryClosureVersion !== 1 || value.pairDependencyVersion !== 1)) {
    throw new Error("Invalid CMS recovery closure reader");
  }
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
  pairs.assertProjection(selector, values[0]);
  const closed = await transaction.getAll(...values.map(pair => firestore.collection(PAIR_READERS).doc(pair.pairId)));
  const retained = values.filter((pair, index) => {
    if (!closed[index].exists) return true;
    closures.parseClosure(closed[index].data(), pair);
    if (index === 0) throw new Error("Preview reader closure disagrees with selection");
    // Closure atomically captured every existing lease window. A request never
    // compares clocks across hosts or extends that closed expiry frontier.
    return false;
  });
  pairs.assertReaderSupports(reader, retained);
  return retained.map(value => value.pairId);
}
async function prepareDependencies(firestore, transaction, pairIds, readerDigest, expiresAt) {
  const refs = pairIds.map(pairId => firestore.collection(PAIR_READERS).doc(pairId).collection("readers").doc(readerDigest));
  const rows = await transaction.getAll(...refs);
  return rows.map((row, i) => ({ ref: refs[i], value: { schemaVersion: 1, pairId: pairIds[i], readerDigest,
    maxExpiresAt: Math.max(expiresAt, row.exists ? dependency(row.data(), pairIds[i], readerDigest).maxExpiresAt : 0) },
  changed: !row.exists || row.data().maxExpiresAt < expiresAt }));
}
// A stable principal row serializes issuance across every retained reader.
// An expired UUID record is its own same-ID tombstone. Random UUIDs carry no
// time, so only a reader's closed window can replace that record: see
// sweepClosedReaderSessions.
function activeSessionEntries(entries, maximum, expiryKey, now) {
  if (!Array.isArray(entries) || entries.length > maximum ||
      entries.some(entry => !entry || Object.keys(entry).sort().join() !== `${expiryKey},sessionId` ||
        !ID.test(entry.sessionId) || !Number.isSafeInteger(entry[expiryKey]) || entry[expiryKey] < 0) ||
      new Set(entries.map(entry => entry.sessionId)).size !== entries.length) {
    throw new Error("Invalid CMS principal session window");
  }
  return entries.filter(entry => entry[expiryKey] > now);
}
function principalSessions(value, principalId, now) {
  if (value === undefined) return { sessions: [], issuances: [] };
  if (!value || Object.keys(value).sort().join() !== "issuances,kind,principalId,schemaVersion,sessions" ||
      value.schemaVersion !== 1 || value.kind !== "principal-session-window" || value.principalId !== principalId) {
    throw new Error("Invalid CMS principal session window");
  }
  return { sessions: activeSessionEntries(value.sessions, MAX_PRINCIPAL_SESSIONS, "expiresAt", now),
    issuances: activeSessionEntries(value.issuances, MAX_SESSION_ISSUANCES, "releaseAt", now) };
}
function sessionBudgetReadyAt(entries, limit, needed, expiryKey, now) {
  const excess = entries.length + needed - limit;
  return excess > 0 ? entries.map(entry => entry[expiryKey]).sort((a, b) => a - b)[excess - 1] : now;
}
function checkedSessionInput({ reader, principalId, sessionId = randomUUID(), ttlMs = MAX_SESSION_MS }, now) {
  parseReader(reader);
  if (!ID.test(sessionId) || typeof principalId !== "string" || !principalId || principalId.length > 128 ||
      !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_SESSION_MS ||
      !Number.isSafeInteger(now + Math.max(ttlMs, SESSION_ISSUANCE_WINDOW_MS))) {
    throw new Error("Invalid CMS reader session");
  }
  return { reader, principalId, sessionId, ttlMs, readerDigest: readerSessionDigest(reader) };
}
function existingSession(row, input) {
  if (!row.exists) return null;
  const session = row.data();
  if (session.principalId !== input.principalId || session.readerDigest !== input.readerDigest ||
      session.ttlMs !== input.ttlMs) {
    throw new Error("CMS reader session retry conflicts or expired");
  }
  return session;
}
// Reaches only the original principal: existingSession refuses every other one.
// One ended lease ends the group, so a retained or absent partner gets no lease
// and spends no quota. These are the stored values, never the retry's clock.
function refuseExpiredSessions(leases, now) {
  const expiredLeases = leases.filter(lease => lease && now >= lease.expiresAt)
    .map(({ sessionId, readerDigest, issuedAt, expiresAt }) => ({ sessionId, readerDigest, issuedAt, expiresAt }));
  if (expiredLeases.length) throw Object.assign(new Error("CMS reader session retry conflicts or expired"), { expiredLeases });
}
async function prepareSession({ firestore, transaction: tx, input, state: value, windowExists, runtime, now }) {
  // Never silently upgrade an unscoped historical window.
  const scoped = runtime?.schemaVersion === 2 && (value.pairDependencyVersion === 1 || !windowExists);
  if (value.pairDependencyVersion === 1 && !scoped) throw new Error("Preview dependency authority is unavailable");
  const pairIds = scoped ? await retainedPairs(firestore, tx, runtime, input.reader) : [];
  const dependencies = scoped ? await prepareDependencies(firestore, tx, pairIds, input.readerDigest, now + input.ttlMs) : [];
  const session = { schemaVersion: 2, sessionId: input.sessionId, readerDigest: input.readerDigest, principalId: input.principalId,
    ttlMs: input.ttlMs, issuedAt: now, expiresAt: now + input.ttlMs, ...(scoped ? { pairDependencyVersion: 1 } : {}) };
  return { session, dependencies, state: { ...value, maxExpiresAt: Math.max(value.maxExpiresAt, session.expiresAt),
    ...(scoped ? { pairDependencyVersion: 1, recoveryClosureVersion: 1, reader: input.reader } : {}) } };
}
async function issueSessions(firestore, rawInputs, now) {
  clock(now);
  const inputs = rawInputs.map(input => checkedSessionInput(input, now));
  const principalId = inputs[0].principalId;
  if (inputs.some(input => input.principalId !== principalId) || new Set(inputs.map(input => input.sessionId)).size !== inputs.length) {
    throw new Error("Invalid CMS reader session group");
  }
  const refs = inputs.map(input => firestore.collection(SESSIONS).doc(input.sessionId));
  const windows = inputs.map(input => firestore.collection(READERS).doc(input.readerDigest));
  const principalRef = firestore.collection(SESSIONS).doc(`principal-${digest(principalId)}`);
  return firestore.runTransaction(async tx => {
    const rows = await tx.getAll(...refs, ...windows, firestore.doc(pairs.SELECTOR_PATH), principalRef);
    const leases = inputs.map((input, index) => existingSession(rows[index], input));
    refuseExpiredSessions(leases, now);
    const states = inputs.map((input, index) => rows[inputs.length + index].exists
      ? window(rows[inputs.length + index].data(), input.readerDigest)
      : { schemaVersion: 2, readerDigest: input.readerDigest, closed: false, maxExpiresAt: 0 });
    const needed = leases.filter(lease => lease === null).length;
    if (!needed) return leases;
    if (states.some((state, index) => !leases[index] && state.closed)) throw new Error("CMS reader no longer issues sessions");
    const active = principalSessions(rows[inputs.length * 2 + 1].data(), principalId, now);
    // A swept UUID may still own an issuance slot. Reusing it before that
    // slot expires would duplicate the principal's unique quota entries.
    const retainedIssuances = active.issuances.filter(entry => inputs.some((input, index) => !leases[index] && input.sessionId === entry.sessionId));
    const availableAt = Math.max(...retainedIssuances.map(entry => entry.releaseAt),
      sessionBudgetReadyAt(active.sessions, MAX_PRINCIPAL_SESSIONS, needed, "expiresAt", now),
      sessionBudgetReadyAt(active.issuances, MAX_SESSION_ISSUANCES, needed, "releaseAt", now));
    if (availableAt > now) throw Object.assign(new Error("CMS staff session limit reached"), {
      status: 429, retryAfterSeconds: Math.max(1, Math.ceil((availableAt - now) / 1000)),
    });
    // Read and validate both components before any write. A refused component
    // leaves the other lease and the principal's issuance quota unchanged.
    const pending = [];
    for (const [index, input] of inputs.entries()) {
      pending.push(leases[index] ? null : await prepareSession({ firestore, transaction: tx, input,
        state: states[index], windowExists: rows[inputs.length + index].exists, runtime: rows[inputs.length * 2].data(), now }));
    }
    const created = pending.filter(Boolean).map(entry => entry.session);
    tx.set(principalRef, { schemaVersion: 1, kind: "principal-session-window", principalId,
      sessions: [...active.sessions, ...created.map(({ sessionId, expiresAt }) => ({ sessionId, expiresAt }))],
      issuances: [...active.issuances, ...created.map(({ sessionId }) => ({ sessionId, releaseAt: now + SESSION_ISSUANCE_WINDOW_MS }))] });
    for (const [index, entry] of pending.entries()) {
      if (!entry) continue;
      tx.create(refs[index], entry.session);
      tx.set(windows[index], entry.state);
      for (const dependency of entry.dependencies) if (dependency.changed) tx.set(dependency.ref, dependency.value);
      leases[index] = entry.session;
    }
    return leases;
  });
}
async function openSession(firestore, input, now = Date.now()) {
  return (await issueSessions(firestore, [input], now))[0];
}
async function openReaderSessions(firestore, { readers, principalId, sessionIds, ttlMs }, now = Date.now()) {
  const components = ["functions", "cmsApi"];
  if (!sessionIds || Object.keys(sessionIds).sort().join() !== "cmsApi,functions" ||
      components.some(component => !ID.test(sessionIds[component]) || parseReader(readers?.[component]).component !== component)) {
    throw new Error("Invalid CMS reader session group");
  }
  const leases = await issueSessions(firestore, components.map(component => ({ reader: readers[component],
    principalId, sessionId: sessionIds[component], ttlMs })), now);
  return Object.fromEntries(components.map((component, index) => [component, leases[index]]));
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
async function closeReader(firestore, readerDigest, { retiredOnly = false } = {}) {
  if (!DIGEST.test(readerDigest)) throw new Error("Invalid CMS reader digest");
  const ref = firestore.collection(READERS).doc(readerDigest);
  return firestore.runTransaction(async tx => {
    const row = await tx.get(ref);
    if (retiredOnly) {
      const components = ["functions", "cmsApi"];
      const live = await tx.getAll(...components.map(component => firestore.doc(`${pairs.READER_RECEIPTS}/${component}`)));
      if (live.some((receipt, index) => readerSessionDigest(pairs.currentReader(receipt.data(), components[index])) === readerDigest)) {
        throw new Error("Current CMS readers cannot be closed");
      }
    }
    const value = row.exists ? window(row.data(), readerDigest) : { schemaVersion: 2, readerDigest, maxExpiresAt: 0, closed: false };
    tx.set(ref, { ...value, closed: true });
  });
}
/** Deletes one bounded page of a closed, fully expired reader's UUID rows. Its
 * closed window now refuses those same IDs and no new row can appear. Windows,
 * pair dependencies and principal rows stay: they own retirement and the caps. */
async function sweepClosedReaderSessions(firestore, readerDigest, now) {
  if (now !== undefined) clock(now);
  if (!DIGEST.test(readerDigest)) throw new Error("Invalid CMS reader digest");
  const history = firestore.collection(SESSIONS).where("readerDigest", "==", readerDigest).limit(MAX_SWEPT_SESSIONS);
  return firestore.runTransaction(async tx => {
    const row = await tx.get(firestore.collection(READERS).doc(readerDigest));
    const owner = window(row.data(), readerDigest);
    if (!owner.closed || owner.maxExpiresAt > (now ?? row.readTime.toMillis())) throw new Error("CMS reader still supports old Admin sessions");
    const sessions = await tx.get(history);
    for (const session of sessions.docs) {
      const value = session.data();
      if (value.sessionId !== session.id || !Number.isSafeInteger(value.expiresAt) || value.expiresAt > owner.maxExpiresAt) {
        throw new Error("CMS reader expiry inventory is incomplete");
      }
      tx.delete(session.ref);
    }
    return { readerDigest, deleted: sessions.size, complete: sessions.size < MAX_SWEPT_SESSIONS };
  });
}
/** Read-only retention inventory for a named coordinator task. */
async function readReaderSessionHistory(firestore) {
  const windows = await firestore.collection(READERS).get();
  return Promise.all(windows.docs.map(async row => {
    const { readerDigest, closed, maxExpiresAt } = window(row.data(), row.id);
    const rows = await firestore.collection(SESSIONS).where("readerDigest", "==", readerDigest).count().get();
    return { readerDigest, closed, maxExpiresAt, sessionRows: rows.data().count };
  }));
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
  return firestore.runTransaction(transaction => assertPairReaderWindowsExpiredInTransaction({ firestore, transaction, pairId, now }), { readOnly: true });
}
async function assertPairReaderWindowsExpiredInTransaction({ firestore, transaction, pairId, now }) {
    clock(now);
    if (typeof pairId !== "string" || !/^preview-[a-z0-9][a-z0-9-]{0,31}$/.test(pairId)) throw new Error("Invalid preview pair reader expiry identity");
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
}
async function assertLiveReaderWindowsSupportInTransaction({ firestore, transaction, candidatePair, now }) {
  clock(now);
  const rows = await transaction.get(firestore.collection(READERS));
  const live = rows.docs.map(row => window(row.data(), row.id)).filter(value => value.maxExpiresAt > now);
  for (const value of live) {
    if (value.pairDependencyVersion !== 1) throw new Error("Historical unscoped Admin sessions must expire before replacement");
    pairs.assertReaderSupports(value.reader, [candidatePair]);
  }
  return live.map(value => ({ readerDigest: value.readerDigest, maxExpiresAt: value.maxExpiresAt }));
}
async function preparePairReaderClosureInTransaction({ firestore, transaction, pairId }) {
  const rows = await transaction.get(firestore.collection(READERS));
  const scoped = rows.docs.map(row => window(row.data(), row.id)).filter(value => value.pairDependencyVersion === 1);
  const refs = scoped.map(value => firestore.collection(PAIR_READERS).doc(pairId).collection("readers").doc(value.readerDigest));
  const dependencies = refs.length ? await transaction.getAll(...refs) : [];
  return scoped.map((value, index) => {
    if (dependencies[index].exists && dependency(dependencies[index].data(), pairId, value.readerDigest).maxExpiresAt > value.maxExpiresAt) {
      throw new Error("CMS reader expiry inventory is incomplete");
    }
    return { ref: refs[index], value: { schemaVersion: 1, pairId, readerDigest: value.readerDigest, maxExpiresAt: value.maxExpiresAt } };
  });
}
/** An installed but never-used legacy endpoint also needs a closed issuance
 * window. Its old implementation already respects that exact window's closed
 * bit. Existing leases may still record only their original captured expiry. */
async function prepareRecoveryReaderFenceInTransaction({ firestore, transaction, allowClose = false }) {
  const proofs = require("./cms-reader-bridge-proof");
  const [installed, attempts, fences, windows, ...liveRows] = await Promise.all([
    transaction.get(firestore.collection("cmsReaderBridgeInstalledProofs")),
    transaction.get(firestore.collection("cmsReaderBridgeInstallAttempts")),
    transaction.get(firestore.collection("cmsPreviewReaderAttemptFences")),
    transaction.get(firestore.collection(READERS)),
    ...["functions", "cmsApi"].map(component => transaction.get(firestore.doc(`${pairs.READER_RECEIPTS}/${component}`))),
  ]);
  const readers = Object.fromEntries(["functions", "cmsApi"].map((component, index) => [component, pairs.currentReader(liveRows[index].data(), component)]));
  const liveReaderDigests = Object.fromEntries(Object.entries(readers).map(([component, reader]) => [component, readerSessionDigest(reader)]));
  const key = proofs.cmsReaderBridgeProofKey(readers), identities = new Set();
  let liveInstalled = false;
  for (const row of installed.docs) {
    const stage = proofs.cmsReaderBridgeStage(row.data()?.proof);
    const value = proofs.parseInstalledCmsReaderProof(row.data(), row.data()?.proof?.operationId, { stage });
    // The real installer keeps the immutable operation receipt alongside the
    // stable reader-identity proof in this same collection. Validate both.
    if (proofs.cmsReaderBridgeProofKey(value.proof.readers, stage) !== row.id && value.proof.operationId !== row.id) {
      throw new Error("CMS installed reader inventory differs");
    }
    if (row.id === key) liveInstalled = true;
    for (const identity of Object.values(value.proof.readerIdentities)) identities.add(identity);
  }
  for (const row of attempts.docs) {
    const attempt = row.data();
    // A started/uncertain probe can already have a deployed legacy endpoint.
    // Its identity is not an installed proof yet: settle it before closure.
    if (attempt?.schemaVersion !== 2 || !["complete", "started", "uncertain"].includes(attempt.state)) throw new Error("CMS reader bridge attempt is invalid");
    const fenced = fences.docs.find(fence => fence.id === row.id);
    if (fenced) {
      const value = parseReaderAttemptFence(fenced.data(), attempt, row.id);
      for (const identity of Object.values(value.readerIdentities)) identities.add(identity);
      continue;
    }
    if (attempt.state !== "complete" || attempt.proof?.operationId !== row.id || attempt.requestDigest !== attempt.proof?.requestDigest) {
      throw new Error("CMS reader bridge attempt must settle or fence issuance before recovery closure");
    }
    const value = proofs.parseInstalledCmsReaderProof({ schemaVersion: 2, proof: attempt.proof,
      readerDigests: Object.fromEntries(Object.entries(attempt.proof.readers ?? {}).map(([component, reader]) => [component, pairs.digest(reader)])) }, row.id,
    { stage: proofs.cmsReaderBridgeStage(attempt.proof) });
    for (const identity of Object.values(value.proof.readerIdentities)) identities.add(identity);
  }
  if (!liveInstalled) throw new Error("Closure-aware deployed CMS readers are required");
  const values = new Map(windows.docs.map(row => [row.id, window(row.data(), row.id)]));
  for (const identity of Object.values(liveReaderDigests)) {
    const value = values.get(identity);
    if (!value || value.closed || value.recoveryClosureVersion !== 1) throw new Error("Closure-aware deployed CMS readers are required");
  }
  const writes = [], closedReaderDigests = [];
  for (const identity of new Set([...identities, ...values.keys()])) {
    const value = values.get(identity);
    if (value?.recoveryClosureVersion === 1) continue;
    if (!value?.closed && !allowClose) throw new Error("Legacy CMS reader issuance is not closed");
    closedReaderDigests.push(identity);
    if (!value?.closed) writes.push({ ref: firestore.collection(READERS).doc(identity),
      value: { ...(value ?? { schemaVersion: 2, readerDigest: identity, maxExpiresAt: 0 }), closed: true } });
  }
  return { writes, proof: { schemaVersion: 1, liveReaderDigests, closedReaderDigests: closedReaderDigests.sort() } };
}
function parseReaderAttemptFence(value, attempt, operationId) {
  if (!value || Object.keys(value).sort().join() !== "operationId,readerIdentities,readers,requestDigest,schemaVersion" || value.schemaVersion !== 2 ||
      value.operationId !== operationId || !/^reader-[a-z0-9][a-z0-9-]{0,63}$/.test(operationId) ||
      value.requestDigest !== attempt?.requestDigest || !DIGEST.test(value.requestDigest) ||
      !value.readers || Object.keys(value.readers).sort().join() !== "cmsApi,functions" ||
      !value.readerIdentities || Object.keys(value.readerIdentities).sort().join() !== "cmsApi,functions" ||
      ["functions", "cmsApi"].some(component => pairs.parseReader(value.readers[component]).component !== component ||
        readerSessionDigest(value.readers[component]) !== value.readerIdentities[component])) throw new Error("CMS reader attempt fence is invalid");
  return value;
}
module.exports = { MAX_SESSION_MS, MAX_PRINCIPAL_SESSIONS, MAX_SESSION_ISSUANCES, MAX_SWEPT_SESSIONS, SESSION_EXPIRED, readerSessionDigest, openSession, openReaderSessions, assertSession, closeReader,
  sweepClosedReaderSessions, readReaderSessionHistory, assertReaderExpired, assertPairReaderWindowsExpired,
  assertPairReaderWindowsExpiredInTransaction, assertLiveReaderWindowsSupportInTransaction, preparePairReaderClosureInTransaction,
  prepareRecoveryReaderFenceInTransaction, parseReaderAttemptFence, parseReaderSessionWindow: window };
