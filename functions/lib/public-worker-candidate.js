"use strict";

const { candidateNoBuildPageContract } = require("./no-build-page-ownership");

const { runtimeFields, assertRuntimeSource } = require("./publication-runtime-owner");
const { candidateNoBuildContract, candidateSupportsPost } = require("./no-build-post-state");
const { isDeepStrictEqual } = require("node:util");
const { publicationTarget, assertPublicationTarget, assertPublicationDatabase } = require("./publication-target");
const {
  PUBLIC_DEPLOYMENT_SCHEMA_VERSION,
  PublicDeploymentStateError,
  isCommitSha,
  isPublicDeploymentIdentifier,
  timestampMillis,
} = require("./public-deployment");

const PUBLIC_WORKER_NAME = "njpbs-production";
const PUBLIC_WORKER_CANDIDATE_SCHEMA_VERSION = 1;
const CLOUDFLARE_UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const DIGEST = /^[a-f0-9]{64}$/;
const WRANGLER_VERSION = /^4\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const RFC3339_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/;
const MAX_PUBLIC_WORKER_ARTIFACT_FILES = 100_000;
const MAX_PUBLIC_WORKER_ARTIFACT_BYTES = 100 * 1024 * 1024 * 1024;
const INPUT_FIELDS = new Set([
  "schemaVersion",
  "buildBatchId",
  "generation",
  "commitSha",
  "workerName",
  "workerVersionId",
  "workerVersionTag",
  "versionCreatedOn",
  "artifactDigest",
  "artifactReceiptDigest",
  "publicationReceiptDigest",
  "mediaManifestDigest",
  "artifactFileCount",
  "artifactBytes",
  "wranglerVersion",
]);
const STORED_FIELDS = new Set([...INPUT_FIELDS, "recordedAt"]);

function stateError(message) {
  throw new PublicDeploymentStateError(message);
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactFields(value, fields) {
  return (
    plainObject(value) &&
    Object.keys(value).length >= fields.size &&
    [...fields].every(field => Object.hasOwn(value, field)) &&
    Object.keys(value).every((field) => fields.has(field) || ["noBuildPost", "noBuildPage", "noBuildRecord", "noBuildStatic", "runtime"].includes(field))
  );
}

function validCalendarDateTime(match) {
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= days[month - 1] &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

function canonicalDate(value) {
  const match = typeof value === "string" ? RFC3339_DATE_TIME.exec(value) : null;
  if (match === null || !validCalendarDateTime(match)) {
    stateError("The public Worker candidate timestamp is invalid");
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    stateError("The public Worker candidate timestamp is invalid");
  }
  return new Date(millis).toISOString();
}

function publicWorkerCandidateTag({ generation, artifactDigest }) {
  if (
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    !DIGEST.test(artifactDigest)
  ) {
    stateError("The public Worker candidate tag input is invalid");
  }
  return `cms-g${generation}-${artifactDigest.slice(0, 16)}`;
}

function publicWorkerCandidateMessage({
  buildBatchId,
  generation,
  commitSha,
  artifactDigest,
  publicationReceiptDigest,
  mediaManifestDigest,
}) {
  if (
    !isPublicDeploymentIdentifier(buildBatchId) ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    !isCommitSha(commitSha) ||
    !DIGEST.test(artifactDigest) ||
    !DIGEST.test(publicationReceiptDigest) ||
    !DIGEST.test(mediaManifestDigest)
  ) {
    stateError("The public Worker candidate message input is invalid");
  }
  return [
    "cms-public-candidate-v1",
    `batch=${buildBatchId}`,
    `generation=${generation}`,
    `commit=${commitSha}`,
    `artifact=${artifactDigest}`,
    `publication=${publicationReceiptDigest}`,
    `manifest=${mediaManifestDigest}`,
  ].join(" ");
}

function assertPublicWorkerCandidateDatabase(firestore, target) {
  if (target === undefined) return;
  const expected = assertPublicationTarget(target);
  const emulator = /^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") &&
    /^demo-[a-z0-9-]+$/.test(firestore?.projectId ?? "");
  if (!emulator) assertPublicationDatabase(firestore, expected);
}

function projectCloudflareWorkerVersion(value, { tag, message, target = publicationTarget() } = {}) {
  target = assertPublicationTarget(target);
  const annotations = value?.annotations;
  const metadata = value?.metadata;
  const resources = value?.resources;
  const bindings = resources?.bindings;
  const hasAssets = Array.isArray(bindings) && bindings.some(
    (binding) => binding?.name === "ASSETS" && binding?.type === "assets",
  );
  const cmsApiBindings = Array.isArray(bindings) ? bindings.filter(binding => binding?.name === "CMS_API") : [];
  const hasCmsApi = cmsApiBindings.length === 1 && cmsApiBindings.some(
    (binding) =>
      binding?.name === "CMS_API" &&
      binding?.type === "service" &&
      binding?.service === (target.environment === "development" ? "template-dev-cms-api" : "njpbs-cms-api") &&
      binding?.entrypoint === "PublicContentEntrypoint",
  );
  if (
    !plainObject(value) ||
    !CLOUDFLARE_UUID.test(value.id) ||
    !plainObject(metadata) ||
    metadata.source !== "wrangler" ||
    !plainObject(annotations) ||
    annotations["workers/tag"] !== tag ||
    annotations["workers/message"] !== message ||
    annotations["workers/triggered_by"] !== "version_upload" ||
    !plainObject(resources) ||
    !plainObject(resources.script) ||
    !plainObject(resources.script_runtime) ||
    !plainObject(resources.script_runtime.assets) ||
    !hasAssets ||
    !hasCmsApi
  ) {
    stateError("The uploaded public Worker version receipt is invalid");
  }
  if (target.environment === "development" &&
      (![3, 4, 5, 6, 7, 8, 9, 10, 11].includes(bindings.length) || new Set(bindings.map(binding => binding?.name)).size !== bindings.length ||
        !bindings.every(binding => ["ASSETS", "CMS_API", "NO_BUILD_POST_RENDERER_SHA", "NO_BUILD_PAGE_RENDERER_SHA", "NO_BUILD_CODE_POST_RENDERER_SHA", "NO_BUILD_RECORD_RENDERER_SHA", "DATA_FIGURE_VERSION", "ELECTION_RESULTS_VERSION", "LIVE_BLOG_VERSION", "DATA_HUB_PUBLIC", "DATA_HUB_COMPOSITION_VERSION", "DURABLE_POST_WITHDRAWALS"].includes(binding?.name)) ||
        bindings.some(binding => binding.name === "DURABLE_POST_WITHDRAWALS" &&
          (binding.type !== "r2_bucket" || binding.bucket_name !== "njpbs-dev-cms-publication")))) {
    stateError("The dev candidate reader bindings are invalid");
  }
  const variable = name => {
    const matches = bindings.filter(binding => binding?.name === name);
    if (!matches.length) return undefined;
    if (matches.length !== 1 || matches[0].type !== "plain_text" || typeof matches[0].text !== "string") {
      stateError("The candidate reader metadata is invalid");
    }
    return matches[0].text;
  };
  const families = target.environment === "development" ? "posts" : variable("NO_BUILD_POST_FAMILIES");
  if (families !== undefined && families !== "posts") stateError("The candidate Post family metadata is invalid");
  const electionResultsMarker = variable("ELECTION_RESULTS_VERSION");
  if (electionResultsMarker !== undefined && !["0", "1", "2"].includes(electionResultsMarker)) stateError("The candidate election results metadata is invalid");
  const electionResultsVersion = ["1", "2"].includes(electionResultsMarker) ? Number(electionResultsMarker) : undefined;
  const dataFigureMarker = variable("DATA_FIGURE_VERSION");
  if (dataFigureMarker !== undefined && dataFigureMarker !== "1") stateError("The candidate data figure metadata is invalid");
  const dataFigureVersion = dataFigureMarker === "1" ? 1 : undefined;
  const liveBlogMarker = variable("LIVE_BLOG_VERSION");
  if (liveBlogMarker !== undefined && !["0", "1"].includes(liveBlogMarker)) stateError("The candidate live blog metadata is invalid");
  const liveBlogVersion = liveBlogMarker === "1" ? 1 : undefined;
  // New family metadata takes precedence over retained pilot variables.
  // Runtime admission is read from authority, never from these version fields.
  const postId = families === undefined ? variable("NO_BUILD_POST_ID") : undefined;
  let noBuildPost;
  if (families !== undefined || postId) {
    const assets = resources.script_runtime.assets;
    // Version receipts expose the uploaded setting as raw_run_worker_first.
    const paths = assets.config?.run_worker_first ?? assets.run_worker_first ?? assets.raw_run_worker_first;
    const requiredPaths = ["/posts", "/posts/*", "/authors", "/authors/*", "/feeds/*", "/api/v1/*", "/sitemap*", "/pagefind/*", "/search/*", "/_content-status.json"];
    if (families === "posts") requiredPaths.unshift("/");
    if (paths !== true && (!Array.isArray(paths) || !requiredPaths.every(path => paths.includes(path)))) {
      stateError("The candidate does not preserve instant Post paths");
    }
    const rendererSha = variable("NO_BUILD_POST_RENDERER_SHA");
    noBuildPost = candidateNoBuildContract(families === "posts"
      ? { schemaVersion: 2, families: ["posts"], rendererSha, enabled: true, authoritative: true,
        ...(dataFigureVersion ? { dataFigureVersion } : {}),
        ...(electionResultsVersion ? { electionResultsVersion } : {}),
        ...(liveBlogVersion ? { liveBlogVersion } : {}) }
      : { schemaVersion: 1, postId, rendererSha, enabled: variable("NO_BUILD_POST_ENABLED") === "true", authoritative: true,
        ...(dataFigureVersion ? { dataFigureVersion } : {}),
        ...(electionResultsVersion ? { electionResultsVersion } : {}),
        ...(liveBlogVersion ? { liveBlogVersion } : {}) });
  }
  const dataHubMarker = variable("DATA_HUB_PUBLIC");
  if (dataHubMarker !== undefined && !["0","1"].includes(dataHubMarker)) stateError("Invalid Data Hub gate metadata");
  const dataHubComposition = variable("DATA_HUB_COMPOSITION_VERSION");
  if (dataHubComposition !== undefined && (!["0", "1"].includes(dataHubComposition) ||
      dataHubComposition === "1" && dataHubMarker !== "1")) stateError("Invalid Data Hub composition metadata");
  const pageRendererSha = variable("NO_BUILD_PAGE_RENDERER_SHA");
  let noBuildPage;
  if (pageRendererSha !== undefined) {
    const assets = resources.script_runtime.assets;
    const paths = assets.config?.run_worker_first ?? assets.run_worker_first ?? assets.raw_run_worker_first;
    if (paths !== true) stateError("The Page candidate must intercept every retained Page route");
    noBuildPage = candidateNoBuildPageContract({ schemaVersion: 1, rendererSha: pageRendererSha, enabled: true,
      authoritative: true, ...(dataHubMarker === "1" ? { dataHubReportingVersion: 1 } : {}),
      ...(dataHubComposition === "1" ? { dataHubCompositionVersion: 1 } : {}), ...(dataFigureVersion ? { dataFigureVersion } : {}),
      ...(electionResultsVersion ? { electionResultsVersion } : {}) });
  }
  const recordRendererSha = variable("NO_BUILD_RECORD_RENDERER_SHA");
  let noBuildRecord;
  if (recordRendererSha) {
    const assets = resources.script_runtime.assets;
    if ((assets.config?.run_worker_first ?? assets.run_worker_first ?? assets.raw_run_worker_first) !== true) {
      stateError("The record candidate must intercept every retained record route");
    }
    noBuildRecord = require("./no-build-record-capability").candidateNoBuildRecordContract({ schemaVersion: 1,
      rendererSha: recordRendererSha, enabled: true, authoritative: true, families: ["programs", "events"] });
  }
  if (liveBlogVersion && !noBuildPost) stateError("The candidate live blog renderer has no Post reader");
  if (electionResultsVersion && !noBuildPost && !noBuildPage) stateError("The candidate election results renderer has no public reader");
  if (dataFigureVersion && !noBuildPost && !noBuildPage) stateError("The candidate data figure renderer has no public reader");
  return Object.freeze({
    ...(noBuildPage ? { noBuildPage } : {}),
    ...(noBuildRecord ? { noBuildRecord } : {}),
    ...(noBuildPost ? { noBuildPost } : {}),
    workerVersionId: value.id.toLowerCase(),
    versionCreatedOn: canonicalDate(metadata.created_on),
  });
}

function workerVersionIdFromWranglerOutput(value) {
  if (typeof value !== "string") {
    stateError("The Wrangler version upload receipt is invalid");
  }
  const matches = [...value.matchAll(
    /Worker Version ID:\s*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/gi,
  )].map((match) => match[1].toLowerCase());
  if (matches.length !== 1) {
    stateError("The Wrangler version upload receipt is invalid");
  }
  return matches[0];
}

function projectPublicWorkerCandidateInput(value, { target = publicationTarget() } = {}) {
  target = assertPublicationTarget(target);
  if (
    !hasExactFields(value, INPUT_FIELDS) ||
    value.schemaVersion !== PUBLIC_WORKER_CANDIDATE_SCHEMA_VERSION ||
    !isPublicDeploymentIdentifier(value.buildBatchId) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !isCommitSha(value.commitSha) ||
    value.workerName !== target.workerName ||
    !CLOUDFLARE_UUID.test(value.workerVersionId) ||
    value.workerVersionTag !== publicWorkerCandidateTag(value) ||
    !DIGEST.test(value.artifactDigest) ||
    !DIGEST.test(value.artifactReceiptDigest) ||
    !DIGEST.test(value.publicationReceiptDigest) ||
    !DIGEST.test(value.mediaManifestDigest) ||
    !Number.isSafeInteger(value.artifactFileCount) ||
    value.artifactFileCount < 1 ||
    value.artifactFileCount > MAX_PUBLIC_WORKER_ARTIFACT_FILES ||
    !Number.isSafeInteger(value.artifactBytes) ||
    value.artifactBytes < 1 ||
    value.artifactBytes > MAX_PUBLIC_WORKER_ARTIFACT_BYTES ||
    !WRANGLER_VERSION.test(value.wranglerVersion)
  ) {
    stateError("The public Worker candidate is invalid");
  }
  const noBuildPost = candidateNoBuildContract(value.noBuildPost);
  const noBuildRecord = require("./no-build-record-capability").candidateNoBuildRecordContract(value.noBuildRecord);
  if (noBuildRecord && noBuildRecord.rendererSha !== value.commitSha) stateError("The record renderer does not match its candidate");
  const noBuildPage = candidateNoBuildPageContract(value.noBuildPage);
  if (noBuildPage && noBuildPage.rendererSha !== value.commitSha) stateError("The Page renderer does not match its candidate");
  if (value.noBuildStatic !== undefined) {
    require("./no-build-post-static-return").projectStaticProof(value.noBuildStatic);
    if (!candidateSupportsPost(noBuildPost, value.noBuildStatic.postId)) stateError("The static Post proof has no matching authoritative reader");
  }
  if (noBuildPost && noBuildPost.rendererSha !== value.commitSha) stateError("The Post renderer does not match its candidate");
  if (value.runtime !== undefined) assertRuntimeSource(value.runtime, value.commitSha);
  return Object.freeze({
    ...runtimeFields(value.runtime),
    schemaVersion: value.schemaVersion,
    buildBatchId: value.buildBatchId,
    generation: value.generation,
    commitSha: value.commitSha,
    workerName: value.workerName,
    workerVersionId: value.workerVersionId.toLowerCase(),
    workerVersionTag: value.workerVersionTag,
    versionCreatedOn: canonicalDate(value.versionCreatedOn),
    artifactDigest: value.artifactDigest,
    artifactReceiptDigest: value.artifactReceiptDigest,
    publicationReceiptDigest: value.publicationReceiptDigest,
    mediaManifestDigest: value.mediaManifestDigest,
    artifactFileCount: value.artifactFileCount,
    artifactBytes: value.artifactBytes,
    wranglerVersion: value.wranglerVersion,
    ...(noBuildPost ? { noBuildPost } : {}),
    ...(noBuildPage ? { noBuildPage } : {}),
    ...(noBuildRecord ? { noBuildRecord } : {}),
    ...(value.noBuildStatic === undefined ? {} : { noBuildStatic: require("./no-build-post-static-return").projectStaticProof(value.noBuildStatic) }),
  });
}

function projectPublicWorkerCandidate(value, expectedBuildBatchId = null, { target } = {}) {
  if (
    !hasExactFields(value, STORED_FIELDS) ||
    timestampMillis(value.recordedAt) === null
  ) {
    stateError("The stored public Worker candidate is invalid");
  }
  const projected = projectPublicWorkerCandidateInput(
    Object.fromEntries(
      Object.entries(value).filter(([field]) => field !== "recordedAt"),
    ),
    { target },
  );
  if (
    expectedBuildBatchId !== null &&
    projected.buildBatchId !== expectedBuildBatchId
  ) {
    stateError("The stored public Worker candidate belongs to another build");
  }
  return Object.freeze({ ...projected, recordedAt: value.recordedAt });
}

function assertPublicWorkerCandidateMatchesBatch(candidateValue, batch, { target } = {}) {
  const candidate = projectPublicWorkerCandidate(
    candidateValue,
    batch?.buildBatchId ?? null,
    { target },
  );
  if (
    batch?.schemaVersion !== PUBLIC_DEPLOYMENT_SCHEMA_VERSION ||
    candidate.generation !== batch.generation ||
    candidate.commitSha !== batch.commitSha ||
    !isDeepStrictEqual(candidate.runtime, batch.runtime)
  ) {
    stateError("The public Worker candidate does not match its build batch");
  }
  return candidate;
}

function samePublicWorkerCandidate(left, right, { target } = {}) {
  const projectedLeft = projectPublicWorkerCandidateInput(left, { target });
  const projectedRight = projectPublicWorkerCandidateInput(right, { target });
  return isDeepStrictEqual(projectedLeft, projectedRight);
}

module.exports = {
  MAX_PUBLIC_WORKER_ARTIFACT_BYTES,
  MAX_PUBLIC_WORKER_ARTIFACT_FILES,
  PUBLIC_WORKER_CANDIDATE_SCHEMA_VERSION,
  PUBLIC_WORKER_NAME,
  assertPublicWorkerCandidateMatchesBatch,
  assertPublicWorkerCandidateDatabase,
  projectPublicWorkerCandidate,
  projectPublicWorkerCandidateInput,
  projectCloudflareWorkerVersion,
  publicWorkerCandidateMessage,
  publicWorkerCandidateTag,
  samePublicWorkerCandidate,
  workerVersionIdFromWranglerOutput,
};
