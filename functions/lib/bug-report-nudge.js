"use strict";

const { createHash } = require("node:crypto");
const { accessTierReadsActive } = require("./access-tier-activation");
const { administrativeRoleFromUserDoc, principalFromUserDoc } = require("./principal");
const { hasCapability } = require("./rbac");
const { lastProgressAt, reportProgress } = require("./bug-report-progress");

const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
const NUDGE_DECISIONS = Object.freeze(["approved", "ignored"]);
class NudgeError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function nudgeForReporter(record, now = new Date()) {
  const history = (record.nudgeHistory ?? []).slice(-20).map((entry) => ({
    requestedAt: entry.requestedAt,
    delivery: ["pending", "delivered", "unknown", "terminal_failed", "cancelled"].includes(entry.delivery) ? entry.delivery : "pending",
    decision: ["approved", "ignored"].includes(entry.decision) ? entry.decision : null,
    decidedAt: entry.decidedAt ?? null,
    deliveredAt: entry.deliveredAt ?? null,
  }));
  const progressAt = lastProgressAt(record);
  const requestedAt = history.at(-1)?.requestedAt ?? null;
  const active = reportProgress(record, { now }).active;
  const eligibleAt = active && progressAt ? new Date(Math.max(Date.parse(progressAt) + THREE_DAYS,
    requestedAt ? Date.parse(requestedAt) + THREE_DAYS : 0)).toISOString() : null;
  return {
    version: record.version,
    eligible: active && eligibleAt !== null && now.getTime() > Date.parse(eligibleAt),
    eligibleAt, progressAt, requestedAt, history,
    historyTruncated: (record.nudgeCount ?? history.length) > history.length,
  };
}

async function commitReporterNudge({ firestore, actor, reportId, mutationId, now = () => new Date() }) {
  const { adminLogEntry } = require("./audit");
  const nudgeId = createHash("sha256").update(`${reportId}:${actor.uid}:${mutationId}`).digest("hex").slice(0, 12);
  return firestore.runTransaction(async (transaction) => {
    const active = await accessTierReadsActive(firestore, transaction);
    const profile = (await transaction.get(firestore.doc(`users/${actor.uid}`))).data();
    if (!active) throw new NudgeError(409, "Report nudges are awaiting activation.");
    if (!profile || (profile.active !== undefined && profile.active !== true) ||
        !hasCapability(principalFromUserDoc(actor.uid, profile, true), "reports.view")) {
      throw new NudgeError(403, "An approved, active CMS account is required.");
    }
    const reportRef = firestore.doc(`bug_reports/${reportId}`);
    const receiptRef = firestore.doc(`bugReportMutationReceipts/${reportId}--${mutationId}`);
    const [snapshot, receipt] = await Promise.all([transaction.get(reportRef), transaction.get(receiptRef)]);
    const record = snapshot.data();
    if (!snapshot.exists || record.reporter?.uid !== actor.uid) throw new NudgeError(404, "This report is not available.");
    if (receipt.exists) {
      if (receipt.data().actorUid !== actor.uid || receipt.data().action !== "nudge") throw new NudgeError(409, "Mutation ID is already in use.");
      return { record, replayed: true };
    }
    const at = now();
    const state = nudgeForReporter(record, at);
    if (!state.eligible) throw new NudgeError(409, "Nudge is available after more than three days without progress, and at most once every three days.");
    const entry = { id: nudgeId, requestedAt: at.toISOString(), delivery: "pending", decision: null, decidedAt: null };
    const next = { ...record, nudgeHistory: [...(record.nudgeHistory ?? []).slice(-19), entry],
      nudgeCount: (record.nudgeCount ?? 0) + 1, version: record.version + 1, updatedAt: at.toISOString() };
    transaction.set(reportRef, next);
    transaction.create(receiptRef, { actorUid: actor.uid, action: "nudge", reportId, mutationId, nudgeId, createdAt: at.toISOString() });
    transaction.create(firestore.doc(`bugReportDeliveryOutbox/${reportId}--nudge--${nudgeId}`), {
      reportId, nudgeId, waitingSince: state.progressAt, eventType: "report_nudged", channel: "telegram",
      state: "pending", attemptCount: 0, nextAttemptAt: at, leaseUntil: null, lastError: null, createdAt: at, updatedAt: at,
    });
    transaction.create(firestore.collection("admin_logs").doc(), adminLogEntry({
      actorUid: actor.uid, action: "bug_report.nudge", target: `bug_reports/${reportId}`,
      before: { progressAt: state.progressAt }, after: { nudgeId, requestedAt: entry.requestedAt }, source: { surface: "reports" },
    }));
    return { record: next, replayed: false };
  });
}

function nudgeHistoryPatch(record, nudgeId, fields) {
  return { version: (record?.version ?? 0) + 1, nudgeHistory: (record?.nudgeHistory ?? []).map((entry) => entry.id === nudgeId ? { ...entry, ...fields } : entry) };
}

async function decideNudge({ firestore, actor, reportId, nudgeId, decision, chatId, messageId, now = () => new Date() }) {
  const { adminLogEntry } = require("./audit");
  // The contract imports nudgeForReporter, so resolve its registry after loading.
  const { BUG_REPORT_COLLECTIONS } = require("./bug-report-contract");
  return firestore.runTransaction(async (transaction) => {
    const active = await accessTierReadsActive(firestore, transaction);
    const profile = (await transaction.get(firestore.doc(`users/${actor.uid}`))).data();
    if (!active || !profile || (profile.active !== undefined && profile.active !== true) ||
        !["admin", "super_admin"].includes(administrativeRoleFromUserDoc(profile, true))) {
      throw new NudgeError(403, "Admin access required.");
    }
    const reportRef = firestore.doc(`bug_reports/${reportId}`);
    const outboxRef = firestore.doc(`bugReportDeliveryOutbox/${reportId}--nudge--${nudgeId}`);
    const [reportSnapshot, outboxSnapshot] = await Promise.all([transaction.get(reportRef), transaction.get(outboxRef)]);
    const record = reportSnapshot.data();
    const notification = outboxSnapshot.data();
    if (!record || notification?.eventType !== "report_nudged" || notification.state !== "delivered" ||
        notification.telegramChatId !== String(chatId) || notification.telegramMessageId !== String(messageId)) {
      throw new NudgeError(409, "This nudge is not available from this message.");
    }
    if (notification.decision) {
      if (notification.decision !== decision) throw new NudgeError(409, "This nudge already has a decision.");
      return { record, replayed: true };
    }
    if (!NUDGE_DECISIONS.includes(decision)) throw new NudgeError(400, "Invalid nudge decision.");
    if (decision === "approved" && !reportProgress(record).active) throw new NudgeError(409, "This report is already closed.");
    if (decision === "approved") {
      const currentProgress = Date.parse(lastProgressAt(record));
      const waitingSince = typeof notification.waitingSince === "string" ? Date.parse(notification.waitingSince) : NaN;
      if (!Number.isFinite(currentProgress) || !Number.isFinite(waitingSince) || currentProgress > waitingSince) {
        throw new NudgeError(409, "This nudge is no longer current. Check the report's current progress.");
      }
    }
    const at = now();
    const fields = { decision, decidedAt: at.toISOString() };
    const next = { ...record, ...nudgeHistoryPatch(record, nudgeId, fields), version: record.version + 1, updatedAt: at.toISOString() };
    transaction.update(outboxRef, { ...fields, decidedBy: actor.uid });
    transaction.set(reportRef, next);
    if (decision === "approved") transaction.create(firestore.doc(`${BUG_REPORT_COLLECTIONS.followupOutbox}/${reportId}--${nudgeId}`), {
      schema: 1, operation: "investigate_report", reportId, nudgeId, requestedBy: record.reporter.uid,
      approvedBy: actor.uid, approvedAt: at.toISOString(), waitingSince: notification.waitingSince,
      state: "pending", attemptCount: 0, nextAttemptAt: at, leaseUntil: null, lastError: null, createdAt: at, updatedAt: at,
    });
    transaction.create(firestore.collection("admin_logs").doc(), adminLogEntry({
      actorUid: actor.uid, action: `bug_report.nudge_${decision}`, target: `bug_reports/${reportId}`,
      before: { nudgeId, decision: null }, after: { nudgeId, ...fields }, source: { surface: "telegram" },
    }));
    return { record: next, replayed: false };
  });
}

module.exports = { THREE_DAYS, NUDGE_DECISIONS, NudgeError, nudgeForReporter, commitReporterNudge, nudgeHistoryPatch, decideNudge };
