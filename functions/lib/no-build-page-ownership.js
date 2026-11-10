"use strict";

const { createHash } = require("node:crypto");
const { PUBLIC_PAGE_DEFINITIONS, publicPageDefinition, publicPagePath, isAvailablePageSlug } = require("./public-page-contract");
const { publiclyVisible } = require("./public-video-references");
const { publicationRuntime } = require("./publication-runtime-owner");

const PAGE_OWNER_COLLECTION = "system/publicDeployment/noBuildPageOwners";
const PAGE_ROUTE_COLLECTION = "system/publicDeployment/noBuildPageRoutes";
const PAGE_CAPABILITY_PATH = "system/publicDeployment/noBuildPages/capability";
const validPageId = value => typeof value === "string" && Boolean(publicPageDefinition(value));
const validOperationId = value => typeof value === "string" && /^[A-Za-z0-9]{20}$/.test(value);
const validSha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const validDigest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function digest(value) {
  // Firestore sorts map fields on storage; seals must not depend on input order.
  const canonical = value => Array.isArray(value) ? value.map(canonical) :
    value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
function refuse(message = "Build-free Page ownership is unavailable.") {
  throw Object.assign(new Error(message), { status: 409 });
}
function validPagePath(pageId, path) {
  if (pageId === "home") return ["/", "/_home-sources.json"].includes(path);
  const slug = typeof path === "string" ? /^\/([^/]+)\/$/.exec(path)?.[1] : null;
  return Boolean(slug && isAvailablePageSlug(pageId, slug));
}
function maxOwnedPagePaths(pageId) {
  const definition = Object.hasOwn(PUBLIC_PAGE_DEFINITIONS, pageId) ? PUBLIC_PAGE_DEFINITIONS[pageId] : null;
  return definition ? 102 + (definition.aliases?.length ?? 0) : 101;
}
function validateNoBuildPageState(state) {
  if (state === undefined || state === null) return null;
  if (state.schemaVersion !== 1 || !validPageId(state.pageId) ||
      !validSha(state.rendererSha) || typeof state.servingEnabled !== "boolean" ||
      !Number.isSafeInteger(state.generation) || state.generation < 1 ||
      !validOperationId(state.operationId) ||
      !Number.isSafeInteger(state.sourceVersion) || state.sourceVersion < 1 ||
      typeof state.visible !== "boolean" || !validPagePath(state.pageId, state.path) ||
      !validDigest(state.snapshotDigest) ||
      (state.datasetFiguresDigest !== undefined && !validDigest(state.datasetFiguresDigest)) ||
      !Array.isArray(state.ownedPaths) || state.ownedPaths.length < 1 || state.ownedPaths.length > maxOwnedPagePaths(state.pageId) ||
      !state.ownedPaths.includes(state.path) || new Set(state.ownedPaths).size !== state.ownedPaths.length ||
      state.ownedPaths.some(path => !validPagePath(state.pageId, path))) refuse();
  if (state.contentRedirectUrl != null && require("./content-link").contentLinkError({ contentLinkMode: "custom", contentLinkUrl: state.contentRedirectUrl })) refuse();
  if (state.pageId === "home" && (state.path !== "/" || state.ownedPaths.length !== 2 ||
      !state.ownedPaths.includes("/_home-sources.json"))) refuse();
  if (publicationRuntime(state.runtime).owner !== "cloudflare" || state.runtime.release !== state.rendererSha) refuse();
  return state;
}
function validateNoBuildPageCapability(value) {
  if (value === undefined || value === null) return null;
  const required = ["schemaVersion", "rendererSha", "servingEnabled", "generation"];
  const fields = [...required, "terminalOwner", "dataFigureVersion", "electionResultsVersion", "dataHubReportingVersion", "dataHubCompositionVersion"];
  if (typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length < required.length || Object.keys(value).length > fields.length ||
      required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !fields.includes(key)) || value.schemaVersion !== 1 ||
      !validSha(value.rendererSha) || typeof value.servingEnabled !== "boolean" ||
      !Number.isSafeInteger(value.generation) || value.generation < 1 ||
      (value.dataFigureVersion !== undefined && value.dataFigureVersion !== 1) ||
      (value.electionResultsVersion !== undefined && ![1, 2].includes(value.electionResultsVersion)) ||
      (value.dataHubReportingVersion !== undefined && value.dataHubReportingVersion !== 1) ||
      (value.dataHubCompositionVersion !== undefined && (value.dataHubCompositionVersion !== 1 || value.dataHubReportingVersion !== 1))) refuse();
  if (Object.hasOwn(value, "terminalOwner")) {
    const seal = value.terminalOwner;
    if (!seal || typeof seal !== "object" || Array.isArray(seal) || Object.keys(seal).length !== 3 ||
        Object.keys(seal).some(key => !["schemaVersion", "transport", "rendererSha"].includes(key)) ||
        seal.schemaVersion !== 1 || seal.transport !== "page-no-build-v1" || seal.rendererSha !== value.rendererSha) refuse();
  }
  return { ...value };
}
function candidateNoBuildPageContract(value) {
  if (value === undefined) return null;
  const required = ["schemaVersion", "rendererSha", "enabled", "authoritative"];
  const fields = [...required, "dataFigureVersion", "electionResultsVersion", "dataHubReportingVersion", "dataHubCompositionVersion"];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length < required.length || Object.keys(value).length > fields.length ||
      required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !fields.includes(key)) || value.schemaVersion !== 1 ||
      !validSha(value.rendererSha) || typeof value.enabled !== "boolean" || value.authoritative !== true ||
      (value.dataFigureVersion !== undefined && value.dataFigureVersion !== 1) ||
      (value.electionResultsVersion !== undefined && ![1, 2].includes(value.electionResultsVersion)) ||
      (value.dataHubReportingVersion !== undefined && value.dataHubReportingVersion !== 1) ||
      (value.dataHubCompositionVersion !== undefined && (value.dataHubCompositionVersion !== 1 || value.dataHubReportingVersion !== 1))) refuse();
  return { ...value };
}
function effectiveNoBuildPageState(state, capability) {
  if (!state || !capability) return state;
  return { ...state, rendererSha: capability.rendererSha, servingEnabled: capability.servingEnabled,
    generation: Math.max(state.generation, capability.generation) };
}
async function readSnapshot(ref, transaction) { return transaction ? transaction.get(ref) : ref.get(); }
async function readNoBuildPageOwner({ firestore, transaction, pageId }) {
  if (!validPageId(pageId)) refuse();
  const ref = firestore.doc(`${PAGE_OWNER_COLLECTION}/${pageId}`);
  const state = validateNoBuildPageState((await readSnapshot(ref, transaction)).data());
  if (state && state.pageId !== pageId) refuse();
  return { ref, state };
}
async function listNoBuildPageOwners({ firestore, transaction, path }) {
  let query = firestore.collection(PAGE_OWNER_COLLECTION);
  if (path !== undefined) query = query.where("ownedPaths", "array-contains", path);
  const rows = await readSnapshot(query, transaction);
  return rows.docs.map(row => {
    const state = validateNoBuildPageState(row.data());
    if (!state || state.pageId !== row.id) refuse();
    return { ref: row.ref, state };
  });
}
async function readNoBuildPageCapability({ firestore, transaction }) {
  return validateNoBuildPageCapability((await readSnapshot(firestore.doc(PAGE_CAPABILITY_PATH), transaction)).data());
}
function pageRouteRef(firestore, path) {
  return firestore.doc(`${PAGE_ROUTE_COLLECTION}/${createHash("sha256").update(path).digest("hex")}`);
}
async function assertNoBuildPageRouteAvailable({ firestore, transaction, pageId, path }) {
  const claim = (await readSnapshot(pageRouteRef(firestore, path), transaction)).data();
  if (claim && (claim.schemaVersion !== 1 || claim.path !== path || claim.pageId !== pageId)) {
    refuse("Another Page owns this public route.");
  }
}
/** Deterministic route documents serialize even the first two simultaneous
 * admissions. Tombstones and aliases keep these claims; pauses never free them. */
async function preparePageRouteClaimsInTransaction({ firestore, transaction, pageId, ownedPaths }) {
  for (const path of ownedPaths) {
    if (!validPagePath(pageId, path)) refuse();
    await assertNoBuildPageRouteAvailable({ firestore, transaction, pageId, path });
    // Static Pages have no route claim yet. Preserve their published aliases too.
    if (pageId === "home") continue;
    const slug = path.slice(1, -1);
    const pages = firestore.collection("cmsPages");
    const rows = await Promise.all([
      transaction.get(pages.where("published.metadata.slug", "==", slug)),
      transaction.get(pages.where("published.metadata.previousSlugs", "array-contains", slug)),
    ]);
    if (rows.some(row => row.docs.some(document => document.id !== pageId))) {
      refuse("Another Page owns this published route.");
    }
  }
  return () => {
    for (const path of ownedPaths) transaction.set(pageRouteRef(firestore, path), { schemaVersion: 1, pageId, path });
  };
}
function assertPageOwnerSnapshot(state, document) {
  if (document?.published?.sourceVersion !== state.sourceVersion ||
      publicPagePath(state.pageId, document?.published?.metadata) !== state.path ||
      publiclyVisible(document) !== state.visible || digest(document.published) !== state.snapshotDigest ||
      state.datasetFiguresDigest && digest(document?.published?.datasetFigures) !== state.datasetFiguresDigest) refuse();
}
module.exports = { PAGE_OWNER_COLLECTION, PAGE_ROUTE_COLLECTION, PAGE_CAPABILITY_PATH, digest, refuse,
  maxOwnedPagePaths, validateNoBuildPageState, validateNoBuildPageCapability, candidateNoBuildPageContract, effectiveNoBuildPageState,
  readNoBuildPageOwner, listNoBuildPageOwners, readNoBuildPageCapability, pageRouteRef,
  assertNoBuildPageRouteAvailable, preparePageRouteClaimsInTransaction, assertPageOwnerSnapshot };
