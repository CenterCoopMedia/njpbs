"use strict";

// Source-only host adapter. No trigger, credentials, SDK initialization or network
// client lives here. Only the reviewed host runner may opt in to delivery.
const { createHash, randomUUID } = require("node:crypto");
const { ADMIN_ORIGIN, isBugReportId } = require("./bug-report-contract");

const COLLECTIONS = Object.freeze({
  reports: "bug_reports", deliveries: "bugReportSlackDeliveries", control: "bugReportSlackControl",
});
const CATEGORY_LABELS = Object.freeze({ bug: "Bug or error", suggestion: "Suggestion", question: "Question" });
const AREA_LABELS = Object.freeze({
  sign_in_access: "Sign-in and access", content_editing: "Content editing",
  save_revision: "Saving and revisions", review_publish: "Review and publishing",
  media: "Media", navigation_ui: "Navigation and interface", other: "Other",
});
const FRESHNESS_CAVEATS = Object.freeze({
  stale: "Engineering updates are out of date. This is the last known progress.",
  unavailable: "Engineering updates are unavailable. This is the last known progress.",
});
const USER_ID = /^[UW][A-Z0-9]{8,32}$/;
const TEAM_ID = /^T[A-Z0-9]{8,32}$/;
const CHANNEL_ID = /^[CG][A-Z0-9]{8,32}$/;
const MESSAGE_TS = /^\d{10,16}\.\d{6}$/;
const MAX_REPORTS = 50;
const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 10_000;
const LEASE_MS = 60_000;
const RUN_LEASE_MS = 240_000;
const RUN_BUDGET_MS = 170_000;
const SUCCESS = new Set(["created", "updated", "unchanged", "not_boardwalk"]);
const DRY_RUN_SUCCESS = new Set(["dry_run", "not_boardwalk"]);
const RETRYABLE_ERRORS = new Set(["ratelimited", "rate_limited", "request_timeout", "service_unavailable", "internal_error", "fatal_error"]);
// Only these API rejections establish that no initial message was accepted.
// Internal errors/timeouts can occur after partial success, even with ok:false.
const DEFINITIVE_REJECTIONS = new Set([
  "ratelimited", "rate_limited", "missing_scope", "not_in_channel", "channel_not_found",
  "invalid_auth", "not_authed", "account_inactive", "token_revoked", "is_archived",
  "no_permission", "restricted_action", "msg_too_long", "invalid_arguments",
]);

class SlackReportError extends Error {
  constructor(code) { super(code); this.name = "SlackReportError"; this.code = code; }
}
function fail(code) { throw new SlackReportError(code); }
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function normalizedEmail(value) {
  if (typeof value !== "string") fail("reporter_identity_unverified");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("reporter_identity_unverified");
  return email;
}
function validateConfig(config) {
  if (!config || !TEAM_ID.test(config.workspaceId) || !CHANNEL_ID.test(config.channelId) || !USER_ID.test(config.botUserId)) {
    fail("configuration_invalid");
  }
  if (!config.identity || !["email-lookup", "verified-map"].includes(config.identity.mode)) fail("identity_configuration_required");
  if (config.isolatedTest) {
    const test = config.isolatedTest;
    const unique = (values, valid, maximum) => Array.isArray(values) && values.length > 0 &&
      values.length <= maximum && new Set(values).size === values.length && values.every(valid);
    if (!/^[a-z0-9_-]{1,80}$/.test(test.channelName) || test.channelName === "tech" ||
        !unique(test.reportIds, isBugReportId, 10) ||
        !unique(test.reporterUids, (uid) => typeof uid === "string" && uid.trim().length > 0 && uid.length <= 128, 10) ||
        !unique(test.memberIds, (id) => USER_ID.test(id), 2) || test.memberIds.length !== 2 || !test.memberIds.includes(config.botUserId)) {
      fail("test_configuration_invalid");
    }
  }
  return config;
}
function defaultProject(record, options) { return require("./bug-report-progress").reportProgress(record, options); }
function escapeSlack(text) { return String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function sourceRevision(record) {
  const updatedAt = typeof record.updatedAt?.toMillis === "function" ? record.updatedAt.toMillis() : Date.parse(record.updatedAt);
  if (!Number.isSafeInteger(record.version) || record.version < 1 || !Number.isFinite(updatedAt)) fail("source_revision_invalid");
  return { version: record.version, updatedAt };
}
function sameRevision(a, b) { return a.version === b.version && a.updatedAt === b.updatedAt; }
function olderRevision(a, b) { return b && (a.version < b.version || a.updatedAt < b.updatedAt); }
function reporterKey(record) {
  if (typeof record.reporter?.uid !== "string" || !record.reporter.uid.trim()) fail("reporter_identity_unverified");
  return digest(`${record.reporter.uid}\0${normalizedEmail(record.reporter.email)}`);
}
function result(reportId, status, code) { return { reportId, status, ...(code ? { code } : {}) }; }

function buildSlackCard(record, { config, userId = null, now = Date.now(), project = defaultProject } = {}) {
  validateConfig(config);
  if (!isBugReportId(record?.id)) fail("report_id_invalid");
  if (userId !== null && !USER_ID.test(userId)) fail("reporter_identity_unverified");
  const progress = project(record, { now: new Date(now) });
  // The shared projection owns these fixed public-safe strings. No issue title,
  // freeform report field, provider response, diagnostic or attachment is used.
  if (typeof progress.label !== "string" || typeof progress.detail !== "string" || progress.label.length > 100 || progress.detail.length > 500) fail("progress_projection_invalid");
  const category = Object.hasOwn(CATEGORY_LABELS, record.category) ? CATEGORY_LABELS[record.category] : "Report";
  const area = Object.hasOwn(AREA_LABELS, record.area) ? AREA_LABELS[record.area] : "Other";
  return {
    channel: config.channelId,
    text: [
      `Boardwalk report ${record.id}${userId ? ` · <@${userId}>` : ""}`,
      `${category} · ${area}`,
      `${escapeSlack(progress.label)}: ${escapeSlack(progress.detail)}`,
      ...(Object.hasOwn(FRESHNESS_CAVEATS, progress.syncState) ? [FRESHNESS_CAVEATS[progress.syncState]] : []),
      `<${ADMIN_ORIGIN}/reports/${record.id}|View report in Boardwalk>`,
    ].join("\n"),
    mrkdwn: true, parse: "none", link_names: false, unfurl_links: false, unfurl_media: false,
  };
}

async function invoke(slack, method, args = {}) {
  if (typeof slack?.[method] !== "function") fail("slack_client_unavailable");
  const controller = new AbortController();
  let timer;
  try {
    const response = await Promise.race([
      Promise.resolve().then(() => slack[method](args, { signal: controller.signal, timeoutMs: REQUEST_TIMEOUT_MS })),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new SlackReportError("request_uncertain")); }, REQUEST_TIMEOUT_MS); }),
    ]);
    if (!["chatPostMessage", "chatUpdate"].includes(method) && response?.ok === false && RETRYABLE_ERRORS.has(response.error)) {
      const error = new SlackReportError("verification_retry_required");
      const seconds = Number(response.retryAfter);
      if (Number.isFinite(seconds) && seconds > 0) error.retryAfterMs = Math.min(3_600_000, Math.ceil(seconds * 1_000));
      throw error;
    }
    return response;
  } catch (error) {
    if (error instanceof SlackReportError && error.code === "verification_retry_required") throw error;
    // Never persist, return or log a provider body, URL, token or error message.
    fail("request_uncertain");
  } finally { clearTimeout(timer); }
}

async function verifyRuntime(slack, config) {
  if (config.activationVerified !== true) fail("runtime_activation_unverified");
  const auth = await invoke(slack, "authTest");
  if (!auth?.ok || auth.team_id !== config.workspaceId || auth.user_id !== config.botUserId || !auth.bot_id) fail("runtime_identity_unverified");
  const response = await invoke(slack, "conversationsInfo", { channel: config.channelId });
  const channel = response?.channel;
  if (!response?.ok || channel?.id !== config.channelId || channel.name !== (config.isolatedTest?.channelName || "tech") || channel.is_member !== true || channel.is_archived !== false || channel.is_ext_shared !== false ||
      (channel.context_team_id && channel.context_team_id !== config.workspaceId)) fail("runtime_channel_unverified");
  if (config.isolatedTest) {
    if (channel.is_private !== true) fail("test_channel_not_private");
    const membership = await invoke(slack, "conversationsMembers", { channel: config.channelId, limit: 100 });
    const expected = config.isolatedTest.memberIds;
    // Small rehearsals must fit on one complete page. Never infer completeness
    // from a short page, nor silently accept an additional staff member.
    if (!membership?.ok || !Array.isArray(membership.members) ||
        membership.response_metadata?.next_cursor || membership.members.length !== expected.length ||
        new Set(membership.members).size !== expected.length ||
        !membership.members.every((id) => expected.includes(id))) fail("test_membership_unverified");
  }
}

async function resolveReporterIdentity(record, { slack, config }) {
  validateConfig(config);
  const email = normalizedEmail(record.reporter?.email);
  const key = reporterKey(record);
  let response;
  let expectedUserId = null;
  if (config.identity.mode === "email-lookup") {
    if (config.identity.lookupAuthorized !== true) fail("reporter_lookup_not_authorized");
    response = await invoke(slack, "usersLookupByEmail", { email });
  } else {
    const matches = (Array.isArray(config.identity.members) ? config.identity.members : []).filter((entry) =>
      typeof entry.email === "string" && entry.email.trim().toLowerCase() === email && entry.workspaceId === config.workspaceId);
    if (matches.length !== 1 || !USER_ID.test(matches[0].userId)) fail("reporter_mapping_required");
    expectedUserId = matches[0].userId;
    response = await invoke(slack, "usersInfo", { user: expectedUserId });
  }
  const user = response?.user;
  if (!response?.ok || !user || !USER_ID.test(user.id) || (expectedUserId && user.id !== expectedUserId) ||
      user.team_id !== config.workspaceId || user.deleted !== false || user.is_bot !== false || user.is_app_user === true ||
      normalizedEmail(user.profile?.email) !== email) fail("reporter_identity_unverified");
  return { userId: user.id, reporterKey: key };
}

function verifyTestReport(record, config) {
  if (config.isolatedTest && (!config.isolatedTest.reportIds.includes(record?.id) ||
      !config.isolatedTest.reporterUids.includes(record?.reporter?.uid))) fail("test_report_not_allowed");
}

function backoff(attempt, response, now) {
  const retryAfter = Number(response?.retryAfter);
  const delay = Math.max(30_000 * 2 ** (attempt - 1), Number.isFinite(retryAfter) ? Math.max(0, retryAfter * 1_000) : 0);
  return now + Math.min(delay, 3_600_000);
}
function sameOwner(delivery, config) {
  return delivery.workspaceId === config.workspaceId && delivery.channelId === config.channelId && delivery.botUserId === config.botUserId;
}

function slackConfigBinding(config) { validateConfig(config); return digest(JSON.stringify(config)); }

function createBugReportSlackConsumer({ store, slack, config, now = Date.now, project = defaultProject }) {
  config = structuredClone(config);
  validateConfig(config);
  const binding = slackConfigBinding(config);

  async function syncReport(reportId, { send = false } = {}) {
    if (!isBugReportId(reportId)) return result(reportId, "blocked", "report_id_invalid");
    if (send && config.activationVerified !== true) return result(reportId, "blocked", "runtime_activation_unverified");
    let snapshot;
    let revision;
    let identity;
    let payload;
    let payloadHash;
    try {
      snapshot = await store.readSnapshot(reportId);
      if (!snapshot.record || snapshot.record.id !== reportId) return result(reportId, "blocked", "report_unavailable");
      verifyTestReport(snapshot.record, config);
      if (snapshot.record.environment?.native) return result(reportId, "not_boardwalk");
      revision = sourceRevision(snapshot.record);
      if (!send) {
        buildSlackCard(snapshot.record, { config, now: now(), project });
        return result(reportId, "dry_run");
      }
      await verifyRuntime(slack, config);
      identity = await resolveReporterIdentity(snapshot.record, { slack, config });
      if (config.isolatedTest && !config.isolatedTest.memberIds.includes(identity.userId)) fail("test_reporter_not_in_channel");
      payload = buildSlackCard(snapshot.record, { config, userId: identity.userId, now: now(), project });
      payloadHash = digest(JSON.stringify(payload));
    } catch (error) {
      return { ...result(reportId, "blocked", error instanceof SlackReportError ? error.code : "source_read_failed"),
        ...(Number.isFinite(error?.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}) };
    }
    const leaseToken = randomUUID();
    let claim;
    try {
      claim = await store.changeDelivery(reportId, ({ record, delivery }) => {
        if (!record || record.id !== reportId) return { result: result(reportId, "blocked", "report_unavailable") };
        verifyTestReport(record, config);
        const currentRevision = sourceRevision(record);
        const currentHash = digest(JSON.stringify(buildSlackCard(record, { config, userId: identity.userId, now: now(), project })));
        if (!sameRevision(revision, currentRevision) || currentHash !== payloadHash || reporterKey(record) !== identity.reporterKey) {
          return { result: result(reportId, "source_changed") };
        }
        if (delivery && !sameOwner(delivery, config)) return { result: result(reportId, "blocked", "message_owner_changed") };
        if (delivery && (delivery.reporterKey !== identity.reporterKey || delivery.reporterUserId !== identity.userId)) {
          return { result: result(reportId, "blocked", "reporter_identity_changed") };
        }
        if (delivery && (delivery.reportId !== reportId || !["sending", "delivered", "retryable_failed", "terminal_failed", "unknown"].includes(delivery.state) ||
            (delivery.state === "delivered" && !MESSAGE_TS.test(delivery.rootTs)))) {
          return { result: result(reportId, "blocked", "message_mapping_invalid") };
        }
        if (delivery?.state === "unknown" || (delivery?.state === "sending" && !delivery.rootTs && (!Number.isFinite(delivery.leaseUntil) || delivery.leaseUntil <= now()))) {
          return { next: { ...delivery, state: "unknown", lastErrorCode: "initial_send_uncertain", leaseToken: null, leaseUntil: null }, result: result(reportId, "reconciliation_required") };
        }
        if (delivery?.state === "sending" && delivery.leaseUntil > now()) return { result: result(reportId, "busy") };
        if (olderRevision(revision, delivery?.desiredRevision) || olderRevision(revision, delivery?.appliedRevision)) return { result: result(reportId, "stale_source") };
        if (delivery?.rootTs && !MESSAGE_TS.test(delivery.rootTs)) return { result: result(reportId, "blocked", "message_mapping_invalid") };
        if (delivery?.state === "terminal_failed") return { result: result(reportId, "terminal_failed", delivery.lastErrorCode) };
        if (delivery?.nextAttemptAt > now()) return { result: { ...result(reportId, "backoff"), retryAfterMs: delivery.nextAttemptAt - now() } };
        if (delivery?.state === "delivered" && delivery.appliedHash === payloadHash) {
          return { next: { ...delivery, desiredRevision: revision, appliedRevision: revision }, result: result(reportId, "unchanged") };
        }
        const attempts = delivery?.desiredHash === payloadHash ? (delivery.attemptCount || 0) + 1 : 1;
        if (attempts > MAX_ATTEMPTS) return { next: { ...delivery, state: "terminal_failed", lastErrorCode: "attempts_exhausted" }, result: result(reportId, "terminal_failed", "attempts_exhausted") };
        const next = {
          ...(delivery || {}), schemaVersion: 1, reportId, workspaceId: config.workspaceId,
          channelId: config.channelId, botUserId: config.botUserId, reporterUserId: identity.userId,
          reporterKey: identity.reporterKey, rootTs: delivery?.rootTs || null,
          desiredRevision: revision, desiredHash: payloadHash, state: "sending", attemptCount: attempts,
          leaseToken, leaseUntil: now() + LEASE_MS, nextAttemptAt: null, lastErrorCode: null,
          createdAt: delivery?.createdAt || now(), updatedAt: now(),
        };
        return { next, result: { claimed: true, delivery: next } };
      });
    } catch (error) {
      return result(reportId, "blocked", error instanceof SlackReportError ? error.code : "delivery_claim_failed");
    }
    if (!claim.claimed) return claim;
    const delivery = claim.delivery;
    const updating = Boolean(delivery.rootTs);
    let response;
    let uncertain = false;
    try {
      response = await invoke(slack, updating ? "chatUpdate" : "chatPostMessage", updating ? { ...payload, ts: delivery.rootTs } : payload);
    } catch { uncertain = true; }
    const receiptMatches = response?.ok === true && response.channel === config.channelId && MESSAGE_TS.test(response.ts) &&
      (updating ? response.ts === delivery.rootTs : response.message?.user === config.botUserId && (!response.message.thread_ts || response.message.thread_ts === response.ts));
    if (response?.ok !== false && !receiptMatches) uncertain = true;
    if (!updating && response?.ok === false && !DEFINITIVE_REJECTIONS.has(response.error)) uncertain = true;
    const at = now();
    let patch;
    let outcome;
    if (receiptMatches) {
      patch = { state: "delivered", rootTs: response.ts, appliedHash: payloadHash, appliedRevision: revision, deliveredAt: at, nextAttemptAt: null, lastErrorCode: null };
      outcome = updating ? "updated" : "created";
    } else if (uncertain && !updating) {
      patch = { state: "unknown", nextAttemptAt: null, lastErrorCode: "initial_send_uncertain" };
      outcome = "reconciliation_required";
    } else {
      const retryable = uncertain || RETRYABLE_ERRORS.has(response?.error);
      const retry = retryable && delivery.attemptCount < MAX_ATTEMPTS;
      patch = { state: retry ? "retryable_failed" : "terminal_failed", nextAttemptAt: retry ? backoff(delivery.attemptCount, response, at) : null,
        lastErrorCode: retryable ? (retry ? "delivery_retry_required" : "attempts_exhausted") : "slack_request_rejected" };
      outcome = patch.state;
    }
    try {
      return await store.changeDelivery(reportId, ({ delivery: current }) => {
        if (!current || current.leaseToken !== leaseToken || current.state !== "sending") return { result: result(reportId, "reconciliation_required", "delivery_lease_lost") };
        return { next: { ...current, ...patch, updatedAt: at, leaseToken: null, leaseUntil: null }, result: { ...result(reportId, outcome), ...(patch.nextAttemptAt ? { retryAfterMs: Math.max(0, patch.nextAttemptAt - at) } : {}) } };
      });
    } catch {
      // The post may have succeeded while its receipt failed to commit. Leave
      // the durable sending lease intact; expiry cannot resend an initial card.
      return result(reportId, "reconciliation_required", "delivery_receipt_uncommitted");
    }
  }

  async function runBatch({ send = false, maxReports = 10 } = {}) {
    if (!Number.isInteger(maxReports) || maxReports < 1 || maxReports > MAX_REPORTS) fail("batch_limit_invalid");
    const startedAt = now();
    const runToken = randomUUID();
    let cursor = null;
    const results = [];
    if (send) {
      if (config.activationVerified !== true) return { status: "blocked", code: "runtime_activation_unverified", results };
      const claim = await store.changeControl((current) => {
        if (current.runToken && current.leaseUntil > now()) return { result: { busy: true } };
        const next = { ...current, cursor: current.cursor || null, runToken, leaseUntil: now() + RUN_LEASE_MS };
        return { next, result: { cursor: next.cursor } };
      });
      if (claim.busy) return { status: "busy", results };
      cursor = claim.cursor;
    }
    let status = "bounded";
    try {
      while (results.length < maxReports && now() - startedAt < RUN_BUDGET_MS) {
        const ids = await store.listReportIds({ afterId: cursor, limit: Math.min(25, maxReports - results.length) });
        if (!ids.length) {
          cursor = null; status = "sweep_complete";
          if (send) await checkpoint();
          break;
        }
        for (const id of ids) {
          if (now() - startedAt >= RUN_BUDGET_MS) break;
          const entry = await syncReport(id, { send });
          results.push(entry);
          if (!(send ? SUCCESS : DRY_RUN_SUCCESS).has(entry.status)) return { status: "blocked", results, cursor };
          cursor = id;
          if (send) await checkpoint();
        }
      }
      return { status, results, cursor };
    } catch {
      return { status: "blocked", code: "batch_storage_failed", results, cursor };
    } finally {
      if (send) {
        await store.changeControl((current) => current.runToken === runToken
          ? { next: { ...current, runToken: null, leaseUntil: null }, result: null }
          : { result: null });
      }
    }
    async function checkpoint() {
      await store.changeControl((current) => {
        if (current.runToken !== runToken) fail("run_lease_lost");
        return { next: { ...current, cursor, updatedAt: now() }, result: null };
      });
    }
  }
  return { binding, syncReport, runBatch };
}

// firebase-admin's Firestore instance is supplied by an authorized host. These
// private collections must be inaccessible to ordinary CMS clients. Each report
// lease is atomic; provider calls must never run inside transaction callbacks.
function createFirestoreSlackStore(db, { config } = {}) {
  validateConfig(config);
  const targetId = digest(`${config.workspaceId}\0${config.channelId}\0${config.botUserId}`);
  const controlRef = db.collection(COLLECTIONS.control).doc(targetId);
  const refs = (id) => {
    if (!isBugReportId(id)) fail("report_id_invalid");
    return [db.collection(COLLECTIONS.reports).doc(id), db.collection(COLLECTIONS.deliveries).doc(id)];
  };
  return {
    readSnapshot: async (id) => {
      const [reportRef, deliveryRef] = refs(id);
      return db.runTransaction(async (transaction) => {
        const report = await transaction.get(reportRef);
        const delivery = await transaction.get(deliveryRef);
        return { record: report.exists ? report.data() : null, delivery: delivery.exists ? delivery.data() : null };
      }, { readOnly: true });
    },
    changeDelivery: async (id, update) => {
      const [reportRef, deliveryRef] = refs(id);
      return db.runTransaction(async (transaction) => {
        const report = await transaction.get(reportRef);
        const delivery = await transaction.get(deliveryRef);
        const change = update({ record: report.exists ? report.data() : null, delivery: delivery.exists ? delivery.data() : null });
        if (change.next) transaction.set(deliveryRef, change.next);
        return change.result;
      }, { maxAttempts: 3 });
    },
    listReportIds: async ({ afterId, limit }) => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 25 || (afterId && !isBugReportId(afterId))) fail("scan_bounds_invalid");
      let query = db.collection(COLLECTIONS.reports).orderBy("__name__");
      if (afterId) query = query.startAfter(afterId);
      const snapshot = await query.limit(limit).select().get();
      return snapshot.docs.map((document) => document.id);
    },
    readControl: async () => { const snapshot = await controlRef.get(); return snapshot.exists ? snapshot.data() : {}; },
    changeControl: async (update) => db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(controlRef);
      const change = update(snapshot.exists ? snapshot.data() : {});
      if (change.next) transaction.set(controlRef, change.next);
      return change.result;
    }, { maxAttempts: 3 }),
  };
}

module.exports = { COLLECTIONS, MAX_REPORTS, SlackReportError, buildSlackCard, createBugReportSlackConsumer, createFirestoreSlackStore, resolveReporterIdentity, sourceRevision, reporterKey, verifyTestReport, validateConfig, slackConfigBinding };
