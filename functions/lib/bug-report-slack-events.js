"use strict";

// Dormant handlers for a future approved host. No exports in functions/index.js,
// Cloud Function declarations, network clients, credentials or schedules here.
const { createHash, randomUUID } = require("node:crypto");
const { isBugReportId } = require("./bug-report-contract");
const {
  buildSlackCard, sourceRevision, reporterKey, verifyTestReport, validateConfig, slackConfigBinding,
} = require("./bug-report-slack");

const COLLECTIONS = Object.freeze({ reports: "bug_reports", work: "bugReportSlackOutbox", control: "bugReportSlackEventControl" });
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const WORK_LEASE_MS = 120_000;
const CHANNEL_GAP_MS = 1_100;
const MAX_ATTEMPTS = 5;
const DONE = new Set(["created", "updated", "unchanged", "not_boardwalk"]);
const RETRYABLE_PREFLIGHT = new Set(["request_uncertain", "verification_retry_required", "source_read_failed", "delivery_claim_failed"]);
const BLOCKED = new Set(["blocked", "terminal_failed", "reconciliation_required", "stale_source"]);
const hash = value => createHash("sha256").update(value).digest("hex");
const outcome = (reportId, status, code) => ({ reportId: isBugReportId(reportId) ? reportId : null, status, ...(code ? { code } : {}) });
function target(config) { return hash(`${config.workspaceId}\0${config.channelId}\0${config.botUserId}`); }
function requireRehearsal(config) {
  validateConfig(config);
  if (!config.isolatedTest || config.activationVerified !== true) throw new Error("isolated_rehearsal_required");
}

function createBugReportSlackEvents({ store, consumer, config, now = Date.now }) {
  config = structuredClone(config);
  requireRehearsal(config);
  if (consumer?.binding !== slackConfigBinding(config)) throw new Error("event_consumer_binding_mismatch");
  if (typeof store?.changeWork !== "function" || typeof consumer?.syncReport !== "function") throw new Error("event_adapters_required");
  const targetId = target(config);
  const allowed = reportId => isBugReportId(reportId) && config.isolatedTest.reportIds.includes(reportId);

  async function enqueue(reportId) {
    if (!allowed(reportId)) return outcome(reportId, "skipped");
    return store.changeWork(reportId, ({ record, work }) => {
      if (!record || record.id !== reportId || record.environment?.native) return { result: outcome(reportId, "skipped") };
      verifyTestReport(record, config);
      const revision = sourceRevision(record);
      // Hash only fixed public-safe projection plus private pseudonymous reporter
      // binding. Event snapshots, event IDs, raw email and freeform text stay out.
      const desiredHash = hash(JSON.stringify({ card: buildSlackCard(record, { config, now: now() }), reporter: reporterKey(record) }));
      if (work && work.targetId !== targetId) return { result: outcome(reportId, "blocked", "event_target_changed") };
      if (work?.state === "blocked") return { result: outcome(reportId, "blocked", work.lastCode) };
      if (work?.desiredRevision && (revision.version < work.desiredRevision.version || revision.updatedAt < work.desiredRevision.updatedAt)) {
        return { result: outcome(reportId, "blocked", "event_source_regressed") };
      }
      if (work?.desiredHash === desiredHash) return { result: outcome(reportId, work.state) };
      const running = work?.state === "running" && work.leaseUntil > now();
      const next = { ...(work || {}), schemaVersion: 1, reportId, targetId,
        desiredRevision: revision, desiredHash, generation: (work?.generation || 0) + 1,
        state: running ? "running" : "pending", attempts: running ? work.attempts : 0,
        nextAttemptAt: Math.max(now(), work?.providerNotBefore || 0), updatedAt: now(), lastCode: null,
        leaseToken: running ? work.leaseToken : null, leaseUntil: running ? work.leaseUntil : null };
      return { work: next, result: outcome(reportId, next.state) };
    });
  }

  async function deliver(reportId) {
    if (!allowed(reportId)) return outcome(reportId, "skipped");
    const token = randomUUID();
    const claim = await store.changeWork(reportId, ({ record, work, control = {} }) => {
      if (!work) return { result: outcome(reportId, "skipped") };
      if (work.targetId !== targetId) return { result: outcome(reportId, "blocked", "event_target_changed") };
      if (!record || record.id !== reportId || record.environment?.native) return { result: outcome(reportId, "skipped") };
      verifyTestReport(record, config);
      if (["blocked", "done"].includes(work.state)) return { result: outcome(reportId, work.state, work.lastCode) };
      if (!new Set(["pending", "running", "retry"]).has(work.state)) return { result: outcome(reportId, "blocked", "event_state_invalid") };
      if ((work.state === "running" && work.leaseUntil > now()) ||
          (control.leaseToken && control.leaseUntil > now())) return { result: outcome(reportId, "busy") };
      if (work.nextAttemptAt > now() || control.nextAllowedAt > now()) return { result: outcome(reportId, "backoff") };
      if (work.attempts >= MAX_ATTEMPTS) return { work: { ...work, state: "blocked", lastCode: "event_attempts_exhausted" }, result: outcome(reportId, "blocked", "event_attempts_exhausted") };
      const next = { ...work, state: "running", attempts: (work.attempts || 0) + 1,
        leaseToken: token, leaseUntil: now() + WORK_LEASE_MS, updatedAt: now() };
      return { work: next, control: { ...control, leaseToken: token, leaseUntil: next.leaseUntil }, result: { claimed: true, generation: next.generation } };
    });
    if (!claim.claimed) return claim;
    let response;
    try { response = await consumer.syncReport(reportId, { send: true }); }
    catch { response = { status: "retry", code: "delivery_call_failed" }; }
    // The conservative consumer owns create uncertainty and the stable root ts.
    // Never clear/reset its mapping or attempt a fallback post here.
    return store.changeWork(reportId, ({ work, control = {} }) => {
      if (work?.leaseToken !== token || control.leaseToken !== token) return { result: outcome(reportId, "blocked", "event_lease_lost") };
      const changed = work.generation !== claim.generation;
      const terminal = BLOCKED.has(response?.status) && !(response?.status === "blocked" && RETRYABLE_PREFLIGHT.has(response.code));
      const success = DONE.has(response?.status);
      const deferred = ["backoff", "busy"].includes(response?.status);
      const attempts = deferred ? Math.max(0, work.attempts - 1) : work.attempts;
      const exhausted = !success && !changed && attempts >= MAX_ATTEMPTS;
      const state = terminal || exhausted ? "blocked" : changed ? "pending" : success ? "done" : "retry";
      const lastCode = terminal ? "delivery_requires_review" : exhausted ? "event_attempts_exhausted" : success ? null : "delivery_retry_pending";
      const retryAfterMs = Number.isFinite(response?.retryAfterMs) ? Math.max(0, Math.min(3_600_000, response.retryAfterMs)) : 0;
      const nextAttemptAt = ["done", "blocked"].includes(state) ? null : now() + Math.max(retryAfterMs,
        changed ? CHANNEL_GAP_MS : Math.min(RECONCILE_INTERVAL_MS, 30_000 * 2 ** Math.max(0, attempts - 1)));
      return { work: { ...work, state, attempts: changed ? 0 : attempts, nextAttemptAt, lastCode,
          providerNotBefore: retryAfterMs ? now() + retryAfterMs : null,
          appliedGeneration: success ? claim.generation : (work.appliedGeneration || 0),
          leaseToken: null, leaseUntil: null, updatedAt: now() },
        control: { ...control, leaseToken: null, leaseUntil: null, nextAllowedAt: now() + Math.max(CHANNEL_GAP_MS, retryAfterMs) },
        result: outcome(reportId, state, lastCode) };
    });
  }

  async function safely(action, reportId) {
    try { return await action(reportId); }
    catch { return outcome(reportId, "retry", "event_storage_or_source_failed"); }
  }
  async function reportWritten(event) {
    const reportId = event?.params?.reportId;
    const queued = await safely(enqueue, reportId);
    if (["skipped", "blocked", "retry"].includes(queued.status)) {
      // A persisted retry is deliverable when due; an enqueue failure is not.
      if (queued.code || queued.status !== "retry") return queued;
    }
    return safely(deliver, reportId);
  }
  async function workWritten(event) { return safely(deliver, event?.params?.reportId); }
  async function reconcile() {
    const results = [];
    // Only the <=10 explicit synthetic fixture IDs. A bad first row cannot stop
    // other reports; blocked work remains durable and is never silently reset.
    for (const reportId of config.isolatedTest.reportIds) results.push(await reportWritten({ params: { reportId } }));
    const status = results.some(entry => entry.status === "blocked" || entry.code === "event_storage_or_source_failed")
      ? "needs_attention" : results.some(entry => !["done", "skipped"].includes(entry.status)) ? "pending" : "checked";
    return { status, results };
  }
  return { enqueue, reportWritten, workWritten, reconcile };
}

// Supplied Firestore must already be authorized. All three reads precede writes;
// callbacks contain no provider calls and may be retried by Firestore.
function createFirestoreSlackEventStore(db, { config }) {
  config = structuredClone(config);
  requireRehearsal(config);
  const control = db.collection(COLLECTIONS.control).doc(target(config));
  return { changeWork: async (reportId, update) => {
    if (!isBugReportId(reportId) || !config.isolatedTest.reportIds.includes(reportId)) throw new Error("test_report_not_allowed");
    const report = db.collection(COLLECTIONS.reports).doc(reportId);
    const job = db.collection(COLLECTIONS.work).doc(reportId);
    return db.runTransaction(async transaction => {
      const reportSnapshot = await transaction.get(report);
      const workSnapshot = await transaction.get(job);
      const controlSnapshot = await transaction.get(control);
      const change = update({ record: reportSnapshot.exists ? reportSnapshot.data() : null,
        work: workSnapshot.exists ? workSnapshot.data() : null,
        control: controlSnapshot.exists ? controlSnapshot.data() : {} });
      if (change.work) transaction.set(job, change.work);
      if (change.control) transaction.set(control, change.control);
      return change.result;
    }, { maxAttempts: 3 });
  } };
}

module.exports = { COLLECTIONS, RECONCILE_INTERVAL_MS, createBugReportSlackEvents, createFirestoreSlackEventStore };
