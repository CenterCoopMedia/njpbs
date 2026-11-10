"use strict";

const { createHash } = require("node:crypto");
const { FieldPath } = require("firebase-admin/firestore");
const logger = require("firebase-functions/logger");
const { cmsOnRequest } = require("./lib/cms-edge");
const { db } = require("./lib/firebase");
const { requirePrincipal } = require("./lib/auth");
const { can, canEditContent } = require("./lib/rbac");
const { isAudioReadAdmitted } = require("./lib/media-access");
const { changesCustomHtml } = require("./lib/custom-html");
const { validateBoundedJsonRequest } = require("./lib/http-json");
const { contentResource, mayReachContentRead, mayReachContentWrite } = require("./lib/content-authorization");
const { adminLogEntry, AUDIT_COLLECTIONS } = require("./lib/audit");
const { documentSizeError } = require("./lib/document-size");
const { prepareMediaUsageWrite } = require("./lib/media-usage");
const {
  TEMPLATE_COLLECTION, TEMPLATE_SCHEMA_VERSION, MODES, TemplateError,
  capturePost, mayReadTemplate, mayManageTemplate, assertTemplateReadable, assertTemplateCompatible,
  templateSummary, assertTemplateMediaAccess,
} = require("./lib/post-templates");

const MAX_TEMPLATES = 500;
const MAX_TEMPLATES_PER_ACTOR = 100;
const MAX_TEMPLATE_LIST_PAGES = 3;
const MUTATION_ACTIONS = Object.freeze(["capture", "update", "remove"]);
const ACTIONS = ["list", "get", ...MUTATION_ACTIONS];
const positiveVersion = value => Number.isSafeInteger(value) && value > 0;
const validId = value => typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 1500 &&
  value === value.trim() && !value.includes("/") && ![".", ".."].includes(value) && !/^__.*__$/.test(value);
const hash = value => createHash("sha256").update(value).digest("hex");

function parseRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !ACTIONS.includes(body.action)) {
    throw new TemplateError(400, "Choose a template action.");
  }
  const fields = {
    list: ["action", "cursor"], get: ["action", "id"],
    capture: ["action", "name", "description", "mode", "sourceId", "sourceVersion", "idempotencyKey"],
    update: ["action", "id", "baseVersion", "name", "description", "retired", "sourceId", "sourceVersion", "mode", "document", "idempotencyKey"],
    remove: ["action", "id", "baseVersion", "idempotencyKey"],
  }[body.action];
  if (Object.keys(body).some(key => !fields.includes(key))) throw new TemplateError(400, "Unknown template request field.");
  if (body.action === "list" && body.cursor !== undefined && !validId(body.cursor)) throw new TemplateError(400, "Choose a valid template page.");
  if (["get", "update", "remove"].includes(body.action) && !validId(body.id)) throw new TemplateError(400, "Choose a valid template.");
  if (["update", "remove"].includes(body.action) && !positiveVersion(body.baseVersion)) throw new TemplateError(400, "Reload the template before changing it.");
  if (["list", "get"].includes(body.action)) return body;
  if (typeof body.idempotencyKey !== "string" || !/^[a-zA-Z0-9_-]{16,128}$/.test(body.idempotencyKey)) {
    throw new TemplateError(400, "A template request needs a unique save key.");
  }
  if ((body.action === "capture" || body.name !== undefined) &&
      (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 120)) {
    throw new TemplateError(400, "Use a template name of 1 to 120 characters.");
  }
  if (body.description !== undefined && (typeof body.description !== "string" || body.description.length > 500)) {
    throw new TemplateError(400, "Use a description of at most 500 characters.");
  }
  const recapture = body.action === "capture" || body.sourceId !== undefined;
  if (recapture && (!validId(body.sourceId) || !positiveVersion(body.sourceVersion) || !MODES.includes(body.mode))) {
    throw new TemplateError(400, "Choose a saved source Post, its version, and a capture mode.");
  }
  if (!recapture && (body.sourceVersion !== undefined || body.mode !== undefined)) throw new TemplateError(400, "Changing capture mode requires a saved source Post.");
  if (body.document !== undefined) {
    const fields = ["type", "status", "title", "categories", "tags", "blocks", "leadMedia", "heroBackgroundPosition", "heroBackgroundImage", "heroImage", "heroImageAlt", "heroImageDecorative", "heroImageCaption"];
    if (recapture || !body.document || typeof body.document !== "object" || Array.isArray(body.document) ||
        Object.keys(body.document).some(key => !fields.includes(key))) {
      throw new TemplateError(400, "Edit template blocks, Post presentation and hero media, or capture a source Post.");
    }
  }
  if (body.retired !== undefined && typeof body.retired !== "boolean") throw new TemplateError(400, "retired must be a boolean.");
  return Object.fromEntries(Object.keys(body).sort().map(key => [key, body[key]]));
}

async function captureSource(firestore, transaction, user, request) {
  const snap = await transaction.get(firestore.collection("cmsPosts").doc(request.sourceId));
  const source = snap.data();
  const resource = contentResource({ collection: "cmsPosts", documentId: request.sourceId, stored: source });
  if (!canEditContent(user.principal, resource)) {
    throw new TemplateError(403, "You do not have permission to capture this Post.");
  }
  if (!snap.exists || source.deleted || source.type !== "post") throw new TemplateError(404, "This source Post is unavailable.");
  if (source.version !== request.sourceVersion) throw new TemplateError(409, "The source Post changed. Reload it, then save the template again.", "post_template_conflict");
  return {
    ...capturePost(source, request.mode), mode: request.mode,
    sourceId: request.sourceId, sourceVersion: source.version,
    // Keep the source's exact audience, including owner-only unassigned drafts.
    sourceResource: Object.fromEntries(Object.entries(resource).filter(([, value]) => value !== undefined)),
  };
}

async function mutateTemplate(firestore, user, request) {
  const id = request.action === "capture" ? hash(`${user.uid}:${request.idempotencyKey}`).slice(0, 32) : request.id;
  const ref = firestore.collection(TEMPLATE_COLLECTION).doc(id);
  const receiptRef = ref.collection("requests").doc(hash(`${user.uid}:${request.idempotencyKey}`));
  const fingerprint = hash(JSON.stringify(request));
  return firestore.runTransaction(async transaction => {
    const snap = await transaction.get(ref);
    const before = snap.data();
    if (request.action !== "capture") {
      assertTemplateReadable(user.principal, before?.deleted ? { ...before, deleted: false } : before);
      if (!mayManageTemplate(user.principal, before)) throw new TemplateError(403, "You do not have permission to change this template.");
    }
    const receipt = (await transaction.get(receiptRef)).data();
    if (receipt) {
      if (receipt.fingerprint !== fingerprint || before?.version !== receipt.version) {
        throw new TemplateError(409, "This template request changed or its result was edited. Reload the library.", "post_template_conflict");
      }
      // Rights are checked again on retries; a receipt never grants access.
      if (!mayReadTemplate(user.principal, before)) throw new TemplateError(403, "You do not have permission to use this template.");
      return { template: templateSummary(id, before, user.principal), removed: before.deleted === true, replayed: true };
    }
    if (request.action === "capture" && snap.exists) throw new TemplateError(409, "This save key was already used. Start a new template save.", "post_template_conflict");
    if (request.action === "capture") {
      const actorTemplates = await transaction.get(firestore.collection(TEMPLATE_COLLECTION)
        .where("createdBy", "==", user.uid)
        .limit(MAX_TEMPLATES_PER_ACTOR));
      if (actorTemplates.size >= MAX_TEMPLATES_PER_ACTOR) {
        throw new TemplateError(409, `Each account can retain at most ${MAX_TEMPLATES_PER_ACTOR} templates.`);
      }
    }
    if (request.action !== "capture" && (before?.deleted || before?.version !== request.baseVersion)) {
      throw new TemplateError(409, "This template changed or was removed. Reload the library before editing it.", "post_template_conflict");
    }
    let captured = null;
    if (request.document !== undefined) {
      captured = { ...capturePost({ ...request.document, type: "post" }, "content"), mode: "content" };
    } else if (request.sourceId !== undefined) {
      captured = await captureSource(firestore, transaction, user, request);
    }
    if (before && !captured && request.action !== "remove") assertTemplateCompatible(before);
    const version = (before?.version ?? 0) + 1;
    const timestamp = new Date().toISOString();
    const after = {
      ...before, ...captured, schemaVersion: TEMPLATE_SCHEMA_VERSION, version,
      name: request.name?.trim() ?? before?.name,
      description: request.description?.trim() ?? before?.description ?? "",
      retired: request.retired ?? before?.retired ?? false,
      createdBy: before?.createdBy ?? user.uid, createdAt: before?.createdAt ?? timestamp,
      updatedBy: user.uid, updatedAt: timestamp,
    };
    if (captured && !can(user.principal, "content.publish", after.sourceResource ?? {}) &&
        changesCustomHtml(before?.blocks, after.blocks)) {
      throw new TemplateError(403, "Only editors and admins can add or change custom HTML.");
    }
    if (request.action === "remove") {
      // Keep only a content-free tombstone and the request receipts. Asset files
      // and independent Posts are never removed by template management.
      for (const key of ["blocks", "tags", "leadMedia", "heroImage", "heroImageAlt", "heroImageDecorative", "heroImageCaption", "heroBackgroundImage", "heroBackgroundPosition"]) delete after[key];
      after.deleted = true;
      after.retired = true;
    }
    const usage = request.action === "remove" ? { assetIds: [], occurrenceCount: 0 }
      : await assertTemplateMediaAccess({ firestore, transaction, principal: user.principal, document: after });
    const media = await prepareMediaUsageWrite({ firestore, transaction, collection: TEMPLATE_COLLECTION, documentId: id, state: "working", sourceVersion: version, usage });
    const sizeError = documentSizeError(after, ref.path);
    if (sizeError) throw new TemplateError(400, sizeError.reason);
    transaction.set(ref, after);
    transaction.set(media.ref, media.document);
    transaction.create(receiptRef, { fingerprint, version });
    transaction.create(firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(), adminLogEntry({
      actorUid: user.uid, actorEmail: user.email ?? null, action: `post_template_${request.action}`,
      target: `${TEMPLATE_COLLECTION}/${id}`,
      before: before ? { version: before.version } : null,
      after: { version, sourceId: after.sourceId, sourceVersion: after.sourceVersion },
    }));
    return { template: templateSummary(id, after, user.principal), removed: after.deleted === true, replayed: false };
  });
}

async function listReadableTemplates(firestore, principal, initialCursor) {
  const templates = [];
  let cursor = initialCursor ?? null;
  let lastScannedId = null;
  let pages = 0;
  let lastPageFull = false;
  do {
    pages += 1;
    let query = firestore.collection(TEMPLATE_COLLECTION)
      .orderBy(FieldPath.documentId())
      .limit(MAX_TEMPLATES + 1);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    lastPageFull = snapshot.docs.length > MAX_TEMPLATES;
    for (const doc of snapshot.docs) {
      lastScannedId = doc.id;
      const template = doc.data();
      if (!template.deleted && mayReadTemplate(principal, template)) {
        templates.push(templateSummary(doc.id, template, principal));
        if (templates.length > MAX_TEMPLATES) break;
      }
    }
    if (templates.length > MAX_TEMPLATES || snapshot.docs.length <= MAX_TEMPLATES) break;
    if (pages >= MAX_TEMPLATE_LIST_PAGES) break;
    cursor = snapshot.docs.at(-1);
  } while (cursor);
  const filledPage = templates.length > MAX_TEMPLATES;
  const scanCapped = pages >= MAX_TEMPLATE_LIST_PAGES && lastPageFull;
  const hasMore = filledPage || scanCapped;
  const page = templates.slice(0, MAX_TEMPLATES);
  const nextCursor = filledPage
    ? page.at(-1).id
    : scanCapped
      ? lastScannedId
      : null;
  return {
    templates: page.sort((a, b) => a.name.localeCompare(b.name)),
    hasMore,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

function createCmsPostTemplatesHandler({ firestore = db, requirePrincipalFn = requirePrincipal, log = logger } = {}) {
  return async (req, res) => {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    try {
      const user = await requirePrincipalFn(req, { includeAccountStatus: true });
      validateBoundedJsonRequest(req, 1.25 * 1024 * 1024);
      const request = parseRequest(req.body);
      if (!mayReachContentRead(user.principal)) throw new TemplateError(403, "You do not have permission to use post templates.");
      if (request.action === "capture" && !mayReachContentWrite(user.principal)) {
        throw new TemplateError(403, "You do not have permission to capture this Post.");
      }
      res.set("Cache-Control", "private, no-store");
      if (request.action === "list") {
        const result = await listReadableTemplates(firestore, user.principal, request.cursor);
        return res.status(200).json({ success: true, ...result });
      }
      if (request.action === "get") {
        const result = await firestore.runTransaction(async transaction => {
          const template = (await transaction.get(firestore.collection(TEMPLATE_COLLECTION).doc(request.id))).data();
          assertTemplateReadable(user.principal, template);
          assertTemplateCompatible(template);
          let mediaWarning = null;
          try {
            await assertTemplateMediaAccess({ firestore, transaction, principal: user.principal, document: template,
              imageReadAdmitted: isAudioReadAdmitted(user) });
          } catch (error) {
            if (!(error instanceof TemplateError) || error.status !== 409) throw error;
            // An authorized editor must be able to open and replace a missing
            // asset. Saving or instantiating still rejects it until repaired.
            mediaWarning = error.message;
          }
          return { template: templateSummary(request.id, template, user.principal), document: capturePost(template, "content"), mediaWarning };
        });
        return res.status(200).json({ success: true, ...result });
      }
      return res.status(200).json({ success: true, ...await mutateTemplate(firestore, user, request) });
    } catch (error) {
      const status = error.status || (error.code === "failed-precondition" ? 503 : 500);
      if (status >= 500) log.error("cmsPostTemplates failed", error);
      return res.status(status).json({
        error: status >= 500 ? "Post templates are unavailable. Try again." : error.message,
        ...(error instanceof TemplateError && error.code ? { code: error.code } : {}),
      });
    }
  };
}

module.exports = {
  MUTATION_ACTIONS, createCmsPostTemplatesHandler, parseRequest, mutateTemplate, listReadableTemplates,
  cmsPostTemplates: cmsOnRequest({ cors: true }, createCmsPostTemplatesHandler()),
};
