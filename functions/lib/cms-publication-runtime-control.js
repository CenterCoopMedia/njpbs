"use strict";
const { assertSerializerPublicationEnabledInTransaction } = require("./serializer-publication-control");

const RUNTIME_DOCUMENT_ID = "cmsPublicationRuntime";
const RUNTIME_DOCUMENT_PATH = `system/${RUNTIME_DOCUMENT_ID}`;
const RUNTIME_SCHEMA_VERSION = 1;
const RUNTIME_PHASES = new Set(["paused", "starting", "ready"]);
const RUNTIME_FIELDS = new Set([
  "schemaVersion",
  "phase",
  "commitSha",
  "serializerId",
]);
const CLOUD_SERIALIZERS = new Set(["cloudflare-publisher", "cloudflare-dev-publisher"]);
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const SERIALIZER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

class CmsPublicationRuntimeControlError extends Error {
  constructor(message) {
    super(message);
    this.name = "CmsPublicationRuntimeControlError";
    this.code = "failed-precondition";
  }
}

function refuse(message) {
  throw new CmsPublicationRuntimeControlError(message);
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseCmsPublicationRuntimeControl(value) {
  if (
    !plainObject(value) ||
    Object.keys(value).length !== RUNTIME_FIELDS.size + (Object.hasOwn(value, "cloud") ? 1 : 0) ||
    Object.keys(value).some((field) => !RUNTIME_FIELDS.has(field) && field !== "cloud") ||
    value.schemaVersion !== RUNTIME_SCHEMA_VERSION ||
    !RUNTIME_PHASES.has(value.phase) ||
    !COMMIT_SHA.test(value.commitSha ?? "") ||
    !SERIALIZER_ID.test(value.serializerId ?? "")
  ) {
    refuse("The CMS publication runtime control is invalid");
  }
  if (Object.hasOwn(value, "cloud") && (!plainObject(value.cloud) ||
      Object.keys(value.cloud).length !== 3 ||
      Object.keys(value.cloud).some(field => !["phase", "commitSha", "serializerId"].includes(field)) ||
      !RUNTIME_PHASES.has(value.cloud.phase) || !COMMIT_SHA.test(value.cloud.commitSha ?? "") ||
      !CLOUD_SERIALIZERS.has(value.cloud.serializerId))) {
    refuse("The CMS publication runtime control is invalid");
  }
  return {
    schemaVersion: value.schemaVersion,
    phase: value.phase,
    commitSha: value.commitSha,
    serializerId: value.serializerId,
    ...(Object.hasOwn(value, "cloud") ? { cloud: { ...value.cloud } } : {}),
  };
}

// Older single-runtime documents keep their exact meaning. A split runtime
// uses the cloud identity only for cloud readiness; legacy claims stay primary.
function cloudCmsPublicationRuntimeControl(value) {
  const control = parseCmsPublicationRuntimeControl(value);
  return control.cloud ?? control;
}

function assertCmsPublicationCloudAdmission(control, { commitSha, serializerId }) {
  if (control === null) refuse("Cloud publication requires its runtime control");
  const cloud = cloudCmsPublicationRuntimeControl(control);
  if (!CLOUD_SERIALIZERS.has(cloud.serializerId) || cloud.phase !== "ready" || cloud.commitSha !== commitSha ||
      serializerId !== undefined && cloud.serializerId !== serializerId) {
    refuse("Cloud publication is paused or owned by another release");
  }
  return cloud;
}

function projectCmsPublicationRuntimeControl(snapshot) {
  if (
    !snapshot ||
    typeof snapshot.exists !== "boolean" ||
    typeof snapshot.data !== "function"
  ) {
    refuse("The CMS publication runtime control snapshot is invalid");
  }
  if (!snapshot.exists) return null;
  return parseCmsPublicationRuntimeControl(snapshot.data());
}

function cmsPublicationRuntimeRef(firestore) {
  if (!firestore || typeof firestore.collection !== "function") {
    refuse("Firestore is required for CMS publication runtime control");
  }
  return firestore.collection("system").doc(RUNTIME_DOCUMENT_ID);
}

async function readCmsPublicationRuntimeControlInTransaction({
  firestore,
  transaction,
}) {
  if (!transaction || typeof transaction.get !== "function") {
    refuse("A Firestore transaction is required for CMS publication runtime control");
  }
  const snapshot = await transaction.get(cmsPublicationRuntimeRef(firestore));
  return projectCmsPublicationRuntimeControl(snapshot);
}

async function assertCmsPublicationAdmissionInTransaction(input) {
  return assertCmsPublicationAdmission(
    await readCmsPublicationRuntimeControlInTransaction(input),
  );
}

async function assertSerializerPublicationAdmissionInTransaction(input) {
  await assertSerializerPublicationEnabledInTransaction(input);
  return assertCmsPublicationAdmissionInTransaction(input);
}

function assertCmsPublicationAdmission(control) {
  if (control !== null && control.phase !== "ready") {
    refuse("CMS publication is paused for a serializer handoff");
  }
  return control;
}

function assertCmsPublicationClaim(control, {
  commitSha,
  serializerId,
}) {
  if (control === null) return null;
  if (
    control.commitSha !== commitSha ||
    control.serializerId !== serializerId
  ) {
    refuse("Another CMS publication serializer owns this runtime");
  }
  return control;
}

module.exports = {
  CmsPublicationRuntimeControlError,
  RUNTIME_DOCUMENT_PATH,
  assertCmsPublicationAdmission,
  assertCmsPublicationAdmissionInTransaction,
  assertSerializerPublicationAdmissionInTransaction,
  assertCmsPublicationClaim,
  cmsPublicationRuntimeRef,
  parseCmsPublicationRuntimeControl,
  cloudCmsPublicationRuntimeControl,
  assertCmsPublicationCloudAdmission,
  projectCmsPublicationRuntimeControl,
  readCmsPublicationRuntimeControlInTransaction,
};
