"use strict";
const { PublicReleaseProtocolError } = require("./public-release-pair");
const { publicationTarget } = require("./publication-target");

/** Reviewed first-install destinations. Each CLI binds one environment before
 * loading owners or credentials; the native baseline still requires original
 * enrollment and closed fences for that exact database. */
function firstInstallPublicationTarget(environment) {
  if (!["development", "production"].includes(environment)) throw new PublicReleaseProtocolError();
  return publicationTarget(environment);
}
module.exports = { firstInstallPublicationTarget };
