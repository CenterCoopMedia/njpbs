"use strict";

// Durable Telegram alerts for new, verified Boardwalk account requests. The
// request transaction writes one deterministic row. The Firestore trigger makes
// the first attempt, and the existing Telegram scheduler recovers safe retries.

const { db } = require("./firebase");

const STAFF_ACCESS_NOTIFICATION_COLLECTION =
  "staffAccessNotificationOutbox";
const MAX_ATTEMPTS = 5;
const LEASE_MILLIS = 2 * 60 * 1_000;
const BATCH_SIZE = 25;

function notificationId(uid, requestVersion) {
  return `${uid}--${requestVersion}--pending`;
}

function timestampMillis(value) {
  if (typeof value?.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") return Date.parse(value);
  if (typeof value === "number") return value;
  return Number.NaN;
}

function plainText(value, maxLength) {
  const normalized = typeof value === "string"
    ? value.trim().replace(/\s+/g, " ")
    : "";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
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
  let result = "";
  for (const character of String(value ?? "")) {
    const encoded = escapeHtml(character);
    if (Buffer.byteLength(`${result}${encoded}…`, "utf8") > maxBytes) {
      return `${result}…`;
    }
    result += encoded;
  }
  return result;
}

function validRequest(row) {
  return row?.eventType === "request_pending" &&
    typeof row.uid === "string" &&
    row.uid.length > 0 &&
    row.uid.length <= 1_500 &&
    !row.uid.includes("/") &&
    Number.isInteger(row.requestVersion) &&
    row.requestVersion > 0 &&
    row.requestVersion <= Number.MAX_SAFE_INTEGER &&
    plainText(row.email, 255).length > 0 &&
    plainText(row.reason, 500).length >= 5 &&
    plainText(row.reference, 100).length > 0;
}

function queueStaffAccessNotification(
  transaction,
  firestore,
  request,
  now = new Date(),
) {
  if (!validRequest({ ...request, eventType: "request_pending" })) {
    throw new Error("A valid pending staff access request is required");
  }
  const id = notificationId(request.uid, request.requestVersion);
  const ref = firestore
    .collection(STAFF_ACCESS_NOTIFICATION_COLLECTION)
    .doc(id);
  transaction.set(ref, {
    eventType: "request_pending",
    uid: request.uid,
    requestVersion: request.requestVersion,
    email: plainText(request.email, 255).toLowerCase(),
    displayName: plainText(request.displayName, 120) || null,
    reason: plainText(request.reason, 500),
    reference: plainText(request.reference, 100),
    requestedAt: request.requestedAt ?? now,
    state: "pending",
    attemptCount: 0,
    nextAttemptAt: now,
    leaseUntil: null,
    telegramChatId: null,
    telegramMessageId: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

function reviewUrl(origin = "https://admin.njpbs.org") {
  return `${origin.replace(/\/$/, "")}/staff-access#staff-request-heading`;
}

function renderStaffAccessTelegram(row, origin) {
  const name = plainText(row.displayName, 120);
  const email = plainText(row.email, 255);
  const reason = plainText(row.reason, 500);
  const reference = plainText(row.reference, 100);
  const url = reviewUrl(origin);
  const applicant = name ? `${name} (${email})` : email;
  const text = [
    "<b>New Boardwalk account request</b>",
    "",
    `<b>Applicant</b> ${escapeHtmlBounded(applicant, 720)}`,
    `<b>Reason</b> ${escapeHtmlBounded(reason, 2_400)}`,
    `<b>Reference</b> <code>${escapeHtmlBounded(reference, 200)}</code>`,
    "",
    "Review and decide this request in Boardwalk.",
  ].join("\n");
  return {
    text,
    keyboard: {
      inline_keyboard: [[{ text: "Review request", url }]],
    },
  };
}

async function claimStaffAccessNotification(
  firestore,
  id,
  now = new Date(),
) {
  const ref = firestore
    .collection(STAFF_ACCESS_NOTIFICATION_COLLECTION)
    .doc(id);
  return firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return null;
    const row = snapshot.data();
    if (row.state !== "pending") return null;
    if (timestampMillis(row.nextAttemptAt) > now.getTime()) return null;
    if (!validRequest(row)) {
      transaction.update(ref, {
        state: "terminal_failed",
        nextAttemptAt: null,
        leaseUntil: null,
        lastError: "invalid_request",
        updatedAt: now,
      });
      return { state: "terminal_failed" };
    }
    const attemptCount = Number(row.attemptCount || 0) + 1;
    transaction.update(ref, {
      state: "sending",
      attemptCount,
      leaseUntil: new Date(now.getTime() + LEASE_MILLIS),
      lastError: null,
      updatedAt: now,
    });
    return { id, ref, ...row, attemptCount };
  });
}

async function settleNotificationSuccess(row, receipt, deps = {}) {
  const firestore = deps.firestore ?? db;
  const now = deps.now ?? (() => new Date());
  const at = now();
  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(row.ref);
    if (!snapshot.exists || snapshot.data().state !== "sending") return;
    transaction.update(row.ref, {
      state: "delivered",
      leaseUntil: null,
      nextAttemptAt: null,
      telegramChatId: String(receipt.chatId),
      telegramMessageId: String(receipt.messageId),
      lastError: null,
      deliveredAt: at,
      updatedAt: at,
    });
  });
}

async function settleNotificationFailure(row, error, deps = {}) {
  const firestore = deps.firestore ?? db;
  const now = deps.now ?? (() => new Date());
  const at = now();
  const retryable = error?.kind === "retryable";
  const ambiguous = error?.kind !== "terminal" && !retryable;
  const canRetry = retryable && row.attemptCount < MAX_ATTEMPTS;
  const state = ambiguous ? "unknown" : canRetry ? "pending" : "terminal_failed";
  const nextAttemptAt = canRetry
    ? new Date(at.getTime() + 2 ** Math.max(0, row.attemptCount - 1) * 60 * 1_000)
    : null;
  const safeError = `${error?.kind || "ambiguous"}${error?.status ? ` (${error.status})` : ""}`;
  await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(row.ref);
    if (!snapshot.exists || snapshot.data().state !== "sending") return;
    transaction.update(row.ref, {
      state,
      leaseUntil: null,
      nextAttemptAt,
      lastError: safeError,
      updatedAt: at,
    });
  });
  return state;
}

async function deliverStaffAccessNotification(id, deps = {}) {
  const firestore = deps.firestore ?? db;
  const now = deps.now ?? (() => new Date());
  const row = await claimStaffAccessNotification(firestore, id, now());
  if (!row) return { state: "skipped" };
  if (row.state === "terminal_failed") return { state: row.state };
  try {
    const chatId = String(deps.chatId ?? "").trim();
    if (!/^[1-9][0-9]{0,19}$/.test(chatId)) {
      const error = new Error("The private administrator chat is not configured");
      error.kind = "retryable";
      throw error;
    }
    if (!deps.telegramClient?.sendMessage) {
      const error = new Error("Telegram delivery is not configured");
      error.kind = "retryable";
      throw error;
    }
    const rendered = renderStaffAccessTelegram(row, deps.adminOrigin);
    const message = await deps.telegramClient.sendMessage(
      chatId,
      rendered.text,
      rendered.keyboard,
    );
    if (!message || !Number.isSafeInteger(Number(message.message_id))) {
      const error = new Error("Telegram returned an invalid receipt");
      error.kind = "ambiguous";
      throw error;
    }
    await settleNotificationSuccess(row, {
      chatId: message.chat?.id ?? chatId,
      messageId: message.message_id,
    }, { firestore, now });
    return { state: "delivered" };
  } catch (error) {
    return {
      state: await settleNotificationFailure(row, error, { firestore, now }),
    };
  }
}

async function recoverExpiredStaffAccessNotifications(deps = {}) {
  const firestore = deps.firestore ?? db;
  const now = deps.now ?? (() => new Date());
  const at = now();
  const snapshot = await firestore
    .collection(STAFF_ACCESS_NOTIFICATION_COLLECTION)
    .where("state", "==", "sending")
    .where("leaseUntil", "<=", at)
    .orderBy("leaseUntil", "asc")
    .limit(BATCH_SIZE)
    .get();
  const results = [];
  for (const document of snapshot.docs) {
    const state = await firestore.runTransaction(async (transaction) => {
      const current = await transaction.get(document.ref);
      if (!current.exists) return "skipped";
      const row = current.data();
      if (
        row.state !== "sending" ||
        timestampMillis(row.leaseUntil) > at.getTime()
      ) {
        return "skipped";
      }
      // The process may have stopped after Telegram accepted the message. Do
      // not send again when the result is ambiguous.
      transaction.update(document.ref, {
        state: "unknown",
        leaseUntil: null,
        nextAttemptAt: null,
        lastError: "ambiguous_expired_lease",
        updatedAt: at,
      });
      return "unknown";
    });
    results.push({ state });
  }
  return results;
}

async function processPendingStaffAccessNotifications(deps = {}) {
  const firestore = deps.firestore ?? db;
  const now = deps.now ?? (() => new Date());
  const snapshot = await firestore
    .collection(STAFF_ACCESS_NOTIFICATION_COLLECTION)
    .where("state", "==", "pending")
    .where("nextAttemptAt", "<=", now())
    .orderBy("nextAttemptAt", "asc")
    .limit(BATCH_SIZE)
    .get();
  const results = [];
  for (const document of snapshot.docs) {
    results.push(await deliverStaffAccessNotification(document.id, deps));
  }
  return results;
}

module.exports = {
  BATCH_SIZE,
  LEASE_MILLIS,
  MAX_ATTEMPTS,
  STAFF_ACCESS_NOTIFICATION_COLLECTION,
  claimStaffAccessNotification,
  deliverStaffAccessNotification,
  notificationId,
  processPendingStaffAccessNotifications,
  queueStaffAccessNotification,
  recoverExpiredStaffAccessNotifications,
  renderStaffAccessTelegram,
  reviewUrl,
  settleNotificationFailure,
  settleNotificationSuccess,
};
