"use strict";

const { onMessagePublished } = require("firebase-functions/v2/pubsub");
const { defineString, defineFloat, defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { getApps, initializeApp } = require("firebase-admin/app");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");
const {
  assertBillingEnabled,
  BILLING_DOC_PATH,
} = require("./lib/billing-state");

const BUDGET_TOPIC = defineString("BILLING_BUDGET_TOPIC", {
  default: "billing-budget-alerts",
});
const DISABLE_THRESHOLD = defineFloat("BILLING_DISABLE_THRESHOLD", {
  default: 1.0,
});
const ALERT_URL = defineString("BILLING_ALERT_URL", {
  default: "",
});
const ALERT_TOKEN = defineSecret("BILLING_ALERT_TOKEN");

if (!process.env.BILLING_ALERT_URL?.trim()) {
  logger.warn("Billing alert destination is not configured; set BILLING_ALERT_URL.");
}

function malformedBudgetNotification(message) {
  return new Error(`malformed budget notification: ${message}`);
}

function getErrorMessage(err) {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

function hasMessageProperty(message, property) {
  return message !== null && typeof message === "object" && property in message;
}

function assertFiniteNumber(payload, field) {
  const value = payload[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw malformedBudgetNotification(`${field} must be a finite number`);
  }
  return value;
}

function parseBudgetNotification(message) {
  let payload;

  if (hasMessageProperty(message, "json")) {
    try {
      payload = message.json;
    } catch (err) {
      throw malformedBudgetNotification(getErrorMessage(err));
    }
  } else if (hasMessageProperty(message, "data")) {
    if (typeof message.data !== "string") {
      throw malformedBudgetNotification("data must be a base64 string");
    }

    try {
      const decoded = Buffer.from(message.data, "base64").toString("utf8");
      payload = JSON.parse(decoded);
    } catch (err) {
      throw malformedBudgetNotification(getErrorMessage(err));
    }
  } else {
    payload = message;
  }

  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw malformedBudgetNotification("payload must be an object");
  }

  return {
    costAmount: assertFiniteNumber(payload, "costAmount"),
    budgetAmount: assertFiniteNumber(payload, "budgetAmount"),
    currencyCode: payload.currencyCode,
    budgetDisplayName: payload.budgetDisplayName,
    alertThresholdExceeded: payload.alertThresholdExceeded,
    forecastThresholdExceeded: payload.forecastThresholdExceeded,
    costIntervalStart: payload.costIntervalStart,
    budgetAmountType: payload.budgetAmountType,
  };
}

function evaluateBudget(payload, threshold = 1.0) {
  // Zero and negative budgets are spend-forbidden; any spend yields an unbounded ratio.
  const ratio = payload.budgetAmount > 0
    ? payload.costAmount / payload.budgetAmount
    : (payload.costAmount > 0 ? Infinity : 0);
  const shouldDisable = ratio >= threshold;

  return { shouldDisable, ratio, threshold };
}

function nullableValue(value) {
  return value === undefined ? null : value;
}

function formatSpendAmount(amount, currencyCode) {
  const currencySuffix = currencyCode ? ` ${currencyCode}` : "";
  return `$${amount}${currencySuffix}`;
}

function formatRatio(payload, ratio) {
  if (!Number.isFinite(ratio)) {
    return payload.budgetAmount === 0
      ? "unbounded (zero budget)"
      : "unbounded (non-positive budget)";
  }
  return ratio.toFixed(3);
}

function buildDisableReason(payload, ratio) {
  return (
    `spend ${formatSpendAmount(payload.costAmount, payload.currencyCode)} ` +
    `crossed budget ${formatSpendAmount(payload.budgetAmount, payload.currencyCode)} ` +
    `(ratio ${formatRatio(payload, ratio)})`
  ).trim();
}

async function applyBudgetNotification(db, payload, options = {}) {
  const threshold = options.threshold === undefined ? 1.0 : options.threshold;
  const ref = db.doc(BILLING_DOC_PATH);
  const snap = await ref.get();
  const existing = snap.exists ? snap.data() : null;
  const { shouldDisable, ratio } = evaluateBudget(payload, threshold);
  const telemetry = {
    costAmount: payload.costAmount,
    budgetAmount: payload.budgetAmount,
    currencyCode: nullableValue(payload.currencyCode),
    budgetDisplayName: nullableValue(payload.budgetDisplayName),
    alertThresholdExceeded: nullableValue(payload.alertThresholdExceeded),
    ratio,
    costIntervalStart: nullableValue(payload.costIntervalStart),
    lastNotificationAt: FieldValue.serverTimestamp(),
  };

  if (shouldDisable) {
    if (existing && existing.disabled === true) {
      await ref.set(telemetry, { merge: true });
      return {
        action: "already-disabled",
        disabled: true,
        freshDisable: false,
        ratio,
      };
    }

    const reason = buildDisableReason(payload, ratio);
    await ref.set({
      ...telemetry,
      disabled: true,
      reason,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    return {
      action: "disabled",
      disabled: true,
      freshDisable: true,
      ratio,
      reason,
    };
  }

  await ref.set(telemetry, { merge: true });

  return {
    action: "telemetry",
    disabled: !!(existing && existing.disabled),
    freshDisable: false,
    ratio,
  };
}

// How long to wait on the notify service before giving up. The alert is
// best-effort and runs after the disable flag is already written, so it must
// never hold the invocation open on a slow or hung endpoint. Same reason the
// schedule proxy bounds its own fetch (functions/lib/pbs/schedule-proxy.js).
const ALERT_TIMEOUT_MS = 5000;

async function sendBillingAlert({ url, token, message, timeoutMs = ALERT_TIMEOUT_MS }) {
  if (!token) {
    return { sent: false, skipped: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`alert request failed with status ${response.status}`);
    }

    return { sent: true };
  } catch (err) {
    // A timeout abort surfaces here as an AbortError; like any other alert
    // failure it is logged and swallowed. This function never touches the
    // disable flag, so the log says so: the failure is delivery only, and
    // whoever reads it after a trip knows the kill switch itself still applied.
    const error = getErrorMessage(err);
    logger.error(
      "billing kill switch: alert delivery failed (best-effort; disable flag unaffected)",
      { error },
    );
    return { sent: false, error };
  } finally {
    clearTimeout(timer);
  }
}

const onBudgetNotification = onMessagePublished(
  {
    topic: BUDGET_TOPIC,
    secrets: [ALERT_TOKEN],
    region: "us-central1",
  },
  async (event) => {
    if (!getApps().length) {
      initializeApp();
    }

    const db = getFirestore();
    let payload;

    try {
      payload = parseBudgetNotification(event.data.message);
    } catch (err) {
      logger.error("billing kill switch: could not parse notification", err);
      return;
    }

    const result = await applyBudgetNotification(db, payload, {
      threshold: DISABLE_THRESHOLD.value(),
    });
    logger.info("billing kill switch processed notification", {
      action: result.action,
      ratio: result.ratio,
    });

    if (result.freshDisable) {
      const alert = await sendBillingAlert({
        url: ALERT_URL.value(),
        token: ALERT_TOKEN.value(),
        message: (
          `NJ PBS billing kill switch tripped: ${result.reason}. ` +
          "Application spending disabled (Firestore flag). " +
          "Metered functions now refuse until re-armed."
        ),
      });
      logger.info("billing kill switch alert", alert);
    }
  },
);

module.exports = {
  onBudgetNotification,
  assertBillingEnabled,
  applyBudgetNotification,
  evaluateBudget,
  parseBudgetNotification,
  sendBillingAlert,
  BUDGET_TOPIC,
  BILLING_DOC_PATH,
};
