"use strict";

const { randomUUID } = require("node:crypto");
const { Timestamp } = require("firebase-admin/firestore");
const { assertStaffAuthority } = require("./live-production-authority");
const { sessionRef, getSession, assertEditable, checkVersion, boundedWrite, audit } = require("./live-production-store");
const { fingerprint } = require("./live-production-requests");
const { parseSourceConfig } = require("./rundown-document-structure");

const POLL_MS = 25000, LEASE_MS = 30000, RETENTION_MS = 24 * 60 * 60 * 1000;
const sourceRef = ref => ref.collection("rundown").doc("source");
const snapshotRef = ref => ref.collection("rundownSnapshots").doc("current");
const emptySource = () => ({ configVersion: 0, generation: 0, config: null, lease: null, nextAttemptAtMs: 0,
  failures: 0, status: "not_configured", checkedAtMs: null, drive: null, hash: null, apiRequests: 0 });
function publicSource(state, snapshot, now) {
  const source = { ...state };
  delete source.lease;
  return { source, snapshot: snapshot?.expiresAtMs > now ? snapshot : null, serverNowMs: now };
}
function failureClass(error) {
  const status = error.response?.status ?? error.status ?? error.code;
  if ([401, 403, 404].includes(status)) return "access_lost";
  if (status === 429) return "quota";
  if (status === 413) return "oversized";
  if (status === 422) return "invalid_source";
  if (status === 409) return "source_changed";
  if (status === 503) return "not_activated";
  return "unavailable";
}

async function rundownSourceRequest(db, request, actor, { readGoogle, clock = Date.now } = {}) {
  const ref = sessionRef(db, request.sessionId), stateRef = sourceRef(ref), contentRef = snapshotRef(ref);
  const leaseId = randomUUID();
  const acquired = await db.runTransaction(async transaction => {
    await assertStaffAuthority(db, transaction, actor);
    const session = await getSession(transaction, ref);
    const state = (await transaction.get(stateRef)).data() ?? emptySource();
    const snapshot = (await transaction.get(contentRef)).data() ?? null;
    const now = clock();
    if (request.action === "get_source") return { result: publicSource(state, snapshot, now) };
    assertEditable(session);
    if (request.action === "set_source") {
      checkVersion(state.configVersion, request.baseConfigVersion);
      const config = parseSourceConfig(request.config);
      const next = { ...state, drive: null, hash: null, checkedAtMs: null,
        configVersion: state.configVersion + 1, config, status: config.enabled ? "waiting" : "disabled" };
      boundedWrite(transaction, "set", stateRef, next);
      transaction.delete(contentRef);
      transaction.delete(ref.collection("rundownProposals").doc("current"));
      transaction.delete(ref.collection("rundownReview").doc("current"));
      audit(transaction, ref, `rundown_config_${next.configVersion}`, actor.uid, "rundown_config", now,
        { configVersion: next.configVersion, configHash: fingerprint(config) });
      return { result: publicSource(next, null, now) };
    }
    if (!state.config?.enabled || (!request.manual && session.state !== "active")) return { result: publicSource(state, snapshot, now) };
    if (state.nextAttemptAtMs > now || state.lease?.expiresAtMs > now) return { result: publicSource(state, snapshot, now) };
    const next = { ...state, lease: { id: leaseId, expiresAtMs: now + LEASE_MS }, nextAttemptAtMs: now + POLL_MS };
    boundedWrite(transaction, "set", stateRef, next);
    return { state: next, snapshot, sessionGeneration: session.generation };
  });
  if (acquired.result) return acquired.result;
  let fetched, failure;
  try { fetched = await readGoogle(acquired.state.config, acquired.snapshot?.expiresAtMs > clock() ? acquired.snapshot : null, request.manual); }
  catch (error) { failure = failureClass(error); }
  return db.runTransaction(async transaction => {
    // Recheck identity, configuration and lifecycle after external IO.
    await assertStaffAuthority(db, transaction, actor);
    const session = await getSession(transaction, ref);
    const state = (await transaction.get(stateRef)).data() ?? emptySource();
    const previous = (await transaction.get(contentRef)).data() ?? null;
    const now = clock();
    if (state.lease?.id !== leaseId || state.lease.expiresAtMs <= now || state.configVersion !== acquired.state.configVersion || session.generation !== acquired.sessionGeneration ||
      session.state === "ended" || (!request.manual && session.state !== "active")) return publicSource(state, previous, now);
    if (failure) {
      const failures = Math.min(state.failures + 1, 6);
      const next = { ...state, lease: null, failures, status: failure, checkedAtMs: now,
        nextAttemptAtMs: now + Math.min(15 * 60 * 1000, POLL_MS * 2 ** failures) };
      boundedWrite(transaction, "set", stateRef, next);
      audit(transaction, ref, `rundown_read_${leaseId}`, actor.uid, "rundown_read_failed", now, { failure, configVersion: state.configVersion });
      return publicSource(next, previous, now);
    }
    const changed = fetched.snapshot && fetched.snapshot.hash !== previous?.hash;
    const generation = state.generation + (changed ? 1 : 0);
    const snapshot = fetched.snapshot ? { ...fetched.snapshot, generation, configVersion: state.configVersion,
      drive: fetched.drive, fetchedAtMs: now, expiresAtMs: now + RETENTION_MS, purgeAt: Timestamp.fromMillis(now + RETENTION_MS) }
      : previous ? { ...previous, expiresAtMs: now + RETENTION_MS, purgeAt: Timestamp.fromMillis(now + RETENTION_MS) } : null;
    const next = { ...state, lease: null, failures: 0, status: "current", generation, hash: snapshot?.hash ?? null,
      checkedAtMs: now, drive: fetched.drive, apiRequests: state.apiRequests + fetched.apiRequests, nextAttemptAtMs: now + POLL_MS };
    boundedWrite(transaction, "set", stateRef, next);
    if (snapshot) boundedWrite(transaction, "set", contentRef, snapshot);
    // Audit has no source text. Only the current private snapshot holds the full rundown.
    if (changed) audit(transaction, ref, `rundown_generation_${generation}`, actor.uid, "rundown_source", now,
      { generation, configVersion: state.configVersion, hash: snapshot.hash, drive: fetched.drive, revisionId: snapshot.revisionId });
    return publicSource(next, snapshot, now);
  });
}
module.exports = { POLL_MS, LEASE_MS, RETENTION_MS, sourceRef, snapshotRef, publicSource, rundownSourceRequest };
