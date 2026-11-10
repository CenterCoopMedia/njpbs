"use strict";
const { liveBlogVideoBlocks } = require("./lib/live-blog");

// cmsPublishSourceVideo (#2751): copy one video-library viewing copy and its poster to
// the public media store, so a post or page that uses it can publish. It runs under
// the source-media service account, which the AWS video read role trusts.

const { S3Client } = require("@aws-sdk/client-s3");
const { defineSecret, defineString } = require("firebase-functions/params");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const { cmsOnRequest } = require("./lib/cms-edge");
const { db } = require("./lib/firebase");
const { requirePrincipal } = require("./lib/auth");
const { validateBoundedJsonRequest } = require("./lib/http-json");
const { can, hasCapability } = require("./lib/rbac");
const { contentResource, mayAnswerAbsentRecordRead } = require("./lib/content-authorization");
const { visibleLayoutBlocks } = require("./lib/content-layout");
const { authorizeMediaSource, objectKeyWithinSource } = require("./lib/media-sources");
const {
  SourceMediaValidationError,
  parseSourceMediaAsset,
} = require("./lib/source-media-contract");
const { createAwsRoleCredentialProvider } = require("./lib/aws-workload-credentials");
const { runtimeAwsConfig, runtimeRegistry } = require("./lib/media-source-runtime");
const { r2ClientConfig } = require("./lib/r2-media");
const { acquirePublicVideoCopy, samePublicVideoSource, PublicVideoError, publishSourceVideo } = require("./lib/public-video");
const { createPublicVideoWithdrawalHandler: withdrawalHandler, createPublicVideoWithdrawalRecoveryHandler: recoveryHandler } = require("./lib/public-video-withdrawal");
const { leadVideoBlocks } = require("./lib/post-lead-media");
const { VIDEO_BLOCK_SOURCE_ID } = require("./lib/video-block");
const { FUNCTION_SERVICE_ACCOUNT, respondWithError } = require("./source-media");

const R2_ACCESS_KEY_ID = defineSecret("CMS_MEDIA_R2_ACCESS_KEY_ID");
const R2_SECRET_ACCESS_KEY = defineSecret("CMS_MEDIA_R2_SECRET_ACCESS_KEY");
const R2_ENDPOINT = defineString("CMS_MEDIA_R2_ENDPOINT", { default: "" });
const R2_BUCKET = defineString("CMS_MEDIA_R2_BUCKET", { default: "" });
const MEDIA_PUBLIC_ORIGIN = defineString("CMS_MEDIA_PUBLIC_ORIGIN", { default: "https://media.njpbs.org" });
const MEDIA_CACHE_PURGE_TOKEN = defineSecret("CMS_MEDIA_CACHE_PURGE_TOKEN");
const MEDIA_ZONE_ID = defineString("CMS_MEDIA_CLOUDFLARE_ZONE_ID", { default: "" });

const MAX_JSON_BYTES = 2 * 1024;
const ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const CONTENT_COLLECTIONS = new Set(["cmsPages", "cmsPosts"]);
const CONTENT_DENIAL = "You do not have permission to publish this content";

function parseRequest(value) {
  const hasContent = value && (Object.hasOwn(value, "collection") || Object.hasOwn(value, "id"));
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some((key) => !["sourceId", "assetId", "collection", "id"].includes(key)) ||
    value.sourceId !== VIDEO_BLOCK_SOURCE_ID ||
    typeof value.assetId !== "string" || !ASSET_ID_PATTERN.test(value.assetId) ||
    (hasContent && (!CONTENT_COLLECTIONS.has(value.collection) ||
      typeof value.id !== "string" || !ASSET_ID_PATTERN.test(value.id)))
  ) {
    throw new SourceMediaValidationError("Request must be {sourceId: \"video-library\", assetId, collection, id}");
  }
  return { sourceId: value.sourceId, assetId: value.assetId, collection: value.collection, id: value.id };
}

function defaultR2() {
  const endpoint = R2_ENDPOINT.value().trim();
  const bucket = R2_BUCKET.value().trim();
  const accessKeyId = R2_ACCESS_KEY_ID.value().trim();
  const secretAccessKey = R2_SECRET_ACCESS_KEY.value().trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    throw new PublicVideoError("The public media store is not configured", 503);
  }
  return { client: new S3Client(r2ClientConfig({ endpoint, accessKeyId, secretAccessKey })), bucket };
}

function createCmsPublishSourceVideoHandler(deps = {}) {
  const firestore = deps.firestore ?? db;
  const requirePrincipalFn = deps.requirePrincipalFn ?? requirePrincipal;
  const registryFn = deps.registryFn ?? runtimeRegistry;
  const authorizeFn = deps.authorizeFn ?? authorizeMediaSource;
  const awsConfigFn = deps.awsConfigFn ?? runtimeAwsConfig;
  const r2Fn = deps.r2Fn ?? defaultR2;
  const publicOriginFn = deps.publicOriginFn ?? (() => MEDIA_PUBLIC_ORIGIN.value());
  const s3ClientFn = deps.s3ClientFn ?? ((source, config) => new S3Client({
    region: config.region,
    credentials: createAwsRoleCredentialProvider({
      roleArn: source.roleArn,
      audience: config.audience,
      region: config.region,
    }),
  }));
  const log = deps.log ?? logger;
  return async (req, res) => {
    try {
      res.set("Cache-Control", "private, no-store");
      if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
      }
      validateBoundedJsonRequest(req, MAX_JSON_BYTES);
      const request = parseRequest(req.body);
      const actor = await requirePrincipalFn(req);
      if (!hasCapability(actor.principal, "content.publish")) {
        throw new PublicVideoError("You do not have permission to publish videos", 403);
      }
      // Functions deploy before Admin. Its old two-field request cannot establish
      // section scope, so only site-wide publishers can use that compatibility path.
      if (!request.collection && !can(actor.principal, "content.publish", {})) {
        throw new SourceMediaValidationError("Request must be {sourceId: \"video-library\", assetId, collection, id}");
      }
      const source = registryFn().get(request.sourceId);
      await authorizeFn({ firestore, actor, source, operation: "read" });
      if (request.collection) {
        const contentSnapshot = await firestore.collection(request.collection).doc(request.id).get();
        const content = contentSnapshot.exists ? contentSnapshot.data() : null;
        if (!content || content.deleted === true) {
          if (!mayAnswerAbsentRecordRead(actor.principal)) {
            throw new PublicVideoError(CONTENT_DENIAL, 403);
          }
          throw new PublicVideoError("Content not found", 404);
        }
        const resource = contentResource({ collection: request.collection, documentId: request.id, stored: content });
        if (!can(actor.principal, "content.publish", resource)) {
          throw new PublicVideoError(CONTENT_DENIAL, 403);
        }
        // The addressed record must actually use this video; an allowed record is not a
        // permit to expose unrelated library items. Hidden rows follow the publish contract.
        const blocks = Array.isArray(content.blocks) ? content.blocks.filter((block) => block && typeof block === "object") : [];
        if (!visibleLayoutBlocks([...leadVideoBlocks(content.leadMedia), ...liveBlogVideoBlocks(content.type === "post" ? content.liveBlog : undefined), ...blocks]).some((block) => block.type === "video" &&
            block.data?.sourceId === request.sourceId && block.data?.assetId === request.assetId)) {
          throw new PublicVideoError("This video is not visible in the saved content", 403);
        }
      }
      const snapshot = await firestore.collection("mediaSourceAssets").doc(request.assetId).get();
      const asset = snapshot.exists ? parseSourceMediaAsset(snapshot.id, snapshot.data()) : null;
      if (!asset || asset.sourceId !== source.id || !objectKeyWithinSource(source, asset.objectKey)) {
        throw new PublicVideoError("Media asset not found", 404);
      }
      const config = awsConfigFn();
      const r2 = r2Fn();
      const copy = await acquirePublicVideoCopy({ firestore, assetId: asset.id, asset });
      let result;
      try {
        result = await publishSourceVideo({
          firestore,
          asset,
          s3: s3ClientFn(source, config),
          r2: r2.client,
          r2Bucket: r2.bucket,
          renditionBucket: config.renditionBucket,
          expectedBucketOwner: config.renditionExpectedBucketOwner,
          publicOrigin: publicOriginFn(),
          actorUid: actor.uid,
          pendingWithdrawalUrls: copy.pendingWithdrawalUrls,
          publicGeneration: copy.publicGeneration,
          writeRecord: record => firestore.runTransaction(async tx => {
            const copyRef = firestore.collection("cmsPublicVideos").doc(asset.id);
            const [currentAsset, currentCopy] = await tx.getAll(
              firestore.collection("mediaSourceAssets").doc(asset.id), copyRef);
            const current = currentAsset.data();
            if (currentCopy.data()?.operation?.id !== copy.operationId || !samePublicVideoSource(current, asset)) {
              throw new PublicVideoError("The video changed while its public copy was being prepared. Publish again shortly.");
            }
            tx.set(copyRef, record);
          }),
        });
      } catch (error) {
        await copy.release();
        throw error;
      }
      log.info("published source video", { assetId: asset.id, copied: result.copied, uid: actor.uid });
      res.status(200).json({ success: true, media: result.media });
    } catch (error) {
      respondWithError(res, log, "publish source video", error);
    }
  };
}

const cmsPublishSourceVideo = cmsOnRequest(
  {
    cors: true,
    maxInstances: 10,
    timeoutSeconds: 540,
    memory: "1GiB",
    cpu: 1,
    concurrency: 4,
    serviceAccount: FUNCTION_SERVICE_ACCOUNT,
    secrets: [R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY],
  },
  createCmsPublishSourceVideoHandler(),
);

function withdrawalDeps(deps) {
  return {
    firestore: db,
    r2Fn: defaultR2,
    purgeConfigFn: () => ({ zoneId: MEDIA_ZONE_ID.value(), token: MEDIA_CACHE_PURGE_TOKEN.value() }),
    log: logger,
    ...deps,
  };
}

function createPublicVideoWithdrawalHandler(deps = {}) {
  return withdrawalHandler(withdrawalDeps(deps));
}

function createPublicVideoWithdrawalRecoveryHandler(deps = {}) {
  return recoveryHandler(withdrawalDeps(deps));
}

const withdrawalOptions = {
  retry: true,
  timeoutSeconds: 300,
  maxInstances: 10,
  secrets: [R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, MEDIA_CACHE_PURGE_TOKEN],
};
const onPublicVideoPostWithdrawal = onDocumentWritten(
  { ...withdrawalOptions, document: "cmsPosts/{id}" }, createPublicVideoWithdrawalHandler(),
);
const onPublicVideoPageWithdrawal = onDocumentWritten(
  { ...withdrawalOptions, document: "cmsPages/{id}" }, createPublicVideoWithdrawalHandler(),
);

const onPublicVideoWithdrawalRecovery = onSchedule({
  schedule: "every 15 minutes",
  timeZone: "UTC",
  timeoutSeconds: 300,
  maxInstances: 1,
  concurrency: 1,
  retryCount: 0,
  secrets: withdrawalOptions.secrets,
}, createPublicVideoWithdrawalRecoveryHandler());

module.exports = {
  defaultR2,
  MEDIA_CACHE_PURGE_TOKEN,
  purgeVideoReplacementCopies: urls => require("./lib/public-video-withdrawal").purgeCopies({ urls,
    config: { zoneId: MEDIA_ZONE_ID.value(), token: MEDIA_CACHE_PURGE_TOKEN.value() }, fetchImpl: fetch }),
  cmsPublishSourceVideo,
  createCmsPublishSourceVideoHandler,
  createPublicVideoWithdrawalHandler,
  createPublicVideoWithdrawalRecoveryHandler,
  onPublicVideoWithdrawalRecovery,
  onPublicVideoPostWithdrawal,
  onPublicVideoPageWithdrawal,
};
