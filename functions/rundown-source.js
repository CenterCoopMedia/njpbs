"use strict";

const { cmsOnRequest } = require("./lib/cms-edge");
const { db } = require("./lib/firebase");
const { requirePrincipal } = require("./lib/auth");
const { can } = require("./lib/rbac");
const { validateBoundedJsonRequest } = require("./lib/http-json");
const { fail, fields, validId, nonnegative } = require("./lib/live-production-requests");
const { rundownSourceRequest } = require("./lib/rundown-source-store");
const { createGoogleRundownSource } = require("./lib/google-rundown-source");
let googleReader, activationKey;
async function readGoogle(...args) {
  const activation = (await db.doc("system/rundownIntakeActivation").get()).data();
  if (activation?.enabled !== true || !Array.isArray(activation.documentIds) || !activation.documentIds.includes(args[0].documentId)) fail("Rundown intake is not activated for this document.", 503);
  const key = JSON.stringify(activation.documentIds);
  if (key !== activationKey) {
    googleReader = createGoogleRundownSource({ allowedDocumentIds: activation.documentIds });
    activationKey = key;
  }
  return googleReader(...args);
}
function parseSourceRequest(body) {
  const actions = { get_source: [], set_source: ["config", "baseConfigVersion"], refresh_source: ["manual"] };
  if (!Object.hasOwn(actions, body?.action ?? "")) fail("Choose a rundown source action.");
  fields(body, ["action", "sessionId", ...actions[body.action]]);
  if (!validId(body.sessionId)) fail("Choose a valid session.");
  if (body.action === "set_source" && !nonnegative(body.baseConfigVersion)) fail("A source configuration version is required.");
  if (body.action === "refresh_source" && typeof body.manual !== "boolean") fail("Specify manual or active-session refresh.");
  return body;
}
function createRundownSourceHandler({ firestore = db, requirePrincipalFn = requirePrincipal, reader = readGoogle, clock = Date.now } = {}) {
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    try {
      const actor = await requirePrincipalFn(req, { includeAccountStatus: true });
      if (actor.approvedActive !== true || !can(actor.principal, "content.edit.any", {})) fail("Existing global editorial access is required.", 403);
      validateBoundedJsonRequest(req, 8192);
      if (Buffer.byteLength(JSON.stringify(req.body) ?? "") > 8192) fail("Rundown request exceeds its byte budget.", 413);
      const result = await rundownSourceRequest(firestore, parseSourceRequest(req.body), actor, { readGoogle: reader, clock });
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      const status = error.status ?? (error instanceof TypeError ? 400 : 500);
      if (status >= 500) console.error("Rundown source request failed", { status });
      return res.status(status).json({ error: status >= 500 ? "Rundown intake is unavailable." : error.message });
    }
  };
}
module.exports = { parseSourceRequest, createRundownSourceHandler,
  cmsRundownSource: cmsOnRequest({ cors: true }, createRundownSourceHandler()) };
