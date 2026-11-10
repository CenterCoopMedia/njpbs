import { appendFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class CmsSmokeError extends Error { name = "CmsSmokeError"; }

// Scheduler metadata is verified after deployment by assertSchedulesReady in
// deploy-cms-function-batches.mjs; HTTP existence alone cannot prove a schedule.
const DEFAULT_FUNCTIONS_ORIGIN =
  "https://us-central1-njpbs-site.cloudfunctions.net";
const DEFAULT_CMS_API_BASE_URL = process.env.CMS_PRODUCTION_API_ORIGIN || "https://api.example.org";
const DEFAULT_ADMIN_ORIGIN = "https://admin.njpbs.org";

function declaredDevFunctionNames(root = new URL("../", import.meta.url)) {
  const require = createRequire(new URL("package.json", root));
  const { devFunctionManifest } = require("./functions/dev-manifest.js");
  return Object.keys(devFunctionManifest({ schemaVersion: 1, environment: "development", enabled: false })).sort();
}

export async function readVerifiedDevManifest(root = new URL("../", import.meta.url)) {
  const wake = JSON.parse(readFileSync(new URL("functions/cloud-publication-wake.generated.json", root), "utf8"));
  if (Object.keys(wake).sort().join() !== "enabled,environment,schemaVersion" ||
      wake.schemaVersion !== 1 || wake.environment !== "development" || wake.enabled !== false) {
    throw new Error("Dev smoke requires the exact default-off development wake artifact");
  }
  const names = declaredDevFunctionNames(root);
  if (READER_TRANSITION_FUNCTION_NAMES.some(name => !names.includes(name))) throw new Error("Dev smoke requires the complete reader family");
  // Firebase SDK discovery verifies the actual dev entry and every endpoint.
  const { loadFunctionDeployManifest } = await import("./lib/functions-deploy-inventory.mjs");
  loadFunctionDeployManifest(names, "njpbs-site-dev", root);
  return names;
}

export async function runDevCmsFunctionSmoke({ deployedFunctionNames, request = fetch } = {}) {
  if (!Array.isArray(deployedFunctionNames) ||
      [...deployedFunctionNames].sort().join() !== declaredDevFunctionNames().join()) {
    throw new Error("Dev smoke requires the verified complete dev manifest");
  }
  const result = await runFunctionSmoke({ baseUrl: "https://dev-api.example.org",
    functionsOrigin: "https://us-central1-njpbs-site-dev.cloudfunctions.net",
    adminOrigin: "https://dev-admin.example.org", deployedFunctionNames, request });
  const { checkDevAnonymousRefusal } = await import("./check-dev-anonymous-refusal.mjs");
  let adminChecks = 0;
  await checkDevAnonymousRefusal({ hosts: ["dev-admin.example.org"], fetchImpl: (...args) => {
    adminChecks += 1; return request(...args);
  } });
  return { checked: result.checked + adminChecks };
}

export const AUTHENTICATED_POST_FUNCTION_NAMES = Object.freeze([
  "cmsCuezStatus",
  "cmsCuezListDestinations",
  "cmsCuezPrepareExport",
  "cmsCuezSendExport",
  "cmsCuezOperationStatus",
  "cmsCuezListImportCandidates",
  "cmsCuezPreviewImport",
  "cmsCuezConfirmImport",
  "cmsCuezRetry",
  "cmsCuezReconcile",
  "grantRole",
  "revokeRole",
  "setStaffAccessLevel",
  "deactivateStaff",
  "reactivateStaff",
  "registerStaffProfile",
  "cmsSetNavigationPreferences",
  "submitStaffAccessRequest",
  // Password recovery is anonymous but still returns 401 without App Check.
  "requestStaffPasswordReset",
  "getStaffAccessStatus",
  "listStaffAccessRequests",
  "decideStaffAccessRequest",
  "cmsSaveContent",
  "cmsGetContent",
  "cmsPostTemplates",
  "cmsDatasets",
  "cmsElectionResultsSources",
  "cmsLiveProduction",
  "cmsRundownSource",
  "cmsRundownParser",
  "cmsRundownReview",
  "cmsLiveProductionAgent",
  "cmsLiveProductionDevices",
  "cmsGetBroadcastSchedule",
  "cmsGetNewsroomBanner",
  "cmsVoiceoverReview",
  "cmsGetVoiceoverAudio",
  "cmsGetSettings",
  "cmsGetCoverageLabels",
  "cmsPublishSettings",
  "cmsSaveSettings",
  "cmsCostLedger",
  "cmsListRevisions",
  "cmsGetRevision",
  "cmsRestoreRevision",
  "cmsTransitionContent",
  "cmsListContent",
  "cmsListMedia",
  "cmsListBinnedMedia",
  "cmsRestoreMedia",
  "cmsReplaceMediaBinary",
  "cmsListMediaSources",
  "cmsListSourceMedia",
  "cmsListMediaFavorites",
  "cmsSetMediaFavorite",
  "cmsSetMediaFavorites",
  "cmsListMediaCollections",
  "cmsListMediaCollectionItems",
  "cmsMutateMediaCollection",
  "cmsSetMediaCollectionItems",
  "cmsGetMediaReview",
  "cmsSaveMediaReview",
  "cmsListMediaComments",
  "cmsMutateMediaComment",
  "cmsCreateSourceMediaRead",
  "cmsSourceMediaOriginal",
  "cmsPublishSourceVideo",
  "cmsRequestVideoClip",
  "cmsGetVideoClip",
  "cmsCreateVideoClipRead",
  "cmsCancelVideoClip",
  "cmsRequestVideoTranscript",
  "cmsGetVideoTranscript",
  "cmsGetVideoSearchCorpus",
  "cmsCreateVideoTranscriptRead",
  "cmsSaveVideoTranscript",
  "cmsRequestVideoTranscriptAlignment",
  "cmsCancelVideoTranscriptAlignment",
  "cmsRequestVideoOrientationExport",
  "cmsListVideoOrientationExports",
  "cmsListTranscriptionCredentials",
  "cmsSaveTranscriptionCredential",
  "cmsDisconnectTranscriptionCredential",
  "cmsGetTranscriptionOptions",
  "cmsRequestByokVideoTranscript",
  "cmsListVideoTranscripts",
  "cmsStartSourceMediaUpload",
  "cmsSignSourceMediaUploadParts",
  "cmsResumeSourceMediaUpload",
  "cmsCompleteSourceMediaUpload",
  "cmsCancelSourceMediaUpload",
  "cmsGetSourceVideoReplacement",
  "cmsRollbackSourceVideoReplacement",
  "cmsDeleteSourceMedia",
  "cmsUpdateSourceMediaMetadata",
  "cmsListMediaUsage",
  "cmsListMediaCategories",
  "cmsMutateMediaCategory",
  "cmsUpdateMediaMetadata",
  "cmsCreateMediaDownload",
  "cmsUploadMedia",
  "cmsListUgcSubmissions",
  "cmsGetUgcSubmissionPreview",
  "cmsRejectUgcSubmission",
  "cmsImportUgcSubmission",
  "cmsSubmitBugReport",
  "cmsListBugReports",
  "cmsNudgeBugReport",
  "cmsGetBugReport",
  "cmsGetBugReportEvidence",
  "cmsListGithubIssues",
  "cmsGetGithubIssue",
  "cmsScanMediaUsage",
  "cmsBulkArchiveContent",
  "cmsAssignContent",
  "cmsListAudit",
  "cmsGetAnalytics",
  "cmsCollectBoardwalkUsage",
  "cmsGetBoardwalkUsage",
  "cmsPreview",
  "cmsPreviewStatus",
  "cmsPublish",
  "cmsRecheckPublication",
  "cmsGetAuthorProfile",
  "cmsUpdateAuthorProfile",
  "cmsSetAuthorProfileVisibility",
  "cmsListBylineAuthors",
  "cmsListAuthorPagePosts",
  "cmsListAuthorProfiles",
  "cmsAdminUpdateAuthorProfile",
]);

// Dedicated machine endpoints use their own worker secret, never staff credentials.
export const WORKER_FUNCTION_NAMES = Object.freeze([
  "videoTranscriptWorkerClaim", "videoTranscriptWorkerHeartbeat",
  "videoTranscriptWorkerComplete", "videoTranscriptWorkerFail",
]);

// Pairing can create state without staff auth; probe method rejection instead.
export const PREMIERE_FUNCTION_NAMES = Object.freeze([
  "cmsStartPremierePairing", "cmsApprovePremierePairing", "cmsPollPremierePairing",
  "cmsPremiereRequest", "cmsRevokePremiereSession",
]);

export const DEVICE_PAIRING_FUNCTION_NAMES = Object.freeze(["cmsPairLiveProductionDevice"]);

const CLOUD_WAKE_FUNCTION_NAMES = Object.freeze([
  "onNoBuildCloudState",
  "onNoBuildCloudCandidate",
  "onNoBuildCloudRelease",
]);
const BACKGROUND_FUNCTION_NAMES = Object.freeze([
  ...CLOUD_WAKE_FUNCTION_NAMES,
  "onDatasetRefresh",
  "onElectionResultsSourcePoll",
  "onCmsSaveWarmup",
  "onNavigationShareOwnerWrite",
  "onNoBuildPostConfirmation",
  "onNoBuildPostConfirmationRecovery",
  "onPublicVideoPostWithdrawal",
  "onPublicVideoPageWithdrawal",
  "onPublicVideoWithdrawalRecovery",
  "onScheduledPublish",
  "onStaffAccessEmailRetry",
  "onVideoSearchAssetWrite",
  "onVideoSearchShardWrite",
  "onVideoPreviewTick",
  "onSourceVideoReplacementTick",
  "onPrivateVideoAssetWrite",
  "onPrivateVideoCopyTick",
  "onVideoClipTick",
  "onVideoTranscriptTick",
  "onVideoTranscriptByokTick",
  "onStaffAccessNotificationCreated",
  "onBugReportDelivery",
  "onBugReportDeliveryCreated",
  "onBugReportGithubOutboxCreated",
  "onBugReportGithubSync",
  "onCostLedgerRefresh",
  "onMediaPurgeSweep",
]);

// Telegram calls this webhook directly. It is not a browser CMS API route and
// must stay absent from the public api.example.org route table.
export const WEBHOOK_FUNCTION_NAMES = Object.freeze([
  "githubBugReportWebhook",
  "telegramBugReportCallback",
]);

// These Functions are callable only by a private Cloudflare service-binding
// entrypoint. The public CMS API route table must not expose them.
const READER_TRANSITION_FUNCTION_NAMES = Object.freeze([
  "cmsReaderV1", "cmsReaderV2", "cmsReadPairCurrentCodeV2",
]);
export const PRIVATE_RPC_FUNCTION_NAMES = Object.freeze([
  ...READER_TRANSITION_FUNCTION_NAMES,
  "cmsGetPublicPage",
  "cmsValidateSiteAccess",
  "ugcGetConfig",
  "ugcStartSubmission",
  "ugcCompleteSubmission",
  "cmsGetPublishedPost",
]);

export const DEPLOYED_FUNCTION_NAMES = Object.freeze([
  "health",
  ...AUTHENTICATED_POST_FUNCTION_NAMES,
  ...PRIVATE_RPC_FUNCTION_NAMES,
  ...BACKGROUND_FUNCTION_NAMES,
  ...WEBHOOK_FUNCTION_NAMES,
  ...WORKER_FUNCTION_NAMES,
  ...PREMIERE_FUNCTION_NAMES,
  ...DEVICE_PAIRING_FUNCTION_NAMES,
]);

export function extractProductionExports(indexSource) {
  return [
    ...new Set(
      [
        ...indexSource.matchAll(/^exports\.([A-Za-z_$][\w$]*)\s*=/gm),
        ...indexSource.matchAll(/^lazyExport\(\s*["']([A-Za-z_$][\w$]*)["']/gm),
      ].map((match) => match[1]),
    ),
  ].sort();
}

export function assertProductionManifest(indexSource) {
  const actual = extractProductionExports(indexSource);
  const expected = new Set(DEPLOYED_FUNCTION_NAMES), actualSet = new Set(actual);
  const missing = [...expected].filter(name => !actualSet.has(name));
  const unexpected = actual.filter(name => !expected.has(name));
  if (missing.length || unexpected.length) {
    throw new CmsSmokeError(`CMS smoke manifest does not match functions/index.js (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"})`);
  }
}

function endpointUrl(baseUrl, endpoint) {
  return `${baseUrl}/${endpoint}`;
}

function assertProductionCmsApiBaseUrl(baseUrl) {
  if (baseUrl !== DEFAULT_CMS_API_BASE_URL) {
    throw new CmsSmokeError("CMS API URL must match CMS_PRODUCTION_API_ORIGIN");
  }
}

function commaSeparatedHeaderValues(headers, name) {
  const value = headers?.get?.(name);
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

async function expectStatus({
  request,
  url,
  init,
  expected,
  expectedHeaders = {},
  label,
}) {
  let response;
  try {
    response = await request(url, init);
  } catch {
    throw new CmsSmokeError(`${label} request failed`);
  }

  if (response.status !== expected) {
    throw new CmsSmokeError(
      `${label} returned ${response.status}; expected ${expected}`,
    );
  }

  for (const [name, requiredValues] of Object.entries(expectedHeaders)) {
    const actualValues = commaSeparatedHeaderValues(response.headers, name);
    for (const requiredValue of requiredValues) {
      if (!actualValues.includes(requiredValue.toLowerCase())) {
        throw new CmsSmokeError(
          `${label} missing ${name} value ${requiredValue}`,
        );
      }
    }
  }

  console.log(`${label}: ${response.status}`);
}

export async function runCmsFunctionSmoke({
  baseUrl = DEFAULT_CMS_API_BASE_URL,
  functionsOrigin = DEFAULT_FUNCTIONS_ORIGIN,
  adminOrigin = DEFAULT_ADMIN_ORIGIN,
  request = fetch,
} = {}) {
  assertProductionCmsApiBaseUrl(baseUrl);
  if (functionsOrigin !== DEFAULT_FUNCTIONS_ORIGIN || adminOrigin !== DEFAULT_ADMIN_ORIGIN) {
    throw new Error("Production smoke requires the exact production target tuple");
  }
  const result = await runFunctionSmoke({ baseUrl, functionsOrigin, adminOrigin, deployedFunctionNames: DEPLOYED_FUNCTION_NAMES, request });
  await expectStatus({ request, url: adminOrigin, init: { redirect: "manual" }, expected: 200,
    label: "public Admin authentication shell" });
  return { checked: result.checked + 1 };
}

async function runFunctionSmoke({ baseUrl, functionsOrigin, adminOrigin, deployedFunctionNames, request }) {
  const deployed = new Set(deployedFunctionNames);
  const authenticatedPostFunctions = AUTHENTICATED_POST_FUNCTION_NAMES.filter(name => deployed.has(name));
  let checked = 0;
  const check = async (probe) => {
    await expectStatus({ request, ...probe });
    checked += 1;
  };

  await check({
    url: endpointUrl(baseUrl, "health"),
    init: { redirect: "manual" },
    expected: 200,
    label: "health",
  });

  for (const endpoint of authenticatedPostFunctions) {
    const uploadBody = ["cmsUploadMedia", "cmsReplaceMediaBinary", "cmsSubmitBugReport"].includes(endpoint)
      ? new FormData()
      : null;
    if (endpoint === "cmsUploadMedia") uploadBody?.set("metadata", "{}");
    if (endpoint === "cmsSubmitBugReport") uploadBody?.set("report", "{}");
    await check({
      url: endpointUrl(baseUrl, endpoint),
      init: {
        method: "POST",
        redirect: "manual",
        headers: {
          ...(uploadBody ? {} : { "content-type": "application/json" }),
          origin: adminOrigin,
        },
        body: uploadBody ?? "{}",
      },
      expected: 401,
      label: `${endpoint} unauthenticated POST`,
    });
  }

  for (const endpoint of authenticatedPostFunctions) {
    await check({
      url: endpointUrl(functionsOrigin, endpoint),
      init: {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          origin: adminOrigin,
        },
        body: "{}",
      },
      expected: 403,
      label: `${endpoint} direct-origin refusal`,
    });
  }

  for (const endpoint of WORKER_FUNCTION_NAMES.filter(name => deployed.has(name))) {
    await check({
      url: endpointUrl(baseUrl, endpoint),
      init: { method: "POST", redirect: "manual", headers: { "content-type": "application/json" }, body: "{}" },
      expected: 401,
      label: `${endpoint} unauthenticated worker refusal`,
    });
    await check({
      url: endpointUrl(functionsOrigin, endpoint),
      init: { method: "POST", redirect: "manual", headers: { "content-type": "application/json" }, body: "{}" },
      expected: 403,
      label: `${endpoint} direct-origin refusal`,
    });
  }

  for (const endpoint of [...PREMIERE_FUNCTION_NAMES, ...DEVICE_PAIRING_FUNCTION_NAMES].filter(name => deployed.has(name))) {
    await check({
      url: endpointUrl(baseUrl, endpoint),
      init: { method: "GET", redirect: "manual", headers: { origin: adminOrigin } },
      expected: 405,
      label: `${endpoint} GET refusal`,
    });
    await check({
      url: endpointUrl(functionsOrigin, endpoint),
      init: {
        method: "POST", redirect: "manual",
        headers: { "content-type": "application/json", origin: adminOrigin }, body: "{}",
      },
      expected: 403,
      label: `${endpoint} direct-origin refusal`,
    });
  }

  for (const endpoint of PRIVATE_RPC_FUNCTION_NAMES.filter(name => deployed.has(name))) {
    if (endpoint === "cmsGetPublishedPost") {
      await check({
        url: endpointUrl(functionsOrigin, `${endpoint}/posts/nj-pbs-announces-six-staff-appointments/`),
        init: { method: "GET", redirect: "manual" },
        expected: 403,
        label: `${endpoint} unsigned published read refusal`,
      });
      continue;
    }
    await check({
      url: endpointUrl(functionsOrigin, endpoint),
      init: {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
      expected: 403,
      label: `${endpoint} direct-origin refusal`,
    });
  }

  await check({
    url: endpointUrl(baseUrl, "deactivateStaff"),
    init: { method: "GET", redirect: "manual" },
    expected: 405,
    label: "deactivateStaff GET",
  });
  await check({
    url: endpointUrl(baseUrl, "deactivateStaff"),
    init: {
      method: "OPTIONS",
      redirect: "manual",
      headers: {
        "access-control-request-headers": "authorization,content-type",
        "access-control-request-method": "POST",
        origin: adminOrigin,
      },
    },
    expected: 204,
    expectedHeaders: {
      "access-control-allow-headers": ["authorization", "content-type"],
      "access-control-allow-methods": ["POST"],
      "access-control-allow-origin": [adminOrigin],
    },
    label: "deactivateStaff preflight",
  });
  if (deployed.has("submitStaffAccessRequest")) {
    await check({
      url: endpointUrl(baseUrl, "submitStaffAccessRequest"),
      init: {
        method: "OPTIONS",
        redirect: "manual",
        headers: {
          "access-control-request-headers":
            "authorization,content-type,x-firebase-appcheck",
          "access-control-request-method": "POST",
          origin: adminOrigin,
        },
      },
      expected: 204,
      expectedHeaders: {
        "access-control-allow-headers": [
          "authorization",
          "content-type",
          "x-firebase-appcheck",
        ],
        "access-control-allow-methods": ["POST"],
        "access-control-allow-origin": [adminOrigin],
      },
      label: "submitStaffAccessRequest preflight",
    });
  }
  if (deployed.has("cmsUploadMedia")) {
    await check({
      url: endpointUrl(baseUrl, "cmsUploadMedia"),
      init: {
        method: "OPTIONS",
        redirect: "manual",
        headers: {
          "access-control-request-headers": "authorization,content-type",
          "access-control-request-method": "POST",
          origin: adminOrigin,
        },
      },
      expected: 204,
      expectedHeaders: {
        "access-control-allow-headers": ["authorization", "content-type"],
        "access-control-allow-methods": ["POST"],
        "access-control-allow-origin": [adminOrigin],
      },
      label: "cmsUploadMedia preflight",
    });
  }
  if (deployed.has("cmsSubmitBugReport")) {
    await check({
      url: endpointUrl(baseUrl, "cmsSubmitBugReport"),
      init: {
        method: "OPTIONS",
        redirect: "manual",
        headers: {
          "access-control-request-headers": "authorization,content-type",
          "access-control-request-method": "POST",
          origin: adminOrigin,
        },
      },
      expected: 204,
      expectedHeaders: {
        "access-control-allow-headers": ["authorization", "content-type"],
        "access-control-allow-methods": ["POST"],
        "access-control-allow-origin": [adminOrigin],
      },
      label: "cmsSubmitBugReport preflight",
    });
  }
  return { checked };
}

function parseArguments(args) {
  let manifestOnly = false;
  let liveOnly = false;
  let indexPath = null;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--manifest-only") {
      manifestOnly = true;
    } else if (argument === "--live-only") {
      liveOnly = true;
    } else if (argument === "--index") {
      index += 1;
      indexPath = args[index] ?? null;
      if (!indexPath) throw new CmsSmokeError("--index requires a file path");
    } else {
      throw new CmsSmokeError("Unknown smoke argument");
    }
  }

  if (manifestOnly && liveOnly) {
    throw new CmsSmokeError("--manifest-only and --live-only cannot be combined");
  }

  return { indexPath, liveOnly, manifestOnly };
}

export async function main(argv = process.argv.slice(2)) {
  const scriptPath = fileURLToPath(import.meta.url);
  const repoRoot = dirname(dirname(scriptPath));
  const { indexPath, liveOnly, manifestOnly } = parseArguments(argv);

  if (!liveOnly || indexPath) {
    const resolvedIndexPath = indexPath
      ? resolve(indexPath)
      : join(repoRoot, "functions/index.js");
    const indexSource = readFileSync(resolvedIndexPath, "utf8");
    assertProductionManifest(indexSource);
    if (manifestOnly && process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `function_targets=${extractProductionExports(indexSource).map(name => `functions:${name}`).join(",")}\n`);
    }
    console.log("CMS production export manifest: matched");
  }

  if (!manifestOnly) {
    await runCmsFunctionSmoke({
      baseUrl:
        process.env.VITE_FUNCTIONS_BASE_URL ?? DEFAULT_CMS_API_BASE_URL,
    });
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof CmsSmokeError ? `CMS deployment smoke failed: ${error.message}` : "CMS deployment smoke did not complete");
    process.exitCode = 1;
  });
}
