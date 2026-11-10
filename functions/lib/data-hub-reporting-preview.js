"use strict";
const { parseReportingMapping, selectReportingStories } = require("./data-hub-reporting");
const { readReportingPosts } = require("./data-hub-reporting-posts");
const { refreshSpotlightReporting, readSpotlightTerms } = require("./data-hub-spotlight");
const { spotlightReportingFor } = require("./data-hub-reporting-sources");
const { readRetainedReporting } = require("./data-hub-reporting-input");
const { PUBLIC_CONTEXT_PATH } = require("./public-context-revision");
const { contentResource, authorizeContentRead } = require("./content-authorization");
const { readNoBuildFamilyAdmission } = require("./no-build-family-admission");
const { createPostBackgroundStorage } = require("./post-background-storage");
async function readReportingPreview({firestore, principal, body, fetchImpl = fetch, clock = Date.now}) {
  const row = await firestore.doc("cmsPages/data-hub").get();
  const page = row.data() ?? {};
  const decision = authorizeContentRead(principal,{exists:row.exists,
    resource:contentResource({collection:"cmsPages",documentId:"data-hub",stored:page})});
  if (!decision.allowed) throw Object.assign(new Error("This Page is not available."),{status:403});
  if (body.action === "terms") return {terms:await readSpotlightTerms(body.taxonomy,body.search,{fetchImpl,clock})};
  if (body.action !== "preview") throw Object.assign(new Error("Choose a reporting read action."),{status:400});
  let mapping;
  try { mapping = parseReportingMapping(body.mapping); } catch { throw Object.assign(new Error("Check the reporting mapping."),{status:400}); }
  const now = new Date(clock());
  const native = await readReportingPosts({firestore,now});
  let previous;
  try {
    const inputs = (await firestore.doc(PUBLIC_CONTEXT_PATH).get()).data()?.externalInputs;
    const admission = await readNoBuildFamilyAdmission({firestore});
    if (inputs && admission.valid) previous = await readRetainedReporting({inputs,
      read:key => createPostBackgroundStorage(admission.backgroundBucket).get(key,{signal:AbortSignal.timeout(10_000)})});
  } catch { /* No unsealed or wrong-query fallback. */ }
  const external = spotlightReportingFor(mapping,await refreshSpotlightReporting([mapping],previous,{fetchImpl,clock}));
  const posts = native.stories.filter(story => selectReportingStories(mapping,[story],now.getTime()).length)
    .sort((a,b) => Date.parse(b.publishedAt)-Date.parse(a.publishedAt) || a.id.localeCompare(b.id));
  const pins = posts.filter(story => mapping.pins.some(pin => pin.source === "posts" && pin.id === story.id));
  return { stories:[...new Map([...pins,...posts.slice(0,25),...external.stories].map(story => [`${story.source}:${story.id}`,story])).values()],
    checkedAt:external.checkedAt,failed:external.failed || native.failed,cutoffAt:now.toISOString() };
}
module.exports = {readReportingPreview};
