"use strict";

const { ADMISSION_PATH, projectNoBuildAdmission } = require("./no-build-post-admission");
const { publicPageDefinition } = require("./public-page-contract");
const { publicationTarget, assertPublicationTarget } = require("./publication-target");

const fields = ["schemaVersion", "revision", "enabled", "families", "backgroundBucket"];
const legacyFields = ["NO_BUILD_POST_ENABLED", "NO_BUILD_POST_ID", "NO_BUILD_POST_BACKGROUND_BUCKET"];
const validPostId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validPageId = value => typeof value === "string" && publicPageDefinition(value) !== null;
function isRecord(value) {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
const hasFields = (value, expected) => isRecord(value) && Object.keys(value).length === expected.length &&
  Object.keys(value).every(key => expected.includes(key));
const closedAdmission = () => ({ valid: false, enabled: false, families: {}, backgroundBucket: "", admissionRevision: null });

function projectSelector(value, validId) {
  if (hasFields(value, ["mode"]) && value.mode === "all") return { mode: "all" };
  if (!hasFields(value, ["mode", "ids"]) || value.mode !== "ids" || !Array.isArray(value.ids) ||
      value.ids.length < 1 || value.ids.length > 100 || [...value.ids].some(id => !validId(id)) ||
      new Set(value.ids).size !== value.ids.length) return null;
  return { mode: "ids", ids: [...value.ids] };
}

function projectNoBuildFamilyAdmission(value, env = process.env, target = publicationTarget()) {
  if (!isRecord(value)) return closedAdmission();
  if (value?.schemaVersion === 1) {
    const pilot = projectNoBuildAdmission(value, env);
    if (!pilot.valid) return { ...closedAdmission(), admissionRevision: pilot.admissionRevision };
    return { valid: true, enabled: pilot.enabled, families: { posts: { mode: "ids", ids: [pilot.postId] } },
      backgroundBucket: pilot.backgroundBucket, admissionRevision: pilot.admissionRevision };
  }
  if (!hasFields(value, fields) || value.schemaVersion !== 2 ||
      !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.enabled !== "boolean" ||
      typeof value.backgroundBucket !== "string" || !/^[a-z0-9][a-z0-9._-]{2,220}$/.test(value.backgroundBucket) ||
      !isRecord(value.families) || Object.keys(value.families).some(family => !["posts", "pages", "programs", "events"].includes(family))) return closedAdmission();
  // An exact-ID environment cannot describe the family contract. Complete the
  // existing one-time removal before a later operator promotes schema 2.
  // config-input: NO_BUILD_POST_BACKGROUND_BUCKET, NO_BUILD_POST_ENABLED, NO_BUILD_POST_ID
  if (legacyFields.some(key => env[key] !== undefined)) return closedAdmission();
  const families = {};
  if (Object.hasOwn(value.families, "posts")) {
    const posts = projectSelector(value.families.posts, validPostId);
    if (!posts) return closedAdmission();
    families.posts = posts;
  }
  if (Object.hasOwn(value.families, "pages")) {
    // Page admission uses the fixed environment and background bucket.
    try { assertPublicationTarget(target); } catch { return closedAdmission(); }
    if (value.backgroundBucket !== target.backgroundBucket) return closedAdmission();
    const pages = projectSelector(value.families.pages, validPageId);
    if (!pages) return closedAdmission();
    families.pages = pages;
  }
  for (const family of ["programs", "events"]) {
    if (!Object.hasOwn(value.families, family)) continue;
    try { assertPublicationTarget(target); } catch { return closedAdmission(); }
    if (value.backgroundBucket !== target.backgroundBucket) return closedAdmission();
    const selector = projectSelector(value.families[family], validPostId);
    if (!selector) return closedAdmission();
    families[family] = selector;
  }
  return { valid: true, enabled: value.enabled, families, backgroundBucket: value.backgroundBucket,
    admissionRevision: value.revision };
}

// Selection grants only new Post admission. Retained route ownership and
// withdrawal remain separate checks; pausing cannot release an owned route.
function admitsNoBuildPost(admission, postId) {
  if (!admission?.valid || !admission.enabled || !validPostId(postId)) return false;
  return selectsNoBuildPost(admission, postId);
}

function selectsNoBuildPost(admission, postId) {
  if (!admission?.valid || !validPostId(postId)) return false;
  const selector = admission.families?.posts;
  return selector?.mode === "all" || (selector?.mode === "ids" && selector.ids.includes(postId));
}

function admitsNoBuildPage(admission, pageId) {
  return Boolean(admission?.enabled && selectsNoBuildPage(admission, pageId));
}

function selectsNoBuildPage(admission, pageId) {
  if (!admission?.valid || !validPageId(pageId)) return false;
  const selector = admission.families?.pages;
  return selector?.mode === "all" || (selector?.mode === "ids" && selector.ids.includes(pageId));
}

function selectsNoBuildRecord(admission, family, documentId) {
  if (!admission?.valid || !["programs", "events"].includes(family) || !validPostId(documentId)) return false;
  const selector = admission.families?.[family];
  return selector?.mode === "all" || selector?.mode === "ids" && selector.ids.includes(documentId);
}

function admitsNoBuildRecord(admission, family, documentId) {
  return Boolean(admission?.enabled && selectsNoBuildRecord(admission, family, documentId));
}

async function readNoBuildFamilyAdmission({ firestore, transaction, env = process.env }) {
  const ref = firestore.doc(ADMISSION_PATH);
  const snapshot = await (transaction ? transaction.get(ref) : ref.get());
  const target = publicationTarget(firestore.projectId === "njpbs-site-dev" ? "development" : "production");
  return projectNoBuildFamilyAdmission(snapshot.data(), env, target);
}

module.exports = { projectNoBuildFamilyAdmission, admitsNoBuildPost, selectsNoBuildPost,
  admitsNoBuildPage, selectsNoBuildPage, admitsNoBuildRecord, selectsNoBuildRecord, readNoBuildFamilyAdmission };
