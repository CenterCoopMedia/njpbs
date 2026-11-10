"use strict";
const { readReportingPosts } = require("./data-hub-reporting-posts");
const { readRetainedReporting } = require("./data-hub-reporting-input");
const { readNoBuildFamilyAdmission } = require("./no-build-family-admission");
const { createPostBackgroundStorage } = require("./post-background-storage");
const { PUBLIC_CONTEXT_PATH } = require("./public-context-revision");
/** Existing Page authority pins the source receipt and all Post reads to its transaction. */
async function readReportingContext({firestore,transaction,now,page,readProviderInput,strictPublicReleaseInputs=false}) {
  if (!page?.dataHubReporting) return undefined;
  let native;
  try { native = await readReportingPosts({firestore,transaction,now}); } catch (error) { if (strictPublicReleaseInputs) throw error; native = {failed:true,stories:[]}; }
  // Optional reporting cannot make the figure page unavailable on a catalogue overflow.
  if (Buffer.byteLength(JSON.stringify(native.stories)) > 1024*1024) {
    if (strictPublicReleaseInputs) throw new Error("Frozen reporting catalogue exceeds its bound");
    native = {failed:true,stories:[]};
  }
  const context = (await transaction.get(firestore.doc(PUBLIC_CONTEXT_PATH))).data();
  let spotlight;
  try {
    if (context?.externalInputs) {
      const admission = await readNoBuildFamilyAdmission({firestore,transaction});
      if (admission.valid) spotlight = await readRetainedReporting({inputs:context.externalInputs,
        read:readProviderInput ?? (key => createPostBackgroundStorage(admission.backgroundBucket).get(key,{signal:AbortSignal.timeout(10_000),maxBytes:16*1024*1024}))});
    }
  } catch (error) { if (strictPublicReleaseInputs) throw error; /* Existing serving keeps optional reporting unavailable. */ }
  const times = [context?.changedAt?.toMillis?.(), Date.parse(page.publishedAt),
    ...native.stories.map(story => Date.parse(story.publishedAt)),
    ...Object.values(spotlight?.queries ?? {}).map(query => Date.parse(query.checkedAt)), Date.parse(spotlight?.pins.checkedAt)]
    .filter(at => Number.isFinite(at) && at > 0 && at <= now.getTime());
  const cutoffAt = new Date(times.length ? Math.max(...times) : 0).toISOString();
  return {cutoffAt,posts:native.stories,...(spotlight ? {spotlight} : {})};
}
module.exports = {readReportingContext};
