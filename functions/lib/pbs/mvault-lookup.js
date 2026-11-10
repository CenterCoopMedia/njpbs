"use strict";

const {
  evaluateEntitlement,
  identityMismatch,
  passportResetOffered,
} = require("./mvault-entitlement");

const MVAULT_ORIGIN = "https://mvault.services.pbs.org";
const DEFAULT_TIMEOUT_MS = 8000;
const TIMINGS = new Set([
  "before_start",
  "within_start_expire_dates",
  "within_grace_period",
  "expired",
]);

function nonblank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function pathSegment(value) {
  if (!nonblank(value) || value === "." || value === "..") {
    throw new Error("Invalid MVault path segment");
  }
  return encodeURIComponent(value);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Strict wire mapping; never pass upstream objects into the decision policy. */
function mapMembership(record) {
  if (!isRecord(record)) return null;
  if (typeof record.status !== "string" || !/^(on|off)$/i.test(record.status)) return null;
  if (record.offer != null && typeof record.offer !== "string") return null;
  if (record.provisional !== undefined && typeof record.provisional !== "boolean") return null;
  if (record.email != null && typeof record.email !== "string") return null;
  const current = record.current_state;
  if (!isRecord(current) || typeof current.has_access !== "boolean") return null;
  const explanation = current.explanation;
  if (!isRecord(explanation) || !TIMINGS.has(explanation.timing)) return null;
  if (typeof explanation.token_activated !== "boolean") return null;
  if (explanation.status !== record.status) return null;

  // PBS exposes timing inside current_state.explanation. Raw date fields are
  // UTC timestamps, not the calendar dates accepted by the policy fallback.
  // Require a known upstream verdict instead of truncating those timestamps.
  return {
    status: record.status,
    offer: record.offer,
    provisional: record.provisional === true || !explanation.token_activated,
    timing: explanation.timing,
  };
}

function classifyHttpStatus(status) {
  if (status === 200) return "ok";
  if (status === 404) return "not-found";
  if (status === 401 || status === 403) return "forbidden";
  if (status === 429) return "rate-limited";
  return "error";
}

async function readMembership({ url, authorization, signInEmail, now, fetchImpl, signal }) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Authorization: authorization, Accept: "application/json" },
    redirect: "error",
    cache: "no-store",
    signal,
  });
  const status = classifyHttpStatus(response.status);
  if (status !== "ok") return { status };
  const records = await response.json();
  if (!Array.isArray(records)) return { status: "error" };
  if (records.length === 0) return { status: "not-found" };
  if (records.length !== 1) return { status: "error" };
  const membership = mapMembership(records[0]);
  if (!membership) return { status: "error" };
  let entitlement = evaluateEntitlement(membership, now);
  if (entitlement.state === "malformed") return { status: "error" };
  // A local policy can deny PBS's grant; it cannot override PBS's denial.
  if (entitlement.entitled && !records[0].current_state.has_access) {
    entitlement = { entitled: false, state: "inactive" };
  }
  const contactEmail = records[0].email;
  return {
    status: "ok",
    entitlement,
    identityMismatch: identityMismatch(signInEmail, contactEmail),
    passportResetOffered: passportResetOffered(entitlement, signInEmail, contactEmail),
  };
}

/**
 * Server-only UID lookup, built but not exported as a Cloud Function (#1261).
 * Results contain only finite decisions. Neither upstream data nor exception
 * text is returned or logged. A later handler must supply a verified PBS UID.
 */
async function fetchMembership({
  stationId,
  pbsUid,
  apiKey,
  apiSecret,
  signInEmail,
  now = Date.now(),
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!nonblank(stationId) || !nonblank(apiKey) || !nonblank(apiSecret)) {
    return { status: "not-configured" };
  }
  // A colon changes the username/password boundary in HTTP Basic Auth.
  if (apiKey.includes(":")) return { status: "not-configured" };
  let timer;
  const controller = new AbortController();
  try {
    const url = `${MVAULT_ORIGIN}/api/${pathSegment(stationId)}/memberships/filter/uid/${pathSegment(pbsUid)}/`;
    const authorization = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`, "utf8").toString("base64")}`;
    const budget = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(timeoutMs, DEFAULT_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => {
        resolve({ status: "timeout" });
        controller.abort();
      }, budget);
    });
    // Race the entire operation, including the body read. This also bounds an
    // injected fetch that does not honor AbortSignal.
    return await Promise.race([
      readMembership({ url, authorization, signInEmail, now, fetchImpl, signal: controller.signal }),
      deadline,
    ]);
  } catch {
    return { status: "error" };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

module.exports = { fetchMembership };
