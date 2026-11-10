"use strict";

const { createHash } = require("node:crypto");
const { recordFamilyForPath, recordIndexPaths, validRecordId, validateNoBuildRecordSnapshot,
  recordSnapshotDigest } = require("./no-build-record-contract");
const { publicContextDigest } = require("./public-context-revision");
const { publiclyVisible } = require("./public-video-references");
const { publicationRuntime } = require("./publication-runtime-owner");
const { isServerMintableSlugShape } = require("./post-slug-contract");

const RECORD_OWNER_COLLECTION = "system/publicDeployment/noBuildRecordOwners";
const RECORD_ROUTE_COLLECTION = "system/publicDeployment/noBuildRecordRoutes";
const validSha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const validDigest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const validOperation = value => typeof value === "string" && /^[A-Za-z0-9]{20}$/.test(value);
function refuse(message = "Record route ownership is unavailable.") {
  throw Object.assign(new Error(message), { status: 409 });
}
function validDetailPath(family, path) {
  return recordFamilyForPath(path) === family && !recordIndexPaths(family).includes(path);
}
function assertOwnedPaths(family, paths) {
  if (!["programs", "events"].includes(family) || !Array.isArray(paths) || !paths.length ||
      paths.length > (family === "programs" ? 202 : 101) || new Set(paths).size !== paths.length ||
      paths.some(path => !validDetailPath(family, path))) refuse();
}

function validateNoBuildRecordState(state) {
  if (state === undefined || state === null) return null;
  const fields = ["schemaVersion", "family", "documentId", "operationId", "sourceVersion", "snapshotDigest", "canonicalPath",
    "ownedPaths", "visible", "rendererSha", "generation", "runtime", "contextRevision", "contextDigest", "admissionRevision"];
  if (typeof state !== "object" || Array.isArray(state) || Object.keys(state).length < fields.length || Object.keys(state).length > fields.length + 1 ||
      fields.some(field => !Object.hasOwn(state, field)) ||
      Object.keys(state).some(field => ![...fields, "durableWithdrawal"].includes(field)) || state.schemaVersion !== 1 ||
      !validRecordId(state.documentId) || !validOperation(state.operationId) || !validSha(state.rendererSha) ||
      !validDigest(state.snapshotDigest) || !Number.isSafeInteger(state.sourceVersion) || state.sourceVersion < 1 ||
      !Number.isSafeInteger(state.generation) || state.generation < 1 || typeof state.visible !== "boolean" ||
      !Number.isSafeInteger(state.contextRevision) || state.contextRevision < 1 || state.contextDigest !== publicContextDigest(state.contextRevision) ||
      !(state.admissionRevision === null || Number.isSafeInteger(state.admissionRevision) && state.admissionRevision > 0)) refuse();
  assertOwnedPaths(state.family, state.ownedPaths);
  if (typeof state.canonicalPath !== "string" || !state.canonicalPath.startsWith(`/${state.family}/`) || !state.ownedPaths.includes(state.canonicalPath) ||
      publicationRuntime(state.runtime).owner !== "cloudflare" || state.runtime.release !== state.rendererSha) refuse();
  if (state.durableWithdrawal !== undefined) {
    const marker = state.durableWithdrawal;
    const keys = ["schemaVersion", "recordId", "family", "operationId", "sourceVersion", "revision", "ownedPaths", "snapshotDigest", "contextRevision"];
    if (!marker || typeof marker !== "object" || Array.isArray(marker) || Object.keys(marker).length !== keys.length ||
        keys.some(key => !Object.hasOwn(marker, key)) || marker.schemaVersion !== 1 || marker.recordId !== state.documentId ||
        marker.family !== state.family || !validOperation(marker.operationId) || !validDigest(marker.snapshotDigest) ||
        !Number.isSafeInteger(marker.sourceVersion) || marker.sourceVersion < 1 || !Number.isSafeInteger(marker.revision) ||
        marker.revision < 1 || marker.revision > state.generation || !Number.isSafeInteger(marker.contextRevision) ||
        marker.contextRevision < 1 || marker.contextRevision > state.contextRevision) refuse();
    assertOwnedPaths(marker.family, marker.ownedPaths);
    if (marker.ownedPaths.some(path => !state.ownedPaths.includes(path))) refuse();
  }
  return state;
}

async function readNoBuildRecordOwner({ firestore, transaction, documentId }) {
  if (!validRecordId(documentId)) refuse();
  const ref = firestore.doc(`${RECORD_OWNER_COLLECTION}/${documentId}`);
  const row = await (transaction ? transaction.get(ref) : ref.get());
  const state = validateNoBuildRecordState(row.data());
  if (state && state.documentId !== documentId) refuse();
  return { ref, state };
}
async function listNoBuildRecordOwners({ firestore, transaction, family }) {
  if (family !== undefined && !["programs", "events"].includes(family)) refuse();
  const query = firestore.collection(RECORD_OWNER_COLLECTION);
  const bounded = (family ? query.where("family", "==", family) : query).limit(1001);
  const rows = await (transaction ? transaction.get(bounded) : bounded.get());
  if (rows.size > 1000) refuse();
  return rows.docs.map(row => {
    const state = validateNoBuildRecordState(row.data());
    if (!state || state.documentId !== row.id) refuse();
    return { ref: row.ref, state };
  });
}
function recordRouteRef(firestore, path) {
  const family = recordFamilyForPath(path);
  if (!family || !validDetailPath(family, path)) refuse();
  return firestore.doc(`${RECORD_ROUTE_COLLECTION}/${createHash("sha256").update(path).digest("hex")}`);
}

async function assertRetainedRecordRoutesAvailable({ firestore, transaction, family, documentId, ownedPaths }) {
  const rows = await transaction.get(firestore.collection("cmsPosts").where("published.metadata.type", "==", family === "programs" ? "program" : "event")
    .select("published.metadata.slug", "published.metadata.previousSlugs").limit(1001));
  if (rows.size > 1000) refuse();
  const proposed = new Set(ownedPaths);
  for (const row of rows.docs) {
    if (row.id === documentId) continue;
    const metadata = row.data().published?.metadata;
    if (!isServerMintableSlugShape(metadata?.slug) ||
        metadata.previousSlugs !== undefined && (!Array.isArray(metadata.previousSlugs) || metadata.previousSlugs.length > 100 ||
          metadata.previousSlugs.some(slug => typeof slug !== "string"))) refuse();
    for (const slug of [metadata.slug, ...(metadata.previousSlugs ?? [])].filter(isServerMintableSlugShape)) {
      if (proposed.has(`/${family}/${slug}/`) || family === "programs" && proposed.has(`/shows/${slug}/`)) {
        refuse("A retained record already has this public address.");
      }
    }
  }
}

/** Deterministic point claims serialize first admissions and keep all retired
 * aliases reserved. Drafts, pause and removal never release a route claim. */
async function prepareRecordRouteClaimsInTransaction({ firestore, transaction, family, documentId, ownedPaths }) {
  if (!validRecordId(documentId)) refuse();
  assertOwnedPaths(family, ownedPaths);
  const { state } = await readNoBuildRecordOwner({ firestore, transaction, documentId });
  if (state && (state.family !== family || state.ownedPaths.some(path => !ownedPaths.includes(path)))) {
    refuse("The record must keep every accepted public route.");
  }
  await assertRetainedRecordRoutesAvailable({ firestore, transaction, family, documentId, ownedPaths });
  const refs = ownedPaths.map(path => recordRouteRef(firestore, path));
  const rows = await transaction.getAll(...refs);
  for (const [index, row] of rows.entries()) {
    const value = row.data();
    if (row.exists && (value?.schemaVersion !== 1 || value.family !== family || value.documentId !== documentId ||
        value.path !== ownedPaths[index] || Object.keys(value).length !== 4)) refuse("A retained record owns this public route.");
  }
  return () => refs.forEach((ref, index) => {
    if (!rows[index].exists) transaction.create(ref, { schemaVersion: 1, family, documentId, path: ownedPaths[index] });
  });
}

function assertRecordOwnerSnapshot(state, document) {
  validateNoBuildRecordState(state);
  if (!state || !document || publiclyVisible(document) !== state.visible ||
      !Number.isSafeInteger(document.version) || document.version < state.sourceVersion ||
      document.publicSourceVersion !== undefined && document.publicSourceVersion !== null &&
        (!Number.isSafeInteger(document.publicSourceVersion) || document.publicSourceVersion > state.sourceVersion || document.publicSourceVersion < 1)) refuse();
  const plan = validateNoBuildRecordSnapshot({ family: state.family, documentId: state.documentId, snapshot: document.published });
  if (plan.sourceVersion !== state.sourceVersion || plan.canonicalPath !== state.canonicalPath ||
      recordSnapshotDigest(document.published) !== state.snapshotDigest || plan.ownedPaths.some(path => !state.ownedPaths.includes(path))) refuse();
}

module.exports = { RECORD_OWNER_COLLECTION, RECORD_ROUTE_COLLECTION, validateNoBuildRecordState,
  readNoBuildRecordOwner, listNoBuildRecordOwners, recordRouteRef, prepareRecordRouteClaimsInTransaction, assertRecordOwnerSnapshot };
