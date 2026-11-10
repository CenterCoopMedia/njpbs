"use strict";

const { cmsOnRequest } = require("./lib/cms-edge");
const {
  BugReportRequestError, createCmsSubmitBugReportHandler, parseMultipartReport,
} = require("./bug-report");

// Only the dev manifest exports this wrapper. Refuse missing/mixed target,
// delivery policy or revision before authentication, replay or persistence.
function createDevCmsSubmitBugReportHandler(deps = {}) {
  const parseMultipartFn = deps.parseMultipartFn ?? ((req) => parseMultipartReport(req, { allowAdminBuildRevision: true }));
  const submit = createCmsSubmitBugReportHandler({
    ...deps,
    deploymentEnvironment: () => "development",
    parseMultipartFn: async (req) => {
      const parsed = await parseMultipartFn(req);
      // Check the submitting bundle before the shared handler can replay a receipt.
      if (parsed.fields.adminBuildRevision !== process.env.CMS_ADMIN_BUILD_REVISION) {
        throw new BugReportRequestError(
          "This Boardwalk version is out of date. Reload Boardwalk to send your report.", 409,
        );
      }
      return parsed;
    },
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

module.exports = { cmsSubmitBugReport, createDevCmsSubmitBugReportHandler };
