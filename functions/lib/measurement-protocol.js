"use strict";

// Consent and payload core for server-side GA4 conversions (#234).
//
// This lives under functions/ because Firebase packages that directory and no
// other repository tree. The future PMSSO/Stripe proxy can therefore require
// the same pure implementation tested through site/src/lib/measurement-protocol.ts.
// It performs no network I/O and reads no credentials; the proxy owns transport,
// measurement_id, and api_secret.

const CONSENT_COOKIE = "njpbs-consent";
const CONSENT_VERSION = "v4";
const GA_COOKIE = "_ga";
const GA_CLIENT_ID = /^\d+\.\d+$/;
const GA_COOKIE_PREFIX = /^GA1\.\d+\./;
const STRIPE_TRANSACTION_ID = /^(?:cs|in|pi)_[A-Za-z0-9_]+$/;
const ISO_CURRENCY = /^[A-Z]{3}$/;
const SERVER_EVENTS = new Set(["member_login", "purchase"]);

/**
 * Read exactly one named cookie. Cookie ordering is not a recency guarantee, so
 * duplicate values are ambiguous even when they agree. Rejecting all duplicates
 * keeps a stale granted value from overriding a newer denial.
 */
function readCookie(header, name) {
  if (typeof header !== "string") return null;

  let raw = null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    if (raw !== null) return null;
    raw = part.slice(eq + 1).trim();
  }

  if (raw === null) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function parseGaClientId(cookieHeader) {
  const raw = readCookie(cookieHeader, GA_COOKIE);
  if (raw === null) return null;
  const prefix = raw.match(GA_COOKIE_PREFIX);
  if (!prefix) return null;
  const clientId = raw.slice(prefix[0].length);
  return GA_CLIENT_ID.test(clientId) ? clientId : null;
}

function parseConsentCookie(cookieHeader) {
  const raw = readCookie(cookieHeader, CONSENT_COOKIE);
  if (raw === null) return "absent";
  const separator = raw.indexOf(":");
  if (separator === -1 || raw.slice(0, separator) !== CONSENT_VERSION) return "absent";

  for (const pair of raw.slice(separator + 1).split(",")) {
    const eq = pair.indexOf("=");
    if (eq === -1 || pair.slice(0, eq).trim() !== "analytics") continue;
    return pair.slice(eq + 1).trim() === "granted" ? "granted" : "denied";
  }
  return "absent";
}

function hasGpc(gpcHeader) {
  return typeof gpcHeader === "string" && gpcHeader.trim() === "1";
}

function decideServerEvent(signals) {
  if (hasGpc(signals.gpcHeader)) return { send: false, reason: "gpc" };
  const consent = parseConsentCookie(signals.cookieHeader);
  if (consent === "absent") return { send: false, reason: "no-consent-cookie" };
  if (consent !== "granted") return { send: false, reason: "consent-denied" };
  const clientId = parseGaClientId(signals.cookieHeader);
  if (clientId === null) return { send: false, reason: "no-client-id" };
  return { send: true, clientId };
}

function requirePositiveInteger(params, name) {
  if (!Number.isSafeInteger(params[name]) || params[name] <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function purchaseParams(params) {
  if (
    typeof params.transaction_id !== "string" ||
    !STRIPE_TRANSACTION_ID.test(params.transaction_id.trim())
  ) {
    throw new TypeError("purchase transaction_id must be a stable Stripe id");
  }
  if (typeof params.value !== "number" || !Number.isFinite(params.value) || params.value <= 0) {
    throw new TypeError("purchase value must be a positive finite number");
  }
  if (typeof params.currency !== "string" || !ISO_CURRENCY.test(params.currency)) {
    throw new TypeError("purchase currency must be a three-letter uppercase code");
  }
  if (typeof params.recurring !== "boolean") {
    throw new TypeError("purchase recurring must be a boolean");
  }

  const cadence = params.recurring ? "recurring" : "one_time";
  return {
    transaction_id: params.transaction_id.trim(),
    value: params.value,
    currency: params.currency,
    recurring: params.recurring,
    items: [
      {
        item_id: `donation_${cadence}`,
        item_name: params.recurring ? "Recurring donation" : "One-time donation",
        price: params.value,
        quantity: 1,
      },
    ],
  };
}

/**
 * Build one attributed conversion event. session_id and engagement_time_msec
 * keep the server event attached to the browser session instead of merely the
 * user. Event-specific construction keeps a spread Stripe/member object from
 * leaking PII. Purchases require the complete station event-map contract and
 * synthesize a fixed donation item instead of accepting caller-owned item data.
 */
function buildEventPayload(clientId, name, params = {}) {
  if (typeof clientId !== "string" || !GA_CLIENT_ID.test(clientId)) {
    throw new TypeError("clientId must be a GA client id");
  }
  if (!SERVER_EVENTS.has(name)) {
    throw new TypeError("event name is not an allowed server conversion");
  }
  requirePositiveInteger(params, "session_id");
  requirePositiveInteger(params, "engagement_time_msec");
  const safe = {
    session_id: params.session_id,
    engagement_time_msec: params.engagement_time_msec,
    ...(name === "purchase" ? purchaseParams(params) : {}),
  };
  return {
    client_id: clientId,
    non_personalized_ads: true,
    events: [{ name, params: safe }],
  };
}

module.exports = {
  parseGaClientId,
  parseConsentCookie,
  decideServerEvent,
  buildEventPayload,
};
