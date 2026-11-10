"use strict";

const logger = require("firebase-functions/logger");
const { requirePrincipal, verifyAppCheckToken } = require("./lib/auth");
const { cmsOnRequest } = require("./lib/cms-edge");
const { db } = require("./lib/firebase");
const { JsonRequestError, validateBoundedJsonRequest } = require("./lib/http-json");
const { periodFor } = require("./lib/cost-ledger");
const store = require("./lib/cost-ledger-store");

const MAX_BYTES = 16 * 1024;
const READ_ACTIONS = new Set(["view"]);
const WRITE_ACTIONS = new Set([
  "seed",
  "saveLine",
  "savePeriodAmount",
  "saveHardware",
  "saveComparison",
  "closeMonth",
  "reopenMonth",
]);

function topLevelRole(user) {
  const grant = user?.principal?.grants?.find((item) =>
    item?.role === "admin" || item?.role === "super_admin");
  return grant?.role || null;
}

function rejection(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sendFailure(res, error, log, action) {
  if (res.headersSent) return;
  const status = error instanceof JsonRequestError
    ? error.status
    : error?.status || 500;
  if (status >= 500) log.error("cmsCostLedger failed", error);
  const serverMessage = action === "view"
    ? "The cost ledger could not be loaded."
    : "The cost ledger could not be saved.";
  res.status(status).json({
    error: status >= 500 ? serverMessage : error.message,
  });
}

function createCmsCostLedgerHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    verifyAppCheckFn = verifyAppCheckToken,
    ledger = store,
    now = () => new Date(),
    log = logger,
  } = deps;

  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    try {
      validateBoundedJsonRequest(req, MAX_BYTES);
      await verifyAppCheckFn(req.headers?.["x-firebase-appcheck"]);
      const user = await requirePrincipalFn(req);
      const role = topLevelRole(user);
      if (!role) throw rejection(403, "Admin access is required.");
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw rejection(400, "Request body must be an object.");
      }
      const action = body.action;
      const canEdit = role === "super_admin";
      if (!READ_ACTIONS.has(action) && !WRITE_ACTIONS.has(action)) {
        throw rejection(400, "That cost ledger action is not recognized.");
      }
      if (WRITE_ACTIONS.has(action) && !canEdit) {
        throw rejection(403, "Super admin access is required.");
      }
      const clock = now();
      const nowIso = clock.toISOString();
      const actor = { uid: user.uid, email: user.email ?? null, source: req.ip || null };
      if (action === "view") {
        const period = body.period || periodFor(clock);
        const view = await ledger.loadView(firestore, period);
        res.status(200).json({ success: true, canEdit, ...view, currentPeriod: periodFor(clock) });
        return;
      }
      let result;
      if (action === "seed") result = await ledger.ensureSeed(firestore, actor, nowIso);
      else if (action === "saveLine") result = await ledger.saveLine(firestore, body.line, actor, nowIso);
      else if (action === "savePeriodAmount") result = await ledger.savePeriodAmount(firestore, body, actor, nowIso);
      else if (action === "saveHardware") result = await ledger.saveHardware(firestore, body.hardware, actor, nowIso);
      else if (action === "saveComparison") result = await ledger.saveComparison(firestore, body.comparison, actor, nowIso);
      else if (action === "closeMonth") result = await ledger.closeMonth(firestore, body.period, actor, nowIso);
      else result = await ledger.reopenMonth(firestore, body.period, actor, nowIso);
      res.status(200).json({ success: true, canEdit, ...result });
    } catch (error) {
      sendFailure(res, error, log, req.body?.action);
    }
  };
}

const cmsCostLedger = cmsOnRequest(
  { cors: true, invoker: "public" },
  createCmsCostLedgerHandler(),
);

module.exports = {
  cmsCostLedger,
  createCmsCostLedgerHandler,
};
