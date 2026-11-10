"use strict";

const logger = require("firebase-functions/logger");
const { cmsOnRequest } = require("./lib/cms-edge");
const { db } = require("./lib/firebase");
const { requirePrincipal } = require("./lib/auth");
const { AUDIT_COLLECTIONS, adminLogEntry } = require("./lib/audit");
const { can, hasCapability } = require("./lib/rbac");
const {
  JsonRequestError,
  requestHeader,
  validateBoundedJsonRequest,
} = require("./lib/http-json");
const {
  MEDIA_CATEGORIES_COLLECTION,
  MediaCategoryValidationError,
  RESERVED_MEDIA_CATEGORY_IDS,
  mediaCategoryForClient,
  normalizeMediaCategoryChanges,
  normalizeMediaCategoryCreate,
  normalizeMediaCategoryId,
  parseMediaCategoryDefinition,
  parseMediaCategoryIfMatch,
  sameCategoryValues,
  sortMediaCategories,
} = require("./lib/media-categories");
const { setPrivateNoStore } = require("./list-media");

const MUTATION_ACTIONS = new Set(["create", "update", "archive", "restore"]);

class MediaCategoryRejection extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.name = "MediaCategoryRejection";
    this.status = status;
    this.details = details;
  }
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validateListRequest(body) {
  if (!plainObject(body)) return "The category list request must be an object";
  const unknown = Object.keys(body)[0];
  return unknown ? `Unknown request field ${unknown}` : null;
}

function validateMutationRequest(body) {
  if (!plainObject(body)) return "The category request must be an object";
  const allowed = new Set(["action", "id", "category", "changes"]);
  const unknown = Object.keys(body).find((field) => !allowed.has(field));
  if (unknown) return `Unknown request field ${unknown}`;
  if (!MUTATION_ACTIONS.has(body.action)) {
    return "action must be create, update, archive or restore";
  }
  try {
    if (body.action === "create") {
      if (body.id !== undefined || body.changes !== undefined) {
        return "Create accepts category only";
      }
      normalizeMediaCategoryCreate(body.category);
      return null;
    }
    if (body.category !== undefined) return "category is accepted only when creating";
    const id = normalizeMediaCategoryId(body.id);
    if (body.action === "update") {
      normalizeMediaCategoryChanges(id, body.changes);
    } else if (body.changes !== undefined) {
      return `${body.action} does not accept changes`;
    }
    return null;
  } catch (error) {
    return error instanceof MediaCategoryValidationError ? error.message : null;
  }
}

function requireCategoryAdministrator(user) {
  if (!can(user?.principal, "settings.manage")) {
    throw new MediaCategoryRejection(
      403,
      "You do not have permission to manage media categories.",
    );
  }
}

function hasMediaCategoryAccess(user) {
  const principal = user?.principal;
  if (hasCapability(principal, "media.upload") ||
      hasCapability(principal, "media.manage") ||
      hasCapability(principal, "settings.manage")) return true;
  return user?.emailVerified === true && user?.approvedActive === true &&
    hasCapability(principal, "media.audio.read");
}

function createCmsListMediaCategoriesHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    log = logger,
  } = deps;
  return async (req, res) => {
    setPrivateNoStore(res);
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    try {
      validateBoundedJsonRequest(req, 4 * 1024);
      const user = await requirePrincipalFn(req, { includeAccountStatus: true });
      const validationError = validateListRequest(req.body);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }
      if (!hasMediaCategoryAccess(user)) {
        throw new MediaCategoryRejection(403, "CMS media access required.");
      }
      const snapshot = await firestore.collection(MEDIA_CATEGORIES_COLLECTION).get();
      const categories = [];
      for (const document of snapshot.docs) {
        const category = parseMediaCategoryDefinition(document.id, document.data());
        if (!category) {
          throw new MediaCategoryRejection(
            503,
            "The media category registry contains an invalid entry.",
          );
        }
        categories.push(mediaCategoryForClient(category, user.principal));
      }
      res.status(200).json({
        success: true,
        categories: sortMediaCategories(categories),
      });
    } catch (error) {
      if (res.headersSent) return;
      const expected =
        error instanceof MediaCategoryRejection ||
        error instanceof MediaCategoryValidationError ||
        error instanceof JsonRequestError ||
        Number.isInteger(error?.status);
      const status = error?.status || 500;
      if (!expected || status >= 500) log.error("cmsListMediaCategories failed", error);
      res.status(status).json({
        error: expected ? error.message : "Failed to list media categories",
      });
    }
  };
}

function createCmsMutateMediaCategoryHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    adminLogEntryFn = adminLogEntry,
    now = () => new Date().toISOString(),
    log = logger,
  } = deps;
  return async (req, res) => {
    setPrivateNoStore(res);
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    try {
      validateBoundedJsonRequest(req, 8 * 1024);
      const user = await requirePrincipalFn(req);
      requireCategoryAdministrator(user);
      const validationError = validateMutationRequest(req.body);
      if (validationError) {
        res.status(400).json({ error: validationError });
        return;
      }
      const source = requestHeader(req, "x-forwarded-for")?.split(",")[0]?.trim() ||
        req.ip || null;
      const action = req.body.action;
      const create = action === "create"
        ? normalizeMediaCategoryCreate(req.body.category)
        : null;
      const id = create?.id ?? normalizeMediaCategoryId(req.body.id);
      const ifMatch = requestHeader(req, "if-match");
      let baseVersion = null;
      if (action !== "create") {
        if (ifMatch === undefined) {
          throw new MediaCategoryRejection(428, "If-Match is required for a category change");
        }
        baseVersion = parseMediaCategoryIfMatch(ifMatch, id);
        if (baseVersion === null) {
          throw new MediaCategoryRejection(
            400,
            "If-Match must be one strong ETag for this media category",
          );
        }
      }

      const outcome = await firestore.runTransaction(async (transaction) => {
        const ref = firestore.collection(MEDIA_CATEGORIES_COLLECTION).doc(id);
        const snapshot = await transaction.get(ref);
        if (action === "create") {
          if (snapshot.exists) {
            throw new MediaCategoryRejection(409, "That media category already exists.");
          }
          if (RESERVED_MEDIA_CATEGORY_IDS.has(id)) {
            throw new MediaCategoryRejection(
              409,
              "Reserved media categories are created by the registry seed.",
            );
          }
          const timestamp = now();
          const stored = {
            ...create,
            active: true,
            version: 1,
            createdAt: timestamp,
            createdBy: user.uid,
            updatedAt: timestamp,
            updatedBy: user.uid,
          };
          transaction.create(ref, stored);
          transaction.create(
            firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(),
            adminLogEntryFn({
              actorUid: user.uid,
              actorEmail: user.email ?? null,
              action: "media.category.create",
              target: `${MEDIA_CATEGORIES_COLLECTION}/${id}`,
              before: null,
              after: { ...create, active: true, version: 1 },
              source,
            }),
          );
          return { changed: true, category: parseMediaCategoryDefinition(id, stored) };
        }

        const stored = snapshot.exists
          ? parseMediaCategoryDefinition(snapshot.id, snapshot.data())
          : null;
        if (!stored) {
          throw new MediaCategoryRejection(404, "This media category is not available.");
        }
        if (stored.version !== baseVersion) {
          throw new MediaCategoryRejection(
            412,
            "This media category changed since you opened it. Reload before saving.",
            { etag: `"media-category.${Buffer.from(id, "utf8").toString("base64url")}.${stored.version}"` },
          );
        }

        let candidate;
        if (action === "update") {
          candidate = {
            ...stored,
            ...normalizeMediaCategoryChanges(id, req.body.changes),
          };
        } else {
          if (action === "archive" && RESERVED_MEDIA_CATEGORY_IDS.has(id)) {
            throw new MediaCategoryRejection(
              409,
              "Reserved media categories cannot be archived.",
            );
          }
          candidate = { ...stored, active: action === "restore" };
        }
        if (sameCategoryValues(stored, candidate)) {
          return { changed: false, category: stored };
        }

        const timestamp = now();
        const updated = {
          ...snapshot.data(),
          label: candidate.label,
          description: candidate.description,
          order: candidate.order,
          active: candidate.active,
          version: stored.version + 1,
          updatedAt: timestamp,
          updatedBy: user.uid,
        };
        transaction.set(ref, updated);
        transaction.create(
          firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(),
          adminLogEntryFn({
            actorUid: user.uid,
            actorEmail: user.email ?? null,
            action: `media.category.${action}`,
            target: `${MEDIA_CATEGORIES_COLLECTION}/${id}`,
            before: {
              label: stored.label,
              description: stored.description,
              order: stored.order,
              active: stored.active,
              version: stored.version,
            },
            after: {
              label: updated.label,
              description: updated.description,
              order: updated.order,
              active: updated.active,
              version: updated.version,
            },
            source,
          }),
        );
        return {
          changed: true,
          category: parseMediaCategoryDefinition(id, updated),
        };
      });

      const category = mediaCategoryForClient(outcome.category, user.principal);
      res.set("ETag", category.etag);
      res.status(200).json({ success: true, changed: outcome.changed, category });
    } catch (error) {
      if (res.headersSent) return;
      const expected =
        error instanceof MediaCategoryRejection ||
        error instanceof MediaCategoryValidationError ||
        error instanceof JsonRequestError ||
        Number.isInteger(error?.status);
      const status = error?.status || 500;
      if (error?.details?.etag) res.set("ETag", error.details.etag);
      if (!expected || status >= 500) log.error("cmsMutateMediaCategory failed", error);
      res.status(status).json({
        error: expected ? error.message : "Failed to change media category",
      });
    }
  };
}

const cmsListMediaCategories = cmsOnRequest(
  { cors: true, maxInstances: 10, timeoutSeconds: 30, cpu: 1, concurrency: 80 },
  createCmsListMediaCategoriesHandler(),
);
const cmsMutateMediaCategory = cmsOnRequest(
  { cors: true, maxInstances: 5, timeoutSeconds: 30 },
  createCmsMutateMediaCategoryHandler(),
);

module.exports = {
  MUTATION_ACTIONS,
  MediaCategoryRejection,
  cmsListMediaCategories,
  cmsMutateMediaCategory,
  createCmsListMediaCategoriesHandler,
  createCmsMutateMediaCategoryHandler,
  hasMediaCategoryAccess,
  validateListRequest,
  validateMutationRequest,
};
