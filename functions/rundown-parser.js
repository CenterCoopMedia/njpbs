"use strict";

const { cmsOnRequest } = require("./lib/cms-edge");
const { db } = require("./lib/firebase");
const { requirePrincipal } = require("./lib/auth");
const { can } = require("./lib/rbac");
const { validateBoundedJsonRequest } = require("./lib/http-json");
const { fail, fields, validId, positive } = require("./lib/live-production-requests");
const { parseRundown } = require("./lib/rundown-parser-store");

function createRundownParserHandler({ firestore = db, requirePrincipalFn = requirePrincipal, clock = Date.now } = {}) {
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    try {
      const actor = await requirePrincipalFn(req, { includeAccountStatus: true });
      if (actor.approvedActive !== true || !can(actor.principal, "content.edit.any", {})) fail("Existing global editorial access is required.", 403);
      validateBoundedJsonRequest(req, 2048);
      if (Buffer.byteLength(JSON.stringify(req.body) ?? "") > 2048) fail("Parser request exceeds its byte budget.", 413);
      fields(req.body, ["sessionId", "sourceGeneration"]);
      if (!validId(req.body.sessionId) || !positive(req.body.sourceGeneration)) fail("Choose the current session and source generation.");
      return res.status(200).json({ success: true, ...await parseRundown(firestore, req.body, actor, clock()) });
    } catch (error) {
      const status = error.status ?? (error instanceof TypeError ? 400 : 500);
      if (status >= 500) console.error("Rundown parser request failed", { status });
      return res.status(status).json({ error: status >= 500 ? "Rundown extraction is unavailable. Existing drafts remain usable." : error.message });
    }
  };
}
module.exports = { createRundownParserHandler, cmsRundownParser: cmsOnRequest({ cors: true }, createRundownParserHandler()) };
