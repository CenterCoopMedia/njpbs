import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { privatePreviewSandbox } from "./process-cms-preview";
import { publicPostRenderEnvironment } from "./public-post-render-environment";
import { assertCmsPublicationSourceCheckout } from "./cms-publication-runtime-guard";
import { assertPublicArtifactInventoryReceipt } from "../src/lib/public-artifact-inventory";
import type { buildFrozenPublication } from "./frozen-publication";
import { BackgroundPreparationError, backgroundPreparationDiagnostic, backgroundRendererStage } from "./background-preparation-diagnostic";

const site = fileURLToPath(new URL("..", import.meta.url));

/** Seal structured content before the unrelated public compiler can fail. */
export async function buildNoBuildCloudPreviewProjection(input: Parameters<typeof buildFrozenPublication>[0], output: string) {
  if (!input.retainedInputDirectory || !/^post-background-[A-Za-z0-9]{20}-[a-f0-9]{64}$/.test(input.buildBatchId)) {
    throw new Error("Preview projection requires retained scoped input");
  }
  await assertCmsPublicationSourceCheckout(input.commitSha);
  await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  const sandbox = await privatePreviewSandbox({ PATH: "/usr/local/bin:/usr/bin:/bin", TZ: "America/New_York",
    CMS_OFFLINE_BUILD: "1", PUBLIC_BUILD_BATCH_ID: input.buildBatchId, PUBLIC_BUILD_COMMIT_SHA: input.commitSha,
    CMS_PREVIEW_INPUT_PATH: path.join(input.retainedInputDirectory, "input.json"),
    LAUNCH_CONTENT_DATA_PATH: "/background/launch-media-manager.json", SPOTLIGHT_NEWS_DATA_PATH: "/background/spotlight-news.json" }, output);
  const args = sandbox.args.slice(0, -1);
  for (const file of ["launch-media-manager.json", "spotlight-news.json", "remote-images.json", "images"]) {
    args.push(file === "images" ? "--ro-bind-try" : "--ro-bind", path.join(input.retainedInputDirectory, file), `/background/${file}`);
  }
  args.push("--ro-bind", await realpath(process.execPath), "/preview/node",
    "--", "/preview/node", "--import", "tsx", path.join(site, "scripts/project-frozen-preview.ts"));
  await new Promise<void>((resolve, reject) => {
    execFile("/usr/bin/bwrap", args, { cwd: site, env: sandbox.environment, timeout: 30_000,
      killSignal: "SIGKILL", maxBuffer: 64 * 1024 }, (error, _stdout, stderr) => error
      ? reject(new BackgroundPreparationError(backgroundPreparationDiagnostic(error, "preview_projection", sandbox.environment, stderr))) : resolve());
  });
}

/** Only checkpointed public inputs cross the preview's offline OS boundary.
 * Activation, Firebase, storage and metadata-service access stay in the parent. */
export async function buildNoBuildCloudBackground(
  input: Parameters<typeof buildFrozenPublication>[0], distDirectory: string,
) {
  let stage = "source_checkout";
  try {
    if (!input.retainedInputDirectory || !/^post-background-[A-Za-z0-9]{20}-[a-f0-9]{64}$/.test(input.buildBatchId)) {
      throw new Error("Cloud background build requires retained scoped input");
    }
    await assertCmsPublicationSourceCheckout(input.commitSha);
    stage = "sandbox_setup";
    await mkdir(path.dirname(distDirectory), { recursive: true, mode: 0o700 });
    const environment = {
      PATH: "/usr/local/bin:/usr/bin:/bin", ASTRO_TELEMETRY_DISABLED: "1", TZ: "America/New_York",
      CMS_OFFLINE_BUILD: "1",
      // Background bytes share the frozen release's Data Hub gate, so a published
      // Data Hub Page is emitted here too (frozen-publication.ts sets the same flag).
      ...publicPostRenderEnvironment({ ...input.buildEnvironment, DATA_HUB_PUBLIC: "1", PUBLIC_ONLY: undefined }),
      CMS_LOADER_STRICT: "1", PUBLIC_BUILD_BATCH_ID: input.buildBatchId,
      PUBLIC_BUILD_COMMIT_SHA: input.commitSha, PUBLIC_ARTIFACT_BATCH_MODE: "background",
      PUBLIC_POST_RENDERER_COMPILE: "0", PUBLIC_ARTIFACT_RETAINED_BUNDLE_PATH: "/preview/input.json",
      PUBLIC_ARTIFACT_RETAINED_IMAGES_PATH: "/background/remote-images.json",
      CMS_PREVIEW_INPUT_PATH: path.join(input.retainedInputDirectory, "input.json"),
      PUBLIC_ARTIFACT_INVENTORY_PATH: "/preview/dist/artifact-inventory.json",
      PUBLIC_ARTIFACT_RETAINED_CONTEXT_PATH: "/preview/dist/public-context.json",
      LAUNCH_CONTENT_DATA_PATH: "/background/launch-media-manager.json",
      SPOTLIGHT_NEWS_DATA_PATH: "/background/spotlight-news.json",
      SCHEDULE_DATA_PATH: "/background/schedule.json",
    };
    const sandbox = await privatePreviewSandbox(environment, distDirectory);
    const args = sandbox.args.slice(0, -1);
    for (const file of ["launch-media-manager.json", "spotlight-news.json", "schedule.json", "remote-images.json", "images"]) {
      args.push(file === "images" ? "--ro-bind-try" : "--ro-bind", path.join(input.retainedInputDirectory, file), `/background/${file}`);
    }
    // Astro and Vite caches are ephemeral; source and dependencies remain read-only.
    args.push("--tmpfs", path.join(site, ".astro"), "--tmpfs", path.join(site, "node_modules/.astro"),
      "--tmpfs", path.join(site, "node_modules/.vite"), "--tmpfs", path.join(site, "node_modules/.vite-temp"), "--bind", distDirectory, path.join(site, "dist"),
      "--", "/usr/bin/node", "--import", "tsx", path.join(site, "scripts/build-with-production-sync.mjs"));
    const childEnvironment: Record<string, string> = { ...sandbox.environment };
    delete childEnvironment.CMS_PREVIEW_INPUT_PATH;
    await new Promise<void>((resolve, reject) => {
      execFile("/usr/bin/bwrap", args, { cwd: site, env: childEnvironment,
        timeout: 300_000, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => error ? reject(new BackgroundPreparationError(
        backgroundPreparationDiagnostic(error, backgroundRendererStage(stdout),
          { ...input.buildEnvironment, ...environment, ...childEnvironment }, stderr))) : resolve());
    });
    stage = "artifact_receipt";
    for (const file of ["artifact-inventory.json", "public-context.json"]) {
      await copyFile(path.join(distDirectory, file), path.join(input.retainedInputDirectory, file));
    }
    const receipt = assertPublicArtifactInventoryReceipt(JSON.parse(await readFile(input.artifactReceiptPath, "utf8")));
    if (receipt.commitSha !== input.commitSha || receipt.buildBatchId !== input.buildBatchId) throw new Error("Cloud background source differs");
    return receipt;
  } catch (error) {
    throw new BackgroundPreparationError(backgroundPreparationDiagnostic(error, stage, input.buildEnvironment ?? {}));
  }
}
