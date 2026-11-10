"use strict";

const { createHash } = require("node:crypto");

const MAX_PREMIERE_REPORT_BYTES = 64 * 1024;
const MAX_PREMIERE_REPORT_EVENTS = 40;
const OPERATIONS = new Set([
  "auth.start", "auth.poll", "auth.restore", "auth.revoke", "library.list",
  "media.download", "media.import", "media.export", "markers.read", "markers.apply",
  "markers.save", "upload.start", "upload.part", "upload.complete", "upload.cancel",
  "cache", "ui", "report.submit",
]);
const CODES = new Set(["network", "http", "invalid_response", "storage", "premiere", "unexpected"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^(?:unknown|\d{1,4}(?:\.\d{1,4}){0,3})$/;

class PremiereReportError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "PremiereReportError";
    this.status = status;
  }
}

function object(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key))) {
    throw new PremiereReportError(`${label} has invalid fields`);
  }
  return value;
}

function choice(value, allowed, label) {
  if (!allowed.has(value)) throw new PremiereReportError(`${label} is invalid`);
  return value;
}

function uuid(value) {
  if (typeof value !== "string" || !UUID.test(value)) throw new PremiereReportError("Report request ID is invalid");
  return value.toLowerCase();
}

function normalizePremiereReportContext(value) {
  object(value, ["pluginVersion", "premiereVersion", "uxpVersion", "pluginRevision", "platform", "view"], "Native context");
  const context = {};
  for (const key of ["pluginVersion", "premiereVersion", "uxpVersion"]) {
    if (typeof value[key] !== "string" || !VERSION.test(value[key])) throw new PremiereReportError("Native version is invalid");
    context[key] = value[key];
  }
  if (value.pluginRevision !== undefined) {
    if (typeof value.pluginRevision !== "string" || !/^[0-9a-f]{40}$/.test(value.pluginRevision)) {
      throw new PremiereReportError("Plugin revision is invalid");
    }
    context.pluginRevision = value.pluginRevision;
  }
  context.platform = choice(value.platform, new Set(["win32", "darwin", "unknown"]), "Native platform");
  context.view = choice(value.view, new Set(["connection", "library", "detail", "return", "settings"]), "Native view");
  return context;
}

function normalizeEvent(value) {
  object(value, ["timestamp", "operation", "outcome", "status", "durationMs", "requestId", "code"], "Diagnostic event");
  if (typeof value.timestamp !== "string" || !Number.isFinite(Date.parse(value.timestamp)) ||
      new Date(value.timestamp).toISOString() !== value.timestamp) throw new PremiereReportError("Event timestamp is invalid");
  const event = {
    timestamp: value.timestamp,
    operation: choice(value.operation, OPERATIONS, "Event operation"),
    outcome: choice(value.outcome, new Set(["success", "failure", "canceled"]), "Event outcome"),
  };
  if (value.status !== undefined) {
    if (!Number.isInteger(value.status) || (value.status !== 0 && (value.status < 100 || value.status > 599))) {
      throw new PremiereReportError("Event status is invalid");
    }
    event.status = value.status;
  }
  if (value.durationMs !== undefined) {
    if (!Number.isFinite(value.durationMs) || value.durationMs < 0 || value.durationMs > 86400000) {
      throw new PremiereReportError("Event duration is invalid");
    }
    event.durationMs = value.durationMs;
  }
  if (value.requestId !== undefined) event.requestId = uuid(value.requestId);
  if (value.code !== undefined) {
    if (event.outcome !== "failure") throw new PremiereReportError("Only failure events may include an error code");
    event.code = choice(value.code, CODES, "Event error code");
  }
  return event;
}

function latestFailure(events) {
  return events.filter(event => event.outcome === "failure").at(-1);
}

function isAutomaticFailure(event) {
  return event?.outcome === "failure" && event.operation !== "report.submit" &&
    !(event.status >= 400 && event.status < 500);
}

// User-written descriptions are optional. Structured diagnostics never accept text.
function redactNativeDescription(value) {
  return value
    .replace(/\b(?:https?|file|plugin-data|plugin-temp):[^\s<>"']+/gi, "[redacted URL]")
    .replace(/\bpds_[A-Za-z0-9_-]+/g, "[redacted token]")
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\r\n"<>|]+/g, "[redacted path]")
    .replace(/\/(?:Users|home|Volumes|mnt|tmp)\/[^\r\n"<>]+/g, "[redacted path]");
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parsePremiereReport(value) {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_PREMIERE_REPORT_BYTES) {
    throw new PremiereReportError("The report request is too large", 413);
  }
  object(value, ["mode", "clientRequestId", "description", "context", "events"], "Native report");
  const mode = choice(value.mode, new Set(["manual", "automatic"]), "Report mode");
  if (!Array.isArray(value.events) || value.events.length > MAX_PREMIERE_REPORT_EVENTS) {
    throw new PremiereReportError("Diagnostics must contain at most 40 events");
  }
  const result = {
    mode, clientRequestId: uuid(value.clientRequestId),
    context: normalizePremiereReportContext(value.context),
    events: value.events.map(normalizeEvent),
  };
  if (value.description !== undefined) {
    if (mode !== "manual" || typeof value.description !== "string") throw new PremiereReportError("Only manual reports may include a description");
    const description = value.description.trim();
    const bytes = Buffer.byteLength(description, "utf8");
    if (bytes < 10 || bytes > 2000) throw new PremiereReportError("Description must contain 10 to 2000 UTF-8 bytes");
    result.description = description;
  }
  const failure = latestFailure(result.events);
  if (mode === "automatic" && !isAutomaticFailure(failure)) {
    throw new PremiereReportError("Automatic reports require an unexpected failure outside report submission");
  }
  return result;
}

function premiereIncidentFingerprint(report) {
  const failure = latestFailure(report.events);
  return digest({ context: report.context, operation: failure.operation,
    code: failure.code ?? (failure.status >= 500 ? "http" : "unexpected"), status: failure.status ?? null });
}

function premiereReportSubmission(report, nowIso) {
  const failure = latestFailure(report.events);
  const context = report.context;
  const summary = failure
    ? `Premiere ${failure.operation} failed (${failure.code ?? "unexpected"}${failure.status === undefined ? "" : `; status ${failure.status}`}).`
    : "Premiere panel problem reported by staff";
  const operation = failure?.operation ?? "ui";
  return {
    category: "bug", severity: "work_impaired",
    area: operation.startsWith("auth.") ? "sign_in_access"
      : operation === "ui" ? "navigation_ui" : "media",
    happened: report.description ? redactNativeDescription(report.description) : summary,
    expected: "The requested Boardwalk operation completes in the Premiere panel.",
    consoleLogs: [{
      level: "info", timestamp: nowIso,
      message: `Source: Premiere native panel; Trigger: ${report.mode}; Plugin: ${context.pluginVersion}; Premiere: ${context.premiereVersion}; UXP: ${context.uxpVersion}; Platform: ${context.platform}; View: ${context.view}${context.pluginRevision ? `; Plugin revision: ${context.pluginRevision}` : ""}`,
    }, ...report.events.map(event => ({
      level: event.outcome === "failure" ? "error" : "info", timestamp: event.timestamp,
      message: Object.entries(event).filter(([key]) => key !== "timestamp").map(([key, value]) => `${key}=${value}`).join("; "),
    }))],
    correlationIds: [...new Set(report.events.flatMap(event => event.requestId ? [event.requestId] : []))].slice(-10),
  };
}

module.exports = {
  MAX_PREMIERE_REPORT_BYTES, MAX_PREMIERE_REPORT_EVENTS, PremiereReportError,
  normalizePremiereReportContext, parsePremiereReport, premiereIncidentFingerprint,
  premiereReportSubmission, premiereRequestFingerprint: digest,
};
