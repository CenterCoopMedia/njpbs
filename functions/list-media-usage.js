"use strict";

const logger = require("firebase-functions/logger");
const { db } = require("./lib/firebase");
const { cmsOnRequest } = require("./lib/cms-edge");
const { requirePrincipal } = require("./lib/auth");
const { can, hasCapability } = require("./lib/rbac");
const { JsonRequestError, validateBoundedJsonRequest } = require("./lib/http-json");
const { isMediaAssetId } = require("./lib/media-library");
const { authorizeContentRead, contentResource } = require("./lib/content-authorization");
const { readPublicDeploymentPointer } = require("./lib/public-deployment-pointer");
const { mayUseMedia, setPrivateNoStore } = require("./list-media");
const { mayReadTemplate } = require("./lib/post-templates");

const MAX_USAGE_SCAN = 500;
const MAX_USAGE_JSON_BYTES = 4 * 1024;
const STATES = new Set(["working", "published", "deployed"]);
const CONTENT_COLLECTIONS = new Set(["cmsPages", "cmsPosts", "cmsSettings", "cmsPostTemplates"]);
const FORBIDDEN_MESSAGE = "You do not have permission to read this media usage.";

class MediaUsageReadError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseUsageRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => !["assetId", "state", "page", "pageSize"].includes(key))) {
    throw new MediaUsageReadError(400, "The media usage request is invalid.");
  }
  const { assetId, state = "working", page = 1, pageSize = 25 } = body;
  if (!isMediaAssetId(assetId) || !STATES.has(state) ||
      !Number.isSafeInteger(page) || page < 1 || page > MAX_USAGE_SCAN ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) {
    throw new MediaUsageReadError(400, "The media usage request is invalid.");
  }
  return { assetId, state, page, pageSize };
}

async function readDeployment(transaction, firestore) {
  const snapshot = await transaction.get(firestore.doc("system/publicDeployment"));
  try {
    const pointer = readPublicDeploymentPointer(snapshot.data());
    if (!pointer.mediaLifecycleReady || pointer.state !== "idle" || pointer.activeGeneration < 1) {
      throw new Error("Deployment is not settled");
    }
    return { generation: pointer.activeGeneration, commitSha: pointer.activeCommitSha };
  } catch {
    throw new MediaUsageReadError(503, "Deployed media usage is temporarily unavailable.");
  }
}

function usageOwner(snapshot, state, deployment) {
  const parts = snapshot.ref.path.split("/");
  const [collection, documentId, childCollection, childId] = parts;
  const profileCollection = state === "deployed" ? "cmsAuthorProfilesPublic" : "cmsAuthorProfiles";
  const expectedId = state === "deployed" ? `deployed-${deployment.generation}` : state;
  if (parts.length !== 4 || childCollection !== "mediaUsage" || childId !== expectedId ||
      (!CONTENT_COLLECTIONS.has(collection) && collection !== profileCollection)) return null;
  return {
    collection,
    documentId,
    // Public profile snapshots carry no account linkage. Resolve access through
    // the private owner, whose uid is maintained by the profile boundary.
    ownerPath: `${collection === "cmsAuthorProfilesPublic" ? "cmsAuthorProfiles" : collection}/${documentId}`,
    usage: snapshot.data(),
  };
}

function mayReadOwner(user, owner, stored) {
  if (!stored || stored.deleted === true) return false;
  if (owner.collection === "cmsPostTemplates") return mayReadTemplate(user.principal, stored);
  if (owner.collection === "cmsSettings") return can(user.principal, "settings.manage");
  if (owner.ownerPath.startsWith("cmsAuthorProfiles/")) {
    return can(user.principal, "profiles.manage") || stored.uid === user.uid;
  }
  return authorizeContentRead(user.principal, {
    exists: true,
    resource: contentResource({ ...owner, stored }),
  }).allowed;
}

function usageRow(owner, stored, query, deployment) {
  const usage = owner.usage;
  const profile = owner.ownerPath.startsWith("cmsAuthorProfiles/");
  const sourceVersion = query.state === "published" && !profile
    ? stored.published?.sourceVersion : stored.version;
  // Content-free lifecycle transitions advance the owner version without
  // rewriting working usage. Keep that indexed version; it is not a stale
  // reference merely because the owner's status changed after its last save.
  const matchesMutableVersion = query.state === "working"
    ? Number.isSafeInteger(sourceVersion) && usage.sourceVersion <= sourceVersion
    : usage.sourceVersion === sourceVersion;
  const matchesSource = query.state === "deployed"
    ? usage.generation === deployment.generation && usage.commitSha === deployment.commitSha
    : matchesMutableVersion;
  if (usage.state !== query.state || !Number.isSafeInteger(usage.sourceVersion) ||
      usage.sourceVersion < 1 || !matchesSource ||
      (query.state === "published" && profile && stored.visibility !== "published")) {
    throw new MediaUsageReadError(503, "The media usage index needs to be refreshed.");
  }
  const label = profile ? stored.displayName : owner.collection === "cmsPostTemplates" ? stored.name : stored.title;
  // occurrenceCount belongs to ALL assets on this owner. It cannot answer how
  // many times the selected asset occurs, so it is deliberately not projected.
  return {
    collection: owner.collection,
    documentId: owner.documentId,
    title: typeof label === "string" ? label.slice(0, 200) : owner.documentId,
    sourceVersion: usage.sourceVersion,
  };
}

async function readMediaUsage(firestore, user, query) {
  // One read-only snapshot keeps asset access, owner access, index versions and
  // the acknowledged deployed generation consistent without locking writers.
  return firestore.runTransaction(async transaction => {
    const asset = await transaction.get(firestore.doc(`media_assets/${query.assetId}`));
    const storedAsset = asset.data();
    if (!asset.exists || storedAsset?.lifecycle !== "active" ||
        !mayUseMedia(user.principal, storedAsset?.category)) {
      throw new MediaUsageReadError(403, FORBIDDEN_MESSAGE);
    }
    const deployment = query.state === "deployed"
      ? await readDeployment(transaction, firestore) : null;
    let indexQuery = firestore.collectionGroup("mediaUsage")
      .where("state", "==", query.state)
      .where("assetIds", "array-contains", query.assetId);
    if (deployment) indexQuery = indexQuery.where("generation", "==", deployment.generation);
    const snapshot = await transaction.get(indexQuery.limit(MAX_USAGE_SCAN + 1));
    // ponytail: bounded index scan; replace this selector with scoped indexed
    // paging when an asset exceeds 500 references. Never return a partial total.
    if (snapshot.docs.length > MAX_USAGE_SCAN) {
      throw new MediaUsageReadError(503, "This asset has more references than this reader supports.");
    }
    const owners = snapshot.docs.map(doc => usageOwner(doc, query.state, deployment)).filter(Boolean);
    const rows = [];
    // Content documents can be large. Keep only one small batch in memory and
    // retain the authorized projection before reading the next batch.
    for (let offset = 0; offset < owners.length; offset += 25) {
      const batch = owners.slice(offset, offset + 25);
      const records = await transaction.getAll(...batch.map(owner => firestore.doc(owner.ownerPath)));
      records.forEach((record, index) => {
        const owner = batch[index];
        const stored = record.data();
        if (record.exists && mayReadOwner(user, owner, stored)) {
          rows.push(usageRow(owner, stored, query, deployment));
        }
      });
    }
    rows.sort((a, b) => `${a.collection}/${a.documentId}`.localeCompare(`${b.collection}/${b.documentId}`));
    const start = (query.page - 1) * query.pageSize;
    return {
      assetId: query.assetId,
      state: query.state,
      generation: deployment?.generation ?? null,
      coverage: "indexed_only",
      items: rows.slice(start, start + query.pageSize),
      total: rows.length,
      page: query.page,
      pageSize: query.pageSize,
      pageCount: Math.ceil(rows.length / query.pageSize),
    };
  }, { readOnly: true });
}

function createCmsListMediaUsageHandler(deps = {}) {
  const { firestore = db, requirePrincipalFn = requirePrincipal, log = logger } = deps;
  return async (req, res) => {
    setPrivateNoStore(res);
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    try {
      validateBoundedJsonRequest(req, MAX_USAGE_JSON_BYTES);
      const user = await requirePrincipalFn(req);
      if (!hasCapability(user.principal, "media.upload") && !hasCapability(user.principal, "media.manage")) {
        throw new MediaUsageReadError(403, FORBIDDEN_MESSAGE);
      }
      const query = parseUsageRequest(req.body);
      const result = await readMediaUsage(firestore, user, query);
      res.status(200).json({ success: true, ...result });
    } catch (error) {
      if (res.headersSent) return;
      const expected = error instanceof MediaUsageReadError || error instanceof JsonRequestError ||
        Number.isInteger(error?.status);
      const status = expected ? error.status : 500;
      if (status >= 500) log.error("cmsListMediaUsage failed", error);
      res.status(status).json({ error: expected ? error.message : "Failed to read media usage" });
    }
  };
}

const cmsListMediaUsage = cmsOnRequest(
  { cors: true, maxInstances: 10, timeoutSeconds: 30 },
  createCmsListMediaUsageHandler(),
);

module.exports = { MAX_USAGE_SCAN, cmsListMediaUsage, createCmsListMediaUsageHandler, readMediaUsage };
