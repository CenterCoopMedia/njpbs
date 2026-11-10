import { execFileSync } from "node:child_process";
import { build } from "astro";
import joinedRecords from "../../functions/lib/joined-records.js";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main as syncSchedule } from "./sync-schedule.mjs";
import { isPublicOnlyBuild } from "../src/lib/build-target.ts";
import { publicPostRenderEnvironment } from "./public-post-render-environment.ts";
import { installRetainedPublicImages } from "./retained-public-images.ts";
import {
  resolveCmsContentMode,
  resolvePublicArtifactBuildRequest,
} from "../src/lib/cms-loader.ts";
import { preparePublicArtifactBundle } from "../src/lib/public-artifact-build.ts";
import { retainPublicContext } from "../src/lib/retained-public-context.ts";
import {
  finalizePublicArtifactInventoryReceipt,
} from "../src/lib/public-artifact-inventory.ts";
import {
  PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION,
  readPublicArtifactBundle,
} from "../src/lib/public-artifact-bundle.ts";

const distDir = fileURLToPath(new URL("../dist", import.meta.url));
const siteRoot = fileURLToPath(new URL("..", import.meta.url));

function recordPublicBuildTiming(request, stage) {
  if (!request) return;
  console.log(JSON.stringify({
    event: "cms_public_build_timing",
    buildBatchId: request.buildBatchId,
    stage,
    at: new Date().toISOString(),
  }));
}

function temporaryBuildEnvironment(env) {
  const previous = new Map();
  const set = (field, value) => {
    // config-input: CMS_CONTENT_MODE, CMS_DEPLOYMENT_ENVIRONMENT, CMS_DEV_FROZEN_BUILD, CMS_OFFLINE_BUILD
    // config-input: CMS_RETAINED_IMAGES_READY, DATA_HUB_PUBLIC, NODE_ENV, PATH, PUBLIC_ARTIFACT_BATCH_MODE
    // config-input: PUBLIC_ARTIFACT_BUNDLE_PATH, PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION, PUBLIC_ARTIFACT_INVENTORY_PATH
    // config-input: PUBLIC_ARTIFACT_RETAINED_BUNDLE_PATH, PUBLIC_ARTIFACT_RETAINED_CONTEXT_PATH
    // config-input: PUBLIC_ARTIFACT_RETAINED_IMAGES_PATH, PUBLIC_BUILD_BATCH_ID, PUBLIC_BUILD_COMMIT_SHA
    // config-input: PUBLIC_GA4_MEASUREMENT_ID, PUBLIC_GA4_REQUIRED, PUBLIC_POST_RENDERER_COMPILE, PUBLIC_REPORT_ENDPOINT
    // config-input: PUBLIC_REPORT_REQUIRED, PUBLIC_SHARE_INTAKE_ENDPOINT, PUBLIC_SHARE_PAGE, PUBLIC_SHARE_REQUIRED
    // config-input: PUBLIC_SHARE_UPLOAD_ORIGIN, PUBLIC_TURNSTILE_SITEKEY, WORKERS_CI, WORKERS_CI_BRANCH
    if (!previous.has(field)) previous.set(field, process.env[field]);
    // config-input: CMS_CONTENT_MODE, CMS_DEPLOYMENT_ENVIRONMENT, CMS_DEV_FROZEN_BUILD, CMS_OFFLINE_BUILD
    // config-input: CMS_RETAINED_IMAGES_READY, DATA_HUB_PUBLIC, NODE_ENV, PATH, PUBLIC_ARTIFACT_BATCH_MODE
    // config-input: PUBLIC_ARTIFACT_BUNDLE_PATH, PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION, PUBLIC_ARTIFACT_INVENTORY_PATH
    // config-input: PUBLIC_ARTIFACT_RETAINED_BUNDLE_PATH, PUBLIC_ARTIFACT_RETAINED_CONTEXT_PATH
    // config-input: PUBLIC_ARTIFACT_RETAINED_IMAGES_PATH, PUBLIC_BUILD_BATCH_ID, PUBLIC_BUILD_COMMIT_SHA
    // config-input: PUBLIC_GA4_MEASUREMENT_ID, PUBLIC_GA4_REQUIRED, PUBLIC_POST_RENDERER_COMPILE, PUBLIC_REPORT_ENDPOINT
    // config-input: PUBLIC_REPORT_REQUIRED, PUBLIC_SHARE_INTAKE_ENDPOINT, PUBLIC_SHARE_PAGE, PUBLIC_SHARE_REQUIRED
    // config-input: PUBLIC_SHARE_UPLOAD_ORIGIN, PUBLIC_TURNSTILE_SITEKEY, WORKERS_CI, WORKERS_CI_BRANCH
    if (value === undefined) delete process.env[field];
    // config-input: CMS_CONTENT_MODE, CMS_DEPLOYMENT_ENVIRONMENT, CMS_DEV_FROZEN_BUILD, CMS_OFFLINE_BUILD
    // config-input: CMS_RETAINED_IMAGES_READY, DATA_HUB_PUBLIC, NODE_ENV, PATH, PUBLIC_ARTIFACT_BATCH_MODE
    // config-input: PUBLIC_ARTIFACT_BUNDLE_PATH, PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION, PUBLIC_ARTIFACT_INVENTORY_PATH
    // config-input: PUBLIC_ARTIFACT_RETAINED_BUNDLE_PATH, PUBLIC_ARTIFACT_RETAINED_CONTEXT_PATH
    // config-input: PUBLIC_ARTIFACT_RETAINED_IMAGES_PATH, PUBLIC_BUILD_BATCH_ID, PUBLIC_BUILD_COMMIT_SHA
    // config-input: PUBLIC_GA4_MEASUREMENT_ID, PUBLIC_GA4_REQUIRED, PUBLIC_POST_RENDERER_COMPILE, PUBLIC_REPORT_ENDPOINT
    // config-input: PUBLIC_REPORT_REQUIRED, PUBLIC_SHARE_INTAKE_ENDPOINT, PUBLIC_SHARE_PAGE, PUBLIC_SHARE_REQUIRED
    // config-input: PUBLIC_SHARE_UPLOAD_ORIGIN, PUBLIC_TURNSTILE_SITEKEY, WORKERS_CI, WORKERS_CI_BRANCH
    else process.env[field] = value;
  };
  for (const [field, value] of Object.entries(env)) set(field, value);
  return {
    set,
    restore() {
      for (const [field, value] of previous) {
        // config-input: CMS_CONTENT_MODE, CMS_DEPLOYMENT_ENVIRONMENT, CMS_DEV_FROZEN_BUILD, CMS_OFFLINE_BUILD
        // config-input: CMS_RETAINED_IMAGES_READY, DATA_HUB_PUBLIC, NODE_ENV, PATH, PUBLIC_ARTIFACT_BATCH_MODE
        // config-input: PUBLIC_ARTIFACT_BUNDLE_PATH, PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION, PUBLIC_ARTIFACT_INVENTORY_PATH
        // config-input: PUBLIC_ARTIFACT_RETAINED_BUNDLE_PATH, PUBLIC_ARTIFACT_RETAINED_CONTEXT_PATH
        // config-input: PUBLIC_ARTIFACT_RETAINED_IMAGES_PATH, PUBLIC_BUILD_BATCH_ID, PUBLIC_BUILD_COMMIT_SHA
        // config-input: PUBLIC_GA4_MEASUREMENT_ID, PUBLIC_GA4_REQUIRED, PUBLIC_POST_RENDERER_COMPILE, PUBLIC_REPORT_ENDPOINT
        // config-input: PUBLIC_REPORT_REQUIRED, PUBLIC_SHARE_INTAKE_ENDPOINT, PUBLIC_SHARE_PAGE, PUBLIC_SHARE_REQUIRED
        // config-input: PUBLIC_SHARE_UPLOAD_ORIGIN, PUBLIC_TURNSTILE_SITEKEY, WORKERS_CI, WORKERS_CI_BRANCH
        if (value === undefined) delete process.env[field];
        // config-input: CMS_CONTENT_MODE, CMS_DEPLOYMENT_ENVIRONMENT, CMS_DEV_FROZEN_BUILD, CMS_OFFLINE_BUILD
        // config-input: CMS_RETAINED_IMAGES_READY, DATA_HUB_PUBLIC, NODE_ENV, PATH, PUBLIC_ARTIFACT_BATCH_MODE
        // config-input: PUBLIC_ARTIFACT_BUNDLE_PATH, PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION, PUBLIC_ARTIFACT_INVENTORY_PATH
        // config-input: PUBLIC_ARTIFACT_RETAINED_BUNDLE_PATH, PUBLIC_ARTIFACT_RETAINED_CONTEXT_PATH
        // config-input: PUBLIC_ARTIFACT_RETAINED_IMAGES_PATH, PUBLIC_BUILD_BATCH_ID, PUBLIC_BUILD_COMMIT_SHA
        // config-input: PUBLIC_GA4_MEASUREMENT_ID, PUBLIC_GA4_REQUIRED, PUBLIC_POST_RENDERER_COMPILE, PUBLIC_REPORT_ENDPOINT
        // config-input: PUBLIC_REPORT_REQUIRED, PUBLIC_SHARE_INTAKE_ENDPOINT, PUBLIC_SHARE_PAGE, PUBLIC_SHARE_REQUIRED
        // config-input: PUBLIC_SHARE_UPLOAD_ORIGIN, PUBLIC_TURNSTILE_SITEKEY, WORKERS_CI, WORKERS_CI_BRANCH
        else process.env[field] = value;
      }
    },
  };
}

/**
 * Generate the Pagefind search index over the emitted tree (#226).
 *
 * This lives in the build rather than as a step each pipeline remembers to add.
 * Six workflows plus three npm entrypoints run a build followed by the guardrail
 * scan, and the scope guard (scripts/pagefind-scope-dist.test.ts) requires an
 * index on a full build. Wiring it per-pipeline meant editing every one of them,
 * and the next pipeline anyone adds would fail for a reason that looks unrelated
 * to search. Generating it here makes the index a property of "the site was
 * built", which is what it actually is.
 *
 * PUBLIC_ONLY is the one build mode that must NOT be indexed, and the reason is
 * a leak rather than a preference. That build emits the coming-soon apex, the
 * 404, and the /wiki/ tree, which renders in every build mode (see
 * src/lib/build-target.ts). Its apex renders through Base, not PublicSiteLayout,
 * so no page carries data-pagefind-body — and Pagefind's opt-in is
 * all-or-nothing: with no tagged page anywhere, it indexes everything it finds.
 * Measured on this site, a PUBLIC_ONLY build indexed 19 pages, 17 of them the
 * wiki. The scope guard asserts both halves of this, so a change that drops this
 * condition fails instead of adding the wiki to site-wide search.
 */
export async function buildSearchIndex(directory = distDir) {
  const pagefind = await import("pagefind");
  const { index, errors: createErrors } = await pagefind.createIndex();
  if (createErrors?.length) {
    throw new Error(`pagefind: could not create index: ${createErrors.join("; ")}`);
  }

  const { errors: addErrors } = await index.addDirectory({ path: directory });
  if (addErrors?.length) {
    throw new Error(`pagefind: could not read ${directory}: ${addErrors.join("; ")}`);
  }

  const linked = JSON.parse(await readFile(path.join(directory, "search/content-links.json"), "utf8").catch(error => { if (error.code === "ENOENT") return "[]"; throw error; }));
  for (const record of linked) {
    const { errors } = await index.addCustomRecord({ url: record.path, content: `${record.title} ${record.text}`, language: "en",
      meta: { title: record.title, contentLinkUrl: record.contentLinkUrl, contentLinkNewTab: String(record.contentLinkNewTab !== false) } });
    if (errors.length) throw new Error("The linked content search record is invalid");
  }
  const { errors: writeErrors } = await index.writeFiles({
    outputPath: path.join(directory, "pagefind"),
  });
  if (writeErrors?.length) {
    throw new Error(`pagefind: could not write the index: ${writeErrors.join("; ")}`);
  }

  await pagefind.close();
}

export async function runBuild(env = process.env, programImageReaders) {
  const environment = temporaryBuildEnvironment(env);
  let temporaryDirectory;
  let request = null;
  let restoreImageFetch;
  try {
    environment.set("CMS_RETAINED_IMAGES_READY", undefined);
    if (env.WORKERS_CI === "1" && env.WORKERS_CI_BRANCH === "production") {
      await syncSchedule(env);
    }

    const publicSettings = [
      env.PUBLIC_BUILD_BATCH_ID,
      env.PUBLIC_BUILD_COMMIT_SHA,
      env.PUBLIC_ARTIFACT_INVENTORY_PATH,
    ];
    const publicSettingCount = publicSettings.filter(
      (value) => typeof value === "string" && value.trim() !== "",
    ).length;
    if (publicSettingCount !== 0 && publicSettingCount !== publicSettings.length) {
      throw new Error(
        "PUBLIC_BUILD_BATCH_ID, PUBLIC_BUILD_COMMIT_SHA, and PUBLIC_ARTIFACT_INVENTORY_PATH must be configured together",
      );
    }
    if (env.PUBLIC_ARTIFACT_RETAINED_CONTEXT_PATH && publicSettingCount === 0) {
      throw new Error("Retaining public context requires an exact public artifact build");
    }

    if (publicSettingCount > 0) {
      if (isPublicOnlyBuild(env)) {
        throw new Error("Public artifact inventory requires the full published build");
      }
      temporaryDirectory = await mkdtemp(
        path.join(tmpdir(), "njpbs-public-artifact-"),
      );
      const frozenDev = env.CMS_DEPLOYMENT_ENVIRONMENT === "development" && env.CMS_DEV_FROZEN_BUILD === "1";
      const retainedBundle = env.PUBLIC_ARTIFACT_RETAINED_BUNDLE_PATH;
      if (retainedBundle && env.PUBLIC_ARTIFACT_BATCH_MODE !== "background") throw new Error("Retained preparation requires a background build");
      const bundlePath = retainedBundle || (frozenDev ? env.PUBLIC_ARTIFACT_BUNDLE_PATH : path.join(temporaryDirectory, "bundle.json"));
      if (!bundlePath || !path.isAbsolute(bundlePath)) throw new Error("Frozen dev bundle path is required");
      for (const [field, value] of Object.entries({
        PUBLIC_ARTIFACT_BUNDLE_PATH: bundlePath,
        PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION: String(PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION),
        PUBLIC_BUILD_BATCH_ID: env.PUBLIC_BUILD_BATCH_ID,
        PUBLIC_BUILD_COMMIT_SHA: env.PUBLIC_BUILD_COMMIT_SHA,
        PUBLIC_ARTIFACT_INVENTORY_PATH: env.PUBLIC_ARTIFACT_INVENTORY_PATH,
      })) {
        environment.set(field, value);
      }
      request = resolvePublicArtifactBuildRequest(
        resolveCmsContentMode(env),
        {
          ...env,
          PUBLIC_ARTIFACT_BUNDLE_PATH: bundlePath,
          PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION: String(PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION),
        },
      );
      if (!request) {
        throw new Error("The public artifact bundle request is missing");
      }
      if (frozenDev || retainedBundle) {
        const frozen = await readPublicArtifactBundle(bundlePath);
        if (frozen.receipt.buildBatchId !== request.buildBatchId || frozen.receipt.commitSha !== request.commitSha) {
          throw new Error("Frozen dev bundle identity differs");
        }
        if (retainedBundle) {
          if (env.CMS_OFFLINE_BUILD !== "1") throw new Error("Retained background build requires the offline signal");
          if (!env.PUBLIC_ARTIFACT_RETAINED_IMAGES_PATH) throw new Error("Retained background images are missing");
          restoreImageFetch = await installRetainedPublicImages(env.PUBLIC_ARTIFACT_RETAINED_IMAGES_PATH,
            { buildBatchId: request.buildBatchId, commitSha: request.commitSha });
          environment.set("CMS_RETAINED_IMAGES_READY", "1");
        }
      } else {
        await preparePublicArtifactBundle(request, new Date(), env);
      }
      recordPublicBuildTiming(request, "firestore_artifact_read_complete");
    }

    recordPublicBuildTiming(request, "astro_build_started");
    // Retained builds must not reuse a warm owner's remote-image cache. Both
    // owners generate derivatives from the same sealed original bytes.
    await build({ root: siteRoot, ...(env.PUBLIC_ARTIFACT_RETAINED_BUNDLE_PATH
      ? { cacheDir: path.join(temporaryDirectory, "astro-cache") } : {}) });
    recordPublicBuildTiming(request, "astro_build_complete");

    if (!isPublicOnlyBuild(env)) {
      recordPublicBuildTiming(request, "pagefind_started");
      await buildSearchIndex();
      recordPublicBuildTiming(request, "pagefind_complete");
    }

    // Both indexers have consumed this build-only handoff. Publication does not
    // refresh it, so shipping it would retain withdrawn custom-link metadata.
    await rm(path.join(distDir, "search/content-links.json"), { force: true });

    if (request && env.PUBLIC_POST_RENDERER_COMPILE !== "0") {
      execFileSync(process.execPath, [path.join(siteRoot, "node_modules/tsx/dist/cli.mjs"), path.join(siteRoot, "scripts/build-public-post-renderer.ts")], {
        cwd: siteRoot, env: { PATH: process.env.PATH, ...publicPostRenderEnvironment(env) }, stdio: "inherit",
      });
    }
    if (request) {
      const bundle = await readPublicArtifactBundle(request.bundlePath);
      await finalizePublicArtifactInventoryReceipt({
        receipt: bundle.receipt,
        recordContextPostPaths: (bundle.posts ?? []).filter(post => joinedRecords.joinedRecordIds(post.blocks).length > 0).map(post => post.path),
        distDirectory: distDir,
        outputPath: request.outputPath,
      });
      if (env.PUBLIC_ARTIFACT_RETAINED_CONTEXT_PATH) {
        await retainPublicContext({ bundle,
          outputPath: env.PUBLIC_ARTIFACT_RETAINED_CONTEXT_PATH, distDirectory: distDir,
          ...(programImageReaders === undefined ? {} : { programImageReaders }) });
      }
      recordPublicBuildTiming(request, "artifact_inventory_complete");
    }
  } finally {
    restoreImageFetch?.();
    environment.restore();
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  runBuild().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
