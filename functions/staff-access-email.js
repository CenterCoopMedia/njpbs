"use strict";

// Durable, server-owned mail for the staff-access workflow. Request handlers
// commit an outbox row with the request change, then make one best-effort
// delivery attempt. A scheduled worker retries only responses that are known to
// be safe to retry. Network failures stay "unknown" so an ambiguous provider
// result cannot cause an automatic duplicate.

const { defineSecret, defineString } = require("firebase-functions/params");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { db } = require("./lib/firebase");
const {
  njpbsEmailLogoAttachment,
  renderNjpbsEmailHeader,
} = require("./lib/njpbs-email-brand");

const STAFF_EMAIL_API_TOKEN = defineSecret("CMS_STAFF_EMAIL_API_TOKEN");
const STAFF_EMAIL_ACCOUNT_ID = defineString("CMS_STAFF_EMAIL_ACCOUNT_ID", {
  default: "",
});
const STAFF_EMAIL_FROM = defineString("CMS_STAFF_EMAIL_FROM", {
  default: "",
});
const STAFF_EMAIL_REPLY_TO = defineString("CMS_STAFF_EMAIL_REPLY_TO", {
  default: "",
});
const STAFF_EMAIL_ADMIN_ORIGIN = defineString("CMS_STAFF_EMAIL_ADMIN_ORIGIN", {
  default: "https://admin.njpbs.org",
});

const OUTBOX_COLLECTION = "staffAccessEmailOutbox";
const MAX_ATTEMPTS = 5;
const LEASE_MILLIS = 2 * 60 * 1000;
const MAX_JSON_REQUEST_BYTES = 4 * 1024 * 1024;
class EmailDeliveryError extends Error {
  constructor(message, { kind, status = null, cause = null } = {}) {
    super(message);
    this.name = "EmailDeliveryError";
    this.kind = kind;
    this.status = status;
    if (cause) this.cause = cause;
  }
}

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function outboxId(uid, requestVersion, eventType) {
  return `${uid}--${requestVersion}--${eventType}`;
}

function configuredValue(param, envName) {
  // config-input: CMS_STAFF_EMAIL_ACCOUNT_ID, CMS_STAFF_EMAIL_ADMIN_ORIGIN, CMS_STAFF_EMAIL_FROM, CMS_STAFF_EMAIL_REPLY_TO
  const local = process.env[envName]?.trim();
  if (local) return local;
  return param.value().trim();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function greeting(displayName) {
  const safeName = plainText(displayName);
  return safeName ? `Hello ${safeName},` : "Hello,";
}

function plainText(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function webUrl(value, fallback) {
  const candidate = plainText(value);
  return /^https?:\/\//i.test(candidate) ? candidate : fallback;
}

function renderParagraphs(paragraphs) {
  return paragraphs
    .filter(Boolean)
    .map(
      (paragraph) =>
        `<p style="margin:0 0 18px;color:#29304a;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:24px;">${escapeHtml(paragraph)}</p>`,
    )
    .join("");
}

function renderDetails(details, title) {
  if (details.length === 0) return "";
  const rows = details
    .map(
      ({ label, value }) => `
    <tr>
      <td style="padding:12px 16px;border-top:1px solid #dfe3f2;">
        <div style="margin:0 0 3px;color:#59617a;font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.04em;line-height:16px;text-transform:uppercase;">${escapeHtml(label)}</div>
        <div style="margin:0;color:#090f2f;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:23px;overflow-wrap:anywhere;word-break:break-word;">${escapeHtml(value)}</div>
      </td>
    </tr>`,
    )
    .join("");
  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin:4px 0 24px;border:1px solid #dfe3f2;border-collapse:separate;border-radius:8px;background:#f7f8fc;">
      <tr>
        <td style="padding:14px 16px;background:#eef0ff;color:#18277f;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:700;line-height:22px;">${escapeHtml(title)}</td>
      </tr>${rows}
    </table>`;
}

function renderEmailHtml({
  preheader,
  heading,
  paragraphs,
  details = [],
  detailsTitle = "Details",
  ctaLabel,
  ctaUrl,
  closing,
}) {
  const safeCtaUrl = escapeHtml(ctaUrl);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f6fb;">
  <div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;color:transparent;font-size:1px;line-height:1px;mso-hide:all;">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f4f6fb;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;border-collapse:separate;background:#ffffff;border-radius:10px;box-shadow:0 2px 10px rgba(9,15,47,0.08);">
          ${renderNjpbsEmailHeader("Staff services")}
          <tr>
            <td style="padding:30px 28px 10px;">
              <div style="margin:0 0 8px;color:#2638c4;font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:700;letter-spacing:0.08em;line-height:18px;text-transform:uppercase;">NJ PBS</div>
              <h1 style="margin:0 0 22px;color:#090f2f;font-family:Arial,Helvetica,sans-serif;font-size:28px;font-weight:700;line-height:35px;">${escapeHtml(heading)}</h1>
              ${renderParagraphs(paragraphs)}
              ${renderDetails(details, detailsTitle)}
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:4px 0 24px;">
                <tr>
                  <td align="center" bgcolor="#2638c4" style="border-radius:6px;background:#2638c4;">
                    <a href="${safeCtaUrl}" style="display:inline-block;min-height:44px;padding:0 24px;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:700;line-height:44px;text-align:center;text-decoration:none;">${escapeHtml(ctaLabel)}</a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 20px;color:#59617a;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:21px;overflow-wrap:anywhere;word-break:break-word;">If the button does not work, copy this address into your browser:<br>${safeCtaUrl}</p>
              <p style="margin:0 0 18px;color:#29304a;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:23px;">${escapeHtml(closing)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 28px;background:#090f2f;border-radius:0 0 10px 10px;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:19px;">
              NJ PBS<br>
              Montclair State University
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function renderEmailText({
  heading,
  paragraphs,
  details = [],
  detailsTitle = "Details",
  ctaLabel,
  ctaUrl,
  closing,
}) {
  const blocks = ["NJ PBS", "Staff services", heading, ...paragraphs];
  if (details.length > 0) {
    blocks.push(
      `${detailsTitle}\n${details.map(({ label, value }) => `${label}: ${value}`).join("\n")}`,
    );
  }
  blocks.push(
    `${ctaLabel}: ${ctaUrl}`,
    closing,
    "NJ PBS\nMontclair State University",
  );
  return `${blocks.filter(Boolean).join("\n\n")}\n`;
}

function renderStaffAccessEmail(message, { adminOrigin } = {}) {
  const origin = (adminOrigin || "https://admin.njpbs.org").replace(/\/$/, "");
  const hello = greeting(message.displayName);
  let subject;
  let content;

  switch (message.eventType) {
    case "verify":
      subject = "Verify your NJ PBS Admin email";
      content = {
        preheader:
          "Verify your email address to continue your NJ PBS Admin access request.",
        heading: "Verify your email",
        paragraphs: [
          hello,
          "Verify your email to send your NJ PBS Admin access request to an administrator for review.",
        ],
        ctaLabel: "Verify my email",
        ctaUrl: webUrl(message.verificationLink, origin),
        closing:
          "If you did not create this account, you can ignore this message.",
      };
      break;
    case "received":
      subject = "NJ PBS Admin access request received";
      content = {
        preheader: "Your NJ PBS Admin access request is waiting for review.",
        heading: "Your request is in review",
        paragraphs: [
          hello,
          "Your NJ PBS Admin access request is in an administrator's review queue.",
          "You will receive another email after an administrator approves or rejects it.",
        ],
        details: [
          { label: "Reference", value: plainText(message.reference) },
        ].filter(({ value }) => value),
        ctaLabel: "Check request status",
        ctaUrl: origin,
        closing: "Keep this reference for any questions about your request.",
      };
      break;
    case "approved":
      subject = "Your NJ PBS Admin account is ready";
      content = {
        preheader: "Your NJ PBS Admin access request was approved.",
        heading: "Your NJ PBS Admin account is ready",
        paragraphs: [
          hello,
          `An administrator approved your account with ${plainText(message.role)} access.`,
          "Sign in with the same email address that you used for your request.",
        ],
        details: [
          { label: "Reference", value: plainText(message.reference) },
        ].filter(({ value }) => value),
        ctaLabel: "Open NJ PBS Admin",
        ctaUrl: origin,
        closing: "Reply to this email if you need help with your account.",
      };
      break;
    case "denied":
      subject = "NJ PBS Admin access request update";
      content = {
        preheader: "There is an update to your NJ PBS Admin access request.",
        heading: "Your access request was not approved",
        paragraphs: [
          hello,
          "An administrator did not approve this NJ PBS Admin access request.",
          "If you think this is an error, reply to this email.",
        ],
        details: [
          { label: "Reference", value: plainText(message.reference) },
        ].filter(({ value }) => value),
        ctaLabel: "Return to NJ PBS Admin",
        ctaUrl: origin,
        closing:
          "Include the reference above if you contact NJ PBS about this request.",
      };
      break;
    case "password_reset":
      subject = "Reset your NJ PBS Admin password";
      content = {
        preheader: "Use this secure link to reset your NJ PBS Admin password.",
        heading: "Reset your password",
        paragraphs: [
          hello,
          "Use this link to reset your NJ PBS Admin password.",
        ],
        ctaLabel: "Reset my password",
        ctaUrl: webUrl(message.passwordResetLink, origin),
        closing:
          "If you did not request a password reset, you can ignore this message.",
      };
      break;
    default:
      throw new EmailDeliveryError("Unknown staff email template", {
        kind: "terminal",
      });
  }

  const text = renderEmailText(content);
  const html = renderEmailHtml(content);
  return {
    subject,
    text,
    html,
    attachments: [njpbsEmailLogoAttachment()],
  };
}

function staffEmailIdentity(deps = {}) {
  return {
    fromAddress: normalizeEmail(
      deps.from ?? configuredValue(STAFF_EMAIL_FROM, "CMS_STAFF_EMAIL_FROM"),
    ),
    fromName: "NJ PBS",
    replyTo: normalizeEmail(
      deps.replyTo ??
        configuredValue(STAFF_EMAIL_REPLY_TO, "CMS_STAFF_EMAIL_REPLY_TO"),
    ),
  };
}

function createCloudflareEmailSender(deps = {}) {
  const fetchFn = deps.fetchFn ?? fetch;
  const accountId =
    deps.accountId ??
    configuredValue(STAFF_EMAIL_ACCOUNT_ID, "CMS_STAFF_EMAIL_ACCOUNT_ID");
  const apiToken =
    deps.apiToken ??
    process.env.CMS_STAFF_EMAIL_API_TOKEN?.trim() ??
    STAFF_EMAIL_API_TOKEN.value().trim();
  const { fromAddress, fromName, replyTo } = staffEmailIdentity(deps);

  return async ({ to, bcc, subject, html, text, attachments }) => {
    if (!accountId || !apiToken ||
        [fromAddress, replyTo].some(value => !value || value === "replace_me@example.org")) {
      throw new EmailDeliveryError("Staff email delivery is not configured", {
        kind: "retryable",
      });
    }

    const payload = {
      to,
      from: { address: fromAddress, name: fromName },
      reply_to: replyTo,
      subject,
      html,
      text,
      ...(bcc ? { bcc } : {}),
      ...(attachments?.length ? { attachments } : {}),
    };
    const requestBody = JSON.stringify(payload);
    if (Buffer.byteLength(requestBody, "utf8") > MAX_JSON_REQUEST_BYTES) {
      throw new EmailDeliveryError("Email request exceeds the size limit", {
        kind: "terminal",
      });
    }

    let response;
    try {
      response = await fetchFn(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/email/sending/send`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiToken}`,
            "content-type": "application/json",
          },
          body: requestBody,
        },
      );
    } catch (error) {
      throw new EmailDeliveryError("Email provider result is unknown", {
        kind: "ambiguous",
        cause: error,
      });
    }

    let result = null;
    try {
      result = await response.json();
    } catch {
      result = null;
    }

    if (response.ok && result?.success === true) {
      return {
        provider: "cloudflare-email-service",
        delivered: Array.isArray(result?.result?.delivered)
          ? result.result.delivered.includes(to)
          : false,
        queued: Array.isArray(result?.result?.queued)
          ? result.result.queued.includes(to)
          : false,
      };
    }

    const kind =
      response.status === 429 || response.status >= 500
        ? "retryable"
        : "terminal";
    throw new EmailDeliveryError("Email provider refused the message", {
      kind,
      status: response.status,
    });
  };
}

function queueStaffAccessEmail(transaction, firestore, message, nowValue) {
  const deliveryId = message.deliveryId ?? message.requestVersion;
  const id = outboxId(message.uid, deliveryId, message.eventType);
  const ref = firestore.collection(OUTBOX_COLLECTION).doc(id);
  transaction.set(
    ref,
    {
      uid: message.uid,
      requestVersion: message.requestVersion ?? null,
      deliveryId,
      eventType: message.eventType,
      to: normalizeEmail(message.to),
      displayName: message.displayName ?? null,
      verificationLink: message.verificationLink ?? null,
      passwordResetLink: message.passwordResetLink ?? null,
      reference: message.reference ?? null,
      state: "pending",
      attemptCount: 0,
      nextAttemptAt: nowValue,
      createdAt: nowValue,
      updatedAt: nowValue,
      leaseUntil: null,
      provider: null,
      providerState: null,
      lastStatus: null,
      sentAt: null,
    },
    { merge: true },
  );
  return id;
}

function timestampMillis(value) {
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return 0;
}

function sameOutboxRevision(row, expected) {
  if (!expected) return true;
  return (
    row.deliveryId === expected.deliveryId &&
    Number(row.attemptCount || 0) === Number(expected.attemptCount || 0) &&
    timestampMillis(row.updatedAt) === timestampMillis(expected.updatedAt)
  );
}

function deliverableOutboxRow(row, now) {
  if (row.state !== "pending") return false;
  if (timestampMillis(row.nextAttemptAt) > now.getTime()) return false;
  return !(row.leaseUntil && timestampMillis(row.leaseUntil) > now.getTime());
}

async function readDeliverableOutboxMessage(firestore, id, now = new Date()) {
  const ref = firestore.collection(OUTBOX_COLLECTION).doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) return null;
  const row = snapshot.data();
  if (!deliverableOutboxRow(row, now)) return null;
  return { id, ref, ...row };
}

async function claimOutboxMessage(
  firestore,
  id,
  now = new Date(),
  expected = null,
) {
  const ref = firestore.collection(OUTBOX_COLLECTION).doc(id);
  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return null;
    const row = snapshot.data();
    if (!deliverableOutboxRow(row, now)) return null;
    if (!sameOutboxRevision(row, expected)) return null;
    const leaseUntil = new Date(now.getTime() + LEASE_MILLIS);
    transaction.update(ref, {
      state: "sending",
      leaseUntil,
      attemptCount: Number(row.attemptCount || 0) + 1,
      updatedAt: now,
    });
    return { id, ref, ...row, attemptCount: Number(row.attemptCount || 0) + 1 };
  });
}

async function markOutboxRenderingFailed(
  firestore,
  id,
  expected,
  error,
  now = new Date(),
) {
  const ref = firestore.collection(OUTBOX_COLLECTION).doc(id);
  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return { state: "skipped" };
    const row = snapshot.data();
    if (!deliverableOutboxRow(row, now) || !sameOutboxRevision(row, expected)) {
      return { state: "skipped" };
    }
    transaction.update(ref, {
      state: "failed",
      attemptCount: Number(row.attemptCount || 0) + 1,
      leaseUntil: null,
      nextAttemptAt: null,
      lastStatus: error.status,
      updatedAt: now,
    });
    return { state: "failed" };
  });
}

async function deliverStaffAccessEmail(id, deps = {}) {
  const firestore = deps.firestore ?? db;
  const now = deps.now ?? (() => new Date());
  const sendEmail = deps.sendEmail ?? createCloudflareEmailSender(deps);
  const renderEmail = deps.renderEmail ?? renderStaffAccessEmail;
  const candidate = await readDeliverableOutboxMessage(firestore, id, now());
  if (!candidate) return { state: "skipped" };

  const adminOrigin =
    deps.adminOrigin ??
    configuredValue(STAFF_EMAIL_ADMIN_ORIGIN, "CMS_STAFF_EMAIL_ADMIN_ORIGIN");
  let rendered;
  let deliveryError = null;
  try {
    rendered = await renderEmail(candidate, { adminOrigin });
  } catch (error) {
    deliveryError =
      error instanceof EmailDeliveryError
        ? error
        : new EmailDeliveryError("Email content rendering failed", {
            kind: "terminal",
            cause: error,
          });
  }
  if (deliveryError) {
    return markOutboxRenderingFailed(
      firestore,
      id,
      candidate,
      deliveryError,
      now(),
    );
  }

  const row = await claimOutboxMessage(firestore, id, now(), candidate);
  if (!row) return { state: "skipped" };
  let receipt;
  try {
    receipt = await sendEmail({ to: row.to, ...rendered });
    await row.ref.update({
      state: "sent",
      leaseUntil: null,
      provider: receipt.provider ?? "unknown",
      providerState: receipt.delivered
        ? "delivered"
        : receipt.queued
          ? "queued"
          : "accepted",
      sentAt: now(),
      updatedAt: now(),
      verificationLink: null,
      passwordResetLink: null,
    });
    return { state: "sent" };
  } catch (error) {
    deliveryError =
      error instanceof EmailDeliveryError
        ? error
        : new EmailDeliveryError("Email delivery failed", {
            kind: "ambiguous",
            cause: error,
          });
    const attemptCount = row.attemptCount;
    let state;
    let nextAttemptAt = null;
    if (deliveryError.kind === "ambiguous") {
      state = "unknown";
    } else if (
      deliveryError.kind === "retryable" &&
      attemptCount < MAX_ATTEMPTS
    ) {
      state = "pending";
      const backoffMinutes = 2 ** Math.max(0, attemptCount - 1);
      nextAttemptAt = new Date(now().getTime() + backoffMinutes * 60 * 1000);
    } else {
      state = "failed";
    }
    await row.ref.update({
      state,
      leaseUntil: null,
      nextAttemptAt,
      lastStatus: deliveryError.status,
      updatedAt: now(),
    });
    return { state };
  }
}

async function recoverExpiredSendingEmails(deps = {}) {
  const firestore = deps.firestore ?? db;
  const now = deps.now ?? (() => new Date());
  const currentTime = now();
  const snapshot = await firestore
    .collection(OUTBOX_COLLECTION)
    .where("state", "==", "sending")
    .where("leaseUntil", "<=", currentTime)
    .limit(25)
    .get();
  const results = [];
  for (const doc of snapshot.docs) {
    const state = await firestore.runTransaction(async (transaction) => {
      const current = await transaction.get(doc.ref);
      if (!current.exists) return "skipped";
      const row = current.data();
      if (
        row.state !== "sending" ||
        timestampMillis(row.leaseUntil) > currentTime.getTime()
      ) {
        return "skipped";
      }
      // The process may have stopped before or after the provider accepted the
      // message. Mark the result unknown instead of risking an automatic duplicate.
      transaction.update(doc.ref, {
        state: "unknown",
        leaseUntil: null,
        nextAttemptAt: null,
        updatedAt: currentTime,
      });
      return "unknown";
    });
    results.push({ state });
  }
  return results;
}

async function retryPendingStaffAccessEmails(deps = {}) {
  const firestore = deps.firestore ?? db;
  const now = deps.now ?? (() => new Date());
  const snapshot = await firestore
    .collection(OUTBOX_COLLECTION)
    .where("state", "==", "pending")
    .where("nextAttemptAt", "<=", now())
    .limit(25)
    .get();
  const results = [];
  for (const doc of snapshot.docs) {
    results.push(await deliverStaffAccessEmail(doc.id, deps));
  }
  return results;
}

const onStaffAccessEmailRetry = onSchedule(
  {
    // Request handlers make the first delivery attempt. This low-frequency job
    // exists only for known-safe retry and expired-lease recovery.
    schedule: "every 60 minutes",
    secrets: [STAFF_EMAIL_API_TOKEN],
  },
  async () => {
    await recoverExpiredSendingEmails();
    await retryPendingStaffAccessEmails();
  },
);

module.exports = {
  EmailDeliveryError,
  MAX_JSON_REQUEST_BYTES,
  OUTBOX_COLLECTION,
  STAFF_EMAIL_ACCOUNT_ID,
  STAFF_EMAIL_ADMIN_ORIGIN,
  STAFF_EMAIL_API_TOKEN,
  STAFF_EMAIL_FROM,
  STAFF_EMAIL_REPLY_TO,
  claimOutboxMessage,
  createCloudflareEmailSender,
  deliverStaffAccessEmail,
  onStaffAccessEmailRetry,
  outboxId,
  queueStaffAccessEmail,
  recoverExpiredSendingEmails,
  renderStaffAccessEmail,
  retryPendingStaffAccessEmails,
  staffEmailIdentity,
};
