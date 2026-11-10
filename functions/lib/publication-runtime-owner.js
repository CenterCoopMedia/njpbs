"use strict";

// Missing ownership belongs to the retained node-compute runtime only. An explicit
// release is immutable for the life of a job, including retries and settlement.
function publicationRuntime(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 2 || !["node-compute", "cloudflare"].includes(value.owner) ||
      !/^[a-f0-9]{40}$/.test(value.release ?? "")) {
    throw new Error("The publication runtime identity is invalid");
  }
  return { owner: value.owner, release: value.release };
}
function runtimeFields(value) {
  return value === undefined ? {} : { runtime: publicationRuntime(value) };
}
function ownsPublication(record, runtime) {
  const requested = publicationRuntime(runtime);
  if (record.runtime === undefined) return requested.owner === "node-compute";
  const stored = publicationRuntime(record.runtime);
  return stored.owner === requested.owner && stored.release === requested.release;
}
// A completed or superseded generation can spawn new work for the same owner.
// Callers must separately prove the new release against the active deployment.
function samePublicationOwner(record, runtime) {
  const requested = publicationRuntime(runtime);
  return record.runtime === undefined ? requested.owner === "node-compute" :
    publicationRuntime(record.runtime).owner === requested.owner;
}
function assertPublicationOwner(record, runtime) {
  if (!ownsPublication(record, runtime)) throw new Error("Another publication runtime owns this job");
}
function assertRuntimeSource(runtime, commitSha) {
  if (publicationRuntime(runtime).release !== commitSha) throw new Error("The publication runtime source conflicts");
}
module.exports = { publicationRuntime, runtimeFields, ownsPublication, samePublicationOwner, assertPublicationOwner, assertRuntimeSource };
