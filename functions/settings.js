"use strict";

const { preparePublicReleaseProducerInTransaction, publicReleaseProducerOperation } = require("./lib/public-release-producer");

// Transaction and read boundaries for versioned global CMS settings. Working
// reads and draft saves require settings.manage. The newsroom banner endpoint
// returns one safe field to any admitted staff member so the signed-in homepage
// never reads settings through Firestore. The publish transaction and the
// detached published read stays available as a handler factory. The publish
// transaction freezes an exact public settings snapshot and its context queue.

const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const {
  assertSerializerPublicationAdmissionInTransaction,
} = require("./lib/cms-publication-runtime-control");
const { bumpPublicContextRevision } = require("./lib/public-context-revision");
const { PUBLIC_SETTINGS_IDS, readSettingsPublication, prepareSettingsPublication, prepareSettingsRetry } = require("./lib/settings-publication");
const logger = require("firebase-functions/logger");
const { cmsOnRequest } = require("./lib/cms-edge");
const { db } = require("./lib/firebase");
const { requirePrincipal } = require("./lib/auth");
const { principalFromStoredUserDoc } = require("./lib/principal");
const {
  AUDIT_COLLECTIONS,
  adminLogEntry,
  versionHistoryEntry,
} = require("./lib/audit");
const { ALL_CAPABILITIES, can, hasCapability } = require("./lib/rbac");
const {
  CMS_SETTINGS_SCHEMAS,
  CMS_SETTINGS_READ_SCHEMAS,
  CmsSettingsContractError,
  DEFAULT_NEWSROOM_BANNER_HEADING,
  DEFAULT_NEWSROOM_MILESTONE_NUMBER,
  NEWSROOM_HOME_SETTINGS_ID,
  NEWSROOM_MILESTONE_SETTINGS_ID,
  NJ_DECIDES_SETTINGS_ID,
  PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID,
  cmsSettingsSchemaFor,
  createCmsSettingsPublishedSnapshot,
  currentCmsSettingsSchemaFor,
  projectPublishedCmsSettings,
  validateCmsSettingsValues,
  cloneSettingsValues,
} = require("./lib/cms-settings-contract");
const {
  DEFAULT_MAX_UPLOAD_BYTES,
  mediaProjection,
  MAX_IMAGE_PIXELS,
} = require("./lib/media-contract");
const {
  CMS_SETTINGS_CONTRACT_HEADER,
  NEWSROOM_SETTINGS_CONTRACT,
} = require("./lib/cms-settings-compatibility");
const {
  DOCUMENT_SIZE_BUDGET_BYTES,
  firestoreDocumentBytes,
} = require("./lib/document-size");
const {
  MediaUsageError,
  collectPublishedMediaUsage,
  collectWorkingMediaUsage,
  prepareMediaUsageWrite,
} = require("./lib/media-usage");
const {
  JsonRequestError,
  requestHeader,
  validateBoundedJsonRequest,
} = require("./lib/http-json");

const MAX_DOCUMENT_ID_BYTES = 1_500;
const MAX_READ_JSON_BYTES = 16 * 1024;
const MAX_SAVE_JSON_BYTES = 512 * 1024;
const SETTINGS_COLLECTION = "cmsSettings";
const NOT_FOUND_MESSAGE = "This settings document is not available.";
const NJ_DECIDES_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const ROOT_FIELDS = new Set([
  "schemaVersion",
  "values",
  "version",
  "published",
]);
const GET_FIELDS = new Set(["id"]);
const PUBLISH_FIELDS = new Set(["id", "baseVersion", "publicationTransport"]);
const SAVE_FIELDS = new Set([
  "id",
  "values",
  "createOnly",
  "baseVersion",
]);

class SettingsRejection extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = "SettingsRejection";
    this.status = status;
    this.code = code;
  }
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function positiveVersion(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isBoundedDocumentId(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_DOCUMENT_ID_BYTES &&
    value === value.trim() &&
    !value.includes("/") &&
    value !== "." &&
    value !== ".." &&
    !/^__.*__$/.test(value)
  );
}

function unknownField(body, allowed) {
  if (!plainObject(body)) return null;
  return Object.keys(body).find((field) => !allowed.has(field)) ?? null;
}

function validateIdRequest(body, allowed) {
  if (!plainObject(body)) return "The settings request must be an object";
  const unknown = unknownField(body, allowed);
  if (unknown) return `Unknown request field ${unknown}`;
  if (!isBoundedDocumentId(body.id)) {
    return "id must be a bounded Firestore document id";
  }
  return null;
}

function validateGetSettingsRequest(body) {
  return validateIdRequest(body, GET_FIELDS);
}

function validateGetPublishedSettingsRequest(body) {
  return validateIdRequest(body, GET_FIELDS);
}

function validateNewsroomBannerRequest(body) {
  if (!plainObject(body)) return "The banner request must be an object";
  const unknown = Object.keys(body)[0];
  return unknown ? `Unknown request field ${unknown}` : null;
}

function validateSaveSettingsRequest(body) {
  const requestError = validateIdRequest(body, SAVE_FIELDS);
  if (requestError) return requestError;
  if (!Object.hasOwn(body, "values") || !plainObject(body.values)) {
    return "values must be an object";
  }
  const hasCreateOnly = Object.hasOwn(body, "createOnly");
  const hasBaseVersion = Object.hasOwn(body, "baseVersion");
  if (hasCreateOnly === hasBaseVersion) {
    return "Provide exactly one of createOnly or baseVersion";
  }
  if (hasCreateOnly && body.createOnly !== true) {
    return "createOnly must be true";
  }
  if (hasBaseVersion && !positiveVersion(body.baseVersion)) {
    return "baseVersion must be a positive safe integer";
  }
  return null;
}

function validatePublishSettingsRequest(body) {
  const requestError = validateIdRequest(body, PUBLISH_FIELDS);
  if (requestError) return requestError;
  if (!positiveVersion(body.baseVersion)) {
    return "baseVersion must be a positive safe integer";
  }
  if (body.publicationTransport !== undefined && body.publicationTransport !== "public-context-no-build-v1") {
    return "publicationTransport must be public-context-no-build-v1";
  }
  return null;
}

function canonicalSettingsValues(schema, values) {
  return cloneSettingsValues(schema, values);
}

function validateIncomingValues(schema, values) {
  const validationError = validateCmsSettingsValues(schema, values);
  if (validationError) throw new SettingsRejection(400, validationError);
  return canonicalSettingsValues(schema, values);
}

async function validateNjDecidesMediaAssets({
  documentId,
  values,
  firestore,
  transaction,
}) {
  if (documentId !== NJ_DECIDES_SETTINGS_ID) return;
  const assetIds = [...new Set([
    values.logoAssetId,
    values.backgroundAssetId,
  ].filter((value) => typeof value === "string" && value !== ""))];
  for (const assetId of assetIds) {
    const snapshot = await transaction.get(
      firestore.collection("media_assets").doc(assetId),
    );
    const record = snapshot?.data();
    if (!snapshot?.exists || record?.lifecycle !== "active") {
      throw new SettingsRejection(
        400,
        `Media asset ${assetId} is not available. Choose another asset.`,
      );
    }
    if (!NJ_DECIDES_IMAGE_TYPES.has(record.mimeType)) {
      throw new SettingsRejection(
        400,
        `Media asset ${assetId} must be a PNG, JPEG or WebP image.`,
      );
    }
    if (
      !Number.isSafeInteger(record.sizeBytes) ||
      record.sizeBytes < 1 ||
      record.sizeBytes > DEFAULT_MAX_UPLOAD_BYTES
    ) {
      throw new SettingsRejection(
        400,
        `Media asset ${assetId} exceeds the branding image size limit.`,
      );
    }
    if (
      !Number.isSafeInteger(record.width) ||
      record.width < 1 ||
      !Number.isSafeInteger(record.height) ||
      record.height < 1 ||
      record.width > Math.floor(MAX_IMAGE_PIXELS / record.height)
    ) {
      throw new SettingsRejection(
        400,
        `Media asset ${assetId} exceeds the branding image dimension limit.`,
      );
    }
    try {
      const { selectedAssets } = require("./lib/public-content-projection");
      selectedAssets({ assetIds: [assetId] }, new Map([[assetId, mediaProjection(record)]]));
    } catch {
      throw new SettingsRejection(400, "This image is not ready for public election coverage. Choose another image.");
    }
  }
}

function canonicalStoredSettings(documentId, document, settingsSchemas) {
  const readSchemas = settingsSchemas === CMS_SETTINGS_SCHEMAS
    ? CMS_SETTINGS_READ_SCHEMAS
    : settingsSchemas;
  if (
    !plainObject(document) ||
    Object.keys(document).some((field) => !ROOT_FIELDS.has(field)) ||
    !Object.hasOwn(document, "schemaVersion") ||
    !Object.hasOwn(document, "values") ||
    !Object.hasOwn(document, "version") ||
    !positiveVersion(document.version)
  ) {
    throw new SettingsRejection(409, "This settings document is invalid.");
  }
  const schema = cmsSettingsSchemaFor(
    documentId,
    document.schemaVersion,
    readSchemas,
  );
  if (!schema) {
    throw new SettingsRejection(
      409,
      "This settings document uses an unavailable schema.",
    );
  }
  const valuesError = validateCmsSettingsValues(schema, document.values);
  if (valuesError) {
    throw new SettingsRejection(409, "This settings document is invalid.");
  }
  const canonical = {
    schemaVersion: schema.schemaVersion,
    values: canonicalSettingsValues(schema, document.values),
    version: document.version,
  };
  if (document.published !== undefined) {
    try {
      canonical.published = projectPublishedCmsSettings({
        documentId,
        schemas: readSchemas,
        document,
      });
    } catch (error) {
      if (!(error instanceof CmsSettingsContractError)) throw error;
      throw new SettingsRejection(409, "This settings document is invalid.");
    }
  }
  return canonical;
}

function requireCurrentSchema(documentId, settingsSchemas) {
  const schema = currentCmsSettingsSchemaFor(documentId, settingsSchemas);
  if (!schema) throw new SettingsRejection(404, NOT_FOUND_MESSAGE);
  return schema;
}

function isPublicHomepageBannerUpgrade(documentId, stored, currentSchema) {
  return documentId === PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID &&
    [1, 2, 3].includes(stored?.schemaVersion) &&
    currentSchema?.schemaVersion === 4 &&
    currentSchema.valueContract === "publicHomepageBannerV4";
}

function isSiteNavigationUpgrade(documentId, stored, currentSchema) {
  return documentId === "site-navigation" && stored?.schemaVersion === 1 && currentSchema?.schemaVersion === 2;
}

function settingsSchemaForPublication(
  documentId,
  stored,
  currentSchema,
  settingsSchemas,
) {
  if (stored.schemaVersion === currentSchema.schemaVersion) return currentSchema;
  if (isPublicHomepageBannerUpgrade(documentId, stored, currentSchema) || isSiteNavigationUpgrade(documentId, stored, currentSchema)) {
    const storedSchema = cmsSettingsSchemaFor(
      documentId,
      stored.schemaVersion,
      settingsSchemas,
    );
    if ([1, 2, 3].includes(storedSchema?.schemaVersion)) return storedSchema;
  }
  throw new SettingsRejection(
    409,
    "This settings document needs migration before it can be published.",
  );
}

function requireSettingsManager(user) {
  if (!can(user?.principal, "settings.manage")) {
    throw new SettingsRejection(
      403,
      "You do not have permission to manage settings.",
    );
  }
}

async function requireSettingsManagerInTransaction(firestore, transaction, uid) {
  const snapshot = await transaction.get(firestore.collection("users").doc(uid));
  requireSettingsManager({
    principal: await principalFromStoredUserDoc(firestore, uid, snapshot.exists ? snapshot.data() : null, transaction),
  });
}

function requireAdmittedStaff(user) {
  if (
    !ALL_CAPABILITIES.some((capability) =>
      hasCapability(user?.principal, capability)
    )
  ) {
    throw new SettingsRejection(403, "CMS access required.");
  }
}

function settingsReceipt(document) {
  return {
    schemaVersion: document.schemaVersion,
    version: document.version,
    valuesSha256: createHash("sha256")
      .update(JSON.stringify(document.values))
      .digest("hex"),
    publishedSourceVersion: document.published?.sourceVersion ?? null,
  };
}

function getClientIp(req) {
  return requestHeader(req, "x-forwarded-for")?.split(",")[0]?.trim() ||
    req.ip || null;
}

function setPrivateNoStore(res) {
  res.set("Cache-Control", "private, no-store");
}

function ensureDocumentFits(document, documentId, firestoreDocumentBytesFn) {
  const bytes = firestoreDocumentBytesFn(
    document,
    `${SETTINGS_COLLECTION}/${documentId}`,
  );
  if (bytes > DOCUMENT_SIZE_BUDGET_BYTES) {
    throw new SettingsRejection(
      400,
      "This settings document is too large. Shorten its longest values and try again.",
    );
  }
}

function ensureRevisionFits(document, path, firestoreDocumentBytesFn) {
  const bytes = firestoreDocumentBytesFn(document, path);
  if (bytes > DOCUMENT_SIZE_BUDGET_BYTES) {
    throw new SettingsRejection(
      400,
      "This settings revision is too large. Shorten its longest values and try again.",
    );
  }
}

function nextVersion(version) {
  if (!positiveVersion(version) || version === Number.MAX_SAFE_INTEGER) {
    throw new SettingsRejection(
      409,
      "This settings document version cannot advance.",
    );
  }
  return version + 1;
}

function samePublishedWorkingVersion(document) {
  return Boolean(
    document.published &&
    document.version > 1 &&
    document.published.schemaVersion === document.schemaVersion &&
    document.published.sourceVersion === document.version - 1 &&
    isDeepStrictEqual(document.published.values, document.values)
  );
}

function expectedError(error) {
  return (
    error instanceof SettingsRejection ||
    error instanceof CmsSettingsContractError ||
    error instanceof MediaUsageError ||
    error instanceof JsonRequestError ||
    Number.isInteger(error?.status)
  );
}

function sendFailure({ error, res, log, operation }) {
  if (res.headersSent) return;
  const expected = expectedError(error);
  const status = error?.status ||
    (error?.code === "failed-precondition" ? 503 : 500);
  if (error?.code === "settings_publication_unavailable" && error.diagnosticCode === "settings_retry_guard_refused") {
    log.warn("Settings publication retry refused", { code: "settings_retry_guard_refused" });
  }
  if (!expected || status >= 500) {
    log.error(`${operation} failed`, error);
  }
  res.status(status).json({
    error: expected && status < 500
      ? error.message
      : "Failed to manage CMS settings",
    ...(["settings_publication_client_outdated", "settings_publication_unavailable"].includes(error?.code)
      ? { code: error.code } : {}),
  });
}

function createCmsGetSettingsHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    settingsSchemas = CMS_SETTINGS_SCHEMAS,
    log = logger,
  } = deps;

  return async (req, res) => {
    setPrivateNoStore(res);
    res.set(CMS_SETTINGS_CONTRACT_HEADER, NEWSROOM_SETTINGS_CONTRACT);
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    try {
      validateBoundedJsonRequest(req, MAX_READ_JSON_BYTES);
      const user = await requirePrincipalFn(req);
      const validationError = validateGetSettingsRequest(req.body);
      if (validationError) throw new SettingsRejection(400, validationError);
      requireSettingsManager(user);
      const schema = requireCurrentSchema(req.body.id, settingsSchemas);
      if (!schema) throw new Error("The admitted CMS settings schema is missing");

      const snapshot = await firestore
        .collection(SETTINGS_COLLECTION)
        .doc(req.body.id)
        .get();
      if (!snapshot.exists) {
        res.status(200).json({
          success: true,
          found: false,
          id: req.body.id,
        });
        return;
      }
      const settings = canonicalStoredSettings(
        req.body.id,
        snapshot.data(),
        settingsSchemas,
      );
      const accepted = settings.published ? await readSettingsPublication({ firestore,
        id: req.body.id, sourceVersion: settings.published.sourceVersion, settings }) : null;
      res.status(200).json({
        success: true,
        found: true,
        id: req.body.id,
        settings,
        ...(accepted ? { publication: accepted.publication } : {}),
      });
    } catch (error) {
      sendFailure({ error, res, log, operation: "cmsGetSettings" });
    }
  };
}

function createCmsGetCoverageLabelsHandler(deps = {}) {
  return createCmsGetPublishedSettingsHandler({ ...deps, publishedSettingsId: require("./lib/cms-settings-contract").COVERAGE_LABELS_SETTINGS_ID });
}

function createCmsGetPublishedSettingsHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    settingsSchemas = CMS_SETTINGS_SCHEMAS,
    publishedSettingsId = null,
    log = logger,
  } = deps;

  return async (req, res) => {
    setPrivateNoStore(res);
    if (publishedSettingsId) res.set(CMS_SETTINGS_CONTRACT_HEADER, NEWSROOM_SETTINGS_CONTRACT);
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    try {
      validateBoundedJsonRequest(req, MAX_READ_JSON_BYTES);
      const user = await requirePrincipalFn(req);
      const { retained, ...nativeBody } = req.body;
      if (retained !== undefined && deps.retainedReplies !== true) throw new SettingsRejection(400, "Retained replies are disabled");
      const validationError = validateGetPublishedSettingsRequest(nativeBody);
      if (validationError) throw new SettingsRejection(400, validationError);
      requireAdmittedStaff(user);
      if (publishedSettingsId && req.body.id !== publishedSettingsId) throw new SettingsRejection(404, NOT_FOUND_MESSAGE);
      requireCurrentSchema(req.body.id, settingsSchemas);

      if (retained !== undefined) return res.status(200).json(await require("./lib/cms-reader-retained-request").retainedReaderReply({
        firestore, body: req.body, feature: "settings", now: deps.now ?? Date.now }));

      const snapshot = await firestore.collection(SETTINGS_COLLECTION).doc(req.body.id).get();
      res.status(200).json(require("./lib/cms-published-settings-reply").publishedSettingsReply({
        id: req.body.id, document: snapshot.data(), schemas: settingsSchemas,
        invalid: () => log.warn("cmsGetPublishedSettings ignored an invalid snapshot", { id: req.body.id, uid: user.uid }),
      }));
    } catch (error) {
      sendFailure({
        error,
        res,
        log,
        operation: "cmsGetPublishedSettings",
      });
    }
  };
}

function createCmsGetNewsroomBannerHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    settingsSchemas = CMS_SETTINGS_SCHEMAS,
    log = logger,
  } = deps;

  return async (req, res) => {
    setPrivateNoStore(res);
    res.set(CMS_SETTINGS_CONTRACT_HEADER, NEWSROOM_SETTINGS_CONTRACT);
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    try {
      validateBoundedJsonRequest(req, MAX_READ_JSON_BYTES);
      const user = await requirePrincipalFn(req);
      const validationError = validateNewsroomBannerRequest(req.body);
      if (validationError) throw new SettingsRejection(400, validationError);
      requireAdmittedStaff(user);
      requireCurrentSchema(NEWSROOM_HOME_SETTINGS_ID, settingsSchemas);
      requireCurrentSchema(NEWSROOM_MILESTONE_SETTINGS_ID, settingsSchemas);

      const collection = firestore.collection(SETTINGS_COLLECTION);
      const [bannerSnapshot, milestoneSnapshot] = await Promise.all([
        collection.doc(NEWSROOM_HOME_SETTINGS_ID).get(),
        collection.doc(NEWSROOM_MILESTONE_SETTINGS_ID).get(),
      ]);
      const bannerSettings = bannerSnapshot.exists
        ? canonicalStoredSettings(
            NEWSROOM_HOME_SETTINGS_ID,
            bannerSnapshot.data(),
            settingsSchemas,
          )
        : null;
      const milestoneSettings = milestoneSnapshot.exists
        ? canonicalStoredSettings(
            NEWSROOM_MILESTONE_SETTINGS_ID,
            milestoneSnapshot.data(),
            settingsSchemas,
          )
        : null;
      res.status(200).json({
        success: true,
        heading:
          bannerSettings?.values.bannerHeading ?? DEFAULT_NEWSROOM_BANNER_HEADING,
        milestoneNumber:
          milestoneSettings?.values.milestoneNumber ??
          DEFAULT_NEWSROOM_MILESTONE_NUMBER,
        source: bannerSettings ? "saved" : "default",
        version: bannerSettings?.version ?? null,
      });
    } catch (error) {
      sendFailure({ error, res, log, operation: "cmsGetNewsroomBanner" });
    }
  };
}

function createCmsSaveSettingsHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    settingsSchemas = CMS_SETTINGS_SCHEMAS,
    prepareMediaUsageWriteFn = prepareMediaUsageWrite,
    adminLogEntryFn = adminLogEntry,
    versionHistoryEntryFn = versionHistoryEntry,
    firestoreDocumentBytesFn = firestoreDocumentBytes,
    log = logger,
  } = deps;

  return async (req, res) => {
    setPrivateNoStore(res);
    res.set(CMS_SETTINGS_CONTRACT_HEADER, NEWSROOM_SETTINGS_CONTRACT);
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    try {
      validateBoundedJsonRequest(req, MAX_SAVE_JSON_BYTES);
      const user = await requirePrincipalFn(req);
      const validationError = validateSaveSettingsRequest(req.body);
      if (validationError) throw new SettingsRejection(400, validationError);
      requireSettingsManager(user);

      const { id, baseVersion, createOnly } = req.body;
      const currentSchema = requireCurrentSchema(id, settingsSchemas);
      const values = validateIncomingValues(currentSchema, req.body.values);
      const source = getClientIp(req);
      const outcome = await firestore.runTransaction(async (transaction) => {
        await requireSettingsManagerInTransaction(firestore, transaction, user.uid);
        const settingsRef = firestore.collection(SETTINGS_COLLECTION).doc(id);
        const snapshot = await transaction.get(settingsRef);
        let before = null;
        if (createOnly === true) {
          if (snapshot.exists) {
            throw new SettingsRejection(
              409,
              "This settings document already exists.",
            );
          }
        } else {
          if (!snapshot.exists) throw new SettingsRejection(404, NOT_FOUND_MESSAGE);
          before = canonicalStoredSettings(id, snapshot.data(), settingsSchemas);
          if (before.version !== baseVersion) {
            throw new SettingsRejection(
              409,
              "This settings document changed since you opened it. Reload before saving.",
            );
          }
          // Older clients omit fields they cannot display. Require explicit
          // empty strings to remove an existing second link.
          if (id === PUBLIC_HOMEPAGE_BANNER_SETTINGS_ID && before.values.secondLinkLabel &&
            (!Object.hasOwn(req.body.values, "secondLinkLabel") || !Object.hasOwn(req.body.values, "secondLinkHref"))) {
            throw new SettingsRejection(409, "This banner has a second link. Reload the latest Boardwalk before saving.");
          }
          if (id === "site-navigation" && before.values.postsBrowse && !Object.hasOwn(req.body.values, "postsBrowse")) {
            throw new SettingsRejection(409, "Posts browsing has been arranged. Reload the latest Boardwalk before saving navigation.");
          }
          const upgrading = isPublicHomepageBannerUpgrade(id, before, currentSchema) || isSiteNavigationUpgrade(id, before, currentSchema);
          if (before.schemaVersion !== currentSchema.schemaVersion && !upgrading) {
            throw new SettingsRejection(
              409,
              "This settings document needs migration before it can be saved.",
            );
          }
          if (!upgrading && isDeepStrictEqual(before.values, values) && isDeepStrictEqual(snapshot.data().values, values)) {
            return { changed: false, settings: before };
          }
        }

        const next = {
          schemaVersion: currentSchema.schemaVersion,
          values,
          version: before ? nextVersion(before.version) : 1,
        };
        if (before?.published) next.published = before.published;
        ensureDocumentFits(next, id, firestoreDocumentBytesFn);
        const historyRef = firestore
          .collection(AUDIT_COLLECTIONS.versionHistory)
          .doc();
        const historyEntry = versionHistoryEntryFn({
          collection: SETTINGS_COLLECTION,
          documentId: id,
          action: before ? "update" : "create",
          before,
          after: next,
          actorUid: user.uid,
          actorEmail: user.email ?? null,
          source,
        });
        ensureRevisionFits(
          historyEntry,
          historyRef.path,
          firestoreDocumentBytesFn,
        );
        const usage = collectWorkingMediaUsage({
          collection: SETTINGS_COLLECTION,
          documentId: id,
          document: next,
          settingsSchemas,
        });
        await validateNjDecidesMediaAssets({
          documentId: id,
          values: next.values,
          firestore,
          transaction,
        });
        const usageWrite = await prepareMediaUsageWriteFn({
          firestore,
          transaction,
          collection: SETTINGS_COLLECTION,
          documentId: id,
          state: "working",
          sourceVersion: next.version,
          usage,
        });
        if (before) transaction.set(settingsRef, next);
        else transaction.create(settingsRef, next);
        transaction.set(usageWrite.ref, usageWrite.document);
        transaction.set(historyRef, historyEntry);
        transaction.set(
          firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(),
          adminLogEntryFn({
            actorUid: user.uid,
            actorEmail: user.email ?? null,
            action: "cms.settings.save",
            target: `${SETTINGS_COLLECTION}/${id}`,
            before: before ? settingsReceipt(before) : null,
            after: settingsReceipt(next),
            source,
          }),
        );
        return { changed: true, settings: next };
      });
      res.status(200).json({ success: true, id, ...outcome });
    } catch (error) {
      sendFailure({ error, res, log, operation: "cmsSaveSettings" });
    }
  };
}

function createCmsPublishSettingsHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    settingsSchemas = CMS_SETTINGS_SCHEMAS,
    prepareMediaUsageWriteFn = prepareMediaUsageWrite,
    adminLogEntryFn = adminLogEntry,
    versionHistoryEntryFn = versionHistoryEntry,
    firestoreDocumentBytesFn = firestoreDocumentBytes,
    now = () => new Date().toISOString(),
    log = logger,
    publishableSettingsIds = null,
  } = deps;

  return async (req, res) => {
    setPrivateNoStore(res);
    res.set(CMS_SETTINGS_CONTRACT_HEADER, NEWSROOM_SETTINGS_CONTRACT);
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    try {
      validateBoundedJsonRequest(req, MAX_READ_JSON_BYTES);
      const user = await requirePrincipalFn(req);
      const validationError = validatePublishSettingsRequest(req.body);
      if (validationError) throw new SettingsRejection(400, validationError);
      requireSettingsManager(user);

      const { id, baseVersion } = req.body;
      if (PUBLIC_SETTINGS_IDS.has(id) && req.body.publicationTransport !== "public-context-no-build-v1") {
        throw new SettingsRejection(409,
          "Boardwalk was updated. Reload this page, then publish again.",
          "settings_publication_client_outdated");
      }
      if (publishableSettingsIds && !publishableSettingsIds.has(id)) {
        throw new SettingsRejection(
          400,
          "This settings document cannot be published.",
        );
      }
      const currentSchema = requireCurrentSchema(id, settingsSchemas);
      const source = getClientIp(req);
      const outcome = await firestore.runTransaction(async (transaction) => {
        await requireSettingsManagerInTransaction(firestore, transaction, user.uid);
        const settingsRef = firestore.collection(SETTINGS_COLLECTION).doc(id);
        const snapshot = await transaction.get(settingsRef);
        if (!snapshot.exists) throw new SettingsRejection(404, NOT_FOUND_MESSAGE);
        const before = canonicalStoredSettings(id, snapshot.data(), settingsSchemas);
        const publicSetting = PUBLIC_SETTINGS_IDS.has(id);
        if (publicSetting) {
          const sourceVersion = before.version === baseVersion && samePublishedWorkingVersion(before)
            ? before.published.sourceVersion : baseVersion;
          const accepted = await readSettingsPublication({ firestore, transaction, id, sourceVersion, settings: before });
          if (accepted) {
            const retry = await prepareSettingsRetry({ firestore, transaction, accepted });
            retry.write();
            return { changed: false, settings: before, publication: retry.publication };
          }
        }
        if (before.version !== baseVersion) {
          throw new SettingsRejection(
            409,
            "This settings document changed since you opened it. Reload before publishing.",
          );
        }
        const publicationSchema = settingsSchemaForPublication(
          id,
          before,
          currentSchema,
          settingsSchemas,
        );
        // Stored navigation can contain historical duplicate headings. Check
        // current values even when the published snapshot already matches.
        validateIncomingValues(publicationSchema, before.values);
        const unchanged = samePublishedWorkingVersion(before);
        if (!unchanged) await validateNjDecidesMediaAssets({ documentId: id, values: before.values, firestore, transaction });
        if (unchanged && !publicSetting) {
          return { changed: false, settings: before };
        }

        if (!publicSetting) {
          await assertSerializerPublicationAdmissionInTransaction({ firestore, transaction });
        }

        const published = unchanged ? before.published : createCmsSettingsPublishedSnapshot({
          schema: publicationSchema,
          values: before.values,
          sourceVersion: before.version,
          publishedAt: now(),
        });
        const next = unchanged ? before : {
          schemaVersion: before.schemaVersion,
          values: before.values,
          version: nextVersion(before.version),
          published,
        };
        const prepared = publicSetting ? await prepareSettingsPublication({ firestore, transaction,
          id, published, actor: user }) : null;
        ensureDocumentFits(next, id, firestoreDocumentBytesFn);
        const historyRef = firestore
          .collection(AUDIT_COLLECTIONS.versionHistory)
          .doc();
        const historyEntry = versionHistoryEntryFn({
          collection: SETTINGS_COLLECTION,
          documentId: id,
          action: "publish",
          before,
          after: next,
          actorUid: user.uid,
          actorEmail: user.email ?? null,
          source,
        });
        ensureRevisionFits(
          historyEntry,
          historyRef.path,
          firestoreDocumentBytesFn,
        );
        const usage = collectPublishedMediaUsage({
          collection: SETTINGS_COLLECTION,
          documentId: id,
          documentVersion: next.version,
          snapshot: published,
          settingsSchemas,
        });
        const usageWrite = await prepareMediaUsageWriteFn({
          firestore,
          transaction,
          collection: SETTINGS_COLLECTION,
          documentId: id,
          state: "published",
          sourceVersion: published.sourceVersion,
          usage,
          ...(prepared?.releaseSelector ? { releaseSelector: prepared.releaseSelector } : {}),
        });
        const writeReleaseChange = !publicSetting && !unchanged
          ? await preparePublicReleaseProducerInTransaction({ firestore, transaction, revisionDelta: 0,
              operationId: publicReleaseProducerOperation("settings", id, published.sourceVersion, published),
              changes: [{ kind: "settings", id, action: "publish", sourceVersion: published.sourceVersion, snapshot: published }] }) : () => {};
        writeReleaseChange();
        if (publicSetting) {
          bumpPublicContextRevision(transaction, firestore);
        }
        transaction.set(settingsRef, next);
        transaction.set(usageWrite.ref, usageWrite.document);
        transaction.set(historyRef, historyEntry);
        transaction.set(
          firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(),
          adminLogEntryFn({
            actorUid: user.uid,
            actorEmail: user.email ?? null,
            action: "cms.settings.publish",
            target: `${SETTINGS_COLLECTION}/${id}`,
            before: settingsReceipt(before),
            after: settingsReceipt(next),
            source,
          }),
        );
        prepared?.write();
        return { changed: !unchanged, settings: next,
          ...(prepared ? { publication: prepared.publication } : {}) };
      });
      res.status(200).json({ success: true, id, ...outcome });
    } catch (error) {
      sendFailure({ error, res, log, operation: "cmsPublishSettings" });
    }
  };
}

const cmsGetNewsroomBanner = cmsOnRequest(
  { cors: true },
  createCmsGetNewsroomBannerHandler(),
);
const cmsGetSettings = cmsOnRequest(
  { cors: true, cpu: 1, concurrency: 80 },
  createCmsGetSettingsHandler(),
);
const cmsGetPublishedSettings = cmsOnRequest(
  { cors: true },
  createCmsGetPublishedSettingsHandler(),
);
const cmsSaveSettings = cmsOnRequest(
  { cors: true, minInstances: 1 },
  createCmsSaveSettingsHandler(),
);
const cmsPublishSettings = cmsOnRequest(
  { cors: true },
  createCmsPublishSettingsHandler({
    publishableSettingsIds: PUBLIC_SETTINGS_IDS,
  }),
);

const cmsGetCoverageLabels = cmsOnRequest({ cors: true }, createCmsGetCoverageLabelsHandler());

module.exports = {
  cmsGetCoverageLabels, createCmsGetCoverageLabelsHandler,
  DEFAULT_NEWSROOM_BANNER_HEADING,
  DEFAULT_NEWSROOM_MILESTONE_NUMBER,
  MAX_DOCUMENT_ID_BYTES,
  MAX_READ_JSON_BYTES,
  MAX_SAVE_JSON_BYTES,
  NEWSROOM_HOME_SETTINGS_ID,
  NEWSROOM_MILESTONE_SETTINGS_ID,
  NOT_FOUND_MESSAGE,
  SettingsRejection,
  canonicalStoredSettings,
  cmsGetNewsroomBanner,
  cmsGetPublishedSettings,
  cmsGetSettings,
  cmsPublishSettings,
  cmsSaveSettings,
  createCmsGetNewsroomBannerHandler,
  createCmsGetPublishedSettingsHandler,
  createCmsGetSettingsHandler,
  createCmsPublishSettingsHandler,
  createCmsSaveSettingsHandler,
  isBoundedDocumentId,
  isPublicHomepageBannerUpgrade,
  samePublishedWorkingVersion,
  settingsSchemaForPublication,
  validateNjDecidesMediaAssets,
  validateGetPublishedSettingsRequest,
  validateGetSettingsRequest,
  validateNewsroomBannerRequest,
  validatePublishSettingsRequest,
  validateSaveSettingsRequest,
};
