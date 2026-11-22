"use strict";

const NAMESPACE_PATH = "system/publicDeployment/noBuildRecordFamilies/current";
const CONTEXT_OUTPUTS = ["listings", "authors", "feed", "contentApi", "sitemap", "search"];
const RECORD_FAMILIES = ["programs", "events"];
const VIDEO_CATALOG_OUTPUT = "videoCatalog";
const CHECKPOINT_FAMILIES = [...RECORD_FAMILIES, VIDEO_CATALOG_OUTPUT];
// Search generations and their reference manifests share this bound.
const SEARCH_FILES_MAX = 4096;
function refuse() { throw Object.assign(new Error("Record namespace ownership is unavailable."), { status: 409 }); }
function recordFamilies(value = []) {
  if (!Array.isArray(value) || value.length > 2 || new Set(value).size !== value.length ||
      value.some(family => !RECORD_FAMILIES.includes(family))) refuse();
  return RECORD_FAMILIES.filter(family => value.includes(family));
}
function validContextOutputs(outputs) {
  return Array.isArray(outputs) && outputs.length <= CONTEXT_OUTPUTS.length + CHECKPOINT_FAMILIES.length &&
    JSON.stringify(outputs) === JSON.stringify([...CONTEXT_OUTPUTS, ...CHECKPOINT_FAMILIES.filter(family => outputs.includes(family))]);
}

function recordOutputForPath(path) {
  return typeof path !== "string" ? null : /^\/(programs|shows)(?:\/|$)/.test(path) ? "programs"
    : /^\/events(?:\/|$)/.test(path) ? "events" : null;
}
function outputLimits(output) {
  return CHECKPOINT_FAMILIES.includes(output) ? { files: 4096, bytes: 64 * 1024 * 1024 }
    : output === "search" ? { files: SEARCH_FILES_MAX, bytes: 16 * 1024 * 1024 }
    : { files: 256, bytes: 16 * 1024 * 1024 };
}
const CHECKPOINT_FILES_MAX = 6 * 256 + SEARCH_FILES_MAX + CHECKPOINT_FAMILIES.length * 4096 + 8;
const CHECKPOINT_MANIFEST_BYTES_MAX = 16 * 1024 * 1024;
const CHECKPOINT_BYTES_MAX = (7 * 16 + CHECKPOINT_FAMILIES.length * 64) * 1024 * 1024;
function contextOutputs(identity) {
  return [...CONTEXT_OUTPUTS, ...recordFamilies(identity?.recordFamilies), ...(identity?.videoCatalog === true ? [VIDEO_CATALOG_OUTPUT] : [])];
}
async function readRecordNamespace({ firestore, transaction }) {
  const ref = firestore.doc(NAMESPACE_PATH);
  const row = await (transaction ? transaction.get(ref) : ref.get());
  const value = row.data();
  if (!row.exists) return { ref, families: [] };
  if (!value || Object.keys(value).length !== 2 || value.schemaVersion !== 1 || !Object.hasOwn(value, "families")) refuse();
  return { ref, families: recordFamilies(value.families) };
}
async function recordFamilyRegistered({ firestore, transaction, family }) {
  const namespace = await readRecordNamespace({ firestore, transaction });
  if (namespace.families.includes(family)) return true;
  const owners = await transaction.get(firestore.collection("system/publicDeployment/noBuildRecordOwners").where("family", "==", family).limit(1));
  if (!owners.empty) refuse();
  return false;
}
/** The existing context transaction registers a complete namespace once. It
 * stays owned after pause or removal of its final visible record. */
async function prepareRecordNamespace({ firestore, transaction, family }) {
  if (family !== undefined && !RECORD_FAMILIES.includes(family)) refuse();
  const before = await readRecordNamespace({ firestore, transaction });
  const families = recordFamilies([...new Set([...before.families, ...(family ? [family] : [])])]);
  return { families, outputs: contextOutputs({ recordFamilies: families }), write() {
    if (family && !before.families.includes(family)) transaction.set(before.ref, { schemaVersion: 1, families });
  } };
}
module.exports = { NAMESPACE_PATH, CONTEXT_OUTPUTS, RECORD_FAMILIES, CHECKPOINT_FAMILIES, VIDEO_CATALOG_OUTPUT, recordFamilies, contextOutputs,
  readRecordNamespace, prepareRecordNamespace, validContextOutputs, recordOutputForPath, outputLimits,
  CHECKPOINT_FILES_MAX, CHECKPOINT_BYTES_MAX, CHECKPOINT_MANIFEST_BYTES_MAX, recordFamilyRegistered, SEARCH_FILES_MAX };
