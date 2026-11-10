// The dev Worker cannot proxy unrelated production-only CMS Functions.
export const DEV_API_ENDPOINTS = new Set([
  "cmsCollectBoardwalkUsage", "cmsGetBoardwalkUsage",
  "registerStaffProfile", "getStaffAccessStatus", "grantRole", "revokeRole",
  "deactivateStaff", "cmsGetContent", "cmsListContent", "cmsSaveContent",
  "cmsTransitionContent", "cmsGetRevision", "cmsListRevisions",
  "cmsRestoreRevision", "cmsAssignContent", "cmsListAudit", "cmsPostTemplates", "cmsDatasets", "cmsElectionResultsSources",
  "cmsGetNewsroomBanner", "cmsGetSettings", "cmsGetCoverageLabels", "cmsSaveSettings",
  "cmsPublishSettings", "cmsListMedia", "cmsListMediaCategories",
  "cmsListMediaUsage", "cmsListBylineAuthors", "cmsGetAuthorProfile",
  "cmsPreview", "cmsPreviewStatus", "cmsPublish", "cmsRecheckPublication", "cmsSubmitBugReport",
]);
