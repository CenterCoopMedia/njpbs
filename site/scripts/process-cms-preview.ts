import { previewDiagnostics } from "./preview-diagnostics.ts";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { Firestore } from "firebase-admin/firestore";
import { readCmsPreviewInput, resolveCmsPreviewInput, type CmsPreviewInput } from "../src/lib/cms-preview-input.ts";
import { exportPreviewLibraryCards } from "../src/lib/record-card-resolution.ts";
import { readPreviewPublicContext } from "./read-preview-public-context.ts";
import { EditorialPreviewContextNotReadyError } from "./cms-preview-editorial-context.ts";
import { assertCmsPreviewSourceCheckout, assertCmsPublicationDirectoriesSeparated } from "./cms-publication-runtime-guard.ts";
import { preparePrivatePreview } from "./prepare-private-preview.mjs";
import { previewOutputTarget } from "./preview-output-target.mjs";
import { readPreviewHomeHeroPages } from "./preview-home-hero-pages.ts";

const require = createRequire(import.meta.url);
const { claimCmsPreviewQueue, finishCmsPreviewQueue, setCmsPreviewContextRefreshing } = require("../../functions/lib/cms-preview-serializer.js");
const { timestampMillis } = require("../../functions/lib/public-deployment.js");
const { PREVIEW_HEADS_COLLECTION, previewContentKey } = require("../../functions/lib/preview-target.js");
const siteDirectory = fileURLToPath(new URL("..", import.meta.url));

type PreviewArtifact = Awaited<ReturnType<typeof preparePrivatePreview>>;
interface PreviewClaim {
  queueId: string;
  rendererSha: string;
  serializerId: string;
  claimToken: string;
}
interface PreviewDependencies {
  assertSource: typeof assertCmsPreviewSourceCheckout;
  claim: typeof claimCmsPreviewQueue;
  finish: typeof finishCmsPreviewQueue;
  readPublicContext: (onRefreshing?: () => Promise<void>) => Promise<Awaited<ReturnType<typeof readPreviewPublicContext>> & {
    verifyBeforeFreeze?: () => Promise<void>;
  }>;
  setRefreshing: typeof setCmsPreviewContextRefreshing;
  build: typeof buildPrivatePreview;
  prepare: typeof preparePrivatePreview;
}

/** No shell, ambient secret, NODE_OPTIONS or inherited credential descriptor. */
export function privatePreviewBuildEnvironment(inputPath: string, sha256: string, claim: PreviewClaim, pageId: string,
  collection = "cmsPages", persistent = false, deploymentEnvironment = "production") {
  const environment = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    NODE_ENV: "production",
    ASTRO_TELEMETRY_DISABLED: "1",
    CMS_OFFLINE_BUILD: "1",
    TZ: "America/New_York",
    CMS_CONTENT_MODE: "draft",
    CMS_PREVIEW_PAGE_ID: pageId,
    CMS_PREVIEW_QUEUE_ID: claim.queueId,
    CMS_PREVIEW_RENDERER_SHA: claim.rendererSha,
    CMS_PREVIEW_INPUT_PATH: inputPath,
    CMS_PREVIEW_INPUT_SHA256: sha256,
    ...(collection === "cmsPosts" ? { CMS_PREVIEW_COLLECTION: collection } : {}),
    ...(persistent ? { CMS_PREVIEW_PERSISTENT: "1" } : {}),
    // Environment-aware layouts must render the dev branches in a dev preview.
    ...(deploymentEnvironment === "development" ? { CMS_DEPLOYMENT_ENVIRONMENT: "development" } : {}),
  };
  resolveCmsPreviewInput(environment);
  return environment;
}

async function assertPrivateBuildOutput(outputDirectory: string) {
  // Never let a stale symlink or broad caller-supplied path write outside the job.
  if (!path.isAbsolute(outputDirectory) || path.basename(outputDirectory) !== "dist") {
    throw new Error("Private preview output must be a job dist directory");
  }
  const parent = await lstat(path.dirname(outputDirectory));
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) {
    throw new Error("Private preview output requires an owner-only job directory");
  }
  await mkdir(outputDirectory, { mode: 0o700 }).catch(error => {
    if (error.code !== "EEXIST") throw error;
  });
  const output = await lstat(outputDirectory);
  if (!output.isDirectory() || output.uid !== process.getuid?.() || (output.mode & 0o077) !== 0) {
    throw new Error("Private preview output must be an owner-only directory");
  }
}

export async function privatePreviewSandbox(environment: Record<string, string>, outputDirectory: string) {
  if (environment.CMS_OFFLINE_BUILD !== "1") throw new Error("Offline build signal is missing");
  await assertPrivateBuildOutput(outputDirectory);
  const repository = path.resolve(siteDirectory, "..");
  const dependencies = [...new Set(await Promise.all([
    realpath(path.join(repository, "node_modules")), realpath(path.join(siteDirectory, "node_modules")),
  ]))];
  const args = ["--unshare-all", "--unshare-user", "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    "--ro-bind", "/etc/passwd", "/etc/passwd",
    "--ro-bind", repository, repository];
  for (const directory of dependencies) args.push("--ro-bind", directory, directory);
  const gitPath = path.join(repository, ".git");
  const git = await lstat(gitPath).catch(error => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (git?.isFile()) args.push("--ro-bind", "/dev/null", gitPath);
  else if (git) args.push("--tmpfs", gitPath);

  // Templates and release assets stay read-only. Content rendering needs only
  // its frozen input and output mount; no compiler or shared build cache runs.
  args.push("--ro-bind", environment.CMS_PREVIEW_INPUT_PATH, "/preview/input.json",
    "--bind", outputDirectory, "/preview/dist", "--chdir", siteDirectory, "--");
  return { args, environment: { ...environment, CMS_PREVIEW_INPUT_PATH: "/preview/input.json" } };
}

export async function buildPrivatePreview(environment: Record<string, string>, outputDirectory: string): Promise<void> {
  const sandbox = await privatePreviewSandbox(environment, outputDirectory);
  await new Promise<void>((resolve, reject) => {
    execFile("/usr/bin/bwrap", [...sandbox.args, "/usr/bin/node",
      "--experimental-strip-types",
      path.join(siteDirectory, "scripts/render-compiled-preview.ts")], {
      cwd: siteDirectory, env: sandbox.environment, timeout: 120_000, killSignal: "SIGKILL",
      maxBuffer: 2 * 1024 * 1024,
    }, error => error ? reject(new Error("Private preview renderer failed")) : resolve());
  });
}

async function privateJobDirectory(stateDirectory: string, queueId: string) {
  if (!/^[A-Za-z0-9]{20}$/.test(queueId)) throw new Error("Invalid private preview job identity");
  await assertCmsPublicationDirectoriesSeparated(stateDirectory, siteDirectory);
  const directories = [stateDirectory, path.join(stateDirectory, "jobs"), path.join(stateDirectory, "jobs", queueId)];
  for (const directory of directories) {
    if (directory !== stateDirectory) await mkdir(directory, { mode: 0o700 }).catch(error => {
      if (error.code !== "EEXIST") throw error;
    });
    const status = await lstat(directory);
    if (!status.isDirectory() || (status.mode & 0o077) !== 0 || status.uid !== process.getuid?.()) {
      throw new Error("Preview processing requires owner-only state directories");
    }
  }
  return directories[2];
}

/** Call only after confirmed terminal writeback. The journal stays until this
 * exact private job has been removed, so interrupted cleanup can be retried.
 */
export async function removePrivatePreviewJob(stateDirectory: string, queueId: string) {
  const directory = await privateJobDirectory(stateDirectory, queueId);
  await rm(directory, { recursive: true, force: true });
}

async function existingPreviewInput(file: string): Promise<Buffer | null> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const status = await handle.stat();
    if (!status.isFile() || (status.mode & 0o077) !== 0 || status.uid !== process.getuid?.()) {
      throw new Error("Preview input must be an owner-only regular file");
    }
    return await handle.readFile();
  } finally { await handle.close(); }
}

/** Process one already journaled claim. The service keeps its token until the
 * terminal result is confirmed; uncertain writeback must not clear ownership.
 * Upload is supplied by the operator and never enters the renderer environment.
 */
export async function processCmsPreview({ firestore, claim, stateDirectory, publisherStateDirectory,
  upload, retain, removeRetained, inputStorage, startup, deploymentEnvironment = "production", projectId = "njpbs-site", dependencies = {} }: {
  firestore: Firestore;
  claim: PreviewClaim;
  stateDirectory: string;
  publisherStateDirectory?: string;
  upload: (artifact: PreviewArtifact) => Promise<void>;
  retain?: (identity: { contentKey: string; queueId: string; requestedAtMs: number }) => Promise<boolean>;
  removeRetained?: (queueId: string) => Promise<void>;
  inputStorage?: {
    read(queueId: string): Promise<Buffer | null>;
    freeze(queueId: string, payload: Buffer): Promise<Buffer>;
  };
  startup?: () => import("./preview-diagnostics.ts").PreviewStartup;
  deploymentEnvironment?: string;
  projectId?: string;
  dependencies?: Partial<PreviewDependencies>;
}) {
  const target = previewOutputTarget(deploymentEnvironment, projectId);
  const operations: PreviewDependencies = { assertSource: assertCmsPreviewSourceCheckout,
    claim: claimCmsPreviewQueue, finish: finishCmsPreviewQueue, setRefreshing: setCmsPreviewContextRefreshing, readPublicContext: () => {
      if (!publisherStateDirectory) throw new Error("Preview public context is not configured");
      return readPreviewPublicContext(publisherStateDirectory);
    },
    build: buildPrivatePreview, prepare: preparePrivatePreview, ...dependencies };
  const measure = previewDiagnostics({ ...claim, ...startup?.() });
  await measure("source-check", () => operations.assertSource(claim.rendererSha));
  const ownership = await measure("claim", () => operations.claim({ firestore, ...claim }));
  if (ownership.outcome !== "claimed" && !(ownership.outcome === "terminal" &&
      ["ready", "failed", "expired"].includes(ownership.status))) return ownership;

  const snapshot = await measure("queue-read", () => firestore.collection("cmsPreviewQueue").doc(claim.queueId).get());
  const queue = snapshot.data();
  const collection = queue?.collection ?? "cmsPages";
  const identity = { pageId: queue?.pageId, sourceVersion: queue?.sourceVersion,
    expiresAtMs: timestampMillis(queue?.expiresAt),
    ...(queue?.persistent === true ? { persistent: true } : {}),
    ...(collection === "cmsPosts" ? { collection } : {}) };
  const completion = { firestore, ...claim, ...identity,
    deploymentEnvironment: process.env.CMS_DEPLOYMENT_ENVIRONMENT ?? "production" };
  // A retained journal can resume after ready writeback but before its current
  // pointer settled. It completes these small writes without rebuilding HTML.
  const settleSavedExport = async (result: { status: string }) => {
    if (queue?.persistent !== true) return result;
    if (!removeRetained) throw new Error("Saved preview cleanup is not configured");
    if (result.status !== "ready") {
      await removeRetained(claim.queueId);
      return result;
    }
    const contentKey = previewContentKey(collection, queue.pageId);
    const requestedAtMs = timestampMillis(queue.requestedAt);
    if (!retain || queue.contentKey !== contentKey || requestedAtMs === null || queue.rendererSha !== claim.rendererSha) {
      throw new Error("Persistent preview completion is not configured");
    }
    const expireSavedQueue = async (queueId: string) => {
      await firestore.runTransaction(async transaction => {
        const ref = firestore.collection("cmsPreviewQueue").doc(queueId);
        const saved = (await transaction.get(ref)).data();
        if (!saved || saved.persistent !== true || saved.contentKey !== contentKey) {
          throw new Error("Saved preview cleanup does not match its queue");
        }
        if (saved.status === "ready") transaction.update(ref, { status: "expired", previewUrl: null });
      });
    };
    if (!await retain({ contentKey, queueId: claim.queueId, requestedAtMs })) {
      await expireSavedQueue(claim.queueId);
      await removeRetained(claim.queueId);
      return { ...result, status: "expired" };
    }
    const cleanupQueueId = await firestore.runTransaction(async transaction => {
      const ref = firestore.collection(PREVIEW_HEADS_COLLECTION).doc(contentKey);
      const head = (await transaction.get(ref)).data();
      if (!head || head.collection !== collection || head.pageId !== queue.pageId) {
        throw new Error("Persistent preview head does not match its queue");
      }
      if ((head.readyRequestedAtMs ?? 0) > requestedAtMs) return;
      const previous = head.readyQueueId !== claim.queueId ? head.readyQueueId : head.cleanupQueueId;
      transaction.update(ref, { readyQueueId: claim.queueId, readyRequestedAtMs: requestedAtMs,
        cleanupQueueId: previous ?? null });
      return previous;
    });
    if (typeof cleanupQueueId === "string" && cleanupQueueId !== claim.queueId) {
      await expireSavedQueue(cleanupQueueId);
      await removeRetained(cleanupQueueId);
      await firestore.runTransaction(async transaction => {
        const ref = firestore.collection(PREVIEW_HEADS_COLLECTION).doc(contentKey);
        const head = (await transaction.get(ref)).data();
        if (head?.readyQueueId === claim.queueId && head.cleanupQueueId === cleanupQueueId) {
          transaction.update(ref, { cleanupQueueId: null });
        }
      });
    }
    return result;
  };
  if (ownership.outcome === "terminal") return settleSavedExport(ownership);
  try {
    const jobDirectory = await privateJobDirectory(stateDirectory, claim.queueId);
    const inputPath = path.join(jobDirectory, "input.json");
    const localInput = await existingPreviewInput(inputPath);
    let payload = inputStorage ? await measure("input-read", () => inputStorage.read(claim.queueId)) : localInput;
    if (localInput && (!payload || !localInput.equals(payload))) {
      throw new Error("Local preview input differs from its durable copy");
    }
    let contextRefreshing = queue?.contextRefreshing === true;
    if (!payload) {
      const retained = await measure("public-context", () => operations.readPublicContext(async () => {
        await operations.setRefreshing({ firestore, ...claim, refreshing: true });
        contextRefreshing = true;
      }));
      const publicContext = { ...retained.publicContext };
      const homeHeroPages = identity.pageId === "home" && collection === "cmsPages"
        ? await readPreviewHomeHeroPages(firestore, queue?.snapshot?.homeHero, new Date()) : undefined;
      let draftLibraryCards: CmsPreviewInput["draftLibraryCards"];
      const referencedLibraryIds = new Set<string>();
      for (const block of queue?.snapshot?.blocks ?? []) {
        if (block.type === "record_card" &&
            (block.data?.recordKind === "sponsor" || block.data?.recordKind === "newsletter") &&
            typeof block.data.recordId === "string") {
          referencedLibraryIds.add(block.data.recordId);
        }
        if (block.type === "sponsor_strip" && Array.isArray(block.data?.sponsorIds)) {
          for (const id of block.data.sponsorIds) if (typeof id === "string") referencedLibraryIds.add(id);
        }
        if (block.type === "newsletter_signup" && Array.isArray(block.data?.newsletterIds)) {
          for (const id of block.data.newsletterIds) if (typeof id === "string") referencedLibraryIds.add(id);
        }
      }
      if (referencedLibraryIds.size) {
        const ids = [...referencedLibraryIds].sort();
        const snapshots = await firestore.getAll(...ids.map(id => firestore.collection("cmsPosts").doc(id)));
        const records: (Record<string, unknown> & { id: string })[] = snapshots.filter(snapshot => snapshot.exists).map(snapshot => ({
          ...(snapshot.data() as Record<string, unknown>), id: snapshot.id,
        }));
        const assetIds = [...new Set(records.flatMap(record => [record.logoAssetId, record.imageAssetId])
          .filter((id): id is string => typeof id === "string" && !!id && !id.includes("/")))];
        const assetSnapshots = assetIds.length
          ? await firestore.getAll(...assetIds.map(id => firestore.collection("media_assets_public").doc(id))) : [];
        const assets = assetSnapshots.flatMap(asset => {
          const data = asset.data();
          return asset.exists && typeof data?.url === "string" && typeof data.mimeType === "string"
            ? [{ id: asset.id, url: data.url, mimeType: data.mimeType,
          ...(Number.isInteger(data.width) ? { width: Number(data.width) } : {}),
          ...(Number.isInteger(data.height) ? { height: Number(data.height) } : {}) }] : [];
        });
        const freshCards = exportPreviewLibraryCards(records, new Date(), assets);
        draftLibraryCards = { recordIds: ids, cards: freshCards };
      }
      const dataHubSources = identity.pageId === "data-hub" && collection === "cmsPages"
        ? await firestore.runTransaction(transaction => require("../../functions/lib/data-hub-reporting-context.js").readReportingContext({
          firestore,transaction,now:new Date(),page:queue?.snapshot}),{readOnly:true}) : undefined;
      payload = Buffer.from(JSON.stringify({ schemaVersion: 2,
        queueId: claim.queueId, rendererSha: claim.rendererSha, ...identity,
        snapshot: queue?.snapshot, assets: queue?.assets, publicContext,
        ...(homeHeroPages === undefined ? {} : { homeHeroPages }),
        ...(dataHubSources ? {dataHubSources} : {}),
        ...(draftLibraryCards ? { draftLibraryCards } : {}) }));
      await retained.verifyBeforeFreeze?.();
      if (inputStorage) {
        const input = payload;
        payload = await measure("input-freeze", () => inputStorage.freeze(claim.queueId, input));
      }
    }
    if (contextRefreshing) await operations.setRefreshing({ firestore, ...claim, refreshing: false });
    if (!localInput) await writeFile(inputPath, payload, { flag: "wx", mode: 0o600 });
    const digest = createHash("sha256").update(payload).digest("hex");
    const environment = privatePreviewBuildEnvironment(inputPath, digest, claim, String(identity.pageId), collection,
      queue?.persistent === true, target.environment);
    const request = resolveCmsPreviewInput(environment)!;
    const frozen = await readCmsPreviewInput(request, new Date());
    if (!isDeepStrictEqual(frozen.page, JSON.parse(JSON.stringify(queue?.snapshot))) ||
        !isDeepStrictEqual(frozen.assets, queue?.assets) ||
        JSON.parse(payload.toString("utf8")).expiresAtMs !== identity.expiresAtMs) {
      throw new Error("Retained preview input does not match the immutable queue");
    }
    const renderDirectory = path.join(jobDirectory, "render");
    await mkdir(renderDirectory, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    const outputDirectory = path.join(renderDirectory, "dist");
    await measure("render", () => operations.build(environment, outputDirectory));
    await measure("source-check", () => operations.assertSource(claim.rendererSha));
    // A build cannot change the frozen input used to identify its output.
    if (!payload.equals(await readFile(inputPath))) throw new Error("Preview input changed during build");
    const artifact = await measure("pack", () => operations.prepare({ buildDirectory: outputDirectory,
      queueId: claim.queueId, pageId: identity.pageId, expiresAtMs: identity.expiresAtMs,
      collection, deploymentEnvironment: target.environment, projectId: target.projectId,
      // The homepage has a fixed root route, including drafts with a preserved legacy slug.
      snapshot: collection === "cmsPages" && identity.pageId === "home" ? undefined : queue?.snapshot,
      ...(queue?.persistent === true ? { contentKey: queue.contentKey } : {}) }));
    await measure("upload", () => upload(artifact));
  } catch (error) {
    // Finalizer errors propagate. The retained token then permits an exact
    // retry after uncertain writeback; build logs never become CMS error text.
    return settleSavedExport(await measure("finish", () => operations.finish({
      ...completion, status: "failed", timingsMs: measure.timings(), startup: startup?.(),
      ...(error instanceof EditorialPreviewContextNotReadyError ? { failureReason: error.code } : {}),
    })));
  }
  // Keep successful completion outside the build catch. A lost ready response
  // is uncertain, not a reason to overwrite success with a failed result.
  return settleSavedExport(await measure("finish", () => operations.finish({
    ...completion, status: "ready", timingsMs: measure.timings(), startup: startup?.(),
  })));
}
