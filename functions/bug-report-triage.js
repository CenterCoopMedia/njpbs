"use strict";

// Server-owned read and triage boundary for #457. Reporters can read only their own
// filed reports. Telegram is the mutation path for CMS-filed reports. Administrators
// can list all reports and read private evidence and audit history for a filed report.

const { cmsOnRequest } = require("./lib/cms-edge");
const { createHash } = require("node:crypto");
const logger = require("firebase-functions/logger");
const { db } = require("./lib/firebase");
const { githubRepository } = require("./lib/bug-report-github-config");
const { hasCapability } = require("./lib/rbac");
const { requirePrincipal, isAdmin, AuthError, ForbiddenError } = require("./lib/auth");
const { accessTierReadsActive, userDocUsesAccessTier } = require("./lib/access-tier-activation");
const {
  administrativeRoleFromStoredUserDoc,
  principalFromUserDoc,
} = require("./lib/principal");
const { AUDIT_COLLECTIONS, adminLogEntry } = require("./lib/audit");
const { resolutionEmailLines } = require("./lib/bug-report-email-resolution");
const { progressChangeFields } = require("./lib/bug-report-progress");
const { NudgeError, commitReporterNudge, nudgeForReporter } = require("./lib/bug-report-nudge");
const {
  BUG_REPORT_COLLECTIONS,
  BUG_REPORT_STATUSES,
  BugReportContractError,
  canTransitionBugReportStatus,
  isBugReportId,
  normalizeActionableResolution,
  reportForAdmin,
  reportForList,
  reportForReporter,
  reportForStaff,
  shouldEmailBugReport,
} = require("./lib/bug-report-contract");

const MAX_LIST_RESULTS = 100;
const MAX_RELATED_REPORTS = 10;
const MAX_GITHUB_NUMBER = 2_147_483_647;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADMIN_ACTIONS = new Set([
  "acknowledge",
  "take_over",
  "assign",
  "set_status",
  "set_related_reports",
  "update_resolution",
  "retry_notification",
  "create_github_issue",
  "create_github_issue_and_fix",
  "attach_github_issue",
  "attach_github_pr",
  "sync_github",
  "retry_github",
]);
const TERMINAL_STATUSES = new Set(["resolved", "dismissed"]);
const ACTION_FIELDS = Object.freeze({
  acknowledge: [],
  take_over: [],
  assign: ["ownerUid"],
  set_status: ["status"],
  set_related_reports: ["relatedReportIds"],
  update_resolution: ["actionableResolution"],
  retry_notification: [],
  create_github_issue: [],
  create_github_issue_and_fix: [],
  attach_github_issue: ["githubNumber"],
  attach_github_pr: ["githubNumber"],
  sync_github: [],
  retry_github: [],
});

class BugReportTriageError extends Error {
  constructor(status, message, data = {}) {
    super(message);
    this.name = "BugReportTriageError";
    this.status = status;
    this.data = data;
  }
}

function clientSource(req) {
  return {
    ip: req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || null,
    requestId: req.headers["x-njpbs-request-id"] || null,
  };
}

function requireJsonPost(req) {
  if (req.method !== "POST") {
    throw new BugReportTriageError(405, "Method not allowed");
  }
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    throw new BugReportTriageError(400, "A JSON request body is required");
  }
}

function validateReportId(value) {
  if (!isBugReportId(value)) {
    throw new BugReportTriageError(400, "Report ID is invalid");
  }
  return value;
}

function requireApprovedPrincipal(user) {
  const approved = user?.emailVerified === true &&
    hasCapability(user?.principal, "reports.view");
  if (!approved) {
    throw new BugReportTriageError(403, "An approved, active CMS account is required");
  }
  return user;
}

function boundedDocumentId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 1_500 &&
    value === value.trim() && !value.includes("/") && value !== "." && value !== ".." &&
    !/^__.*__$/.test(value);
}

function dateMillis(value) {
  if (typeof value === "string") return Date.parse(value);
  if (value instanceof Date) return value.getTime();
  if (value && typeof value.toMillis === "function") return value.toMillis();
  return Number.NaN;
}

function unresolvedFirst(left, right) {
  const leftTerminal = TERMINAL_STATUSES.has(left.status) ? 1 : 0;
  const rightTerminal = TERMINAL_STATUSES.has(right.status) ? 1 : 0;
  if (leftTerminal !== rightTerminal) return leftTerminal - rightTerminal;
  if (left.severity === "blocker" && right.severity !== "blocker") return -1;
  if (right.severity === "blocker" && left.severity !== "blocker") return 1;
  return dateMillis(right.createdAt) - dateMillis(left.createdAt);
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const fields = Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestFingerprint(body) {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

function isActiveStaffRecord(value, tiersActive = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (tiersActive && Object.hasOwn(value, "accessTier")) {
    return hasCapability(principalFromUserDoc("assignment", value, tiersActive), "reports.view");
  }
  if (value.active === false) return false;
  if (value.role === "admin" || value.role === "super_admin") return true;
  return Array.isArray(value.grants) && value.grants.some((grant) =>
    grant && typeof grant === "object" &&
    ["contributor", "editor", "admin", "super_admin"].includes(grant.role));
}

function validateListRequest(body) {
  const allowed = new Set(["view", "limit"]);
  const unknown = Object.keys(body).find((field) => !allowed.has(field));
  if (unknown) throw new BugReportTriageError(400, `Unknown list field ${unknown}`);
  const view = body.view ?? "mine";
  if (!["mine", "all"].includes(view)) {
    throw new BugReportTriageError(400, "Report view is invalid");
  }
  const limit = body.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_RESULTS) {
    throw new BugReportTriageError(400, "Report limit is invalid");
  }
  return { view, limit };
}

function validateUpdateRequest(body) {
  const baseFields = [
    "reportId",
    "baseVersion",
    "mutationId",
    "action",
  ];
  const reportId = validateReportId(body.reportId);
  if (!Number.isSafeInteger(body.baseVersion) || body.baseVersion < 1) {
    throw new BugReportTriageError(400, "Base version is invalid");
  }
  if (typeof body.mutationId !== "string" || !UUID_PATTERN.test(body.mutationId)) {
    throw new BugReportTriageError(400, "Mutation ID is invalid");
  }
  if (!ADMIN_ACTIONS.has(body.action)) {
    throw new BugReportTriageError(400, "Report action is invalid");
  }
  const actionFields = ACTION_FIELDS[body.action];
  const allowed = new Set([...baseFields, ...actionFields]);
  const unknown = Object.keys(body).find((field) => !allowed.has(field));
  if (unknown) throw new BugReportTriageError(400, `Unknown update field ${unknown}`);
  const missing = actionFields.find((field) => !Object.hasOwn(body, field));
  if (missing) throw new BugReportTriageError(400, `Update field ${missing} is required`);
  return {
    reportId,
    baseVersion: body.baseVersion,
    mutationId: body.mutationId.toLocaleLowerCase("en-US"),
    action: body.action,
  };
}

function canonicalRelatedReportIds(value, reportId) {
  if (!Array.isArray(value) || value.length > MAX_RELATED_REPORTS) {
    throw new BugReportTriageError(400, "Related reports must be a bounded list");
  }
  const ids = [];
  for (const candidate of value) {
    const id = validateReportId(candidate);
    if (id === reportId) {
      throw new BugReportTriageError(400, "A report cannot relate to itself");
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return ids.sort();
}

function actionAuditSummary(record) {
  return {
    status: record.status,
    ownerUid: record.ownerUid,
    relatedReportIds: record.links?.relatedReportIds ?? [],
    acknowledgedAt: record.acknowledgedAt,
    actionableResolution: record.actionableResolution,
    githubIssueNumbers: record.links?.githubIssueNumbers ?? [],
    pullRequestNumbers: record.links?.pullRequestNumbers ?? [],
    githubDelivery: record.githubDelivery ?? null,
    version: record.version,
  };
}

function validateGithubNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_GITHUB_NUMBER) {
    throw new BugReportTriageError(400, "GitHub number is invalid");
  }
  return value;
}

function githubJobForAction(action, body, record) {
  if (action === "create_github_issue") return { operation: "create_issue", targetNumber: null };
  if (action === "create_github_issue_and_fix") {
    return { operation: "create_issue_and_fix", targetNumber: null };
  }
  if (action === "attach_github_issue") {
    return { operation: "attach_issue", targetNumber: validateGithubNumber(body.githubNumber) };
  }
  if (action === "attach_github_pr") {
    return { operation: "attach_pull_request", targetNumber: validateGithubNumber(body.githubNumber) };
  }
  if (action === "sync_github") {
    if (!(record.links?.githubIssueNumbers?.length || record.links?.pullRequestNumbers?.length)) {
      throw new BugReportTriageError(409, "This report has no GitHub work to sync");
    }
    return { operation: "sync", targetNumber: null };
  }
  if (action === "retry_github") {
    const delivery = record.githubDelivery ?? {};
    if (!["retryable_failed", "unknown", "terminal_failed"].includes(delivery.state)) {
      throw new BugReportTriageError(409, "This GitHub handoff is not ready to retry");
    }
    if (!["create_issue", "create_issue_and_fix", "attach_issue", "attach_pull_request", "sync"].includes(delivery.lastOperation)) {
      throw new BugReportTriageError(409, "This GitHub handoff has no retryable operation");
    }
    return {
      operation: delivery.lastOperation,
      targetNumber: delivery.lastTargetNumber ?? null,
    };
  }
  return null;
}

async function applyAdminAction({
  firestore,
  transaction,
  record,
  body,
  actor,
  nowIso,
}) {
  const next = structuredClone(record);
  const action = body.action;
  let auditAction;

  if (action === "acknowledge") {
    if (next.acknowledgedAt) {
      throw new BugReportTriageError(409, "This report is already acknowledged");
    }
    next.acknowledgedAt = nowIso;
    next.acknowledgedBy = actor.uid;
    if (next.status === "open") next.status = "acknowledged";
    auditAction = "bug_report.acknowledge";
  } else if (action === "take_over") {
    if (next.ownerUid === actor.uid) {
      throw new BugReportTriageError(409, "This report is already assigned to you");
    }
    next.ownerUid = actor.uid;
    next.assignedAt = nowIso;
    auditAction = "bug_report.take_over";
  } else if (action === "assign") {
    if (body.ownerUid !== null && !boundedDocumentId(body.ownerUid)) {
      throw new BugReportTriageError(400, "Owner UID is invalid");
    }
    if (typeof body.ownerUid === "string") {
      const ownerSnapshot = await transaction.get(
        firestore.collection("users").doc(body.ownerUid),
      );
      if (!ownerSnapshot.exists || !isActiveStaffRecord(ownerSnapshot.data(),
          await userDocUsesAccessTier(firestore, ownerSnapshot.data(), transaction))) {
        throw new BugReportTriageError(400, "The selected owner is not active CMS staff");
      }
    }
    next.ownerUid = body.ownerUid;
    next.assignedAt = body.ownerUid === null ? null : nowIso;
    auditAction = "bug_report.assign";
  } else if (action === "set_status") {
    if (!BUG_REPORT_STATUSES.includes(body.status)) {
      throw new BugReportTriageError(400, "Report status is invalid");
    }
    if (next.status === body.status) {
      throw new BugReportTriageError(409, `This report is already ${body.status}`);
    }
    if (!canTransitionBugReportStatus(next.status, body.status)) {
      throw new BugReportTriageError(
        409,
        `A report cannot move from ${next.status} to ${body.status}`,
      );
    }
    next.status = body.status;
    next.resolvedAt = body.status === "resolved" ? nowIso : null;
    next.resolvedBy = body.status === "resolved" ? actor.uid : null;
    next.dismissedAt = body.status === "dismissed" ? nowIso : null;
    next.dismissedBy = body.status === "dismissed" ? actor.uid : null;
    auditAction = "bug_report.status";
  } else if (action === "set_related_reports") {
    const relatedReportIds = canonicalRelatedReportIds(
      body.relatedReportIds,
      record.id,
    );
    if (relatedReportIds.length > 0) {
      const snapshots = await Promise.all(relatedReportIds.map((id) =>
        transaction.get(firestore.collection(BUG_REPORT_COLLECTIONS.reports).doc(id))));
      if (snapshots.some((snapshot) => !snapshot.exists)) {
        throw new BugReportTriageError(400, "A related report is not available");
      }
    }
    next.links.relatedReportIds = relatedReportIds;
    auditAction = "bug_report.relate";
  } else if (action === "update_resolution") {
    next.actionableResolution = normalizeActionableResolution(body.actionableResolution);
    auditAction = "bug_report.resolution";
  } else if (action === "retry_notification") {
    if (!["retryable_failed", "unknown", "terminal_failed"].includes(next.deliveryStatus)) {
      throw new BugReportTriageError(409, "This report notification is not ready to retry");
    }
    next.deliveryStatus = "pending";
    next.delivery.lastError = null;
    auditAction = "bug_report.notification_retry";
  } else {
    const job = githubJobForAction(action, body, next);
    if (!job) throw new BugReportTriageError(400, "Report action is invalid");
    if (
      ["create_github_issue", "create_github_issue_and_fix"].includes(action) &&
      next.githubDelivery?.state === "pending"
    ) {
      throw new BugReportTriageError(409, "This report already has a GitHub handoff in progress");
    }
    if (["create_github_issue", "create_github_issue_and_fix"].includes(action) && next.links?.githubIssueNumbers?.length) {
      throw new BugReportTriageError(409, "This report already has a GitHub issue");
    }
    next.githubDelivery = {
      ...(next.githubDelivery ?? {}),
      state: "pending",
      lastError: null,
      lastOperation: job.operation,
      lastTargetNumber: job.targetNumber,
      ...(job.operation === "create_issue_and_fix"
        ? { fixStatus: "pending", fixRequestedAt: nowIso }
        : {}),
    };
    auditAction = `bug_report.github_${job.operation}`;
  }

  return { next, auditAction };
}

async function commitAdminAction({
  firestore,
  actor,
  body,
  source,
  now = () => new Date().toISOString(),
  adminLogEntryFn = adminLogEntry,
  authorizeInTransaction,
}) {
  const validated = validateUpdateRequest(body);
  const fingerprint = requestFingerprint(body);
  return firestore.runTransaction(async (transaction) => {
    if (authorizeInTransaction) {
      await authorizeInTransaction(transaction, actor);
    }
    const reportRef = firestore.collection(BUG_REPORT_COLLECTIONS.reports)
      .doc(validated.reportId);
    const receiptRef = firestore.collection(BUG_REPORT_COLLECTIONS.mutationReceipts)
      .doc(`${validated.reportId}--${validated.mutationId}`);
    const receiptSnapshot = await transaction.get(receiptRef);
    const reportSnapshot = await transaction.get(reportRef);
    if (!reportSnapshot.exists) {
      throw new BugReportTriageError(404, "This report is not available");
    }
    const stored = reportSnapshot.data();
    if (receiptSnapshot.exists) {
      const receipt = receiptSnapshot.data();
      if (receipt?.actorUid !== actor.uid || receipt?.requestFingerprint !== fingerprint) {
        throw new BugReportTriageError(409, "Mutation ID is already in use");
      }
      return { record: stored, changed: false, replayed: true };
    }
    if (stored.version !== validated.baseVersion) {
      throw new BugReportTriageError(
        409,
        "This report changed since you opened it. Reload before saving.",
        { currentVersion: stored.version },
      );
    }
    const nowIso = now();
    let changed;
    try {
      changed = await applyAdminAction({
        firestore,
        transaction,
        record: stored,
        body,
        actor,
        nowIso,
      });
    } catch (error) {
      if (error instanceof BugReportContractError) {
        throw new BugReportTriageError(400, error.message);
      }
      throw error;
    }
    const next = {
      ...changed.next,
      ...progressChangeFields(stored, changed.next, nowIso),
      version: stored.version + 1,
      updatedAt: nowIso,
    };
    transaction.set(reportRef, next);
    transaction.create(receiptRef, {
      reportId: validated.reportId,
      actorUid: actor.uid,
      mutationId: validated.mutationId,
      action: validated.action,
      requestFingerprint: fingerprint,
      resultVersion: next.version,
      createdAt: nowIso,
    });
    transaction.create(
      firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(),
      adminLogEntryFn({
        actorUid: actor.uid,
        actorEmail: actor.email ?? null,
        action: changed.auditAction,
        target: `bug_reports/${validated.reportId}`,
        before: actionAuditSummary(stored),
        after: actionAuditSummary(next),
        source,
      }),
    );
    const githubJob = githubJobForAction(validated.action, body, stored);
    if (githubJob) {
      transaction.create(
        firestore.collection(BUG_REPORT_COLLECTIONS.githubOutbox)
          .doc(`${validated.reportId}--${validated.mutationId}`),
        {
          reportId: validated.reportId,
          operation: githubJob.operation,
          targetNumber: githubJob.targetNumber,
          requestedBy: actor.uid,
          state: "pending",
          attemptCount: 0,
          nextAttemptAt: new Date(nowIso),
          leaseUntil: null,
          lastError: null,
          createdAt: new Date(nowIso),
          updatedAt: new Date(nowIso),
        },
      );
    }
    transaction.create(
      firestore.collection(BUG_REPORT_COLLECTIONS.deliveryOutbox)
        .doc(`${validated.reportId}--telegram--${validated.mutationId}`),
      {
        reportId: validated.reportId,
        eventType: "report_updated",
        reportVersion: next.version,
        channel: "telegram",
        state: "pending",
        attemptCount: 0,
        nextAttemptAt: new Date(nowIso),
        leaseUntil: null,
        lastError: null,
        createdAt: new Date(nowIso),
        updatedAt: new Date(nowIso),
      },
    );
    const statusChanged =
      validated.action === "acknowledge" ||
      (validated.action === "set_status" && stored.status !== next.status);
    const resolutionChanged = validated.action === "update_resolution" &&
      canonicalJson(resolutionEmailLines(stored.actionableResolution)) !==
        canonicalJson(resolutionEmailLines(next.actionableResolution));
    if (shouldEmailBugReport(next) && (statusChanged || resolutionChanged)) {
      transaction.create(
        firestore.collection(BUG_REPORT_COLLECTIONS.deliveryOutbox)
          .doc(`${validated.reportId}--email--${next.version}`),
        {
          reportId: validated.reportId,
          eventType: validated.action === "acknowledge"
            ? "report_acknowledged"
            : validated.action === "set_status"
              ? "report_status_changed"
              : "report_resolution_updated",
          eventStatus: next.status,
          eventResolution: next.actionableResolution,
          reportVersion: next.version,
          channel: "email",
          state: "pending",
          attemptCount: 0,
          nextAttemptAt: new Date(nowIso),
          leaseUntil: null,
          lastError: null,
          createdAt: new Date(nowIso),
          updatedAt: new Date(nowIso),
        },
      );
    }
    return { record: next, changed: true, replayed: false };
  });
}

function sendError(res, error, log, operation) {
  const status = error?.status || (error?.code === "failed-precondition" ? 503 : 500);
  if (status >= 500) log.error(`${operation} failed`, error);
  res.status(status).json({
    error: error?.message || "The bug report request failed",
    ...(error?.data ?? {}),
  });
}

function createCmsListBugReportsHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    isAdminFn = isAdmin,
    log = logger,
  } = deps;
  return async (req, res) => {
    try {
      requireJsonPost(req);
      const user = requireApprovedPrincipal(await requirePrincipalFn(req));
      const { view, limit } = validateListRequest(req.body);
      const sharedReportsActive = await accessTierReadsActive(firestore);
      let query = firestore.collection(BUG_REPORT_COLLECTIONS.reports);
      const allReports = view === "all";
      const admin = allReports && await isAdminFn(user.uid);
      if (allReports && !admin && !sharedReportsActive) {
        throw new BugReportTriageError(403, "Admin access required");
      }
      if (!allReports) query = query.where("reporter.uid", "==", user.uid);
      const snapshots = await query
        .orderBy("createdAt", "desc")
        .limit(MAX_LIST_RESULTS + 1)
        .get();
      const reports = snapshots.docs
        .slice(0, MAX_LIST_RESULTS)
        .map((snapshot) => snapshot.data())
        .sort(unresolvedFirst)
        .slice(0, limit)
        .map((record) => allReports && !admin && record.reporter?.uid !== user.uid
          ? reportForStaff(record)
          : reportForList(admin ? reportForAdmin(record) : reportForReporter(record, user.uid)));
      res.set("Cache-Control", "private, no-store");
      res.status(200).json({
        success: true,
        reports,
        view,
        truncated: snapshots.docs.length > MAX_LIST_RESULTS,
        sharedReportsActive,
        ...(admin ? { repository: githubRepository() } : {}),
      });
    } catch (error) {
      sendError(res, error, log, "cmsListBugReports");
    }
  };
}

function createCmsGetBugReportHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    isAdminFn = isAdmin,
    log = logger,
  } = deps;
  return async (req, res) => {
    try {
      requireJsonPost(req);
      const reportId = validateReportId(req.body.reportId);
      const user = requireApprovedPrincipal(await requirePrincipalFn(req));
      const admin = await isAdminFn(user.uid);
      const snapshot = await firestore
        .collection(BUG_REPORT_COLLECTIONS.reports).doc(reportId).get();
      if (!snapshot.exists) throw new BugReportTriageError(404, "This report is not available");
      const stored = snapshot.data();
      const ownsReport = stored?.reporter?.uid === user.uid;
      if (!admin && !ownsReport && !await accessTierReadsActive(firestore)) {
        throw new BugReportTriageError(404, "This report is not available");
      }
      let audit = [];
      let auditTruncated = false;
      if (admin) {
        const auditSnapshot = await firestore.collection(AUDIT_COLLECTIONS.adminLogs)
          .where("target", "==", `bug_reports/${reportId}`)
          .orderBy("at", "desc")
          .limit(MAX_LIST_RESULTS + 1)
          .get();
        auditTruncated = auditSnapshot.docs.length > MAX_LIST_RESULTS;
        audit = auditSnapshot.docs.slice(0, MAX_LIST_RESULTS)
          .map((entry) => ({ id: entry.id, ...entry.data() }))
          .map((entry) => ({
            id: entry.id,
            action: entry.action,
            actorUid: entry.actorUid ?? null,
            actorEmail: entry.actorEmail ?? null,
            at: entry.at,
            before: entry.before ?? null,
            after: entry.after ?? null,
          }));
      }
      res.set("Cache-Control", "private, no-store");
      res.status(200).json({
        success: true,
        report: admin ? { ...reportForAdmin(stored), ...(ownsReport ? { nudge: nudgeForReporter(stored) } : {}) }
          : ownsReport ? reportForReporter(stored, user.uid) : reportForStaff(stored),
        audit,
        auditTruncated,
        canAdminister: admin,
      });
    } catch (error) {
      sendError(res, error, log, "cmsGetBugReport");
    }
  };
}

function createCmsGetBugReportEvidenceHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    isAdminFn = isAdmin,
    log = logger,
  } = deps;
  return async (req, res) => {
    try {
      requireJsonPost(req);
      const reportId = validateReportId(req.body.reportId);
      const user = requireApprovedPrincipal(await requirePrincipalFn(req));
      const admin = await isAdminFn(user.uid);
      const [reportSnapshot, evidenceSnapshot] = await Promise.all([
        firestore.collection(BUG_REPORT_COLLECTIONS.reports).doc(reportId).get(),
        firestore.collection(BUG_REPORT_COLLECTIONS.evidence).doc(reportId).get(),
      ]);
      if (!reportSnapshot.exists || !evidenceSnapshot.exists) {
        throw new BugReportTriageError(404, "Screenshot evidence is not available");
      }
      const stored = reportSnapshot.data();
      if (!admin && stored?.reporter?.uid !== user.uid) {
        throw new BugReportTriageError(404, "Screenshot evidence is not available");
      }
      const evidence = evidenceSnapshot.data();
      const bytes = Buffer.isBuffer(evidence?.bytes)
        ? evidence.bytes
        : evidence?.bytes?.toBuffer?.();
      if (!bytes || evidence.reportId !== reportId || evidence.mimeType !== "image/webp") {
        throw new BugReportTriageError(404, "Screenshot evidence is not available");
      }
      res.set("Cache-Control", "private, no-store");
      res.status(200).json({
        success: true,
        mimeType: evidence.mimeType,
        base64: bytes.toString("base64"),
        width: evidence.width,
        height: evidence.height,
      });
    } catch (error) {
      sendError(res, error, log, "cmsGetBugReportEvidence");
    }
  };
}

function createCmsUpdateBugReportHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    isAdminFn = isAdmin,
    adminLogEntryFn = adminLogEntry,
    now = () => new Date().toISOString(),
    log = logger,
  } = deps;
  return async (req, res) => {
    try {
      requireJsonPost(req);
      const user = requireApprovedPrincipal(await requirePrincipalFn(req));
      if (!(await isAdminFn(user.uid))) {
        throw new BugReportTriageError(403, "Admin access required");
      }
      const source = clientSource(req);
      const result = await commitAdminAction({
        firestore,
        actor: user,
        body: req.body,
        source,
        now,
        adminLogEntryFn,
        authorizeInTransaction: async (transaction) => {
          const snapshot = await transaction.get(firestore.collection("users").doc(user.uid));
          const profile = snapshot.data();
          if (!snapshot.exists ||
            !["admin", "super_admin"].includes(await administrativeRoleFromStoredUserDoc(firestore, profile, transaction))) {
            throw new BugReportTriageError(403, "Admin access required");
          }
        },
      });
      res.status(200).json({
        success: true,
        report: reportForAdmin(result.record),
        changed: result.changed,
        replayed: result.replayed,
      });
    } catch (error) {
      sendError(res, error, log, "cmsUpdateBugReport");
    }
  };
}

const cmsListBugReports = cmsOnRequest({ cors: true }, createCmsListBugReportsHandler());
function createCmsNudgeBugReportHandler(deps = {}) {
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try {
      requireJsonPost(req);
      const actor = requireApprovedPrincipal(await (deps.requirePrincipalFn ?? requirePrincipal)(req));
      if (Object.keys(req.body).some((key) => !["reportId", "mutationId"].includes(key)) || !UUID_PATTERN.test(req.body.mutationId ?? "")) {
        throw new BugReportTriageError(400, "The nudge request is invalid.");
      }
      const result = await commitReporterNudge({ firestore: deps.firestore ?? db, actor,
        reportId: validateReportId(req.body.reportId), mutationId: req.body.mutationId, now: deps.now });
      res.status(200).json({ success: true, nudge: nudgeForReporter(result.record, deps.now?.() ?? new Date()), replayed: result.replayed });
    } catch (error) {
      const trusted = error instanceof NudgeError || error instanceof BugReportTriageError || error instanceof AuthError || error instanceof ForbiddenError;
      const status = error instanceof AuthError ? 401 : error instanceof ForbiddenError ? 403
        : trusted && [400, 403, 404, 405, 409].includes(error.status) ? error.status : 500;
      if (status === 500) (deps.log ?? logger).error("cmsNudgeBugReport failed", {
        reportId: isBugReportId(req.body?.reportId) ? req.body.reportId : null,
        code: Number.isInteger(error?.code) && error.code >= 0 && error.code <= 16 ? error.code
          : ["aborted", "already-exists", "failed-precondition", "unavailable", "deadline-exceeded", "permission-denied"].includes(error?.code) ? error.code : "unknown",
      });
      res.status(status).json({ error: status === 500 ? "The nudge could not be queued. Try again." : error.message });
    }
  };
}
const cmsNudgeBugReport = cmsOnRequest({ cors: true }, createCmsNudgeBugReportHandler());
const cmsGetBugReport = cmsOnRequest({ cors: true }, createCmsGetBugReportHandler());
const cmsGetBugReportEvidence = cmsOnRequest(
  { cors: true },
  createCmsGetBugReportEvidenceHandler(),
);

module.exports = {
  ADMIN_ACTIONS,
  BugReportTriageError,
  MAX_LIST_RESULTS,
  applyAdminAction,
  canonicalRelatedReportIds,
  githubJobForAction,
  commitAdminAction,
  cmsGetBugReport,
  cmsGetBugReportEvidence,
  cmsListBugReports,
  cmsNudgeBugReport,
  createCmsNudgeBugReportHandler,
  createCmsGetBugReportEvidenceHandler,
  createCmsGetBugReportHandler,
  createCmsListBugReportsHandler,
  createCmsUpdateBugReportHandler,
  isActiveStaffRecord,
  requireApprovedPrincipal,
  unresolvedFirst,
  validateListRequest,
  validateUpdateRequest,
};
