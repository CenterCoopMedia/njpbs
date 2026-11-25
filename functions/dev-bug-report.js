"use strict";

const { cmsOnRequest } = require("./lib/cms-edge");
const { createCmsSubmitBugReportHandler, parseMultipartReport } = require("./bug-report");

// Only the dev manifest exports this wrapper. Refuse missing/mixed target,
// delivery policy or revision before authentication, replay or persistence.
function createDevCmsSubmitBugReportHandler(deps = {}) {
  const submit = createCmsSubmitBugReportHandler({
    ...deps,
    deploymentEnvironment: () => "development",
    parseMultipartFn: deps.parseMultipartFn ?? ((req) => parseMultipartReport(req, { allowAdminBuildRevision: true })),
  });
  return async (req, res) => {
    if (process.env.GCLOUD_PROJECT !== "njpbs-site-dev" ||
        process.env.CMS_DEPLOYMENT_ENVIRONMENT !== "development" ||
        process.env.CMS_DEV_REPORT_INTAKE_MODE !== "stored-only" ||
        !/^[a-f0-9]{40}$/.test(process.env.CMS_ADMIN_BUILD_REVISION ?? "")) {
      res.set("Cache-Control", "private, no-store");
      res.status(503).json({ error: "Dev report intake is not configured" });
      return;
    }
    await submit(req, res);
  };
}

const cmsSubmitBugReport = cmsOnRequest({
  cors: true, memory: "1GiB", concurrency: 1, maxInstances: 2, timeoutSeconds: 30,
}, createDevCmsSubmitBugReportHandler());

// functions/index.js serves this wrapper in a development deployment and the production handler otherwise.
const selectedCmsSubmitBugReport = process.env.CMS_DEPLOYMENT_ENVIRONMENT === "development"
  ? cmsSubmitBugReport : require("./bug-report").cmsSubmitBugReport;

module.exports = { cmsSubmitBugReport, createDevCmsSubmitBugReportHandler, selectedCmsSubmitBugReport };
