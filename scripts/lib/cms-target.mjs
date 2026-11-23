import publication from "../../functions/lib/publication-target.js";

// The CMS deploy workflow sets CMS_TARGET from its target input; unset is production.
export function cmsTarget(env = process.env) {
  return publication.publicationTarget(env.CMS_TARGET || "production");
}
