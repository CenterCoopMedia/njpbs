"use strict";

// Response-header helpers shared by the server-side proxy endpoints (#185).
//
// These are pure: each returns a plain header map, so the request handler can
// merge and apply them and a test can assert the exact headers with no Express
// response mock. The header baseline is carried over from the CJS2026 proxy
// (nosniff, frame-options, HSTS, referrer-policy, permissions-policy); the CORS
// helper implements an origin allowlist so only the Cloudflare/Pages-served
// static front can call the Firebase Functions origin from a browser.

// The header baseline every proxy response carries. Kept restrictive on purpose:
// the proxy returns JSON, never frames, and never needs a browser feature, so it
// denies framing outright and turns the powerful features off.
const HARDENING_HEADERS = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), browsing-topics=()",
});

// Origins the static front is served from and is therefore allowed to call the
// proxy from a browser. The apex and www are the public deploy; dev is the
// post-merge review surface. The wired function extends this with any project
// param, so this list is the safe default, not the whole story.
const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
  "https://njpbs.org",
  "https://www.njpbs.org",
  "https://dev-public.example.org",
]);

/** The header baseline, as a fresh mutable copy per call. */
function hardeningHeaders() {
  return { ...HARDENING_HEADERS };
}

/**
 * Decide the allowed origin for a request. Returns the request's own origin
 * when it is on the allowlist, so the response can echo it back exactly (a
 * wildcard would defeat the point of an allowlist), or null when the origin is
 * absent or not allowed. Matching is exact and case-sensitive: an Origin header
 * is a serialized origin, not a free-text field.
 */
function resolveAllowedOrigin(requestOrigin, allowlist = DEFAULT_ALLOWED_ORIGINS) {
  if (typeof requestOrigin !== "string" || requestOrigin === "") {
    return null;
  }
  return allowlist.includes(requestOrigin) ? requestOrigin : null;
}

/**
 * CORS headers for a request. Always sets `Vary: Origin` so a shared cache never
 * serves one origin's allowed response to another. When the origin is allowed it
 * echoes it and advertises the read-only method set; when it is not, it returns
 * only `Vary` (no allow-origin), which is how a browser is told the call is not
 * permitted. `allowed` lets the handler answer a disallowed preflight distinctly.
 */
function corsHeaders({
  requestOrigin,
  allowlist = DEFAULT_ALLOWED_ORIGINS,
  methods = "GET, OPTIONS",
} = {}) {
  const origin = resolveAllowedOrigin(requestOrigin, allowlist);
  const headers = { Vary: "Origin" };

  if (origin === null) {
    return { headers, allowed: false };
  }

  headers["Access-Control-Allow-Origin"] = origin;
  headers["Access-Control-Allow-Methods"] = methods;
  headers["Access-Control-Allow-Headers"] = "Content-Type";
  headers["Access-Control-Max-Age"] = "3600";

  return { headers, allowed: true };
}

module.exports = {
  HARDENING_HEADERS,
  DEFAULT_ALLOWED_ORIGINS,
  hardeningHeaders,
  resolveAllowedOrigin,
  corsHeaders,
};
