"use strict";

function lazyExport(exportName, modulePath, moduleExportName = exportName, enabled = true) {
  if (!enabled) return;
  Object.defineProperty(exports, exportName, {
    enumerable: true,
    configurable: true,
    get() {
      const value = require(modulePath)[moduleExportName];
      Object.defineProperty(exports, exportName, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      return value;
    },
  });
}

lazyExport("cmsGetAnalytics", "./analytics");
lazyExport("cmsCollectBoardwalkUsage", "./boardwalk-usage");
lazyExport("cmsGetBoardwalkUsage", "./boardwalk-usage");
lazyExport("cmsCuezStatus", "./cuez-transfers");
lazyExport("cmsCuezListDestinations", "./cuez-transfers");
lazyExport("cmsCuezPrepareExport", "./cuez-transfers");
lazyExport("cmsCuezSendExport", "./cuez-transfers");
lazyExport("cmsCuezOperationStatus", "./cuez-transfers");
lazyExport("cmsCuezListImportCandidates", "./cuez-transfers");
lazyExport("cmsCuezPreviewImport", "./cuez-transfers");
lazyExport("cmsCuezConfirmImport", "./cuez-transfers");
lazyExport("cmsCuezRetry", "./cuez-transfers");
lazyExport("cmsCuezReconcile", "./cuez-transfers");
lazyExport("health", "./health");
lazyExport("cmsGetBroadcastSchedule", "./broadcast-schedule");
lazyExport("grantRole", "./roles");
lazyExport("revokeRole", "./roles");
lazyExport("setStaffAccessLevel", "./staff-access-level");
lazyExport("deactivateStaff", "./deactivate-staff");
lazyExport("reactivateStaff", "./reactivate-staff");
lazyExport("cmsBulkArchiveContent", "./bulk-archive");
lazyExport("cmsAssignContent", "./assign-content");
lazyExport("cmsGetContent", "./get-content");
lazyExport("cmsPostTemplates", "./post-templates");
lazyExport("cmsDatasets", "./datasets");
lazyExport("cmsElectionResultsSources", "./election-results-sources");
lazyExport("onElectionResultsSourcePoll", "./election-results-sources");
lazyExport("onDatasetRefresh", "./dataset-refresh");
lazyExport("cmsLiveProductionDevices", "./live-production-enrollment");
lazyExport("cmsPairLiveProductionDevice", "./live-production-enrollment");
lazyExport("cmsLiveProduction", "./live-production");
lazyExport("cmsLiveProductionAgent", "./live-production");
lazyExport("cmsRundownSource", "./rundown-source");
lazyExport("cmsRundownParser", "./rundown-parser");
lazyExport("cmsRundownReview", "./rundown-review");
lazyExport("cmsListRevisions", "./revisions");
lazyExport("cmsGetRevision", "./revisions");
lazyExport("cmsRestoreRevision", "./restore-revision");
lazyExport("cmsTransitionContent", "./lifecycle-transition");
lazyExport("cmsListContent", "./list-content");
lazyExport("cmsListMedia", "./list-media");
lazyExport("cmsListBinnedMedia", "./list-binned-media");
lazyExport("cmsRestoreMedia", "./set-media-lifecycle");
lazyExport("cmsListMediaSources", "./source-media");
lazyExport("cmsListSourceMedia", "./source-media");
lazyExport("cmsCreateSourceMediaRead", "./source-media");
lazyExport("cmsSourceMediaOriginal", "./source-media-originals");
lazyExport("cmsPublishSourceVideo", "./source-video-publication");
lazyExport("onPublicVideoPostWithdrawal", "./source-video-publication");
lazyExport("onPublicVideoPageWithdrawal", "./source-video-publication");
lazyExport("onPublicVideoWithdrawalRecovery", "./source-video-publication");
lazyExport("onNoBuildPostConfirmation", "./no-build-post-confirmation");
lazyExport("onNoBuildPostConfirmationRecovery", "./no-build-post-confirmation");
lazyExport("cmsListMediaFavorites", "./media-favorites");
lazyExport("cmsSetMediaFavorite", "./media-favorites");
lazyExport("cmsSetMediaFavorites", "./media-favorites");
lazyExport("cmsListMediaCollections", "./media-collections");
lazyExport("cmsListMediaCollectionItems", "./media-collections");
lazyExport("cmsMutateMediaCollection", "./media-collections");
lazyExport("cmsSetMediaCollectionItems", "./media-collections");
lazyExport("cmsGetMediaReview", "./media-feedback");
lazyExport("cmsSaveMediaReview", "./media-feedback");
lazyExport("cmsListMediaComments", "./media-feedback");
lazyExport("cmsMutateMediaComment", "./media-feedback");
lazyExport("cmsStartSourceMediaUpload", "./source-media-uploads");
lazyExport("cmsSignSourceMediaUploadParts", "./source-media-uploads");
lazyExport("cmsResumeSourceMediaUpload", "./source-media-uploads");
lazyExport("cmsCompleteSourceMediaUpload", "./source-media-uploads");
lazyExport("cmsCancelSourceMediaUpload", "./source-media-uploads");
lazyExport("cmsDeleteSourceMedia", "./source-media-uploads");
lazyExport("cmsUpdateSourceMediaMetadata", "./source-media-uploads");
lazyExport("cmsGetSourceVideoReplacement", "./source-video-replacement");
lazyExport("cmsRollbackSourceVideoReplacement", "./source-video-replacement");
lazyExport("onSourceVideoReplacementTick", "./source-video-replacement");
lazyExport("cmsListMediaUsage", "./list-media-usage");
lazyExport("cmsUpdateMediaMetadata", "./update-media");
lazyExport("cmsUploadMedia", "./media");
lazyExport("cmsCreateMediaDownload", "./media-download");
lazyExport("cmsListUgcSubmissions", "./ugc-review-list");
lazyExport("cmsGetUgcSubmissionPreview", "./ugc-review");
lazyExport("cmsRejectUgcSubmission", "./ugc-review");
lazyExport("cmsImportUgcSubmission", "./ugc-review");
lazyExport("ugcGetConfig", "./ugc-intake");
lazyExport("ugcStartSubmission", "./ugc-intake");
lazyExport("ugcCompleteSubmission", "./ugc-intake");
lazyExport("cmsListMediaCategories", "./media-categories");
lazyExport("cmsMutateMediaCategory", "./media-categories");
lazyExport("cmsScanMediaUsage", "./scan-media-usage");
lazyExport("cmsListAudit", "./list-audit");
lazyExport("cmsSaveContent", "./save");
lazyExport("onCmsSaveWarmup", "./save-warmup");
lazyExport("cmsGetNewsroomBanner", "./settings");
lazyExport("cmsGetSettings", "./settings");
lazyExport("cmsGetCoverageLabels", "./settings");
lazyExport("cmsPublishSettings", "./settings");
lazyExport("cmsSaveSettings", "./settings");
lazyExport("registerStaffProfile", "./staff-profile");
lazyExport("cmsSetNavigationPreferences", "./navigation-preferences");
lazyExport("onNavigationShareOwnerWrite", "./navigation-share-owner");
lazyExport("cmsGetAuthorProfile", "./author-profiles");
lazyExport("cmsUpdateAuthorProfile", "./author-profiles");
lazyExport("cmsSetAuthorProfileVisibility", "./author-profiles");
lazyExport("cmsListAuthorProfiles", "./author-profiles");
lazyExport("cmsListAuthorPagePosts", "./author-profiles");
lazyExport("cmsListBylineAuthors", "./author-profiles");
lazyExport("cmsAdminUpdateAuthorProfile", "./author-profiles");
lazyExport("submitStaffAccessRequest", "./staff-access");
lazyExport("requestStaffPasswordReset", "./staff-access");
lazyExport("getStaffAccessStatus", "./staff-access");
lazyExport("listStaffAccessRequests", "./staff-access");
lazyExport("decideStaffAccessRequest", "./staff-access");
lazyExport("onStaffAccessEmailRetry", "./staff-access-email");
lazyExport("onStaffAccessNotificationCreated", "./staff-access-notification");
lazyExport("cmsSubmitBugReport", "./bug-report");
lazyExport("cmsListBugReports", "./bug-report-triage");
lazyExport("cmsNudgeBugReport", "./bug-report-triage");
lazyExport("cmsGetBugReport", "./bug-report-triage");
lazyExport("cmsGetBugReportEvidence", "./bug-report-triage");
lazyExport("cmsListGithubIssues", "./bug-report-github");
lazyExport("cmsGetGithubIssue", "./bug-report-github");
lazyExport("onBugReportDelivery", "./bug-report-delivery");
lazyExport("onBugReportDeliveryCreated", "./bug-report-delivery");
lazyExport("telegramBugReportCallback", "./bug-report-delivery");
lazyExport("githubBugReportWebhook", "./bug-report-github");
lazyExport("onBugReportGithubOutboxCreated", "./bug-report-github");
lazyExport("onBugReportGithubSync", "./bug-report-github");
lazyExport("cmsPreview", "./preview");
lazyExport("cmsPreviewStatus", "./preview");
lazyExport("cmsPublish", "./publish");
lazyExport("cmsRecheckPublication", "./recheck-publication");
lazyExport("onScheduledPublish", "./scheduled-publish");
lazyExport("cmsGetPublicPage", "./public-content");
lazyExport("cmsReaderV1", "./cms-reader-endpoints");
lazyExport("cmsReaderV2", "./cms-reader-endpoints");
lazyExport("cmsReadPairCurrentCodeV2", "./cms-reader-endpoints");
lazyExport("cmsVoiceoverReview", "./voiceover-review");
lazyExport("cmsGetVoiceoverAudio", "./voiceover-audio");

// Firebase deploy resolves the secrets declared by the loaded codebase rather
// than only the functions named in --only. An exported secret-bound function must
// have its Secret Manager value before source discovery. Keep undeployed secret
// functions inside their commented export lines: a top-level require runs the
// module's defineSecret() even when no export is reached.
//
// cmsPublish and onScheduledPublish share CMS_PUBLISH_GITHUB_TOKEN. The staging
// workflow can provision that Secret Manager value from a short-lived GitHub
// repository secret before Firebase source discovery, then deploys both functions
// together. publish.js reads the secret-free billing-state core, so the publish
// transport does not depend on the unrelated BILLING_ALERT_TOKEN notification
// secret. Both paths still return or fail before changing content when billing,
// token, or terminal-writeback readiness is missing.
//
// cmsPreview and cmsPreviewStatus are deployed together. The request endpoint
// pins each immutable request to the reviewed renderer revision supplied by the
// staging deploy. Only the serializer transport is accepted, and its ready gate
// must be confirmed before it can create an atomically audited serializer queue
// row. The status endpoint has no secret,
// but keeping the pair in one manifest prevents the UI from requesting a build
// it can never observe.
//
// The other scheduled and event functions need no emulator export, because no
// test calls them over HTTP:
//
// Dev shadow reader: Enabled for nj-pbs-announces-six-staff-appointments with
// the approved read-only account and HMAC secret. The relay and shadow Worker
// are not deployed yet; this export does not change public site routing.
lazyExport("cmsGetPublishedPost", "./published-post-reader");
//
// onPublishQueueReconcile binds its dedicated Healthchecks URL. Provision
// HEALTHCHECKS_PUBLISH_RECONCILE before export; explicitly enabled dev purge also
// needs SHADOW_POST_ROUTE_PURGE_TOKEN. Its runner and trigger
// metadata are emulator-tested without making a live ping.
//   exports.onPublishQueueReconcile =
//     require("./publish-reconcile").onPublishQueueReconcile;
//
// onBudgetNotification binds BILLING_ALERT_TOKEN and needs the Pub/Sub budget
// topic. Configure the billing kill switch before enabling budget automation.
//   exports.onBudgetNotification = require("./billing").onBudgetNotification;
//
// scheduleProxy binds PBS_TVSS_AUTH, blocked on the external PBS-credentials
// issues #191 and #206. Its candidate mapper and proxy logic are tested through
// functions/lib/pbs/, but resolveTransform and this export stay disabled until
// the exact authenticated response shape is reconciled against the mapper.
//   exports.scheduleProxy = require("./schedule").scheduleProxy;

// cmsSetMediaLifecycle stays server-only until the deployment coordinator in
// #444 and #461 owns system/publicDeployment and its deployed-generation usage
// writeback. The handler fails closed without that receipt. Do not export it
// before both deployment entry points use the coordinator.
//   exports.cmsSetMediaLifecycle =
//     require("./set-media-lifecycle").cmsSetMediaLifecycle;

lazyExport("cmsReplaceMediaBinary", "./replace-media");
// Deployment defaults off; the resolver binds only provisioned scoped secrets.
lazyExport("onMediaPurgeSweep", "./media-purge-sweep");

lazyExport("cmsValidateSiteAccess", "./site-access");

lazyExport("onVideoPreviewTick", "./video-previews");
lazyExport("cmsRequestVideoClip", "./video-clips");
lazyExport("cmsGetVideoClip", "./video-clips");
lazyExport("cmsCreateVideoClipRead", "./video-clips");
lazyExport("cmsCancelVideoClip", "./video-clips");
lazyExport("onVideoClipTick", "./video-clips");
lazyExport("cmsRequestVideoTranscript", "./video-transcripts");
lazyExport("cmsGetVideoTranscript", "./video-transcripts");
lazyExport("cmsGetVideoSearchCorpus", "./video-search-corpus");
lazyExport("cmsCreateVideoTranscriptRead", "./video-transcripts");
lazyExport("cmsSaveVideoTranscript", "./video-transcripts");
lazyExport("cmsRequestVideoTranscriptAlignment", "./video-transcript-alignment");
lazyExport("cmsCancelVideoTranscriptAlignment", "./video-transcript-alignment");
lazyExport("cmsRequestVideoOrientationExport", "./video-orientation-exports");
lazyExport("cmsListVideoOrientationExports", "./video-orientation-exports");
lazyExport("onVideoTranscriptTick", "./video-transcripts");
lazyExport("videoTranscriptWorkerClaim", "./video-transcript-worker");
lazyExport("videoTranscriptWorkerHeartbeat", "./video-transcript-worker");
lazyExport("videoTranscriptWorkerComplete", "./video-transcript-worker");
lazyExport("videoTranscriptWorkerFail", "./video-transcript-worker");
lazyExport("cmsListTranscriptionCredentials", "./video-transcription-credentials");
lazyExport("cmsSaveTranscriptionCredential", "./video-transcription-credentials");
lazyExport("cmsDisconnectTranscriptionCredential", "./video-transcription-credentials");
lazyExport("cmsGetTranscriptionOptions", "./video-transcript-byok");
lazyExport("cmsRequestByokVideoTranscript", "./video-transcript-byok");
lazyExport("cmsListVideoTranscripts", "./video-transcript-byok");
lazyExport("onVideoTranscriptByokTick", "./video-transcript-byok-runner");
lazyExport("cmsCostLedger", "./cost-ledger");
lazyExport("onCostLedgerRefresh", "./cost-ledger-refresh");
lazyExport("cmsStartPremierePairing", "./premiere-desktop");
lazyExport("cmsApprovePremierePairing", "./premiere-desktop");
lazyExport("cmsPollPremierePairing", "./premiere-desktop");
lazyExport("cmsPremiereRequest", "./premiere-desktop");
lazyExport("cmsRevokePremiereSession", "./premiere-desktop");

// Dev shadow follow-ups are opt-in after the dedicated KV namespace and token
// are provisioned. The production publication transport stays unchanged.
if (process.env.SHADOW_POST_REVISIONS_ENABLED === "true") {
  lazyExport("onShadowPostRevisionWrite", "./shadow-post-revisions");
  lazyExport("onShadowPostRevisionRetry", "./shadow-post-revisions");
}

// Source-only until the coordinator provisions the authenticated wake boundary.
// This export switch is deployment configuration, never publication admission.
const cloudWakeEnabled = require("./lib/cloud-publication-wake-deployment").readCloudPublicationWakeDeployment().enabled;
lazyExport("onNoBuildCloudState", "./no-build-cloud-wake", undefined, cloudWakeEnabled);
lazyExport("onNoBuildCloudCandidate", "./no-build-cloud-wake", undefined, cloudWakeEnabled);
lazyExport("onNoBuildCloudRelease", "./no-build-cloud-wake", undefined, cloudWakeEnabled);

// Private transcript search materialization.
lazyExport("onVideoSearchShardWrite", "./video-search-shards");
lazyExport("onVideoSearchAssetWrite", "./video-search-shards");

lazyExport("onPrivateVideoAssetWrite", "./private-video-copies");
lazyExport("onPrivateVideoCopyTick", "./private-video-copies");
