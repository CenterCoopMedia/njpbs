"use strict";

const { reportProgress } = require("./bug-report-progress");
const { nudgeForReporter } = require("./bug-report-nudge");
const { normalizePremiereReportContext } = require("./premiere-report-contract");

// Pure contract for the staff-reported incident workflow (#457). This module
// accepts only the fields the report dialog is allowed to collect, redacts them
// before a record exists, and keeps reporter and administrator projections
// separate. HTTP handlers, storage, notifications, and external providers land
// in later stack units.

const BUG_REPORT_API_VERSION = 1;
const ADMIN_ORIGIN = "https://admin.njpbs.org";

const BUG_REPORT_COLLECTIONS = Object.freeze({
  reports: "bug_reports",
  evidence: "bugReportEvidence",
  deliveryOutbox: "bugReportDeliveryOutbox",
  githubOutbox: "bugReportGithubOutbox",
  githubLocks: "bugReportGithubLocks",
  githubWebhookReceipts: "bugReportGithubWebhookReceipts",
  autofixOutbox: "bugReportAutofixOutbox",
  followupOutbox: "bugReportFollowupOutbox",
  mutationReceipts: "bugReportMutationReceipts",
  rateLimits: "bugReportRateLimits",
});

const BUG_REPORT_SEVERITIES = Object.freeze([
  "blocker",
  "work_impaired",
  "minor",
]);

const BUG_REPORT_AREAS = Object.freeze([
  "sign_in_access",
  "content_editing",
  "save_revision",
  "review_publish",
  "media",
  "navigation_ui",
  "other",
]);

const BUG_REPORT_STATUSES = Object.freeze([
  "open",
  "acknowledged",
  "in_progress",
  "blocked",
  "resolved",
  "dismissed",
]);

const BUG_REPORT_DELIVERY_STATUSES = Object.freeze([
  "not_queued",
  "pending",
  "sending",
  "delivered",
  "retryable_failed",
  "unknown",
  "terminal_failed",
]);

const BUG_REPORT_RECORD_KINDS = Object.freeze([
  "page",
  "post",
  "settings",
  "media",
  "staff_account",
  "author_profile",
  "publish_request",
]);

const BUG_REPORT_ROLES = Object.freeze([
  "staff",
  "contributor",
  "editor",
  "admin",
  "super_admin",
]);

const BUG_REPORT_DEPLOYMENT_ENVIRONMENTS = Object.freeze([
  "production",
  "development",
  "preview",
  "emulator",
  "local",
]);

const CAUSE_CERTAINTIES = Object.freeze([
  "confirmed",
  "suspected",
  "unknown",
]);

const REPORT_ID_PATTERN = /^br_[0-9a-f]{32}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUILD_REVISION_PATTERN = /^[0-9a-f]{40}$/;
const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SUBMISSION_FIELDS = new Set([
  "category",
  "severity",
  "area",
  "tryingToDo",
  "happened",
  "expected",
  "steps",
  "workaround",
  "consoleLogs",
  "route",
  "affectedRecord",
  "clientContext",
  "correlationIds",
]);
const AFFECTED_RECORD_FIELDS = new Set([
  "kind",
  "id",
  "lifecycle",
  "version",
]);
const CLIENT_CONTEXT_FIELDS = new Set([
  "diagnostics",
  "browser",
  "operatingSystem",
  "viewport",
  "online",
  "timeZone",
]);
const VIEWPORT_FIELDS = new Set(["width", "height"]);
const CONSOLE_LOG_FIELDS = new Set(["level", "message", "timestamp"]);
const CONSOLE_LEVELS = Object.freeze(["log", "info", "warn", "error", "debug"]);
const RESOLUTION_FIELDS = new Set([
  "immediateSafeAction",
  "likelyCause",
  "recommendedResolution",
  "verification",
  "fallback",
  "needsAdminInput",
  "missingEvidence",
]);
const LIKELY_CAUSE_FIELDS = new Set(["certainty", "summary"]);

const REPORTER_VISIBLE_FIELDS = Object.freeze([
  "category",
  "apiVersion",
  "id",
  "severity",
  "area",
  "tryingToDo",
  "happened",
  "expected",
  "steps",
  "workaround",
  "consoleLogs",
  "route",
  "affectedRecord",
  "evidence",
  "environment",
  "correlationIds",
  "status",
  "actionableResolution",
  "acknowledgedAt",
  "assignedAt",
  "resolvedAt",
  "dismissedAt",
  "version",
  "createdAt",
  "updatedAt",
]);

const ADMIN_VISIBLE_FIELDS = Object.freeze([
  "category",
  "apiVersion",
  "id",
  "severity",
  "area",
  "tryingToDo",
  "happened",
  "expected",
  "steps",
  "workaround",
  "consoleLogs",
  "route",
  "affectedRecord",
  "reporter",
  "evidence",
  "environment",
  "correlationIds",
  "status",
  "ownerUid",
  "deliveryStatus",
  "delivery",
  "githubDelivery",
  "links",
  "actionableResolution",
  "acknowledgedAt",
  "acknowledgedBy",
  "assignedAt",
  "resolvedAt",
  "resolvedBy",
  "dismissedAt",
  "dismissedBy",
  "version",
  "createdAt",
  "updatedAt",
]);

const STATUS_TRANSITIONS = Object.freeze({
  open: Object.freeze(["acknowledged", "in_progress", "resolved", "dismissed"]),
  acknowledged: Object.freeze(["in_progress", "blocked", "resolved", "dismissed"]),
  in_progress: Object.freeze(["blocked", "resolved", "dismissed"]),
  blocked: Object.freeze(["in_progress", "resolved", "dismissed"]),
  resolved: Object.freeze(["in_progress"]),
  dismissed: Object.freeze(["open"]),
});

class BugReportContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "BugReportContractError";
    this.status = 400;
  }
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requirePlainObject(value, label) {
  if (!plainObject(value)) {
    throw new BugReportContractError(`${label} must be an object`);
  }
  return value;
}

function rejectUnknownFields(value, allowed, label) {
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) {
    throw new BugReportContractError(`${label} has unknown field ${unknown}`);
  }
}

function requireVocabulary(value, values, label) {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new BugReportContractError(`${label} is invalid`);
  }
  return value;
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, "utf8");
}

function stripControls(value) {
  return value
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex -- User-supplied reports cannot retain controls.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

function redactSecrets(value) {
  return value
    .replace(
      /\b(authorization)\s*[:=]\s*[^\n]+/gi,
      "$1: [redacted]",
    )
    .replace(/\b(cookie|set-cookie)\s*[:=]\s*[^\n]+/gi, "$1=[redacted]")
    .replace(
      /(^|[^A-Za-z0-9])((?:(?:access|refresh|id|auth|session)[_ -]?)?(?:api[_ -]?key|token|secret|password))\s*[:=]\s*[^\n&]+/gi,
      "$1$2=[redacted]",
    )
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(
      /\b(?:gh[pousr]_|github_pat_|AIza|AKIA|xox[baprs]-|sk-|pk_live_|rk_live_)[A-Za-z0-9._-]{12,}\b/g,
      "[redacted token]",
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[redacted token]",
    )
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      "[redacted email]",
    );
}

function normalizeLines(value) {
  return value
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function redactReportText(
  value,
  { label = "Report text", maxBytes = 2_000, required = false } = {},
) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new BugReportContractError(`${label} is required`);
    return null;
  }
  if (
    typeof value !== "string" ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    utf8Bytes(value) > maxBytes * 4
  ) {
    throw new BugReportContractError(`${label} is too long`);
  }
  const redacted = normalizeLines(redactSecrets(stripControls(value)));
  if (required && redacted.length === 0) {
    throw new BugReportContractError(`${label} is required`);
  }
  if (utf8Bytes(redacted) > maxBytes) {
    throw new BugReportContractError(`${label} must be ${maxBytes} bytes or fewer`);
  }
  return redacted || null;
}

function isBugReportId(value) {
  return typeof value === "string" && REPORT_ID_PATTERN.test(value);
}

function mintBugReportId(randomHex) {
  const entropy = String(randomHex).trim().toLocaleLowerCase("en-US");
  if (!/^[0-9a-f]+$/.test(entropy) || entropy.length < 32) {
    throw new BugReportContractError(
      "A bug report id requires at least 32 hexadecimal characters of entropy",
    );
  }
  return `br_${entropy.slice(0, 32)}`;
}

function normalizeAdminRoute(value, deploymentEnvironment) {
  const environment = requireVocabulary(
    deploymentEnvironment,
    BUG_REPORT_DEPLOYMENT_ENVIRONMENTS,
    "Deployment environment",
  );
  if (typeof value !== "string") {
    throw new BugReportContractError("Admin route is required");
  }
  const safe = stripControls(value).trim();
  if (!safe.startsWith("/") || safe.startsWith("//")) {
    throw new BugReportContractError("Admin route must be a local Admin path");
  }
  const pathOnly = safe.split(/[?#]/, 1)[0];
  let parsed;
  try {
    parsed = new URL(pathOnly, ADMIN_ORIGIN);
  } catch {
    throw new BugReportContractError("Admin route is invalid");
  }
  if (
    parsed.origin !== ADMIN_ORIGIN ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    utf8Bytes(parsed.pathname) > 512
  ) {
    throw new BugReportContractError("Admin route is invalid");
  }
  return {
    path: parsed.pathname,
    url: environment === "production"
      ? `${ADMIN_ORIGIN}${parsed.pathname}`
      : null,
  };
}

function normalizeAffectedRecord(value) {
  if (value === undefined || value === null) return null;
  const record = requirePlainObject(value, "Affected record");
  rejectUnknownFields(record, AFFECTED_RECORD_FIELDS, "Affected record");
  const kind = requireVocabulary(
    record.kind,
    BUG_REPORT_RECORD_KINDS,
    "Affected record kind",
  );
  if (typeof record.id !== "string" || !RECORD_ID_PATTERN.test(record.id)) {
    throw new BugReportContractError("Affected record id is invalid");
  }
  const lifecycle = record.lifecycle === undefined || record.lifecycle === null
    ? null
    : redactReportText(record.lifecycle, {
        label: "Affected record lifecycle",
        maxBytes: 80,
        required: true,
      });
  const version = record.version === undefined || record.version === null
    ? null
    : record.version;
  if (version !== null && (!Number.isSafeInteger(version) || version < 1)) {
    throw new BugReportContractError("Affected record version is invalid");
  }
  return { kind, id: record.id, lifecycle, version };
}

function normalizeViewport(value) {
  const viewport = requirePlainObject(value, "Viewport");
  rejectUnknownFields(viewport, VIEWPORT_FIELDS, "Viewport");
  for (const field of VIEWPORT_FIELDS) {
    if (
      !Number.isSafeInteger(viewport[field]) ||
      viewport[field] < 1 ||
      viewport[field] > 10_000
    ) {
      throw new BugReportContractError(`Viewport ${field} is invalid`);
    }
  }
  return { width: viewport.width, height: viewport.height };
}

function normalizeTimeZone(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 100) {
    throw new BugReportContractError("Time zone is invalid");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
  } catch {
    throw new BugReportContractError("Time zone is invalid");
  }
  return value;
}

function diagnosticNumber(value, label, maximum, minimum = 0, integer = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum ||
      value > maximum || (integer && !Number.isSafeInteger(value))) {
    throw new BugReportContractError(`${label} is invalid`);
  }
  return value;
}

function normalizeDiagnostics(value) {
  const data = requirePlainObject(value, "Diagnostics");
  rejectUnknownFields(data, new Set([
    "userAgent", "language", "screen", "sessionAgeMs", "visibilityState", "reducedMotion",
    "hardwareConcurrency", "deviceMemoryGB", "navigation", "memory", "recentRequests",
  ]), "Diagnostics");
  const screen = requirePlainObject(data.screen, "Screen");
  rejectUnknownFields(screen, new Set(["width", "height", "colorDepth", "pixelRatio"]), "Screen");
  if (typeof data.reducedMotion !== "boolean") throw new BugReportContractError("Reduced motion is invalid");
  const maximumTime = 31 * 24 * 60 * 60 * 1_000;
  const result = {
    userAgent: redactReportText(data.userAgent, { label: "User agent", maxBytes: 512 }),
    language: redactReportText(data.language, { label: "Language", maxBytes: 64 }),
    screen: {
      ...normalizeViewport({ width: screen.width, height: screen.height }),
      colorDepth: diagnosticNumber(screen.colorDepth, "Color depth", 64, 1, true),
      pixelRatio: diagnosticNumber(screen.pixelRatio, "Pixel ratio", 10, 0.1),
    },
    sessionAgeMs: diagnosticNumber(data.sessionAgeMs, "Session age", maximumTime),
    visibilityState: requireVocabulary(data.visibilityState, ["visible", "hidden"], "Visibility"),
    reducedMotion: data.reducedMotion,
  };
  if (data.hardwareConcurrency !== undefined) {
    result.hardwareConcurrency = diagnosticNumber(data.hardwareConcurrency, "Hardware concurrency", 1_024, 1, true);
  }
  if (data.deviceMemoryGB !== undefined) {
    result.deviceMemoryGB = diagnosticNumber(data.deviceMemoryGB, "Device memory", 1_024);
  }
  if (data.navigation !== undefined) {
    const navigation = requirePlainObject(data.navigation, "Navigation timing");
    rejectUnknownFields(navigation, new Set(["type", "ttfbMs", "domContentLoadedMs", "loadMs"]), "Navigation timing");
    result.navigation = {
      type: requireVocabulary(navigation.type, ["navigate", "reload", "back_forward", "prerender"], "Navigation type"),
      ttfbMs: diagnosticNumber(navigation.ttfbMs, "First byte timing", maximumTime),
      domContentLoadedMs: diagnosticNumber(navigation.domContentLoadedMs, "DOM timing", maximumTime),
      loadMs: diagnosticNumber(navigation.loadMs, "Load timing", maximumTime),
    };
  }
  if (data.memory !== undefined) {
    const memory = requirePlainObject(data.memory, "Memory");
    const fields = new Set(["usedJSHeapSize", "totalJSHeapSize", "jsHeapSizeLimit"]);
    rejectUnknownFields(memory, fields, "Memory");
    result.memory = Object.fromEntries([...fields].map(field => [field,
      diagnosticNumber(memory[field], "Memory size", 2 ** 40)]));
  }
  if (!Array.isArray(data.recentRequests) || data.recentRequests.length > 20) {
    throw new BugReportContractError("Recent requests must be a bounded array");
  }
  result.recentRequests = data.recentRequests.map(candidate => {
    const request = requirePlainObject(candidate, "Request timing");
    rejectUnknownFields(request, new Set(["path", "status", "durationMs", "initiatorType"]), "Request timing");
    if (typeof request.path !== "string" || request.path.length > 512 ||
        !request.path.startsWith("/") || request.path.startsWith("//")) {
      throw new BugReportContractError("Request path is invalid");
    }
    if (request.status !== 0 && request.status < 100) throw new BugReportContractError("Response status is invalid");
    return {
      path: new URL(request.path, ADMIN_ORIGIN).pathname,
      status: diagnosticNumber(request.status, "Response status", 599, 0, true),
      durationMs: diagnosticNumber(request.durationMs, "Request duration", maximumTime),
      initiatorType: redactReportText(request.initiatorType, { label: "Request type", maxBytes: 32 }),
    };
  });
  return result;
}

function normalizeClientContext(value) {
  const context = requirePlainObject(value, "Client context");
  rejectUnknownFields(context, CLIENT_CONTEXT_FIELDS, "Client context");
  if (typeof context.online !== "boolean") {
    throw new BugReportContractError("Online state is invalid");
  }
  return {
    browser: redactReportText(context.browser, {
      label: "Browser",
      maxBytes: 160,
      required: true,
    }),
    operatingSystem: redactReportText(context.operatingSystem, {
      label: "Operating system",
      maxBytes: 160,
      required: true,
    }),
    viewport: normalizeViewport(context.viewport),
    online: context.online,
    timeZone: normalizeTimeZone(context.timeZone),
    ...(context.diagnostics === undefined ? {} : { diagnostics: normalizeDiagnostics(context.diagnostics) }),
  };
}

function normalizeUuid(value, label) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new BugReportContractError(`${label} is invalid`);
  }
  return value.toLocaleLowerCase("en-US");
}

function normalizeCorrelationIds(value, requestId) {
  if (!Array.isArray(value) || value.length > 10) {
    throw new BugReportContractError("Correlation IDs must be a bounded array");
  }
  const ids = [normalizeUuid(requestId, "Request ID")];
  for (const candidate of value) {
    const id = normalizeUuid(candidate, "Correlation ID");
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function normalizeReporter(value) {
  const reporter = requirePlainObject(value, "Reporter");
  rejectUnknownFields(reporter, new Set(["uid", "email", "role"]), "Reporter");
  if (
    typeof reporter.uid !== "string" ||
    reporter.uid.length < 1 ||
    utf8Bytes(reporter.uid) > 128
  ) {
    throw new BugReportContractError("Reporter uid is invalid");
  }
  const email = typeof reporter.email === "string"
    ? reporter.email.trim().toLocaleLowerCase("en-US")
    : "";
  if (!EMAIL_PATTERN.test(email) || utf8Bytes(email) > 320) {
    throw new BugReportContractError("Reporter email is invalid");
  }
  return {
    uid: reporter.uid,
    email,
    role: requireVocabulary(reporter.role, BUG_REPORT_ROLES, "Reporter role"),
  };
}

function normalizeNow(value) {
  if (typeof value !== "string") {
    throw new BugReportContractError("Report timestamp is invalid");
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new BugReportContractError("Report timestamp is invalid");
  }
  return value;
}

function truncateUtf8(value, maxBytes) {
  if (utf8Bytes(value) <= maxBytes) return value;
  let result = "";
  for (const character of value) {
    if (utf8Bytes(`${result}${character}…`) > maxBytes) break;
    result += character;
  }
  return `${result}…`;
}

function normalizeConsoleMessage(value) {
  if (typeof value !== "string" || utf8Bytes(value) > 2_000) {
    throw new BugReportContractError("Console log message is too long");
  }
  const redacted = normalizeLines(redactSecrets(stripControls(value)));
  return redacted ? truncateUtf8(redacted, 1_000) : null;
}

function normalizeConsoleLogs(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new BugReportContractError("Console logs must be a bounded array");
  }
  return value.flatMap((candidate) => {
    const entry = requirePlainObject(candidate, "Console log");
    rejectUnknownFields(entry, CONSOLE_LOG_FIELDS, "Console log");
    const level = requireVocabulary(entry.level, CONSOLE_LEVELS, "Console log level");
    const timestamp = normalizeNow(entry.timestamp);
    const message = normalizeConsoleMessage(entry.message);
    if (!message) return [];
    return [{
      level,
      message,
      timestamp,
    }];
  });
}

function defaultActionableResolution() {
  return {
    immediateSafeAction:
      "Keep the current CMS work open and do not repeat a destructive action.",
    likelyCause: {
      certainty: "unknown",
      summary: "No administrator has confirmed the cause.",
    },
    recommendedResolution: [
      "An administrator must compare the affected route, record version, and Admin build with the report before changing content.",
    ],
    verification:
      "No fix is verified until the reported action succeeds on the recorded or a newer reviewed Admin build.",
    fallback:
      "Keep the affected content unchanged and use only the safe workaround recorded in the report.",
    needsAdminInput:
      "Choose the next safe diagnostic after reviewing the recorded route, version, and build.",
    missingEvidence: ["No administrator reproduction result is recorded."],
  };
}

function normalizeTextList(value, label, { maxItems, itemBytes, allowEmpty }) {
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    (!allowEmpty && value.length === 0)
  ) {
    throw new BugReportContractError(`${label} is invalid`);
  }
  return value.map((item) =>
    redactReportText(item, {
      label: `Each ${label.toLocaleLowerCase("en-US")} item`,
      maxBytes: itemBytes,
      required: true,
    }));
}

function normalizeActionableResolution(value) {
  const resolution = requirePlainObject(value, "Actionable resolution");
  rejectUnknownFields(resolution, RESOLUTION_FIELDS, "Actionable resolution");
  const likelyCause = requirePlainObject(
    resolution.likelyCause,
    "Likely cause",
  );
  rejectUnknownFields(likelyCause, LIKELY_CAUSE_FIELDS, "Likely cause");
  const certainty = requireVocabulary(
    likelyCause.certainty,
    CAUSE_CERTAINTIES,
    "Likely cause certainty",
  );
  const missingEvidence = normalizeTextList(
    resolution.missingEvidence,
    "Missing evidence",
    { maxItems: 8, itemBytes: 500, allowEmpty: certainty !== "unknown" },
  );
  return {
    immediateSafeAction: redactReportText(resolution.immediateSafeAction, {
      label: "Immediate safe action",
      maxBytes: 1_000,
      required: true,
    }),
    likelyCause: {
      certainty,
      summary: redactReportText(likelyCause.summary, {
        label: "Likely cause summary",
        maxBytes: 1_000,
        required: true,
      }),
    },
    recommendedResolution: normalizeTextList(
      resolution.recommendedResolution,
      "Recommended resolution",
      { maxItems: 8, itemBytes: 1_000, allowEmpty: false },
    ),
    verification: redactReportText(resolution.verification, {
      label: "Verification",
      maxBytes: 1_000,
      required: true,
    }),
    fallback: redactReportText(resolution.fallback, {
      label: "Fallback",
      maxBytes: 1_000,
      required: true,
    }),
    needsAdminInput: redactReportText(resolution.needsAdminInput, {
      label: "Needs admin input",
      maxBytes: 1_000,
      required: true,
    }),
    missingEvidence,
  };
}

function initialLinks() {
  return {
    relatedReportIds: [],
    githubIssueNumbers: [],
    pullRequestNumbers: [],
    workflowRunUrls: [],
    deploymentRunUrls: [],
    githubIssues: [],
    pullRequests: [],
  };
}

function initialGithubDelivery() {
  return {
    state: "not_linked",
    attemptCount: 0,
    lastAttemptAt: null,
    lastError: null,
    lastOperation: null,
    lastTargetNumber: null,
    lastSyncedAt: null,
    fixRequestedAt: null,
    fixStatus: "not_requested",
    fixSessionName: null,
    fixPullRequestUrl: null,
  };
}

function composeBugReport(input, context) {
  const submission = requirePlainObject(input, "Bug report submission");
  rejectUnknownFields(submission, SUBMISSION_FIELDS, "Bug report submission");
  const trusted = requirePlainObject(context, "Trusted report context");
  const reportId = trusted.reportId;
  if (!isBugReportId(reportId)) {
    throw new BugReportContractError("Bug report id is invalid");
  }
  if (
    typeof trusted.buildRevision !== "string" ||
    !BUILD_REVISION_PATTERN.test(trusted.buildRevision)
  ) {
    throw new BugReportContractError("Admin build revision is invalid");
  }
  const reporter = normalizeReporter(trusted.reporter);
  const nowIso = normalizeNow(trusted.nowIso);
  const native = trusted.native;
  if (native && (native.source !== "premiere" || !["manual", "automatic"].includes(native.mode))) {
    throw new BugReportContractError("Native report source is invalid");
  }
  const client = native ? {
    native: { source: "premiere", mode: native.mode, ...normalizePremiereReportContext(native.context) },
  } : normalizeClientContext(submission.clientContext);
  if (native && (submission.clientContext !== undefined || submission.route != null || submission.affectedRecord != null)) {
    throw new BugReportContractError("Native reports cannot include browser or asset context");
  }
  const deploymentEnvironment = requireVocabulary(
    trusted.deploymentEnvironment,
    BUG_REPORT_DEPLOYMENT_ENVIRONMENTS,
    "Deployment environment",
  );
  const category = submission.category === undefined ? undefined
    : requireVocabulary(submission.category, ["bug", "suggestion", "question"], "Report category");
  const happened = redactReportText(submission.happened, {
    label: "What happened", maxBytes: 2_000, required: true,
  });
  if (category !== undefined && (native ? utf8Bytes(happened) : happened.length) < 10) {
    throw new BugReportContractError("Describe what happened in at least 10 characters");
  }
  const resolution = defaultActionableResolution();
  if (native) {
    resolution.immediateSafeAction = "Keep the current Premiere project open and avoid repeating the failed operation until its result is known.";
    resolution.recommendedResolution = ["An administrator must compare the recorded Premiere, UXP, and plugin versions and safe operation events before changing code or content."];
    resolution.verification = "No fix is verified until the reported action succeeds in Premiere on the recorded or a newer reviewed plugin build.";
    resolution.needsAdminInput = "Choose the next safe diagnostic after reviewing the native versions, panel view, and operation events.";
  }

  return {
    ...(category === undefined ? {} : { category }),
    apiVersion: BUG_REPORT_API_VERSION,
    id: reportId,
    severity: requireVocabulary(
      submission.severity,
      BUG_REPORT_SEVERITIES,
      "Bug report severity",
    ),
    area: requireVocabulary(submission.area, BUG_REPORT_AREAS, "Bug report area"),
    tryingToDo: redactReportText(submission.tryingToDo, {
      label: "What you were trying to do",
      maxBytes: 1_000,
      required: category === undefined,
    }) || "",
    happened,
    expected: redactReportText(submission.expected, {
      label: "What you expected",
      maxBytes: 2_000,
      required: category === undefined,
    }) || "",
    steps: redactReportText(submission.steps, {
      label: "Reproducible steps",
      maxBytes: 3_000,
    }),
    workaround: redactReportText(submission.workaround, {
      label: "Workaround or recovery",
      maxBytes: 2_000,
    }),
    consoleLogs: normalizeConsoleLogs(submission.consoleLogs),
    route: native ? null : normalizeAdminRoute(submission.route, deploymentEnvironment),
    affectedRecord: normalizeAffectedRecord(submission.affectedRecord),
    reporter,
    evidence: { screenshot: null },
    environment: {
      buildRevision: trusted.buildRevision,
      deploymentEnvironment,
      ...client,
    },
    correlationIds: normalizeCorrelationIds(
      submission.correlationIds ?? [],
      trusted.requestId,
    ),
    status: "open",
    ownerUid: null,
    deliveryStatus: "not_queued",
    delivery: {
      telegramChatId: null,
      telegramMessageId: null,
      attemptCount: 0,
      lastAttemptAt: null,
      lastError: null,
    },
    links: initialLinks(),
    githubDelivery: initialGithubDelivery(),
    actionableResolution: resolution,
    acknowledgedAt: null,
    acknowledgedBy: null,
    assignedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    dismissedAt: null,
    dismissedBy: null,
    version: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

function canTransitionBugReportStatus(current, next) {
  if (!BUG_REPORT_STATUSES.includes(current) || !BUG_REPORT_STATUSES.includes(next)) {
    return false;
  }
  return current === next || STATUS_TRANSITIONS[current].includes(next);
}

function clone(value) {
  return structuredClone(value);
}

function reportForReporter(record, reporterUid) {
  if (
    !plainObject(record) ||
    typeof reporterUid !== "string" ||
    record.reporter?.uid !== reporterUid
  ) {
    throw new BugReportContractError("This bug report is not available");
  }
  const projection = Object.fromEntries(
    REPORTER_VISIBLE_FIELDS.map((field) => [field, clone(record[field])]),
  );
  projection.reporter = {
    uid: record.reporter.uid,
    role: record.reporter.role,
  };
  projection.progress = reportProgress(record);
  projection.nudge = nudgeForReporter(record);
  return projection;
}

function reportForAdmin(record) {
  if (!plainObject(record) || !isBugReportId(record.id)) {
    throw new BugReportContractError("This bug report is not available");
  }
  return {
    ...Object.fromEntries(ADMIN_VISIBLE_FIELDS.map((field) => [field, clone(record[field])])),
    ...(record.automatic ? { automatic: clone(record.automatic) } : {}),
    progress: reportProgress(record),
  };
}

function reportForList(record) {
  const fields = ["id", "category", "severity", "status", "createdAt"];
  return {
    ...Object.fromEntries(fields.map(field => [field, record[field]])),
    tryingToDo: truncateUtf8(record.tryingToDo || "", 160),
    happened: truncateUtf8(record.happened || "", 160),
    progress: clone(record.progress ?? reportProgress(record)),
    ...(record.nudge ? { nudge: clone(record.nudge) } : {}),
  };
}

// Other staff can follow work without receiving the reporter's free text,
// identity, route, resolution, screenshots, diagnostics or external URLs.
function reportForStaff(record) {
  if (!plainObject(record) || !isBugReportId(record.id)) {
    throw new BugReportContractError("This bug report is not available");
  }
  const areas = {
    sign_in_access: "Sign-in or access", content_editing: "Content editing",
    save_revision: "Save or revision", review_publish: "Review or publish",
    media: "Media", navigation_ui: "Navigation or interface", other: "Other",
  };
  return {
    shared: true,
    id: record.id, category: record.category ?? "bug", severity: record.severity,
    status: record.status, createdAt: record.createdAt,
    tryingToDo: `${areas[record.area] ?? "Other"} report`, happened: "",
    progress: reportProgress(record),
  };
}

function shouldEmailBugReport(record) {
  return record.environment?.native?.mode !== "automatic";
}

module.exports = {
  ADMIN_ORIGIN,
  BUG_REPORT_API_VERSION,
  BUG_REPORT_AREAS,
  BUG_REPORT_COLLECTIONS,
  BUG_REPORT_DELIVERY_STATUSES,
  BUG_REPORT_DEPLOYMENT_ENVIRONMENTS,
  BUG_REPORT_RECORD_KINDS,
  BUG_REPORT_ROLES,
  BUG_REPORT_SEVERITIES,
  BUG_REPORT_STATUSES,
  BugReportContractError,
  CAUSE_CERTAINTIES,
  canTransitionBugReportStatus,
  composeBugReport,
  defaultActionableResolution,
  isBugReportId,
  initialGithubDelivery,
  initialLinks,
  mintBugReportId,
  normalizeActionableResolution,
  normalizeAdminRoute,
  redactReportText,
  reportForAdmin,
  reportForList,
  reportForStaff,
  reportForReporter,
  shouldEmailBugReport,
};
