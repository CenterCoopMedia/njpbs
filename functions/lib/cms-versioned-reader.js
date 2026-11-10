"use strict";

// Constructed by default-off retained mounts. Legacy routes use their original
// handlers. Each retained version binds its original two readers.
const { parseReader } = require("./cms-preview-pair");
const sessions = require("./cms-reader-session");
const { requirePrincipal } = require("./auth");
const { can } = require("./rbac");
const { withCmsEdge, requestHeader } = require("./cms-edge");
const { linkForwardedRequest } = require("./session-refusal");

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const VERSIONS = Object.freeze([1, 2]);
const MAX_BYTES = 2 * 1024 * 1024;
const object = value => value && typeof value === "object" && !Array.isArray(value);
function refuse(status = 409) { throw Object.assign(new Error("Versioned CMS reader refused"), { status }); }
function exact(value, keys) {
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) refuse(400);
}
function readerIdentities(readers) {
  exact(readers, ["functions", "cmsApi"]);
  for (const component of ["functions", "cmsApi"]) {
    if (parseReader(readers[component]).component !== component) refuse();
  }
  return Object.fromEntries(Object.entries(readers).map(([key, value]) => [key, sessions.readerSessionDigest(value)]));
}
function sessionIds(value) {
  exact(value, ["functions", "cmsApi"]);
  if (Object.values(value).some(id => typeof id !== "string" || !UUID.test(id)) || value.functions === value.cmsApi) refuse(400);
  return value;
}

/** Handlers are the actual retained endpoint handlers, selected in trusted
 * deployment code, never an endpoint or origin supplied by an HTTP caller.
 * Each handler retains its own permissions, input validation and idempotency.
 * Version numbers describe this envelope, not a waiver of content contracts.
 */
function createVersionedCmsReaderHandler({ firestore, readers, version, handlers,
  authenticate = req => requirePrincipal(req, { checkRevoked: true, cacheRevocation: false }),
  now = Date.now, edge } = {}) {
  const identities = readerIdentities(readers);
  if (!VERSIONS.includes(version) || !firestore || !object(handlers) || !Object.keys(handlers).length ||
      Object.entries(handlers).some(([name, handler]) => !/^cms[A-Za-z0-9]{1,80}$/.test(name) || typeof handler !== "function") ||
      typeof authenticate !== "function" || Object.values(readers).some(reader => !reader.supported.adminSession.includes(version))) refuse();
  // Copy trusted configuration so a later caller mutation cannot switch code.
  const retained = structuredClone(readers), dispatch = Object.freeze({ ...handlers });
  return withCmsEdge(async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try {
      if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
      if (!req.is?.("application/json") || !object(req.body) || Buffer.byteLength(JSON.stringify(req.body)) > MAX_BYTES) refuse(400);
      if (requestHeader(req, "x-njpbs-cms-reader") !== identities.cmsApi) refuse(403);
      const actor = await authenticate(req);
      if (typeof actor?.uid !== "string" || !can(actor.principal, "guide.view")) refuse(403);
      const input = req.body;
      if (input.version !== version) refuse(400);
      if (input.action === "open") {
        exact(input, ["version", "action", "sessionIds", "ttlMs"]);
        sessionIds(input.sessionIds);
        // Both leases and quota are committed together. Retrying the original
        // IDs returns their original expiries; it cannot renew them. A retry
        // after expiry gets the typed 410 below, which also spends no quota.
        const leases = await sessions.openReaderSessions(firestore, {
          readers: retained, principalId: actor.uid, sessionIds: input.sessionIds, ttlMs: input.ttlMs,
        }, now());
        return res.status(200).json({ schemaVersion: 2, version, identities, leases });
      }
      exact(input, ["version", "action", "sessionIds", "endpoint", "body"]);
      if (input.action !== "request" || !Object.hasOwn(dispatch, input.endpoint) || !object(input.body)) refuse(400);
      sessionIds(input.sessionIds);
      for (const component of ["functions", "cmsApi"]) await sessions.assertSession(firestore, {
        sessionId: input.sessionIds[component], principalId: actor.uid, readerDigest: identities[component],
      }, now());
      // The gateway and operator bind these stamps to independent provider
      // readback. Credential headers never enter the response or a journal.
      res.set("X-NJPBS-Functions-Reader", identities.functions);
      res.set("X-NJPBS-Gateway-Reader", identities.cmsApi);
      const forwarded = Object.create(req);
      linkForwardedRequest(forwarded, req);
      forwarded.body = input.body;
      forwarded.rawBody = Buffer.from(JSON.stringify(input.body));
      forwarded.headers = { ...req.headers, "content-length": String(forwarded.rawBody.length) };
      return await dispatch[input.endpoint](forwarded, res);
    } catch (error) {
      if (res.headersSent) return;
      // Stored original leases for this authenticated principal, nothing else.
      if (error?.expiredLeases) {
        return res.status(410).json({ schemaVersion: 2, version, code: sessions.SESSION_EXPIRED, identities, expired: error.expiredLeases });
      }
      const status = [400, 401, 403, 409, 429].includes(error?.status) ? error.status : 503;
      if (status === 429 && Number.isSafeInteger(error.retryAfterSeconds) && error.retryAfterSeconds > 0) {
        res.set("Retry-After", String(error.retryAfterSeconds));
      }
      return res.status(status).json({ error: "Versioned CMS reader unavailable" });
    }
  }, edge);
}

module.exports = { VERSIONS, MAX_BYTES, readerIdentities, createVersionedCmsReaderHandler };
