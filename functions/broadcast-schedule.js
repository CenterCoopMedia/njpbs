"use strict";

const logger = require("firebase-functions/logger");
const { cmsOnRequest } = require("./lib/cms-edge");
const { requirePrincipal } = require("./lib/auth");
const { ALL_CAPABILITIES, hasCapability } = require("./lib/rbac");
const { JsonRequestError, validateBoundedJsonRequest } = require("./lib/http-json");

const MAX_SCHEDULE_REQUEST_BYTES = 2 * 1024;

class BroadcastScheduleRejection extends Error {
  constructor(status, message) {
    super(message);
    this.name = "BroadcastScheduleRejection";
    this.status = status;
  }
}

async function loadBroadcastSchedule() {
  const data = await import("./lib/broadcast-schedule-data.mjs");
  return {
    source: data.BROADCAST_SCHEDULE_SOURCE,
    airings: data.BROADCAST_AIRINGS,
  };
}

function requireAdmittedStaff(user) {
  if (
    !ALL_CAPABILITIES.some((capability) =>
      hasCapability(user?.principal, capability)
    )
  ) {
    throw new BroadcastScheduleRejection(403, "CMS access required.");
  }
}

function validateScheduleRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "The broadcast schedule request must be an object";
  }
  const unknown = Object.keys(body)[0];
  return unknown ? `Unknown request field ${unknown}` : null;
}

function setPrivateNoStore(res) {
  res.set("Cache-Control", "private, no-store");
  res.set("Vary", "Authorization");
}

function createCmsGetBroadcastScheduleHandler(deps = {}) {
  const {
    requirePrincipalFn = requirePrincipal,
    loadScheduleFn = loadBroadcastSchedule,
    log = logger,
  } = deps;

  return async (req, res) => {
    setPrivateNoStore(res);
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    try {
      validateBoundedJsonRequest(req, MAX_SCHEDULE_REQUEST_BYTES);
      const user = await requirePrincipalFn(req);
      const validationError = validateScheduleRequest(req.body);
      if (validationError) {
        throw new BroadcastScheduleRejection(400, validationError);
      }
      requireAdmittedStaff(user);
      const schedule = await loadScheduleFn();
      res.status(200).json({ success: true, ...schedule });
    } catch (error) {
      if (res.headersSent) return;
      const expected =
        error instanceof BroadcastScheduleRejection ||
        error instanceof JsonRequestError ||
        Number.isInteger(error?.status);
      const status = error?.status ?? 500;
      if (!expected || status >= 500) {
        log.error("cmsGetBroadcastSchedule failed", error);
      }
      res.status(status).json({
        error:
          expected && status < 500
            ? error.message
            : "Failed to load the broadcast schedule",
      });
    }
  };
}

const cmsGetBroadcastSchedule = cmsOnRequest(
  { cors: true },
  createCmsGetBroadcastScheduleHandler(),
);

module.exports = {
  BroadcastScheduleRejection,
  MAX_SCHEDULE_REQUEST_BYTES,
  cmsGetBroadcastSchedule,
  createCmsGetBroadcastScheduleHandler,
  loadBroadcastSchedule,
  requireAdmittedStaff,
  validateScheduleRequest,
};
