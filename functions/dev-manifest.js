"use strict";

// Source discovery and deployment must use the same reviewed list. A missing
// export is an error, not a reason to fall back to the production entry point.
const { CLOUD_WAKE_FUNCTIONS } = require("./lib/cloud-publication-wake-deployment");

const DEV_FUNCTIONS = Object.freeze({
  health: "./health",
  cmsCollectBoardwalkUsage: "./boardwalk-usage",
  cmsGetBoardwalkUsage: "./boardwalk-usage",
  registerStaffProfile: "./staff-profile",
  getStaffAccessStatus: "./dev-staff-access-status",
  grantRole: "./roles",
  revokeRole: "./roles",
  deactivateStaff: "./deactivate-staff",
  cmsValidateSiteAccess: "./site-access",
  cmsGetContent: "./get-content",
  cmsListContent: "./list-content",
  cmsSaveContent: "./save",
  cmsTransitionContent: "./lifecycle-transition",
  cmsGetRevision: "./revisions",
  cmsListRevisions: "./revisions",
  cmsRestoreRevision: "./restore-revision",
  cmsAssignContent: "./assign-content",
  cmsListAudit: "./list-audit",
  cmsPostTemplates: "./post-templates",
  cmsDatasets: "./datasets",
  cmsElectionResultsSources: "./election-results-sources",
  onElectionResultsSourcePoll: "./election-results-sources",
  onDatasetRefresh: "./dataset-refresh",
  cmsGetNewsroomBanner: "./settings",
  cmsGetSettings: "./settings",
  cmsGetCoverageLabels: "./settings",
  cmsSaveSettings: "./settings",
  cmsPublishSettings: "./settings",
  cmsGetPublicPage: "./public-content",
  cmsListMedia: "./list-media",
  cmsListMediaCategories: "./media-categories",
  cmsListMediaUsage: "./list-media-usage",
  cmsListBylineAuthors: "./author-profiles",
  cmsGetAuthorProfile: "./author-profiles",
  cmsPreview: "./preview",
  cmsPreviewStatus: "./preview",
  cmsReaderV1: "./cms-reader-endpoints",
  cmsReaderV2: "./cms-reader-endpoints",
  cmsReadPairCurrentCodeV2: "./cms-reader-endpoints",
  cmsPublish: "./publish",
  cmsRecheckPublication: "./recheck-publication",
  cmsSubmitBugReport: "./dev-bug-report",
  onNoBuildPostConfirmation: "./no-build-post-confirmation",
  onNoBuildPostConfirmationRecovery: "./no-build-post-confirmation",
  onScheduledPublish: "./scheduled-publish",
});

function devFunctionManifest(deployment) {
  if (deployment?.enabled !== true || deployment.environment !== "development") return DEV_FUNCTIONS;
  const selected = { ...DEV_FUNCTIONS };
  for (const name of CLOUD_WAKE_FUNCTIONS) selected[name] = "./no-build-cloud-wake";
  return Object.freeze(selected);
}

module.exports = { DEV_FUNCTIONS, devFunctionManifest };
