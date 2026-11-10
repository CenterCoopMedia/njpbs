"use strict";

const { publicationTarget, assertPublicationTarget, assertPublicationDatabase } = require("./publication-target");
const { refuse } = require("./no-build-page-ownership");

/** Existing callers may omit the target only when their database names one
 * exact deployment. An unknown project never defaults to production. */
function pagePublicationTarget({ firestore, target, environment = process.env.CMS_DEPLOYMENT_ENVIRONMENT }) {
  if (!target) {
    const name = ["development", "production"].find(name => publicationTarget(name).projectId === firestore?.projectId);
    if (!name) refuse("The Page publication environment is unavailable.");
    target = publicationTarget(name);
  }
  target = assertPublicationTarget(target);
  assertPublicationDatabase(firestore, target);
  const local = environment === "emulator" && process.env.FUNCTIONS_EMULATOR === "true";
  if (environment !== undefined && !local && environment !== target.environment) {
    refuse("The Page publication environment differs.");
  }
  return target;
}
module.exports = { pagePublicationTarget };
