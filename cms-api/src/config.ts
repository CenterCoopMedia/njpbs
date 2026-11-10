export type RateClass =
  | "liveProductionConnect"
  | "liveProduction"
  | "staffSite"
  | "read"
  | "sourcePosters"
  | "videoSearchManifest"
  | "mutation"
  | "metadata"
  | "usage"
  | "usageReport"
  | "transcription"
  | "lifecycle"
  | "upload"
  | "imageUpload"
  | "multipartControl"
  | "report"
  | "preview"
  | "publish"
  | "liveBlogUpdate"
  | "worker"
  | "accountRequest"
  | "accountRecovery"
  | "desktopPairingStart"
  | "desktopPairingPoll"
  | "desktop";

export interface EndpointPolicy {
  contentType: "json" | "multipart";
  maxBytes: number;
  rateClass: RateClass;
  auth?: "anonymous" | "worker" | "desktop-pairing" | "desktop";
}

const KIB = 1024;
const MIB = 1024 * KIB;

export const ENDPOINTS = Object.freeze({
  cmsCuezStatus: { contentType: "json", maxBytes: 16 * KIB, rateClass: "read" },
  cmsCuezListDestinations: { contentType: "json", maxBytes: 16 * KIB, rateClass: "read" },
  cmsCuezPrepareExport: { contentType: "json", maxBytes: 16 * KIB, rateClass: "metadata" },
  cmsCuezSendExport: { contentType: "json", maxBytes: 16 * KIB, rateClass: "metadata" },
  cmsCuezOperationStatus: { contentType: "json", maxBytes: 16 * KIB, rateClass: "read" },
  cmsCuezListImportCandidates: { contentType: "json", maxBytes: 16 * KIB, rateClass: "read" },
  cmsCuezPreviewImport: { contentType: "json", maxBytes: 16 * KIB, rateClass: "read" },
  cmsCuezConfirmImport: { contentType: "json", maxBytes: 16 * KIB, rateClass: "metadata" },
  cmsCuezRetry: { contentType: "json", maxBytes: 16 * KIB, rateClass: "metadata" },
  cmsCuezReconcile: { contentType: "json", maxBytes: 16 * KIB, rateClass: "metadata" },
  cmsStartPremierePairing: { contentType: "json", maxBytes: 2 * KIB, rateClass: "desktopPairingStart", auth: "desktop-pairing" },
  cmsApprovePremierePairing: { contentType: "json", maxBytes: 2 * KIB, rateClass: "mutation" },
  cmsPollPremierePairing: { contentType: "json", maxBytes: 2 * KIB, rateClass: "desktopPairingPoll", auth: "desktop-pairing" },
  cmsPremiereRequest: { contentType: "json", maxBytes: 96 * KIB, rateClass: "desktop", auth: "desktop" },
  cmsRevokePremiereSession: { contentType: "json", maxBytes: 2 * KIB, rateClass: "desktop", auth: "desktop" },
  cmsGetAnalytics: { contentType: "json", maxBytes: 2 * KIB, rateClass: "read" },
  cmsCollectBoardwalkUsage: { contentType: "json", maxBytes: 8 * KIB, rateClass: "usage" },
  cmsGetBoardwalkUsage: { contentType: "json", maxBytes: 2 * KIB, rateClass: "usageReport" },
  grantRole: { contentType: "json", maxBytes: 32 * KIB, rateClass: "mutation" },
  revokeRole: { contentType: "json", maxBytes: 32 * KIB, rateClass: "mutation" },
  setStaffAccessLevel: { contentType: "json", maxBytes: 32 * KIB, rateClass: "mutation" },
  deactivateStaff: { contentType: "json", maxBytes: 8 * KIB, rateClass: "mutation" },
  reactivateStaff: { contentType: "json", maxBytes: 8 * KIB, rateClass: "mutation" },
  registerStaffProfile: { contentType: "json", maxBytes: 2 * KIB, rateClass: "mutation" },
  cmsSetNavigationPreferences: { contentType: "json", maxBytes: 32 * KIB, rateClass: "mutation" },
  submitStaffAccessRequest: {
    contentType: "json",
    maxBytes: 4 * KIB,
    rateClass: "accountRequest",
  },
  requestStaffPasswordReset: {
    contentType: "json",
    maxBytes: 2 * KIB,
    rateClass: "accountRecovery",
    auth: "anonymous",
  },
  getStaffAccessStatus: { contentType: "json", maxBytes: 2 * KIB, rateClass: "read" },
  listStaffAccessRequests: { contentType: "json", maxBytes: 2 * KIB, rateClass: "read" },
  decideStaffAccessRequest: { contentType: "json", maxBytes: 4 * KIB, rateClass: "mutation" },
  cmsSaveContent: { contentType: "json", maxBytes: 1.25 * MIB, rateClass: "mutation" },
  cmsGetContent: { contentType: "json", maxBytes: 16 * KIB, rateClass: "read" },
  cmsLiveProductionDevices: { contentType: "json", maxBytes: 2 * KIB, rateClass: "mutation" },
  cmsPairLiveProductionDevice: { contentType: "json", maxBytes: 2 * KIB, rateClass: "desktopPairingPoll", auth: "desktop-pairing" },
  cmsLiveProduction: { contentType: "json", maxBytes: 256 * KIB, rateClass: "liveProduction" },
  cmsRundownSource: { contentType: "json", maxBytes: 8 * KIB, rateClass: "liveProduction" },
  cmsRundownParser: { contentType: "json", maxBytes: 2 * KIB, rateClass: "liveProduction" },
  cmsRundownReview: { contentType: "json", maxBytes: 256 * KIB, rateClass: "liveProduction" },
  cmsLiveProductionAgent: { contentType: "json", maxBytes: 256 * KIB, rateClass: "liveProduction" },
  cmsDatasets: { contentType: "json", maxBytes: 204 * KIB, rateClass: "mutation" },
  cmsElectionResultsSources: { contentType: "json", maxBytes: 128 * KIB, rateClass: "mutation" },
  cmsPostTemplates: { contentType: "json", maxBytes: 1.25 * MIB, rateClass: "mutation" },
  cmsGetCoverageLabels: { contentType: "json", maxBytes: 16 * KIB, rateClass: "read" },
  cmsGetSettings: { contentType: "json", maxBytes: 16 * KIB, rateClass: "read" },
  cmsSaveSettings: { contentType: "json", maxBytes: 512 * KIB, rateClass: "mutation" },
  cmsCostLedger: { contentType: "json", maxBytes: 16 * KIB, rateClass: "mutation" },
  cmsPublishSettings: {
    contentType: "json",
    maxBytes: 16 * KIB,
    rateClass: "publish",
  },
  cmsListRevisions: { contentType: "json", maxBytes: 16 * KIB, rateClass: "read" },
  cmsGetRevision: { contentType: "json", maxBytes: 16 * KIB, rateClass: "read" },
  cmsRestoreRevision: { contentType: "json", maxBytes: 32 * KIB, rateClass: "mutation" },
  cmsTransitionContent: { contentType: "json", maxBytes: 32 * KIB, rateClass: "lifecycle" },
  cmsListContent: { contentType: "json", maxBytes: 64 * KIB, rateClass: "read" },
  cmsListMedia: { contentType: "json", maxBytes: 16 * KIB, rateClass: "read" },
  cmsListBinnedMedia: { contentType: "json", maxBytes: 4 * KIB, rateClass: "read" },
  cmsRestoreMedia: { contentType: "json", maxBytes: 4 * KIB, rateClass: "metadata" },
  cmsListMediaSources: { contentType: "json", maxBytes: 8 * KIB, rateClass: "read" },
  cmsListSourceMedia: { contentType: "json", maxBytes: 8 * KIB, rateClass: "read" },
  cmsListMediaFavorites: { contentType: "json", maxBytes: 32 * KIB, rateClass: "read" },
  cmsSetMediaFavorite: { contentType: "json", maxBytes: 4 * KIB, rateClass: "mutation" },
  cmsSetMediaFavorites: { contentType: "json", maxBytes: 32 * KIB, rateClass: "mutation" },
  cmsListMediaCollections: { contentType: "json", maxBytes: 8 * KIB, rateClass: "read" },
  cmsListMediaCollectionItems: { contentType: "json", maxBytes: 8 * KIB, rateClass: "read" },
  cmsMutateMediaCollection: { contentType: "json", maxBytes: 8 * KIB, rateClass: "mutation" },
  cmsSetMediaCollectionItems: { contentType: "json", maxBytes: 64 * KIB, rateClass: "mutation" },
  cmsGetMediaReview: { contentType: "json", maxBytes: 4 * KIB, rateClass: "read" },
  cmsSaveMediaReview: { contentType: "json", maxBytes: 16 * KIB, rateClass: "mutation" },
  cmsListMediaComments: { contentType: "json", maxBytes: 4 * KIB, rateClass: "read" },
  cmsMutateMediaComment: { contentType: "json", maxBytes: 16 * KIB, rateClass: "mutation" },
  cmsRequestVideoClip: { contentType: "json", maxBytes: 4 * KIB, rateClass: "metadata" },
  cmsGetVideoClip: { contentType: "json", maxBytes: 4 * KIB, rateClass: "read" },
  cmsCreateVideoClipRead: { contentType: "json", maxBytes: 4 * KIB, rateClass: "read" },
  cmsCancelVideoClip: { contentType: "json", maxBytes: 4 * KIB, rateClass: "metadata" },
  cmsRequestVideoTranscript: { contentType: "json", maxBytes: 8 * KIB, rateClass: "mutation" },
  cmsGetVideoTranscript: { contentType: "json", maxBytes: 8 * KIB, rateClass: "read" },
  cmsGetVideoSearchCorpus: { contentType: "json", maxBytes: 8 * KIB, rateClass: "read" },
  cmsListTranscriptionCredentials: { contentType: "json", maxBytes: 8 * KIB, rateClass: "read" },
  cmsSaveTranscriptionCredential: { contentType: "json", maxBytes: 16 * KIB, rateClass: "mutation" },
  cmsDisconnectTranscriptionCredential: { contentType: "json", maxBytes: 8 * KIB, rateClass: "mutation" },
  cmsGetTranscriptionOptions: { contentType: "json", maxBytes: 8 * KIB, rateClass: "read" },
  cmsRequestByokVideoTranscript: { contentType: "json", maxBytes: 8 * KIB, rateClass: "mutation" },
  cmsListVideoTranscripts: { contentType: "json", maxBytes: 8 * KIB, rateClass: "read" },
  cmsSaveVideoTranscript: { contentType: "json", maxBytes: 2 * MIB, rateClass: "upload" },
  cmsCreateVideoTranscriptRead: { contentType: "json", maxBytes: 8 * KIB, rateClass: "read" },
  cmsSourceMediaOriginal: { contentType: "json", maxBytes: 4 * KIB, rateClass: "mutation" },
  cmsCreateSourceMediaRead: { contentType: "json", maxBytes: 8 * KIB, rateClass: "read" },
  cmsPublishSourceVideo: { contentType: "json", maxBytes: 2 * KIB, rateClass: "lifecycle" },
  cmsStartSourceMediaUpload: { contentType: "json", maxBytes: 96 * KIB, rateClass: "upload" },
  cmsSignSourceMediaUploadParts: { contentType: "json", maxBytes: 16 * KIB, rateClass: "multipartControl" },
  cmsResumeSourceMediaUpload: { contentType: "json", maxBytes: 4 * KIB, rateClass: "multipartControl" },
  cmsCompleteSourceMediaUpload: { contentType: "json", maxBytes: 4 * KIB, rateClass: "multipartControl" },
  cmsCancelSourceMediaUpload: { contentType: "json", maxBytes: 4 * KIB, rateClass: "multipartControl" },
  cmsDeleteSourceMedia: { contentType: "json", maxBytes: 4 * KIB, rateClass: "metadata" },
  cmsUpdateSourceMediaMetadata: { contentType: "json", maxBytes: 96 * KIB, rateClass: "metadata" },
  cmsGetSourceVideoReplacement: { contentType: "json", maxBytes: 4 * KIB, rateClass: "read" },
  cmsRollbackSourceVideoReplacement: { contentType: "json", maxBytes: 4 * KIB, rateClass: "metadata" },
  cmsListMediaUsage: { contentType: "json", maxBytes: 4 * KIB, rateClass: "read" },
  cmsListMediaCategories: { contentType: "json", maxBytes: 4 * KIB, rateClass: "read" },
  cmsMutateMediaCategory: { contentType: "json", maxBytes: 8 * KIB, rateClass: "metadata" },
  cmsUpdateMediaMetadata: { contentType: "json", maxBytes: 16 * KIB, rateClass: "metadata" },
  cmsCreateMediaDownload: { contentType: "json", maxBytes: 2 * KIB, rateClass: "read" },
  cmsReplaceMediaBinary: {
    contentType: "multipart",
    maxBytes: 25 * MIB + 128 * KIB,
    rateClass: "imageUpload",
  },
  cmsUploadMedia: {
    contentType: "multipart",
    maxBytes: 25 * MIB + 128 * KIB,
    rateClass: "imageUpload",
  },
  cmsListUgcSubmissions: { contentType: "json", maxBytes: 4 * KIB, rateClass: "read" },
  cmsGetUgcSubmissionPreview: { contentType: "json", maxBytes: 4 * KIB, rateClass: "read" },
  cmsRejectUgcSubmission: { contentType: "json", maxBytes: 4 * KIB, rateClass: "metadata" },
  cmsImportUgcSubmission: { contentType: "json", maxBytes: 4 * KIB, rateClass: "upload" },
  cmsSubmitBugReport: {
    contentType: "multipart",
    maxBytes: 5 * MIB + 128 * KIB,
    rateClass: "report",
  },
  cmsListBugReports: { contentType: "json", maxBytes: 2 * KIB, rateClass: "read" },
  cmsNudgeBugReport: { contentType: "json", maxBytes: 2 * KIB, rateClass: "mutation" },
  cmsGetBugReport: { contentType: "json", maxBytes: 2 * KIB, rateClass: "read" },
  cmsGetBugReportEvidence: {
    contentType: "json",
    maxBytes: 2 * KIB,
    rateClass: "read",
  },
  cmsListGithubIssues: { contentType: "json", maxBytes: 2 * KIB, rateClass: "read" },
  cmsGetGithubIssue: { contentType: "json", maxBytes: 2 * KIB, rateClass: "read" },
  cmsScanMediaUsage: { contentType: "json", maxBytes: 4 * KIB, rateClass: "lifecycle" },
  cmsBulkArchiveContent: { contentType: "json", maxBytes: 64 * KIB, rateClass: "lifecycle" },
  cmsAssignContent: { contentType: "json", maxBytes: 16 * KIB, rateClass: "mutation" },
  cmsListAudit: { contentType: "json", maxBytes: 16 * KIB, rateClass: "read" },
  cmsGetBroadcastSchedule: { contentType: "json", maxBytes: 2 * KIB, rateClass: "read" },
  cmsGetNewsroomBanner: { contentType: "json", maxBytes: 2 * KIB, rateClass: "read" },
  cmsVoiceoverReview: {
    contentType: "json",
    maxBytes: 8 * KIB,
    rateClass: "mutation",
  },
  cmsGetVoiceoverAudio: {
    contentType: "json",
    maxBytes: 2 * KIB,
    rateClass: "read",
  },
  cmsPreview: { contentType: "json", maxBytes: 64 * KIB, rateClass: "preview" },
  cmsPreviewStatus: { contentType: "json", maxBytes: 16 * KIB, rateClass: "read" },
  cmsRecheckPublication: { contentType: "json", maxBytes: 2 * KIB, rateClass: "publish" },
  cmsPublish: { contentType: "json", maxBytes: 64 * KIB, rateClass: "publish" },
  // Author/staff profile foundation (#1044). The two self reads are `read`; the
  // self and admin edits are `mutation`; owner Publish/Unpublish is `publish`
  // because it changes what the public site shows. All five require the same
  // signed-in, App Check-verified caller as every other cms* endpoint, so none
  // declares `auth: "anonymous"`.
  cmsGetAuthorProfile: { contentType: "json", maxBytes: 2 * KIB, rateClass: "read" },
  cmsUpdateAuthorProfile: {
    contentType: "json",
    maxBytes: 16 * KIB,
    rateClass: "mutation",
  },
  cmsSetAuthorProfileVisibility: {
    contentType: "json",
    maxBytes: 2 * KIB,
    rateClass: "publish",
  },
  // The byline picker's feed (#1040). A read, and a small one: the request is a
  // limit and a cursor, and the response is names and opaque ids.
  cmsListBylineAuthors: { contentType: "json", maxBytes: 2 * KIB, rateClass: "read" },
  // Safe, cursor-paged published Post summaries by stable byline identity (#1097).
  cmsListAuthorPagePosts: { contentType: "json", maxBytes: 2 * KIB, rateClass: "read" },
  cmsListAuthorProfiles: { contentType: "json", maxBytes: 2 * KIB, rateClass: "read" },
  cmsAdminUpdateAuthorProfile: {
    contentType: "json",
    maxBytes: 16 * KIB,
    rateClass: "mutation",
  },
  videoTranscriptWorkerClaim: { contentType: "json", maxBytes: 8 * KIB, rateClass: "worker", auth: "worker" },
  videoTranscriptWorkerHeartbeat: { contentType: "json", maxBytes: 8 * KIB, rateClass: "worker", auth: "worker" },
  videoTranscriptWorkerComplete: { contentType: "json", maxBytes: 16 * MIB, rateClass: "worker", auth: "worker" },
  videoTranscriptWorkerFail: { contentType: "json", maxBytes: 8 * KIB, rateClass: "worker", auth: "worker" },
  cmsRequestVideoTranscriptAlignment: { contentType: "json", maxBytes: 8 * KIB, rateClass: "transcription" },
  cmsCancelVideoTranscriptAlignment: { contentType: "json", maxBytes: 8 * KIB, rateClass: "mutation" },
  cmsRequestVideoOrientationExport: { contentType: "json", maxBytes: 4 * KIB, rateClass: "mutation" },
  cmsListVideoOrientationExports: { contentType: "json", maxBytes: 4 * KIB, rateClass: "read" },
} satisfies Record<string, EndpointPolicy>);

export type CmsEndpoint = keyof typeof ENDPOINTS;

export interface BucketPolicy {
  capacity: number;
  refillPerSecond: number;
}

export interface RatePolicy {
  actor: BucketPolicy;
  ip: BucketPolicy;
}

// Actor limits stop one signed-in account from exhausting a costly boundary.
// IP limits are four times wider so several staff members can share one office
// network without consuming each other's normal budget.
export const RATE_POLICIES = Object.freeze({
  liveProductionConnect: {
    actor: { capacity: 6, refillPerSecond: 1 / 10 },
    ip: { capacity: 24, refillPerSecond: 0.4 },
  },
  liveProduction: {
    actor: { capacity: 120, refillPerSecond: 4 },
    ip: { capacity: 480, refillPerSecond: 16 },
  },
  desktopPairingStart: {
    actor: { capacity: 5, refillPerSecond: 1 / 60 },
    ip: { capacity: 5, refillPerSecond: 1 / 60 },
  },
  desktopPairingPoll: {
    actor: { capacity: 60, refillPerSecond: 1 },
    ip: { capacity: 60, refillPerSecond: 1 },
  },
  // The Function verifies the opaque session and applies per-account operation
  // limits. The edge bounds anonymous work before consulting that session store.
  desktop: {
    actor: { capacity: 120, refillPerSecond: 4 },
    ip: { capacity: 480, refillPerSecond: 16 },
  },
  // Page loads need a larger burst than individual CMS reads because each
  // private asset is admitted separately. These buckets do not spend CMS quota.
  staffSite: {
    actor: { capacity: 240, refillPerSecond: 8 },
    ip: { capacity: 960, refillPerSecond: 32 },
  },
  read: {
    actor: { capacity: 60, refillPerSecond: 2 },
    ip: { capacity: 240, refillPerSecond: 8 },
  },
  // Charge one token per requested poster, up to the Function's 100-item page.
  // Three full pages cover opening, searching and paging without tile fan-out.
  sourcePosters: {
    actor: { capacity: 300, refillPerSecond: 2 },
    ip: { capacity: 1200, refillPerSecond: 8 },
  },
  // A full manifest can read 5,001 descriptors and 5,000 catalog records.
  // Allow entry plus two conflict retries, then one fresh scan per minute.
  videoSearchManifest: {
    actor: { capacity: 3, refillPerSecond: 1 / 60 },
    ip: { capacity: 12, refillPerSecond: 1 / 15 },
  },
  mutation: {
    actor: { capacity: 30, refillPerSecond: 1 },
    ip: { capacity: 120, refillPerSecond: 4 },
  },
  metadata: {
    actor: { capacity: 20, refillPerSecond: 0.5 },
    ip: { capacity: 80, refillPerSecond: 2 },
  },
  // Best-effort analytics must never consume an editorial action's request budget.
  usage: {
    actor: { capacity: 24, refillPerSecond: 1 },
    ip: { capacity: 240, refillPerSecond: 10 },
  },
  // History needs up to 87 native count queries. Admit all three windows,
  // then one report per minute per account, separately from editorial reads.
  usageReport: {
    actor: { capacity: 3, refillPerSecond: 1 / 60 },
    ip: { capacity: 12, refillPerSecond: 1 / 15 },
  },
  transcription: {
    actor: { capacity: 2, refillPerSecond: 1 / 300 },
    ip: { capacity: 8, refillPerSecond: 4 / 300 },
  },
  lifecycle: {
    actor: { capacity: 10, refillPerSecond: 0.2 },
    ip: { capacity: 40, refillPerSecond: 0.8 },
  },
  upload: {
    actor: { capacity: 8, refillPerSecond: 1 / 30 },
    ip: { capacity: 32, refillPerSecond: 4 / 30 },
  },
  // Each image spends at least one token, then one per additional 2 MiB received.
  // Small photo batches keep their 40-request burst. Large uploads share a
  // 80 MiB burst and 40 MiB/minute refill instead of multiplying that by 25 MiB.
  imageUpload: {
    actor: { capacity: 40, refillPerSecond: 1 / 3 },
    ip: { capacity: 160, refillPerSecond: 4 / 3 },
  },
  // A call signs at most six parts. Four calls per second permits up to 24
  // bounded part grants while starts remain on the slower upload budget.
  multipartControl: {
    actor: { capacity: 40, refillPerSecond: 4 },
    ip: { capacity: 160, refillPerSecond: 16 },
  },
  report: {
    actor: { capacity: 5, refillPerSecond: 1 / 180 },
    ip: { capacity: 20, refillPerSecond: 4 / 180 },
  },
  preview: {
    actor: { capacity: 5, refillPerSecond: 1 / 60 },
    ip: { capacity: 20, refillPerSecond: 4 / 60 },
  },
  publish: {
    actor: { capacity: 3, refillPerSecond: 1 / 120 },
    ip: { capacity: 12, refillPerSecond: 4 / 120 },
  },
  // A direct live blog update queues a publication from cmsSaveContent, which
  // already spends the mutation budget. This extra budget covers an entry every
  // minute or two plus corrections on election night.
  liveBlogUpdate: {
    actor: { capacity: 6, refillPerSecond: 1 / 10 },
    ip: { capacity: 24, refillPerSecond: 4 / 10 },
  },
  // The IP bucket runs before worker authentication or origin forwarding.
  // Its small burst permits normal claim, heartbeat and completion retries.
  worker: {
    actor: { capacity: 10, refillPerSecond: 0.5 },
    ip: { capacity: 10, refillPerSecond: 0.5 },
  },
  accountRequest: {
    actor: { capacity: 5, refillPerSecond: 1 / 86_400 },
    ip: { capacity: 5, refillPerSecond: 1 / 21_600 },
  },
  accountRecovery: {
    actor: { capacity: 2, refillPerSecond: 1 / 900 },
    ip: { capacity: 5, refillPerSecond: 1 / 180 },
  },
} satisfies Record<RateClass, RatePolicy>);

export function endpointPolicy(pathname: string):
  | { endpoint: CmsEndpoint; policy: EndpointPolicy }
  | null {
  const match = /^\/([A-Za-z][A-Za-z0-9]*)$/.exec(pathname);
  if (!match) return null;
  const endpoint = match[1] as CmsEndpoint;
  const policy = Object.hasOwn(ENDPOINTS, endpoint) ? ENDPOINTS[endpoint] : undefined;
  return policy ? { endpoint, policy } : null;
}
