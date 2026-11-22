"use strict";

const { FieldPath } = require("firebase-admin/firestore");
const logger = require("firebase-functions/logger");
const { AuthError, ForbiddenError, requirePrincipal } = require("./lib/auth");
const { cmsOnRequest } = require("./lib/cms-edge");
const { db } = require("./lib/firebase");
const { JsonRequestError, validateBoundedJsonRequest } = require("./lib/http-json");
const { MediaDiscoveryError, discoveryDigest, readCursor, writeCursor } = require("./lib/media-discovery-cursor");
const { runtimeRegistry } = require("./lib/media-source-runtime");
const {
  MediaSourceAccessError, authorizeMediaSource, hasActiveArchiveCategory, objectKeyWithinSource,
} = require("./lib/media-sources");
const { SourceMediaValidationError, normalizeSearchPrefix, parseSourceMediaAsset } = require("./lib/source-media-contract");
const { sourceMediaQuery } = require("./lib/source-media-query");
const { safeStorageDiagnostic } = require("./lib/source-original-state");

const MAX_PAGE_SIZE = 30;
const ACCESS_DENIED = "You do not have permission to search media.";

function parseSearchRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => !["q", "limit", "cursor"].includes(key))) {
    throw new MediaDiscoveryError(400, "Search requests accept only q, limit and cursor.");
  }
  const q = normalizeSearchPrefix(body.q);
  const { limit = MAX_PAGE_SIZE, cursor } = body;
  if (!q) throw new MediaDiscoveryError(400, "Enter text to search for media.");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new MediaDiscoveryError(400, `Limit must be a whole number from 1 through ${MAX_PAGE_SIZE}.`);
  }
  return { q, limit, cursor };
}

async function authorizedSources(firestore, actor, registry) {
  if (actor.approvedActive !== true) throw new MediaDiscoveryError(403, ACCESS_DENIED);
  let archiveCategoryActive;
  const options = {
    firestore, actor, operation: "browse",
    isApprovedActiveAccountFn: async () => actor.approvedActive,
    archiveCategoryActiveFn: () => (archiveCategoryActive ??= hasActiveArchiveCategory(firestore)),
  };
  const sources = [];
  // Keep the authorization roster stable across registry iteration orders.
  for (const id of [...registry.keys()].sort()) {
    const source = registry.get(id);
    try {
      await authorizeMediaSource({ ...options, source });
      sources.push(source);
    } catch (error) {
      if (!(error instanceof MediaSourceAccessError) || error.status !== 403) throw error;
    }
  }
  if (sources.length === 0) throw new MediaDiscoveryError(403, ACCESS_DENIED);
  return sources;
}

async function readSourceWindow(firestore, source, { q, limit, cursor }, documentIdField) {
  const { query } = sourceMediaQuery(firestore, source.id, { q, cursor }, documentIdField);
  const { docs } = await query.limit(limit + 1).get();
  return docs.flatMap(document => {
    const data = document.data();
    const sort = data.nameSort;
    if (typeof sort !== "string" || !sort.startsWith(q)) return [];
    return [{ id: document.id, sort, data, source }];
  });
}

function compareRows(left, right) {
  // Firestore orders strings by UTF-8 bytes. Asset document IDs are unique across
  // all registered sources because they share the same collection.
  return Buffer.compare(Buffer.from(left.sort), Buffer.from(right.sort)) ||
    Buffer.compare(Buffer.from(left.id), Buffer.from(right.id));
}

async function searchVideoSources({ firestore, actor, sources, request, documentIdField, log }) {
  const { q, limit } = request;
  const binding = discoveryDigest({
    scope: "registered-video-name-prefix", uid: actor.uid, q,
    sources: sources.map(source => [source.id, source.prefix]),
  });
  const continuation = request.cursor === undefined ? null : await readCursor(firestore, request.cursor, binding);
  const windows = await Promise.allSettled(sources.map(source =>
    readSourceWindow(firestore, source, { q, limit, cursor: continuation?.after }, documentIdField)));
  const rows = [];
  const coverage = windows.map((window, index) => {
    const { id, label } = sources[index];
    if (window.status === "fulfilled") {
      rows.push(...window.value);
      return { id, label, fields: ["name"], status: "searched" };
    }
    log.warn("Media search source unavailable", { sourceId: id, ...safeStorageDiagnostic(window.reason) });
    return { id, label, fields: ["name"], status: "unavailable", error: "Could not search this source. Retry this page." };
  });
  const pageRows = rows.sort(compareRows).slice(0, limit);
  const records = pageRows.flatMap(({ id, data, source }) => {
    const asset = parseSourceMediaAsset(id, data);
    if (!asset || asset.sourceId !== source.id || !objectKeyWithinSource(source, asset.objectKey)) return [];
    return [{ id, sourceId: source.id, kind: asset.kind, name: asset.name }];
  });
  // Use the last consumed index row, including a rejected record, to make sparse pages
  // advance. A failed source could have rows before this position, so pause on this
  // page and let the caller retry the same request when any source is unavailable.
  const complete = windows.every(window => window.status === "fulfilled");
  const nextCursor = complete && rows.length > limit
    ? await writeCursor(firestore, binding, { sort: pageRows.at(-1).sort, id: pageRows.at(-1).id })
    : null;
  return { success: true, records, sources: coverage, nextCursor };
}

function createCmsSearchMediaHandler({
  firestore = db, requirePrincipalFn = requirePrincipal, registryFn = runtimeRegistry,
  documentIdField = FieldPath.documentId(), log = logger,
} = {}) {
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    try {
      validateBoundedJsonRequest(req, 2 * 1024);
      const request = parseSearchRequest(req.body);
      const actor = await requirePrincipalFn(req, { includeAccountStatus: true });
      const sources = await authorizedSources(firestore, actor, registryFn());
      const result = await searchVideoSources({ firestore, actor, sources, request, documentIdField, log });
      res.status(200).json(result);
    } catch (error) {
      if (error instanceof MediaDiscoveryError || error instanceof JsonRequestError ||
          error instanceof SourceMediaValidationError || error instanceof AuthError || error instanceof ForbiddenError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      log.error("Media search failed", safeStorageDiagnostic(error));
      res.status(500).json({ error: "Could not search media. Retry this page." });
    }
  };
}

const cmsSearchMedia = cmsOnRequest(
  { cors: true, maxInstances: 10, timeoutSeconds: 30, cpu: 1, concurrency: 80 },
  createCmsSearchMediaHandler(),
);

module.exports = { cmsSearchMedia, createCmsSearchMediaHandler };
