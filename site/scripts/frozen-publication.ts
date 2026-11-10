// Frozen background inputs and builds shared by cloud aggregate preparation.
// No serializer queue listener, claim, upload, activation or settlement lives here.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { assertPublicArtifactInventoryReceipt, type PublicArtifactInventoryReceipt } from "../src/lib/public-artifact-inventory";
import { runCmsPublicationBuild as runBuild } from "./run-cms-publication-build";
import { main as syncSpotlightNews } from "./sync-spotlight-news.mjs";
import { main as syncLaunchContent } from "./sync-launch-content.mjs";
import { main as syncSchedule } from "./sync-schedule.mjs";
import { freezeRetainedPublicImages } from "./retained-public-images";

import { assertCmsPublicationSourceCheckout as assertRuntimeSourceCheckout } from "./cms-publication-runtime-guard";

export interface MediaManagerCredential {
  key: string;
  secret: string;
}

export class CmsPublicationProcessorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CmsPublicationProcessorError";
  }
}

function processorError(message: string): never {
  throw new CmsPublicationProcessorError(message);
}

async function readArtifactReceipt(
  inputPath: string,
): Promise<PublicArtifactInventoryReceipt> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(inputPath, "utf8"));
  } catch {
    processorError("The CMS public artifact receipt is missing or invalid");
  }
  return assertPublicArtifactInventoryReceipt(value);
}

export async function assertCmsPublicationSourceCheckout(expectedCommitSha: string): Promise<void> {
  try { await assertRuntimeSourceCheckout(expectedCommitSha); }
  catch { processorError("The CMS publication source checkout does not match the requested commit"); }
}

function publicationBuildEnvironment({
  buildEnvironment,
  buildBatchId,
  commitSha,
  artifactReceiptPath,
}: {
  buildEnvironment: Record<string, string | undefined>;
  buildBatchId: string;
  commitSha: string;
  artifactReceiptPath: string;
}): Record<string, string | undefined> {
  return {
    ...buildEnvironment,
    FIRESTORE_EMULATOR_HOST: buildEnvironment.FIRESTORE_EMULATOR_HOST,
    FIREBASE_PROJECT_ID: buildEnvironment.FIREBASE_PROJECT_ID,
    GCLOUD_PROJECT: buildEnvironment.GCLOUD_PROJECT,
    GOOGLE_CLOUD_PROJECT: buildEnvironment.GOOGLE_CLOUD_PROJECT,
    GOOGLE_APPLICATION_CREDENTIALS:
      buildEnvironment.GOOGLE_APPLICATION_CREDENTIALS,
    PUBLIC_GA4_REQUIRED: "1",
    PUBLIC_REPORT_REQUIRED: "1",
    PUBLIC_SHARE_REQUIRED: "1",
    CMS_LOADER_STRICT: "1",
    CMS_CONTENT_MODE: "published",
    CMS_PREVIEW_PAGE_ID: undefined,
    CMS_PREVIEW_QUEUE_ID: undefined,
    CMS_PREVIEW_RENDERER_SHA: undefined,
    CMS_PREVIEW_INPUT_PATH: undefined,
    CMS_PREVIEW_INPUT_SHA256: undefined,
    // Seal the public Data Hub capability into the frozen build.
    DATA_HUB_PUBLIC: "1",
    PUBLIC_ONLY: undefined,
    INTERNAL_SURFACES: undefined,
    WORKERS_CI: undefined,
    WORKERS_CI_BRANCH: undefined,
    REQUIRE_FRESH_CONTENT: "1",
    LAUNCH_CONTENT_OUTPUT: path.join(
      path.dirname(artifactReceiptPath),
      "launch-media-manager.json",
    ),
    LAUNCH_CONTENT_DATA_PATH: path.join(
      path.dirname(artifactReceiptPath),
      "launch-media-manager.json",
    ),
    SPOTLIGHT_NEWS_OUTPUT: path.join(
      path.dirname(artifactReceiptPath),
      "spotlight-news.json",
    ),
    SCHEDULE_OUTPUT: path.join(
      path.dirname(artifactReceiptPath),
      "schedule.json",
    ),
    SCHEDULE_DATA_PATH: path.join(
      path.dirname(artifactReceiptPath),
      "schedule.json",
    ),
    SPOTLIGHT_NEWS_DATA_PATH: path.join(
      path.dirname(artifactReceiptPath),
      "spotlight-news.json",
    ),
    PUBLIC_ARTIFACT_BUNDLE_PATH: undefined,
    PUBLIC_ARTIFACT_RETAINED_BUNDLE_PATH: undefined,
    PUBLIC_ARTIFACT_RETAINED_IMAGES_PATH: undefined,
    CMS_OFFLINE_BUILD: undefined,
    CMS_RETAINED_IMAGES_READY: undefined,
    PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION: undefined,
    PUBLIC_ARTIFACT_RETAINED_CONTEXT_PATH: path.join(path.dirname(artifactReceiptPath), "public-context.json"),
    PUBLIC_BUILD_BATCH_ID: buildBatchId,
    PUBLIC_BUILD_COMMIT_SHA: commitSha,
    PUBLIC_ARTIFACT_INVENTORY_PATH: artifactReceiptPath,
  };
}

export async function freezeBackgroundPublicationInputs({ buildBatchId, commitSha, artifactReceiptPath,
  buildEnvironment = {}, mediaManagerCredential, retainedInputDirectory }: {
  buildBatchId: string; commitSha: string; artifactReceiptPath: string;
  buildEnvironment?: Record<string, string | undefined>; mediaManagerCredential?: MediaManagerCredential;
  retainedInputDirectory?: string;
}): Promise<string[]> {
  await assertCmsPublicationSourceCheckout(commitSha);
  const environment = publicationBuildEnvironment({ buildBatchId, commitSha, artifactReceiptPath, buildEnvironment });
  await syncLaunchContent(mediaManagerCredential ? { ...environment,
    MEDIA_MANAGER_API_KEY: mediaManagerCredential.key, MEDIA_MANAGER_API_SECRET: mediaManagerCredential.secret } : environment);
  await syncSpotlightNews(environment);
  await syncSchedule(environment);
  return retainedInputDirectory ? freezeRetainedPublicImages(retainedInputDirectory, { buildBatchId, commitSha }) : [];
}

/** Build from a retained, digest-verified input without another historical read
 * or external-content refresh. The caller owns reservation and checkpoints. */
export async function buildFrozenPublication({ buildBatchId, commitSha, artifactReceiptPath,
  buildEnvironment = {}, mediaManagerCredential, retainedInputDirectory }: {
  buildBatchId: string; commitSha: string; artifactReceiptPath: string;
  buildEnvironment?: Record<string, string | undefined>; mediaManagerCredential?: MediaManagerCredential;
  retainedInputDirectory?: string;
}): Promise<PublicArtifactInventoryReceipt> {
  await assertCmsPublicationSourceCheckout(commitSha);
  const environment = publicationBuildEnvironment({ buildBatchId, commitSha, artifactReceiptPath, buildEnvironment });
  if (retainedInputDirectory) {
    environment.CMS_OFFLINE_BUILD = "1";
    environment.PUBLIC_ARTIFACT_RETAINED_BUNDLE_PATH = path.join(retainedInputDirectory, "input.json");
    environment.PUBLIC_ARTIFACT_RETAINED_IMAGES_PATH = path.join(retainedInputDirectory, "remote-images.json");
    environment.LAUNCH_CONTENT_DATA_PATH = path.join(retainedInputDirectory, "launch-media-manager.json");
    environment.SPOTLIGHT_NEWS_DATA_PATH = path.join(retainedInputDirectory, "spotlight-news.json");
    environment.SCHEDULE_DATA_PATH = path.join(retainedInputDirectory, "schedule.json");
  } else {
    await freezeBackgroundPublicationInputs({ buildBatchId, commitSha, artifactReceiptPath, buildEnvironment, mediaManagerCredential });
  }
  await runBuild(environment);
  return readArtifactReceipt(artifactReceiptPath);
}
