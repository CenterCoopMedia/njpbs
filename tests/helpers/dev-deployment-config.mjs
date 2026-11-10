import { readFileSync, writeFileSync } from "node:fs";
import { repositoryFixture } from "./repository-identity.mjs";

export const devDeploymentEnvironment = Object.freeze({
  ...repositoryFixture,
  CMS_DEV_CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  CMS_DEV_FIREBASE_WEB_APP_ID: `1:123456789013:web:${"a".repeat(32)}`,
  FIREBASE_WEB_APP_ID: `1:123456789013:web:${"a".repeat(32)}`,
});

export function devFunctionsEnvironment(targets, root = new URL("../../", import.meta.url)) {
  const template = readFileSync(new URL("functions/.env.example", root), "utf8");
  const fields = Object.fromEntries(template.split(/\r?\n/).filter(line => line && !line.startsWith("#"))
    .map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  Object.assign(fields, {
    CMS_DEPLOYMENT_ENVIRONMENT: "development", CMS_DEV_REPORT_INTAKE_MODE: "stored-only",
    CMS_WRITEBACK_CONFIGURED: "true", CMS_PUBLISH_TRANSPORT: "github",
    CMS_PUBLISH_GITHUB_REPOSITORY: repositoryFixture.CANONICAL_GITHUB_REPOSITORY,
    CMS_MEDIA_R2_BUCKET: targets.CMS_MEDIA_BUCKET, CMS_MEDIA_PUBLIC_ORIGIN: targets.CMS_MEDIA_ORIGIN,
    CMS_PREVIEW_SERIALIZER_READY: "false", CMS_PREVIEW_RENDERER_SHA: "",
    CMS_MEDIA_AWS_AUDIENCE: "", CMS_MEDIA_AWS_VIDEO_ENABLED: "false",
    CMS_MEDIA_AWS_VIDEO_ACCOUNT_ID: "", CMS_MEDIA_AWS_VIDEO_BUCKET: "", CMS_MEDIA_AWS_VIDEO_PREFIX: "",
    CMS_MEDIA_AWS_VIDEO_ROLE_ARN: "", CMS_MEDIA_AWS_ARCHIVE_ENABLED: "false", CMS_MEDIA_AWS_ARCHIVE_ACCOUNT_ID: "",
    CMS_MEDIA_AWS_ARCHIVE_ORIGINALS_BUCKET: "", CMS_MEDIA_AWS_ARCHIVE_ORIGINALS_PREFIX: "",
    CMS_MEDIA_AWS_ARCHIVE_WORKING_BUCKET: "", CMS_MEDIA_AWS_ARCHIVE_WORKING_PREFIX: "", CMS_MEDIA_AWS_ARCHIVE_ROLE_ARN: "",
    CMS_READER_BRIDGE_ENABLED: "false", CMS_READER_BRIDGE_OPERATION_ID: "",
    CMS_READER_BRIDGE_FUNCTIONS_CANDIDATE: "", CMS_READER_BRIDGE_CMS_API_CANDIDATE: "",
    PUBLIC_RELEASE_READERS_ENABLED: "false", PUBLIC_RELEASE_COMPOSED_READERS_ENABLED: "false",
  });
  return Object.entries(fields).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
}

export function writeDevFunctionsEnvironment(filename, targets) {
  writeFileSync(filename, devFunctionsEnvironment(targets), { mode: 0o600 });
}
