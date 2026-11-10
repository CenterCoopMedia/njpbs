"use strict";

async function prepareSelectedPairContentPublication(input) {
  const root = (await input.transaction.get(input.firestore.doc("system/publicDeployment"))).data();
  if (root?.schemaVersion !== 2) return null;
  require("./public-release-media-fence").parseStoredSelector(root);
  const recordFamily = require("./no-build-record-publication").recordFamily(input.nextDocument);
  const kind = input.collection === "cmsPages" ? "page" : recordFamily ? "record" : "post";
  if (!require("./public-video-references").publiclyVisible(input.nextDocument)) {
    const current = (await input.transaction.get(input.firestore.doc(`${input.collection}/${input.documentId}`))).data();
    if (current?.publiclyVisible === false && current.publishBuildPending &&
        require("./public-deployment-pointer").isPublicDeploymentIdentifier(current.publishBuildQueueId)) {
      const queue = (await input.transaction.get(input.firestore.doc(`cmsPublishQueue/${current.publishBuildQueueId}`))).data();
      if (queue?.transport === "release-pair-publication-v2") {
        const admission = await require("./public-release-publication-request").readPendingPairWithdrawalInTransaction({
          ...input, operationId: current.publishBuildQueueId, sourceVersion: current.published?.sourceVersion, sourceKind: kind });
        const p = require("./public-release-pair");
        if (admission && (p.publicReleaseDigest(input.nextDocument.published) !== p.publicReleaseDigest(current.published) ||
            recordFamily && admission.source.family !== recordFamily)) throw new p.PublicReleaseProtocolError();
        if (admission) return { idempotent: true, admission, operation: { operationId: admission.operationId },
          transport: "release-pair-publication-v2", requiresPrimaryAdmission: false, queueId: admission.operationId,
          contentQueueId: admission.operationId, affectedHomeSections: [], warnings: [], homeFullBuildQueueId: null, write() {} };
      }
    }
  }
  if (input.collection === "cmsPages") return require("./no-build-page-publication").preparePairPagePublication(input);
  const records = require("./no-build-record-publication");
  if (records.recordFamily(input.nextDocument)) return records.preparePairRecordPublication(input);
  if (input.collection === "cmsPosts" && input.nextDocument?.type === "post")
    return require("./no-build-post-publication").preparePairPostPublication(input);
  throw Object.assign(new Error("This content has no pair publication owner."), { status: 409 });
}
async function prepareNoBuildContentPublication(input) {
  await require("./content-link-directory").assertContentLinkCapacityInTransaction(input);
  const pair = await prepareSelectedPairContentPublication(input);
  if (pair) return pair;
  if (input.collection === "cmsPages") {
    const page = await require("./no-build-page-publication").prepareNoBuildPagePublication(input);
    // Unselected Home retains the existing Post placement exclusion. An owned
    // Page never falls through to the serializer or a different family owner.
    if (page) return page;
    if (require("./dataset-dependencies").figureBlocks(input.nextDocument?.published).length) {
      throw Object.assign(new Error("Data figures require the compiled Page publication owner."), { status: 409 });
    }
  }
  const record = await require("./no-build-record-publication").prepareNoBuildRecordPublication(input);
  if (record) return record;
  const post = await require("./no-build-post-publication").prepareNoBuildPostPublication(input);
  if (!post && require("./dataset-dependencies").figureBlocks(input.nextDocument?.published).length) {
    throw Object.assign(new Error("Data figures require the compiled Post publication owner."), { status: 409 });
  }
  return post;
}
async function assertNoBuildContentScheduleInTransaction(input) {
  await require("./content-link-directory").assertContentLinkCapacityInTransaction({ ...input,
    nextDocument: { ...input.nextDocument, status: "published", publiclyVisible: true } });
  const pair = await prepareSelectedPairContentPublication({ ...input,
    nextDocument: { ...input.nextDocument, version: input.nextDocument.published?.sourceVersion, status: "published", publiclyVisible: true,
      publishAt: input.nextDocument.published?.publishedAt },
    queueRef: input.firestore.collection("cmsPublishQueue").doc(), actor: { uid: "system:scheduler" } });
  if (pair) return pair.transport;
  if (input.collection === "cmsPages") {
    const page = await require("./no-build-page-publication").assertNoBuildPageScheduleInTransaction(input);
    if (page) return page;
  }
  if (input.collection === "cmsPosts" && require("./no-build-record-publication").recordFamily(input.nextDocument)) {
    const record = await require("./no-build-record-publication").prepareNoBuildRecordPublication({ ...input,
      validationOnly: true, nextDocument: { ...input.nextDocument, version: input.nextDocument.published?.sourceVersion, status: "published", publiclyVisible: true,
        publishAt: input.nextDocument.published?.publishedAt }, queueRef: input.firestore.collection("cmsPublishQueue").doc(), actor: { uid: "system:scheduler" } });
    return record?.transport;
  }
  return require("./no-build-post-publication").assertNoBuildScheduleInTransaction(input);
}
module.exports = { prepareNoBuildContentPublication, assertNoBuildContentScheduleInTransaction };
