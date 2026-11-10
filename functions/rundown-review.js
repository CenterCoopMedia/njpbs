"use strict";

const { cmsOnRequest } = require("./lib/cms-edge");
const { db } = require("./lib/firebase");
const { requirePrincipal } = require("./lib/auth");
const { can } = require("./lib/rbac");
const { validateBoundedJsonRequest } = require("./lib/http-json");
const { fail, fields, validId, positive, nonnegative } = require("./lib/live-production-requests");
const { reconcileRundown, decideRundown } = require("./lib/rundown-review-store");
function parseReviewRequest(body) {
  const deciding = ["accept", "ignore"].includes(body?.action);
  if (!deciding && body?.action !== "reconcile") fail("Choose a rundown review action.");
  fields(body, ["action", "sessionId", "sourceGeneration", ...(deciding ? ["requestId", "reviewVersion", "suggestionId", "baseVersion", "targetBannerId", "text", "overrideFields", "editedFields"] : [])]);
  if (!validId(body.sessionId) || !positive(body.sourceGeneration)) fail("Choose the current session and source generation.");
  if (deciding && (!validId(body.requestId) || !positive(body.reviewVersion) || !validId(body.suggestionId) || !nonnegative(body.baseVersion))) fail("Choose a current suggestion and draft version.");
  if (body.targetBannerId !== undefined && !validId(body.targetBannerId)) fail("Choose a valid source-linked banner.");
  if (body.overrideFields !== undefined && (!Array.isArray(body.overrideFields) || body.overrideFields.length > 5 ||
    body.overrideFields.some(key => !["templateId", "headline", "name", "title", "order"].includes(key)))) fail("Choose the protected fields to replace.");
  if (body.editedFields !== undefined && (!Array.isArray(body.editedFields) || body.editedFields.length > 4 ||
    body.editedFields.some(key => !["headline", "name", "title"].includes(key)))) fail("Choose the proposal text fields edited by the producer.");
  return body;
}
function createRundownReviewHandler({ firestore = db, requirePrincipalFn = requirePrincipal, clock = Date.now } = {}) {
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    try {
      const actor = await requirePrincipalFn(req, { includeAccountStatus: true });
      if (actor.approvedActive !== true || !can(actor.principal, "content.edit.any", {})) fail("Existing global editorial access is required.", 403);
      validateBoundedJsonRequest(req, 256 * 1024);
      if (Buffer.byteLength(JSON.stringify(req.body) ?? "") > 256 * 1024) fail("Review request exceeds its byte budget.", 413);
      const request = parseReviewRequest(req.body);
      const result = request.action === "reconcile" ? await reconcileRundown(firestore, request, actor, clock()) : await decideRundown(firestore, request, actor, clock());
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      const status = error.status ?? (error instanceof TypeError ? 400 : 500);
      if (status >= 500) console.error("Rundown review request failed", { status });
      return res.status(status).json({ error: status >= 500 ? "Rundown review is unavailable. Existing drafts remain usable." : error.message });
    }
  };
}
module.exports = { parseReviewRequest, createRundownReviewHandler,
  cmsRundownReview: cmsOnRequest({ cors: true }, createRundownReviewHandler()) };
