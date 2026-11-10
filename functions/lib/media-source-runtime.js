"use strict";

// Deployment parameters and the enabled media-source registry. Kept apart from source-media.js
// so the eager media list can read the registry for tab counts without loading the AWS SDK.

const { defineString } = require("firebase-functions/params");
const { buildMediaSourceRegistry } = require("./media-sources");

const AWS_REGION = "us-east-2";
const AWS_IDENTITY_AUDIENCE = defineString("CMS_MEDIA_AWS_AUDIENCE", {
  default: "njpbs-boardwalk-s3",
});
const AWS_VIDEO_ENABLED = defineString("CMS_MEDIA_AWS_VIDEO_ENABLED", { default: "false" });
const AWS_VIDEO_ACCOUNT_ID = defineString("CMS_MEDIA_AWS_VIDEO_ACCOUNT_ID", { default: "" });
const AWS_VIDEO_BUCKET = defineString("CMS_MEDIA_AWS_VIDEO_BUCKET", { default: "" });
const AWS_VIDEO_PREFIX = defineString("CMS_MEDIA_AWS_VIDEO_PREFIX", { default: "" });
const AWS_VIDEO_ROLE_ARN = defineString("CMS_MEDIA_AWS_VIDEO_ROLE_ARN", { default: "" });
const AWS_RENDITION_BUCKET = defineString("CMS_MEDIA_AWS_RENDITION_BUCKET", { default: "" });
const REPLACEMENT_CLEANUP_ROLE = defineString("CMS_VIDEO_REPLACEMENT_CLEANUP_ROLE_ARN", { default: "" });
const REPLACEMENT_REPLICA_BUCKET = defineString("CMS_VIDEO_REPLACEMENT_REPLICA_BUCKET", { default: "" });
const REPLACEMENT_DRY_RUN = defineString("CMS_VIDEO_REPLACEMENT_CLEANUP_DRY_RUN", { default: "true" });
function videoReplacementRuntimeConfig() {
  const cleanupRoleArn = REPLACEMENT_CLEANUP_ROLE.value(), dryRun = REPLACEMENT_DRY_RUN.value() !== "false";
  const replicaBucket = REPLACEMENT_REPLICA_BUCKET.value();
  return { cleanupRoleArn, replicaBucket, dryRun, enabled: Boolean(cleanupRoleArn && replicaBucket) && !dryRun };
}
const AWS_ARCHIVE_ENABLED = defineString("CMS_MEDIA_AWS_ARCHIVE_ENABLED", { default: "false" });
const AWS_ARCHIVE_ACCOUNT_ID = defineString("CMS_MEDIA_AWS_ARCHIVE_ACCOUNT_ID", { default: "" });
const AWS_ARCHIVE_ORIGINALS_BUCKET = defineString(
  "CMS_MEDIA_AWS_ARCHIVE_ORIGINALS_BUCKET",
  { default: "" },
);
const AWS_ARCHIVE_ORIGINALS_PREFIX = defineString(
  "CMS_MEDIA_AWS_ARCHIVE_ORIGINALS_PREFIX",
  { default: "" },
);
const AWS_ARCHIVE_WORKING_BUCKET = defineString(
  "CMS_MEDIA_AWS_ARCHIVE_WORKING_BUCKET",
  { default: "" },
);
const AWS_ARCHIVE_WORKING_PREFIX = defineString(
  "CMS_MEDIA_AWS_ARCHIVE_WORKING_PREFIX",
  { default: "" },
);
const AWS_ARCHIVE_ROLE_ARN = defineString("CMS_MEDIA_AWS_ARCHIVE_ROLE_ARN", { default: "" });

function runtimeRegistry() {
  return buildMediaSourceRegistry({
    videoEnabled: AWS_VIDEO_ENABLED.value(),
    videoAccountId: AWS_VIDEO_ACCOUNT_ID.value(),
    videoBucket: AWS_VIDEO_BUCKET.value(),
    videoPrefix: AWS_VIDEO_PREFIX.value(),
    videoRoleArn: AWS_VIDEO_ROLE_ARN.value(),
    archiveEnabled: AWS_ARCHIVE_ENABLED.value(),
    archiveAccountId: AWS_ARCHIVE_ACCOUNT_ID.value(),
    archiveOriginalsBucket: AWS_ARCHIVE_ORIGINALS_BUCKET.value(),
    archiveOriginalsPrefix: AWS_ARCHIVE_ORIGINALS_PREFIX.value(),
    archiveWorkingBucket: AWS_ARCHIVE_WORKING_BUCKET.value(),
    archiveWorkingPrefix: AWS_ARCHIVE_WORKING_PREFIX.value(),
    archiveRoleArn: AWS_ARCHIVE_ROLE_ARN.value(),
  });
}

function runtimeAwsConfig() {
  return {
    audience: AWS_IDENTITY_AUDIENCE.value(),
    region: AWS_REGION,
    renditionBucket: AWS_RENDITION_BUCKET.value(),
    renditionExpectedBucketOwner: AWS_VIDEO_ACCOUNT_ID.value(),
  };
}

module.exports = {
  AWS_REGION,
  runtimeAwsConfig,
  runtimeRegistry,
  videoReplacementRuntimeConfig,
};
