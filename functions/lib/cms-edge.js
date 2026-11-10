"use strict";

const { timingSafeEqual } = require("node:crypto");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { sessionWasRefused, sessionRefusalReason, SESSION_EXPIRED_CODE } = require("./session-refusal");

const CMS_EDGE_ORIGIN_SECRET = defineSecret("CMS_EDGE_ORIGIN_SECRET");
const CMS_EDGE_HEADER = "x-njpbs-cms-edge";
const CMS_EDGE_CLIENT_IP_HEADER = "x-njpbs-client-ip";
const LOCAL_EDGE_SECRET = "local-cms-edge-only";

function requestHeader(req, name) {
  const value = req?.headers?.[name];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : null;
  return typeof value === "string" ? value : null;
}

function configuredEdgeSecret() {
  const local = process.env.CMS_EDGE_ORIGIN_SECRET?.trim();
  if (local) return local;
  if (process.env.FUNCTIONS_EMULATOR === "true") return LOCAL_EDGE_SECRET;
  return CMS_EDGE_ORIGIN_SECRET.value().trim();
}

function secretsMatch(expected, supplied) {
  if (typeof expected !== "string" || typeof supplied !== "string") {
    return false;
  }
  const expectedBytes = Buffer.from(expected, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  return (
    expectedBytes.length > 0 &&
    expectedBytes.length === suppliedBytes.length &&
    timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

function withCmsEdge(handler, deps = {}) {
  const readSecret = deps.readSecret ?? configuredEdgeSecret;
  const log = deps.logger ?? logger;
  return async (req, res) => {
    let expected;
    try {
      expected = readSecret();
    } catch (error) {
      log.error("CMS edge secret could not be read", { error });
      res.set("Cache-Control", "private, no-store");
      res.status(503).json({ error: "CMS API edge is not configured" });
      return;
    }
    if (!secretsMatch(expected, requestHeader(req, CMS_EDGE_HEADER))) {
      log.warn("CMS direct-origin request refused", {
        method: req?.method ?? null,
        path: req?.path ?? null,
        requestId: requestHeader(req, "x-njpbs-request-id"),
      });
      res.set("Cache-Control", "private, no-store");
      res.status(403).json({ error: "CMS API edge is required" });
      return;
    }
    const clientIp = requestHeader(req, CMS_EDGE_CLIENT_IP_HEADER)?.trim();
    if (clientIp) {
      req.headers ??= {};
      req.headers["x-forwarded-for"] = clientIp;
    }
    // Preserve a trusted session refusal even when a handler masks its error text.
    const originalJson = res.json;
    res.json = function (body) {
      let response = body;
      if (res.statusCode === 401 && sessionWasRefused(req) &&
          body && typeof body === "object" && !Array.isArray(body)) {
        const fields = { ...body };
        delete fields.reason;
        const reason = sessionRefusalReason(req);
        response = { ...fields, code: SESSION_EXPIRED_CODE, ...(reason ? { reason } : {}) };
      }
      return originalJson.call(this, response);
    };
    try {
      await handler(req, res);
    } finally {
      res.json = originalJson;
    }
  };
}

function cmsEdgeOptions(options = {}) {
  const existingSecrets = Array.isArray(options.secrets) ? options.secrets : [];
  const configured = {
    ...options,
    secrets: [...existingSecrets, CMS_EDGE_ORIGIN_SECRET],
  };
  if (process.env.CMS_DEPLOYMENT_ENVIRONMENT === "development") {
    configured.minInstances = 0;
    configured.maxInstances = 2;
  }
  if (process.env.FUNCTIONS_EMULATOR !== "true") delete configured.cors;
  return configured;
}

function cmsOnRequest(options, handler) {
  return onRequest(cmsEdgeOptions(options), withCmsEdge(handler));
}

module.exports = {
  CMS_EDGE_CLIENT_IP_HEADER,
  CMS_EDGE_HEADER,
  CMS_EDGE_ORIGIN_SECRET,
  LOCAL_EDGE_SECRET,
  cmsEdgeOptions,
  cmsOnRequest,
  configuredEdgeSecret,
  requestHeader,
  secretsMatch,
  withCmsEdge,
};
