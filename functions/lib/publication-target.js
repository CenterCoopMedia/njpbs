"use strict";

// The development values match the existing dev publication and preview
// contracts. Selecting a target never provisions it or changes admission.
const TARGETS = Object.freeze({
  production: Object.freeze({ environment: "production", projectId: "njpbs-site",
    workerName: "njpbs-production", origin: "https://njpbs.org",
    publisherWorker: "njpbs-cms-publisher", publisherOrigin: "https://publisher-health.njpbs.org",
    serializerId: "cloudflare-publisher",
    publicationBucket: "njpbs-cms-publication", previewBucket: "njpbs-cms-previews",
    backgroundBucket: "njpbs-public-artifacts" }),
  development: Object.freeze({ environment: "development", projectId: "njpbs-site-dev",
    workerName: "template-dev-public", origin: "https://dev-public.example.org",
    publisherWorker: "njpbs-dev-cms-publisher", publisherOrigin: "https://dev-publisher-health.njpbs.org",
    serializerId: "cloudflare-dev-publisher",
    publicationBucket: "njpbs-dev-cms-publication", previewBucket: "template-dev-cms-previews",
    backgroundBucket: "njpbs-dev-public-artifacts" }),
});

function publicationTarget(environment = "production") {
  if (!Object.hasOwn(TARGETS, environment)) throw new Error("Invalid publication environment");
  return TARGETS[environment];
}
function assertPublicationTarget(value) {
  const expected = publicationTarget(value?.environment);
  if (!value || Object.keys(value).length !== Object.keys(expected).length ||
      Object.keys(expected).some(key => value[key] !== expected[key])) {
    throw new Error("Refusing a mixed publication target");
  }
  return expected;
}
function assertPublicationDatabase(firestore, target) {
  const expected = assertPublicationTarget(target);
  if (firestore?.projectId !== expected.projectId) throw new Error("Refusing a mixed publication database");
}
function publicationPostCacheTag(target, slug) {
  const expected = assertPublicationTarget(target);
  if (typeof slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 1000) {
    throw new Error("Invalid Post cache route");
  }
  return `${expected.environment === "development" ? "njpbs-dev-post" : "njpbs-post"}-${slug}`;
}
module.exports = { publicationTarget, assertPublicationTarget, assertPublicationDatabase, publicationPostCacheTag };
