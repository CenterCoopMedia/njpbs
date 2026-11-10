"use strict";

// Durable Telegram and reporter-email delivery for the authenticated CMS report
// workflow. Report writes commit first. This worker sends or updates one Telegram
// card and sends bounded transactional confirmations afterward.

const { createHash, randomUUID, timingSafeEqual } = require("node:crypto");
const logger = require("firebase-functions/logger");
const { defineList, defineSecret, defineString } = require("firebase-functions/params");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { db } = require("./lib/firebase");
const { adminLogEntry } = require("./lib/audit");
const { accessTierReadsActive, userDocUsesAccessTier } = require("./lib/access-tier-activation");
const { administrativeRoleFromUserDoc } = require("./lib/principal");
const {
  ADMIN_ORIGIN,
  BUG_REPORT_COLLECTIONS,
  canTransitionBugReportStatus,
  shouldEmailBugReport,
} = require("./lib/bug-report-contract");
const { resolutionEmailLines } = require("./lib/bug-report-email-resolution");
const { reportProgress } = require("./lib/bug-report-progress");
const { decideNudge, nudgeHistoryPatch } = require("./lib/bug-report-nudge");
const {
  njpbsEmailLogoAttachment,
  renderNjpbsEmailHeader,
} = require("./lib/njpbs-email-brand");
const {
  BugReportTriageError,
  commitAdminAction,
} = require("./bug-report-triage");
const {
  STAFF_EMAIL_ACCOUNT_ID,
  STAFF_EMAIL_API_TOKEN,
  createCloudflareEmailSender,
} = require("./staff-access-email");
const {
  processPendingStaffAccessNotifications,
  recoverExpiredStaffAccessNotifications,
} = require("./lib/staff-access-notification");

const TELEGRAM_BOT_TOKEN = defineSecret("CMS_BUG_REPORT_TELEGRAM_BOT_TOKEN");
const TELEGRAM_WEBHOOK_SECRET = defineSecret(
  "CMS_BUG_REPORT_TELEGRAM_WEBHOOK_SECRET",
);
const TELEGRAM_CHAT_ID = defineString("CMS_BUG_REPORT_TELEGRAM_CHAT_ID", {
  default: "",
});
const TELEGRAM_ADMIN_MAP = defineString("CMS_BUG_REPORT_TELEGRAM_ADMIN_MAP", {
  default: "{}",
});
const BUG_REPORT_ADMIN_ORIGIN = defineString("CMS_BUG_REPORT_ADMIN_ORIGIN", {
  default: ADMIN_ORIGIN,
});
const BUG_REPORT_EMAIL_FROM = defineString("CMS_BUG_REPORT_EMAIL_FROM", {
  default: "",
});
const BUG_REPORT_EMAIL_REPLY_TO = defineString("CMS_BUG_REPORT_EMAIL_REPLY_TO", {
  default: "",
});
const BUG_REPORT_EMAIL_BCC = defineList("CMS_BUG_REPORT_EMAIL_BCC", { default: [] });
const MAX_ATTEMPTS = 5;
const LEASE_MILLIS = 2 * 60 * 1_000;
const DELIVERY_RUN_LEASE_MILLIS = 330 * 1_000;
const BATCH_SIZE = 25;
const CALLBACK_PATTERN =
  /^br:1:(m|s|p|a|t|r|ip|b|rs|d|o|f|x):(br_[0-9a-f]{32})$/;
const REPORT_CATEGORY_LABELS = Object.freeze({
  bug: "Bug or error",
  suggestion: "Suggestion",
  question: "Question",
});
class DeliveryError extends Error {
  constructor(message, { kind, status = null } = {}) {
    super(message);
    this.name = "DeliveryError";
    this.kind = kind;
    this.status = status;
  }
}

function configuredValue(param, envName) {
  // config-input: CMS_BUG_REPORT_ADMIN_ORIGIN, CMS_BUG_REPORT_EMAIL_FROM, CMS_BUG_REPORT_EMAIL_REPLY_TO
  // config-input: CMS_BUG_REPORT_TELEGRAM_ADMIN_MAP, CMS_BUG_REPORT_TELEGRAM_CHAT_ID, CMS_STAFF_EMAIL_ACCOUNT_ID
  const local = process.env[envName]?.trim();
  return local || param.value().trim();
}

function timestampMillis(value) {
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return Date.parse(value);
  if (typeof value === "number") return value;
  return Number.NaN;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeHtmlBounded(value, maxBytes) {
  const replacements = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
  let result = "";
  for (const character of String(value ?? "").trim()) {
    const encoded = replacements[character] ?? character;
    if (Buffer.byteLength(`${result}${encoded}…`, "utf8") > maxBytes) return `${result}…`;
    result += encoded;
  }
  return result;
}

function fitTelegramCard(lines, maxBytes = 4_096) {
  const kept = [];
  for (const line of lines) {
    const candidate = [...kept, line].join("\n");
    if (Buffer.byteLength(candidate, "utf8") > maxBytes) break;
    kept.push(line);
  }
  return kept.join("\n");
}

function truncate(value, maxLength) {
  const text = String(value ?? "").trim();
  return text.length <= maxLength
    ? text
    : `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function titleCase(value) {
  return String(value ?? "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function reportCategoryLabel(value) {
  return Object.hasOwn(REPORT_CATEGORY_LABELS, value)
    ? REPORT_CATEGORY_LABELS[value]
    : null;
}

function reporterReportName(category) {
  if (category === "bug") return "bug or error report";
  if (category === "suggestion") return "suggestion";
  if (category === "question") return "question";
  return "problem report";
}

function reporterStatusName(status) {
  if (status === "dismissed") return "closed";
  return String(status ?? "").replaceAll("_", " ");
}

function reporterEmailExcerpt(value, maxLength) {
  return truncate(value, maxLength).replace(/[\uD800-\uDBFF](?=…$)/u, "");
}

function reportUrl(reportId, origin = ADMIN_ORIGIN) {
  return `${origin.replace(/\/$/, "")}/reports/${encodeURIComponent(reportId)}`;
}

function escapeHtmlLines(value) {
  return escapeHtml(value)
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("\n", "<br>");
}

function renderBugReportEmailHtml({
  subject,
  heading,
  introduction,
  details,
  updateLines,
  url,
}) {
  const detailRows = details.map(({ label, value }, index) => `
                <tr>
                  <td style="width:94px;padding:10px 14px;border-top:${index === 0 ? "0" : "1px solid #dfe3f2"};color:#59617a;font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.04em;line-height:16px;vertical-align:top;">${escapeHtml(label)}</td>
                  <td style="padding:10px 14px;border-top:${index === 0 ? "0" : "1px solid #dfe3f2"};color:#090f2f;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:24px;overflow-wrap:anywhere;word-break:break-word;">${escapeHtmlLines(value)}</td>
                </tr>`).join("");
  const updateDetails = updateLines.length
    ? `
              <div style="margin:0 0 24px;padding:16px;border-left:3px solid #2638c4;background:#f7f8fc;">
                <h2 style="margin:0 0 12px;color:#29304a;font-family:Arial,Helvetica,sans-serif;font-size:18px;line-height:24px;">Resolution</h2>
                ${updateLines.map((line) => `<p style="margin:0 0 12px;color:#29304a;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:24px;overflow-wrap:anywhere;word-break:break-word;">${escapeHtmlLines(line)}</p>`).join("")}
              </div>`
    : "";
  const safeUrl = escapeHtml(url);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6fb;">
  <div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px;mso-hide:all;">${escapeHtml(introduction)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f4f6fb;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;border-collapse:separate;background:#ffffff;border-radius:10px;box-shadow:0 2px 10px rgba(9,15,47,0.08);">
          ${renderNjpbsEmailHeader("CMS reports")}
          <tr>
            <td style="padding:30px 28px 12px;">
              <p style="margin:0 0 14px;color:#29304a;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:24px;">Hello,</p>
              <h1 style="margin:0 0 18px;color:#090f2f;font-family:Arial,Helvetica,sans-serif;font-size:28px;font-weight:700;line-height:35px;">${escapeHtml(heading)}</h1>
              <p style="margin:0 0 22px;color:#29304a;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:24px;">${escapeHtml(introduction)}</p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin:0 0 24px;border:1px solid #dfe3f2;border-collapse:separate;border-spacing:0;border-radius:8px;background:#f7f8fc;">
                ${detailRows}
              </table>
              ${updateDetails}
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:4px 0 24px;">
                <tr>
                  <td align="center" bgcolor="#2638c4" style="border-radius:6px;background:#2638c4;">
                    <a href="${safeUrl}" style="display:inline-block;min-height:44px;padding:0 24px;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:700;line-height:44px;text-align:center;text-decoration:none;">Follow the report</a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 18px;color:#59617a;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:21px;overflow-wrap:anywhere;word-break:break-word;">If the button does not work, copy this address into your browser:<br><a href="${safeUrl}" style="color:#2638c4;">${safeUrl}</a></p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 28px;background:#090f2f;border-radius:0 0 10px 10px;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:19px;">NJ PBS</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function externalReport(record) {
  const environment = record.environment ?? {};
  const category = reportCategoryLabel(record.category)
    ? record.category
    : null;
  return {
    id: record.id,
    ...(category ? { category } : {}),
    severity: titleCase(record.severity),
    status: titleCase(record.status),
    tryingToDo: truncate(record.tryingToDo, 160),
    happened: truncate(record.happened, 240),
    expected: truncate(record.expected, 200),
    steps: truncate(record.steps || "Not supplied", 260),
    workaround: truncate(record.workaround || "Not supplied", 160),
    area: titleCase(record.area),
    consoleLogs: (record.consoleLogs ?? []).slice(-4).map((entry) => ({
      level: titleCase(entry.level),
      message: truncate(entry.message, 160),
    })),
    reporter: truncate(record.reporter?.email || record.reporter?.uid, 120),
    createdAt: truncate(record.createdAt, 40),
    route: truncate(record.route?.path, 160),
    affectedRecord: record.affectedRecord
      ? `${titleCase(record.affectedRecord.kind)} ${truncate(record.affectedRecord.id, 96)}`
      : "None",
    buildRevision: truncate(record.environment?.buildRevision, 12),
    browser: truncate(environment.browser, 160),
    operatingSystem: truncate(environment.operatingSystem, 160),
    viewport: environment.viewport
      ? `${environment.viewport.width} × ${environment.viewport.height}`
      : "Unknown",
    native: environment.native ?? null,
    repeatCount: record.automatic?.repeatCount ?? null,
    relatedReports: (record.links?.relatedReportIds ?? []).slice(0, 10),
    issues: (record.links?.githubIssueNumbers ?? []).slice(0, 10),
    pullRequests: (record.links?.pullRequestNumbers ?? []).slice(0, 10),
    owner: truncate(record.ownerUid || "Unassigned", 100),
    githubDelivery: record.githubDelivery ?? null,
    githubIssueStates: (record.links?.githubIssues ?? []).slice(0, 10),
    pullRequestStates: (record.links?.pullRequests ?? []).slice(0, 10),
  };
}

function renderTelegramCard(record) {
  const report = externalReport(record);
  const source = report.native ? "Premiere" : "CMS";
  const category = reportCategoryLabel(report.category);
  const description = category && !report.tryingToDo
    ? [`<b>Description</b> ${escapeHtmlBounded(report.happened, 240)}`]
    : [
        `<b>Problem</b> ${escapeHtmlBounded(report.tryingToDo, 160)}`,
        `<b>Impact</b> ${escapeHtmlBounded(report.happened, 240)}`,
      ];
  const related = [
    report.relatedReports.length
      ? `Reports: ${report.relatedReports.join(", ")}`
      : null,
    report.issues.length ? `Issues: ${report.issues.map((id) => `#${id}`).join(", ")}` : null,
    report.pullRequests.length
      ? `PRs: ${report.pullRequests.map((id) => `#${id}`).join(", ")}`
      : null,
  ].filter(Boolean).join(" · ") || "No linked engineering work";
  const engineering = [
    report.githubDelivery?.fixStatus && report.githubDelivery.fixStatus !== "not_requested"
      ? `Autofix: ${report.githubDelivery.fixStatus.replaceAll("_", " ")}`
      : null,
    ...report.githubIssueStates.map((issue) =>
      `Issue #${issue.number}: ${issue.state}`),
    ...report.pullRequestStates.map((pullRequest) =>
      `PR #${pullRequest.number}: ${pullRequest.state}; review ${pullRequest.reviewState}; checks ${pullRequest.checksState}; deployment ${pullRequest.deploymentState}`),
  ].filter(Boolean).join(" · ") || `GitHub handoff: ${report.githubDelivery?.state ?? "not linked"}`;
  const consoleText = report.consoleLogs.length
    ? report.consoleLogs.map((entry) =>
      `${escapeHtml(entry.level)}: ${escapeHtmlBounded(entry.message, 160)}`).join("\n")
    : "No console messages captured.";
  return fitTelegramCard([
    category
      ? `<b>${escapeHtml(category)} ${source} report · ${escapeHtml(report.status)}</b>`
      : `<b>${escapeHtml(report.severity)} ${source} report · ${escapeHtml(report.status)}</b>`,
    `<code>${escapeHtml(report.id)}</code>`,
    ...(report.native ? [
      `<b>Source</b> Premiere native panel; ${escapeHtmlBounded(report.native.mode, 16)}`,
      ...(report.repeatCount ? [`<b>Occurrences</b> ${report.repeatCount} in this 15-minute incident`] : []),
    ] : []),
    ...(category ? [`<b>Severity</b> ${escapeHtml(report.severity)}`] : []),
    "",
    ...description,
    `<b>Expected</b> ${escapeHtmlBounded(report.expected, 200)}`,
    `<b>Steps</b> ${escapeHtmlBounded(report.steps, 260)}`,
    `<b>Workaround</b> ${escapeHtmlBounded(report.workaround, 160)}`,
    `<b>Console</b>\n${consoleText}`,
    "",
    `<b>Reporter</b> ${escapeHtmlBounded(report.reporter, 120)}`,
    `<b>Area</b> ${escapeHtml(report.area)}`,
    `<b>Time</b> ${escapeHtml(report.createdAt)}`,
    report.native ? `<b>View</b> ${escapeHtmlBounded(report.native.view, 24)}`
      : `<b>Route</b> <code>${escapeHtmlBounded(report.route, 160)}</code>`,
    `<b>Record</b> ${escapeHtmlBounded(report.affectedRecord, 120)}`,
    `<b>Build</b> <code>${escapeHtml(report.buildRevision)}</code>`,
    `<b>Client</b> ${escapeHtmlBounded(report.native
      ? `Plugin ${report.native.pluginVersion}; Premiere ${report.native.premiereVersion}; UXP ${report.native.uxpVersion}; ${report.native.platform}`
      : `${report.browser}; ${report.operatingSystem}; ${report.viewport}`, 280)}`,
    `<b>Owner</b> ${escapeHtmlBounded(report.owner, 100)}`,
    `<b>Linked work</b> ${escapeHtmlBounded(related, 220)}`,
    `<b>Engineering state</b> ${escapeHtmlBounded(engineering, 320)}`,
  ]);
}

function callbackData(action, reportId) {
  return `br:1:${action}:${reportId}`;
}

function telegramKeyboard(record, menu = "primary", origin = ADMIN_ORIGIN) {
  const rows = [];
  if (menu === "status") {
    const statusButtons = [];
    if (canTransitionBugReportStatus(record.status, "in_progress") && record.status !== "in_progress") {
      statusButtons.push({ text: "Start work", callback_data: callbackData("ip", record.id) });
    }
    if (canTransitionBugReportStatus(record.status, "blocked") && record.status !== "blocked") {
      statusButtons.push({ text: "Mark blocked", callback_data: callbackData("b", record.id) });
    }
    if (canTransitionBugReportStatus(record.status, "open") && record.status !== "open") {
      statusButtons.push({ text: "Reopen", callback_data: callbackData("o", record.id) });
    }
    if (statusButtons.length) rows.push(statusButtons);
    rows.push([{ text: "Back", callback_data: callbackData("p", record.id) }]);
    return { inline_keyboard: rows };
  }
  if (menu === "more") {
    rows.push([
      { text: "Change status", callback_data: callbackData("s", record.id) },
      ...(canTransitionBugReportStatus(record.status, "resolved") && record.status !== "resolved"
        ? [{ text: "Resolve", callback_data: callbackData("rs", record.id) }]
        : []),
    ]);
    if (canTransitionBugReportStatus(record.status, "dismissed") && record.status !== "dismissed") {
      rows.push([{ text: "Dismiss", callback_data: callbackData("d", record.id) }]);
    }
    rows.push([{ text: "Back", callback_data: callbackData("p", record.id) }]);
    return { inline_keyboard: rows };
  }
  const primaryIssue = record.links?.githubIssues?.[0];
  const handoffPending = record.githubDelivery?.state === "pending";
  if (!primaryIssue && !handoffPending) {
    rows.push([
      { text: "File issue", callback_data: callbackData("f", record.id) },
      { text: "File + fix", callback_data: callbackData("x", record.id) },
    ]);
  } else if (primaryIssue?.url) {
    rows.push([{ text: `Open issue #${primaryIssue.number}`, url: primaryIssue.url }]);
  }
  rows.push([{ text: "Open CMS report", url: reportUrl(record.id, origin) }]);
  if (!["resolved", "dismissed"].includes(record.status)) {
    rows.push([{ text: "Ignore", callback_data: callbackData("d", record.id) }]);
  }
  return { inline_keyboard: rows };
}

function renderBugReportEmail(record, eventType, origin = ADMIN_ORIGIN) {
  const url = reportUrl(record.id, origin);
  const category = reportCategoryLabel(record.category);
  const reportName = reporterReportName(record.category);
  const statusName = reporterStatusName(record.status);
  const native = Boolean(record.environment?.native);
  const reportSource = native ? "from the Premiere panel" : "in Boardwalk";
  // Native descriptions can be generated diagnostics, so keep them out of mail.
  const tryingToDo = native ? "" : reporterEmailExcerpt(record.tryingToDo, 160);
  const happened = native ? "" : reporterEmailExcerpt(record.happened, 240);
  const summary = reporterEmailExcerpt((tryingToDo || happened).replace(/\s+/g, " "), 80) ||
    (native ? "Premiere panel report" : "Your Boardwalk report");
  const areaLabels = {
    sign_in_access: "Sign-in or access",
    content_editing: "Content editing",
    save_revision: "Save or revision",
    review_publish: "Review or publish",
    media: "Media",
    navigation_ui: "Navigation or interface",
    other: "Other",
  };
  const severityLabels = {
    blocker: "Blocker",
    work_impaired: "Work impaired",
    minor: "Minor",
  };
  const resolutionLines = resolutionEmailLines(record.actionableResolution);
  const resolutionInstruction = resolutionLines.length
    ? "Read the resolution below"
    : "Check the report for details";
  const statusNextSteps = {
    open: "Your report is waiting for review. Follow the report for updates.",
    acknowledged: "A person is looking into it. Follow the report for updates.",
    in_progress: "Work on your report has started. Follow the report for updates.",
    blocked: "Work is paused until we have more information or another change is ready. Check the report for details.",
    resolved: `${resolutionInstruction}. If the problem continues, send a new report.`,
    dismissed: `This report is closed without further work. ${resolutionInstruction}, and send a new report if you have new details.`,
  };
  let subject;
  let heading;
  let introduction;
  let updateLines = [];
  let nextSteps = Object.hasOwn(statusNextSteps, record.status)
    ? statusNextSteps[record.status]
    : "Follow the report for updates.";
  if (eventType === "report_received") {
    subject = `We received your ${reportName}: ${summary}`;
    heading = `We received your ${reportName}`;
    introduction = `We received your ${reportName} ${reportSource}.`;
    nextSteps = "Someone will review it. You can follow the report for updates.";
  } else if (eventType === "report_acknowledged") {
    subject = `We are looking into your ${reportName}: ${summary}`;
    heading = "We are looking into it";
    introduction = `A person is looking into your ${reportName} ${reportSource}.`;
    nextSteps = "Follow the report for updates. You do not need to send it again.";
  } else if (eventType === "report_status_changed") {
    const terminal = record.status === "resolved" || record.status === "dismissed";
    subject = `Your ${reportName} is now ${statusName}: ${summary}`;
    heading = terminal ? `Report ${statusName}` : "Report status updated";
    introduction = `Your ${reportName} ${reportSource} is now ${statusName}.`;
    updateLines = terminal ? resolutionLines : [];
  } else if (eventType === "report_resolution_updated") {
    subject = `Resolution updated for your ${reportName}: ${summary}`;
    heading = "Resolution updated";
    introduction = `We updated the saved resolution for your ${reportName} ${reportSource}.`;
    updateLines = resolutionLines;
  } else {
    throw new DeliveryError("Unknown bug report email template", { kind: "terminal" });
  }
  const details = [
    { label: "Reference", value: record.id },
    ...(category ? [{ label: "Category", value: category }] : []),
    ...(tryingToDo ? [{ label: "What you were trying to do", value: tryingToDo }] : []),
    ...(happened ? [{ label: "What you wrote", value: happened }] : []),
    ...(!native && Object.hasOwn(areaLabels, record.area) ? [{ label: "Area", value: areaLabels[record.area] }] : []),
    ...(!native && Object.hasOwn(severityLabels, record.severity) ? [{ label: "Severity", value: severityLabels[record.severity] }] : []),
    { label: "Status", value: statusName },
    { label: "What happens next", value: nextSteps },
  ];
  const lines = [
    "Hello,",
    "",
    heading,
    introduction,
    ...details.map(({ label, value }) => `${label}: ${value}`),
    ...(updateLines.length ? ["", "Resolution:", ...updateLines] : []),
    `Follow the report: ${url}`,
  ];
  const text = `${lines.join("\n")}\n`;
  const html = renderBugReportEmailHtml({
    subject,
    heading,
    introduction,
    details,
    updateLines,
    url,
  });
  return {
    subject,
    text,
    html,
    attachments: [njpbsEmailLogoAttachment()],
  };
}

function createTelegramClient(deps = {}) {
  const fetchFn = deps.fetchFn ?? fetch;
  const token = deps.token ?? process.env.CMS_BUG_REPORT_TELEGRAM_BOT_TOKEN?.trim() ??
    TELEGRAM_BOT_TOKEN.value().trim();
  if (!token) {
    throw new DeliveryError("Telegram delivery is not configured", { kind: "retryable" });
  }
  const request = async (method, body) => {
    let response;
    try {
      response = await fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new DeliveryError("Telegram result is unknown", {
        kind: "ambiguous",
        cause: error,
      });
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (response.ok && payload?.ok === true) return payload.result;
    if (
      response.status === 400 &&
      typeof payload?.description === "string" &&
      payload.description.toLocaleLowerCase("en-US").includes("message is not modified")
    ) {
      return null;
    }
    throw new DeliveryError("Telegram refused the request", {
      kind: response.status === 429 || response.status >= 500 ? "retryable" : "terminal",
      status: response.status,
    });
  };
  return {
    answerCallbackQuery: (callbackQueryId, text) => request("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: truncate(text, 180),
    }),
    editKeyboard: (chatId, messageId, replyMarkup) => request("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
    }),
    editMessage: (chatId, messageId, text, replyMarkup) => request("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: replyMarkup,
    }),
    sendMessage: (chatId, text, replyMarkup) => request("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: replyMarkup,
    }),
  };
}

function parseTelegramAdminMap(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new DeliveryError("Telegram administrator mapping is invalid", { kind: "terminal" });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DeliveryError("Telegram administrator mapping is invalid", { kind: "terminal" });
  }
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > 20) {
    throw new DeliveryError("Telegram administrator mapping is invalid", { kind: "terminal" });
  }
  for (const [telegramId, uid] of entries) {
    if (!/^-?[0-9]{1,20}$/.test(telegramId) ||
        typeof uid !== "string" || uid.length < 1 || uid.length > 1_500 || uid.includes("/")) {
      throw new DeliveryError("Telegram administrator mapping is invalid", { kind: "terminal" });
    }
  }
  return Object.fromEntries(entries);
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left ?? ""));
  const rightBuffer = Buffer.from(String(right ?? ""));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function callbackMutationId(callbackQueryId) {
  const hash = createHash("sha256").update(callbackQueryId).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function parseCallbackData(value) {
  const nudge = /^br:2:(a|i):(br_[0-9a-f]{32}):([0-9a-f]{12})$/.exec(value ?? "");
  if (nudge) return { action: nudge[1] === "a" ? "nudge_approve" : "nudge_ignore", reportId: nudge[2], nudgeId: nudge[3] };
  const match = CALLBACK_PATTERN.exec(value ?? "");
  return match ? { action: match[1], reportId: match[2] } : null;
}

function isActiveAdminProfile(profile, tiersActive = false) {
  return ["admin", "super_admin"].includes(
    administrativeRoleFromUserDoc(profile, tiersActive),
  );
}

async function telegramActor(firestore, uid) {
  const snapshot = await firestore.collection("users").doc(uid).get();
  if (!snapshot.exists || !isActiveAdminProfile(snapshot.data(), await userDocUsesAccessTier(firestore, snapshot.data()))) {
    throw new BugReportTriageError(403, "Admin access required");
  }
  const profile = snapshot.data();
  return { uid, email: typeof profile.email === "string" ? profile.email : null };
}

function callbackAdminAction(action) {
  if (action === "a") return { action: "acknowledge" };
  if (action === "t") return { action: "take_over" };
  if (action === "r") return { action: "retry_notification" };
  if (action === "ip") return { action: "set_status", status: "in_progress" };
  if (action === "b") return { action: "set_status", status: "blocked" };
  if (action === "rs") return { action: "set_status", status: "resolved" };
  if (action === "d") return { action: "set_status", status: "dismissed" };
  if (action === "o") return { action: "set_status", status: "open" };
  if (action === "f") return { action: "create_github_issue" };
  if (action === "x") return { action: "create_github_issue_and_fix" };
  return null;
}

async function createTelegramWebhookHandler(deps = {}) {
  const firestore = deps.firestore ?? db;
  const client = deps.client ?? createTelegramClient(deps);
  const webhookSecret = deps.webhookSecret ??
    process.env.CMS_BUG_REPORT_TELEGRAM_WEBHOOK_SECRET?.trim() ??
    TELEGRAM_WEBHOOK_SECRET.value().trim();
  const configuredChatId = String(deps.chatId ?? configuredValue(
    TELEGRAM_CHAT_ID,
    "CMS_BUG_REPORT_TELEGRAM_CHAT_ID",
  ));
  const adminMap = deps.adminMap ?? parseTelegramAdminMap(configuredValue(
    TELEGRAM_ADMIN_MAP,
    "CMS_BUG_REPORT_TELEGRAM_ADMIN_MAP",
  ));
  const origin = deps.adminOrigin ?? configuredValue(
    BUG_REPORT_ADMIN_ORIGIN,
    "CMS_BUG_REPORT_ADMIN_ORIGIN",
  );
  const now = deps.now ?? (() => new Date().toISOString());

  return async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }
    if (!webhookSecret || !safeEqual(
      req.headers["x-telegram-bot-api-secret-token"],
      webhookSecret,
    )) {
      res.status(401).send("Unauthorized");
      return;
    }
    const query = req.body?.callback_query;
    if (!query) {
      res.status(200).send("OK");
      return;
    }
    const parsed = parseCallbackData(query.data);
    const fromId = String(query.from?.id ?? "");
    const chatId = String(query.message?.chat?.id ?? "");
    const messageId = query.message?.message_id;
    const mappedUid = adminMap[fromId];
    if (
      !parsed ||
      !mappedUid ||
      chatId !== configuredChatId ||
      !Number.isSafeInteger(messageId)
    ) {
      await client.answerCallbackQuery(query.id, "This action is not authorized.");
      res.status(200).send("OK");
      return;
    }

    try {
      const actor = await telegramActor(firestore, mappedUid);
      const reportRef = firestore.collection(BUG_REPORT_COLLECTIONS.reports)
        .doc(parsed.reportId);
      const reportSnapshot = await reportRef.get();
      if (!reportSnapshot.exists) throw new BugReportTriageError(404, "Report not found");
      let record = reportSnapshot.data();
      if (parsed.nudgeId) {
        const result = await decideNudge({ firestore, actor, reportId: parsed.reportId, nudgeId: parsed.nudgeId,
          decision: parsed.action === "nudge_approve" ? "approved" : "ignored", chatId, messageId, now: () => new Date(now()) });
        let refreshFailed = false;
        try { await client.editKeyboard(chatId, messageId, { inline_keyboard: [] }); }
        catch {
          refreshFailed = true;
          logger.error("Nudge decision saved; Telegram keyboard refresh failed", { reportId: parsed.reportId });
        }
        try {
          await client.answerCallbackQuery(query.id, refreshFailed ? "Nudge decision saved. Open the CMS report for current status."
            : result.replayed ? "This decision was already recorded."
              : parsed.action === "nudge_approve" ? "Follow-up requested. Work has not started yet." : "Nudge ignored. Report unchanged.");
        } catch { logger.error("Nudge decision saved; Telegram answer failed", { reportId: parsed.reportId }); }
        res.status(200).send("OK");
        return;
      }
      if (parsed.action === "m" || parsed.action === "s" || parsed.action === "p") {
        const menu = parsed.action === "m" ? "more" : parsed.action === "s" ? "status" : "primary";
        await client.editKeyboard(chatId, messageId, telegramKeyboard(record, menu, origin));
        await client.answerCallbackQuery(query.id, "Actions updated.");
        res.status(200).send("OK");
        return;
      }
      const action = callbackAdminAction(parsed.action);
      if (!action) throw new BugReportTriageError(400, "Action not supported");
      const mutationId = callbackMutationId(query.id);
      const receiptSnapshot = await firestore
        .collection(BUG_REPORT_COLLECTIONS.mutationReceipts)
        .doc(`${parsed.reportId}--${mutationId}`)
        .get();
      let result;
      if (receiptSnapshot.exists) {
        const receipt = receiptSnapshot.data();
        if (receipt.actorUid !== actor.uid || receipt.action !== action.action) {
          throw new BugReportTriageError(409, "Callback receipt does not match this action");
        }
        result = { record, changed: false, replayed: true };
      } else {
        result = await commitAdminAction({
          firestore,
          actor,
          body: {
            reportId: parsed.reportId,
            baseVersion: record.version,
            mutationId,
            ...action,
          },
          source: { telegramUserId: fromId, telegramChatId: chatId },
          now,
          adminLogEntryFn: adminLogEntry,
          authorizeInTransaction: async (transaction) => {
            const snapshot = await transaction.get(firestore.collection("users").doc(mappedUid));
            if (!snapshot.exists || !isActiveAdminProfile(snapshot.data(), await userDocUsesAccessTier(firestore, snapshot.data(), transaction))) {
              throw new BugReportTriageError(403, "Admin access required");
            }
          },
        });
      }
      record = result.record;
      let cardRefreshFailed = false;
      try {
        await client.editMessage(
          chatId,
          messageId,
          renderTelegramCard(record),
          telegramKeyboard(record, "primary", origin),
        );
      } catch (error) {
        cardRefreshFailed = true;
        logger.error("Bug report Telegram callback card refresh failed", {
          reportId: parsed.reportId,
          status: error?.status ?? null,
          name: error?.name ?? "Error",
        });
      }
      try {
        await client.answerCallbackQuery(
          query.id,
          cardRefreshFailed
            ? "Report saved. Open the CMS report for current status."
            : result.replayed ? "This action was already applied." : "Report updated.",
        );
      } catch (error) {
        logger.error("Bug report Telegram callback answer failed", {
          reportId: parsed.reportId,
          name: error?.name ?? "Error",
        });
      }
      res.status(200).send("OK");
    } catch (error) {
      logger.error("Bug report Telegram callback failed", {
        reportId: parsed.reportId,
        status: error?.status ?? null,
        name: error?.name ?? "Error",
      });
      try {
        await client.answerCallbackQuery(
          query.id,
          error?.status === 409
            ? parsed.nudgeId
              ? "This nudge cannot be applied. An operator must check its delivery receipt and current report status."
              : "The report changed. Open it and try again."
            : "The action could not be applied.",
        );
      } catch (answerError) {
        logger.error("Bug report Telegram callback answer failed", {
          name: answerError?.name ?? "Error",
        });
      }
      res.status(200).send("OK");
    }
  };
}

async function claimOutboxRow(firestore, id, now = new Date()) {
  const ref = firestore.collection(BUG_REPORT_COLLECTIONS.deliveryOutbox).doc(id);
  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return null;
    const row = snapshot.data();
    if (row.state !== "pending" || timestampMillis(row.nextAttemptAt) > now.getTime()) {
      return null;
    }
    const reportRef = firestore.collection(BUG_REPORT_COLLECTIONS.reports).doc(row.reportId);
    const reportSnapshot = await transaction.get(reportRef);
    if (!reportSnapshot.exists) {
      transaction.update(ref, {
        state: "terminal_failed",
        nextAttemptAt: null,
        lastError: "Report record is unavailable",
        updatedAt: now,
      });
      return null;
    }
    const record = reportSnapshot.data();
    if (row.eventType === "report_nudged" && (!await accessTierReadsActive(firestore, transaction) ||
        !reportProgress(record).active || reportProgress(record).updatedAt > row.waitingSince)) {
      transaction.update(ref, { state: "suppressed", leaseUntil: null, nextAttemptAt: null, updatedAt: now });
      transaction.update(reportRef, nudgeHistoryPatch(record, row.nudgeId, { delivery: "cancelled" }));
      return null;
    }
    if (row.channel === "email" && !shouldEmailBugReport(record)) {
      transaction.update(ref, {
        state: "suppressed", nextAttemptAt: null, leaseUntil: null,
        lastError: null, updatedAt: now,
      });
      return null;
    }
    if (
      row.channel === "telegram" && row.eventType !== "report_nudged" &&
      !record.delivery?.telegramMessageId &&
      record.deliveryStatus === "unknown"
    ) {
      transaction.update(ref, {
        state: "blocked_unknown",
        nextAttemptAt: null,
        lastError: "Initial Telegram delivery is awaiting explicit retry",
        updatedAt: now,
      });
      return null;
    }
    if (row.eventType === "report_repeated" && record.automatic) {
      if (!record.delivery?.telegramMessageId && record.deliveryStatus === "terminal_failed") {
        transaction.update(ref, {
          state: "terminal_failed", nextAttemptAt: null, leaseUntil: null,
          lastError: "Initial Telegram delivery failed", updatedAt: now,
        });
        return null;
      }
      if ((record.delivery?.telegramRepeatCount ?? 0) >= record.automatic.repeatCount) {
        transaction.update(ref, {
          state: "delivered", nextAttemptAt: null, leaseUntil: null,
          deliveredAt: now, updatedAt: now,
        });
        return null;
      }
      const nextEdit = Date.parse(record.delivery?.nextAutomaticEditAt ?? "");
      if (!record.delivery?.telegramMessageId || record.deliveryStatus === "sending" || nextEdit > now.getTime()) {
        transaction.update(ref, {
          nextAttemptAt: new Date(Math.max(now.getTime() + 60000, nextEdit || 0)), updatedAt: now,
        });
        return null;
      }
    }
    const operation = row.channel === "telegram"
      ? row.eventType !== "report_nudged" && record.delivery?.telegramMessageId ? "edit" : "send"
      : "email";
    const attemptCount = Number(row.attemptCount || 0) + 1;
    const leaseUntil = new Date(now.getTime() + LEASE_MILLIS);
    transaction.update(ref, {
      state: "sending",
      operation,
      attemptCount,
      leaseUntil,
      updatedAt: now,
    });
    if (row.channel === "telegram" && row.eventType !== "report_nudged") {
      transaction.update(reportRef, {
        deliveryStatus: "sending",
        "delivery.attemptCount": attemptCount,
        "delivery.lastAttemptAt": now.toISOString(),
        "delivery.lastError": null,
        ...(row.eventType === "report_repeated"
          ? { "delivery.nextAutomaticEditAt": new Date(now.getTime() + 60000).toISOString() } : {}),
      });
    }
    return { id, ref, reportRef, record, ...row, operation, attemptCount };
  });
}

async function settleOutboxSuccess(row, receipt, deps = {}) {
  const firestore = deps.firestore ?? db;
  const now = deps.now ?? (() => new Date());
  const at = now();
  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(row.ref);
    if (!snapshot.exists || snapshot.data().state !== "sending") return;
    const currentReport = row.record.automatic || row.eventType === "report_nudged" ? (await transaction.get(row.reportRef)).data() : null;
    const deliveredRepeatCount = Math.max(currentReport?.delivery?.telegramRepeatCount ?? 0,
      row.record.automatic?.repeatCount ?? 0);
    const repeatPending = row.channel === "telegram" && row.eventType !== "report_nudged" &&
      (currentReport?.automatic?.repeatCount ?? 0) > deliveredRepeatCount;
    transaction.update(row.ref, {
      state: repeatPending ? "pending" : "delivered",
      leaseUntil: null,
      nextAttemptAt: repeatPending ? new Date(at.getTime() + 60000) : null,
      lastError: null,
      deliveredAt: at,
      updatedAt: at,
      ...(row.eventType === "report_nudged" ? { telegramChatId: String(receipt.chatId), telegramMessageId: String(receipt.messageId) } : {}),
      ...(repeatPending ? { eventType: "report_repeated", attemptCount: 0 } : {}),
    });
    if (row.eventType === "report_nudged") {
      transaction.update(row.reportRef, nudgeHistoryPatch(currentReport, row.nudgeId, { delivery: "delivered", deliveredAt: at.toISOString() }));
    } else if (row.channel === "telegram") {
      transaction.update(row.reportRef, {
        deliveryStatus: "delivered",
        "delivery.telegramChatId": String(receipt.chatId),
        "delivery.telegramMessageId": String(receipt.messageId),
        "delivery.attemptCount": row.attemptCount,
        "delivery.lastAttemptAt": at.toISOString(),
        "delivery.lastError": null,
        ...(row.record.automatic ? {
          "delivery.telegramRepeatCount": deliveredRepeatCount,
          "delivery.nextAutomaticEditAt": new Date(at.getTime() + 60000).toISOString(),
        } : {}),
      });
    }
  });
}

async function settleOutboxFailure(row, error, deps = {}) {
  const firestore = deps.firestore ?? db;
  const now = deps.now ?? (() => new Date());
  const at = now();
  const retryable = error.kind === "retryable" ||
    (error.kind === "ambiguous" && row.operation === "edit");
  const unknown = error.kind === "ambiguous" && row.operation !== "edit";
  const canRetry = retryable && row.attemptCount < MAX_ATTEMPTS;
  const state = unknown ? "unknown" : canRetry ? "pending" : "terminal_failed";
  const nextAttemptAt = canRetry
    ? new Date(at.getTime() + 2 ** Math.max(0, row.attemptCount - 1) * 60 * 1_000)
    : null;
  const safeError = `${error.kind || "unknown"}${error.status ? ` (${error.status})` : ""}`;
  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(row.ref);
    if (!snapshot.exists || snapshot.data().state !== "sending") return;
    const currentReport = row.eventType === "report_nudged" ? (await transaction.get(row.reportRef)).data() : null;
    transaction.update(row.ref, {
      state,
      leaseUntil: null,
      nextAttemptAt,
      lastError: safeError,
      updatedAt: at,
    });
    if (row.eventType === "report_nudged") {
      transaction.update(row.reportRef, nudgeHistoryPatch(currentReport, row.nudgeId, { delivery: unknown ? "unknown" : canRetry ? "pending" : "terminal_failed" }));
    } else if (row.channel === "telegram") {
      transaction.update(row.reportRef, {
        deliveryStatus: unknown
          ? "unknown"
          : canRetry ? "retryable_failed" : "terminal_failed",
        "delivery.attemptCount": row.attemptCount,
        "delivery.lastAttemptAt": at.toISOString(),
        "delivery.lastError": safeError,
        ...(row.eventType === "report_repeated"
          ? { "delivery.nextAutomaticEditAt": new Date(at.getTime() + 60000).toISOString() } : {}),
      });
    }
  });
  return state;
}

async function deliverOutboxRow(id, deps = {}) {
  const firestore = deps.firestore ?? db;
  const now = deps.now ?? (() => new Date());
  const row = await claimOutboxRow(firestore, id, now());
  if (!row) return { state: "skipped" };
  try {
    if (row.channel === "telegram") {
      const client = deps.telegramClient ?? createTelegramClient(deps);
      const chatId = String(deps.chatId ?? configuredValue(
        TELEGRAM_CHAT_ID,
        "CMS_BUG_REPORT_TELEGRAM_CHAT_ID",
      ));
      if (!chatId) {
        throw new DeliveryError("Telegram chat is not configured", { kind: "retryable" });
      }
      const origin = deps.adminOrigin ?? configuredValue(
        BUG_REPORT_ADMIN_ORIGIN,
        "CMS_BUG_REPORT_ADMIN_ORIGIN",
      );
      const deliveredRecord = { ...row.record, deliveryStatus: "delivered" };
      const nudge = row.eventType === "report_nudged";
      const progress = nudge ? reportProgress(deliveredRecord) : null;
      const text = nudge ? fitTelegramCard([
        "<b>Staff report nudge</b>", escapeHtml(deliveredRecord.id),
        escapeHtmlBounded(deliveredRecord.tryingToDo || deliveredRecord.happened || "Staff report", 500),
        `Current status: ${escapeHtml(progress.label)}`,
        `No recorded progress since ${escapeHtml(row.waitingSince)}.`,
        "Approve a fresh investigation, or ignore this nudge without changing the report.",
      ]) : renderTelegramCard(deliveredRecord);
      const keyboard = nudge ? { inline_keyboard: [
        [{ text: "Approve a follow-up", callback_data: `br:2:a:${row.reportId}:${row.nudgeId}` },
          { text: "Ignore", callback_data: `br:2:i:${row.reportId}:${row.nudgeId}` }],
        [{ text: "Open CMS report", url: reportUrl(row.reportId, origin) }],
      ] } : telegramKeyboard(deliveredRecord, "primary", origin);
      const storedMessageId = nudge ? null : row.record.delivery?.telegramMessageId;
      let message;
      if (storedMessageId) {
        await client.editMessage(
          row.record.delivery.telegramChatId || chatId,
          Number(storedMessageId),
          text,
          keyboard,
        );
        message = {
          chat: { id: row.record.delivery.telegramChatId || chatId },
          message_id: Number(storedMessageId),
        };
      } else {
        message = await client.sendMessage(chatId, text, keyboard);
      }
      if (!message || !Number.isSafeInteger(Number(message.message_id))) {
        throw new DeliveryError("Telegram returned an invalid receipt", { kind: "ambiguous" });
      }
      await settleOutboxSuccess(row, {
        chatId: message.chat?.id ?? chatId,
        messageId: message.message_id,
      }, { firestore, now });
      return { state: "delivered" };
    }
    if (row.channel === "email") {
      const origin = deps.adminOrigin ?? configuredValue(
        BUG_REPORT_ADMIN_ORIGIN,
        "CMS_BUG_REPORT_ADMIN_ORIGIN",
      );
      const emailRecord = {
        ...row.record,
        ...(row.eventStatus ? { status: row.eventStatus } : {}),
        actionableResolution: Object.hasOwn(row, "eventResolution")
          ? row.eventResolution
          : undefined,
      };
      const rendered = renderBugReportEmail(emailRecord, row.eventType, origin);
      const sendEmail = deps.sendEmail ?? createCloudflareEmailSender({
        ...deps,
        accountId: deps.accountId ?? configuredValue(
          STAFF_EMAIL_ACCOUNT_ID,
          "CMS_STAFF_EMAIL_ACCOUNT_ID",
        ),
        apiToken: deps.emailApiToken ??
          process.env.CMS_STAFF_EMAIL_API_TOKEN?.trim() ??
          STAFF_EMAIL_API_TOKEN.value().trim(),
        from: deps.emailFrom ?? configuredValue(
          BUG_REPORT_EMAIL_FROM,
          "CMS_BUG_REPORT_EMAIL_FROM",
        ),
        replyTo: deps.emailReplyTo ?? configuredValue(
          BUG_REPORT_EMAIL_REPLY_TO,
          "CMS_BUG_REPORT_EMAIL_REPLY_TO",
        ),
      });
      const receipt = await sendEmail({
        to: row.record.reporter?.email,
        ...rendered,
        bcc: process.env.CMS_BUG_REPORT_EMAIL_BCC?.trim()
          ? BUG_REPORT_EMAIL_BCC.value()
          : [],
      });
      if (!receipt?.delivered && !receipt?.queued) {
        throw new DeliveryError("Email provider did not accept the message", {
          kind: "ambiguous",
        });
      }
      await settleOutboxSuccess(row, {}, { firestore, now });
      return { state: "delivered" };
    }
    throw new DeliveryError("Unknown report delivery channel", { kind: "terminal" });
  } catch (error) {
    const deliveryError = error instanceof DeliveryError || error?.name === "EmailDeliveryError"
      ? error
      : new DeliveryError("Delivery failed", { kind: "ambiguous" });
    const state = await settleOutboxFailure(row, deliveryError, { firestore, now });
    return { state };
  }
}

async function recoverExpiredDeliveries(deps = {}) {
  const firestore = deps.firestore ?? db;
  const now = deps.now ?? (() => new Date());
  const at = now();
  const snapshot = await firestore.collection(BUG_REPORT_COLLECTIONS.deliveryOutbox)
    .where("state", "==", "sending")
    .where("leaseUntil", "<=", at)
    .orderBy("leaseUntil", "asc")
    .limit(BATCH_SIZE)
    .get();
  const results = [];
  for (const document of snapshot.docs) {
    const row = document.data();
    const error = new DeliveryError("Delivery lease expired", {
      kind: row.operation === "edit" ? "retryable" : "ambiguous",
    });
    results.push({
      state: await settleOutboxFailure({
        id: document.id,
        ref: document.ref,
        reportRef: firestore.collection(BUG_REPORT_COLLECTIONS.reports).doc(row.reportId),
        ...row,
      }, error, { firestore, now }),
    });
  }
  return results;
}

async function processPendingDeliveries(deps = {}) {
  const firestore = deps.firestore ?? db;
  const now = deps.now ?? (() => new Date());
  const snapshot = await firestore.collection(BUG_REPORT_COLLECTIONS.deliveryOutbox)
    .where("state", "==", "pending")
    .where("nextAttemptAt", "<=", now())
    .orderBy("nextAttemptAt", "asc")
    .limit(BATCH_SIZE)
    .get();
  const results = [];
  for (const document of snapshot.docs) {
    results.push(await deliverOutboxRow(document.id, deps));
  }
  return results;
}

async function withDeliveryLease(firestore, work, now = () => new Date()) {
  const ref = firestore.collection("system").doc("bugReportDeliveryRun");
  const owner = randomUUID();
  const claimed = await firestore.runTransaction(async (transaction) => {
    const current = (await transaction.get(ref)).data();
    const at = now();
    if (timestampMillis(current?.leaseUntil) > at.getTime()) {
      transaction.update(ref, { wakeRequested: true });
      return false;
    }
    transaction.set(ref, { owner, leaseUntil: new Date(at.getTime() + DELIVERY_RUN_LEASE_MILLIS), wakeRequested: false });
    return true;
  });
  if (!claimed) return false;
  try {
    while (true) {
      // A full batch means later due rows may still be waiting. A boolean wake
      // only records that another trigger arrived, so keep going while either is set.
      const moreDue = await work() === true;
      const runAgain = await firestore.runTransaction(async (transaction) => {
        const current = (await transaction.get(ref)).data();
        if (current?.owner !== owner) return false;
        if (moreDue || current.wakeRequested) {
          if (current.wakeRequested) transaction.update(ref, { wakeRequested: false });
          return true;
        }
        transaction.set(ref, { owner: null, leaseUntil: null, wakeRequested: false });
        return false;
      });
      if (!runAgain) return true;
    }
  } finally {
    await firestore.runTransaction(async (transaction) => {
      if ((await transaction.get(ref)).data()?.owner === owner) {
        transaction.set(ref, { owner: null, leaseUntil: null, wakeRequested: false });
      }
    });
  }
}

async function runDeliveryWork(deps = {}) {
  const recovered = await recoverExpiredDeliveries(deps);
  const results = await processPendingDeliveries(deps);
  const reportReviewCount = results.filter(({ state }) => ["terminal_failed", "unknown"].includes(state)).length;
  if (reportReviewCount) logger.warn("Bug report deliveries need operator review", { count: reportReviewCount });
  const staffAccessNotificationDeps = {
    firestore: deps.firestore,
    now: deps.now,
    telegramClient: deps.telegramClient ?? createTelegramClient(deps),
    chatId: deps.chatId ?? configuredValue(
      TELEGRAM_CHAT_ID,
      "CMS_BUG_REPORT_TELEGRAM_CHAT_ID",
    ),
    adminOrigin: deps.adminOrigin ?? configuredValue(
      BUG_REPORT_ADMIN_ORIGIN,
      "CMS_BUG_REPORT_ADMIN_ORIGIN",
    ),
  };
  const recoveredStaffAccessNotifications =
    await recoverExpiredStaffAccessNotifications(
      staffAccessNotificationDeps,
    );
  const processedStaffAccessNotifications =
    await processPendingStaffAccessNotifications(
      staffAccessNotificationDeps,
    );
  const needsStaffAccessNotificationReview = [
    ...recoveredStaffAccessNotifications,
    ...processedStaffAccessNotifications,
  ].filter(({ state }) => ["terminal_failed", "unknown"].includes(state));
  if (needsStaffAccessNotificationReview.length > 0) {
    logger.warn("Staff access notifications need operator review", {
      count: needsStaffAccessNotificationReview.length,
    });
  }
  return [recovered, results, recoveredStaffAccessNotifications, processedStaffAccessNotifications]
    .some((batch) => batch.length === BATCH_SIZE);
}

const onBugReportDeliveryCreated = onDocumentCreated(
  {
    document: `${BUG_REPORT_COLLECTIONS.deliveryOutbox}/{jobId}`,
    secrets: [TELEGRAM_BOT_TOKEN, STAFF_EMAIL_API_TOKEN],
    timeoutSeconds: 300,
    memory: "256MiB",
    retry: false,
  },
  async () => {
    if (process.env.FUNCTIONS_EMULATOR === "true") return;
    await withDeliveryLease(db, runDeliveryWork);
  },
);

const onBugReportDelivery = onSchedule(
  {
    schedule: "every 10 minutes",
    maxInstances: 1,
    timeoutSeconds: 300,
    secrets: [TELEGRAM_BOT_TOKEN, STAFF_EMAIL_API_TOKEN],
  },
  async () => withDeliveryLease(db, runDeliveryWork),
);

const telegramBugReportCallback = onRequest(
  {
    secrets: [TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET],
    timeoutSeconds: 30,
  },
  async (req, res) => {
    const handler = await createTelegramWebhookHandler();
    await handler(req, res);
  },
);

module.exports = {
  BUG_REPORT_ADMIN_ORIGIN,
  BUG_REPORT_EMAIL_FROM,
  BUG_REPORT_EMAIL_REPLY_TO,
  DeliveryError,
  TELEGRAM_ADMIN_MAP,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  TELEGRAM_WEBHOOK_SECRET,
  callbackAdminAction,
  callbackData,
  callbackMutationId,
  claimOutboxRow,
  createTelegramClient,
  createTelegramWebhookHandler,
  deliverOutboxRow,
  externalReport,
  isActiveAdminProfile,
  onBugReportDelivery,
  onBugReportDeliveryCreated,
  parseCallbackData,
  parseTelegramAdminMap,
  processPendingDeliveries,
  runDeliveryWork,
  withDeliveryLease,
  recoverExpiredDeliveries,
  renderBugReportEmail,
  renderTelegramCard,
  safeEqual,
  settleOutboxFailure,
  settleOutboxSuccess,
  telegramBugReportCallback,
  telegramKeyboard,
};
