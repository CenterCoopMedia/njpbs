import { prepareStaticPostProof, type StaticPostProof } from "./prepare-static-post-proof";
export { prepareStaticPostProof } from "./prepare-static-post-proof";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { spawn } from "node:child_process";
import { cp, open, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPublicArtifactInventoryReceipt,
  type PublicArtifactInventoryReceipt,
} from "../src/lib/public-artifact-inventory";
import {
  assertPreparedPublicWorkerArtifact,
  type PreparedPublicWorkerArtifact,
  verifyPreparedPublicWorkerArtifact,
} from "../src/lib/public-worker-artifact";
import { findExactRecentWorkerVersion } from
  "../src/lib/public-worker-version-recovery";
import { assertCmsPublicationSourceCheckout } from "./cms-publication-runtime-guard";

const requireModule = createRequire(import.meta.url);
const { readNoBuildFamilyAdmission } = requireModule("../../functions/lib/no-build-family-admission.js");
const { listNoBuildPostOwners } = requireModule("../../functions/lib/no-build-post-ownership.js");
const { readPublicReleasePreparation, preparedPublicWorkerCandidateRef, recordPreparedPublicWorkerCandidate,
  assertPreparedPublicReleaseCheckpoint } =
  requireModule("../../functions/lib/public-release-preparation.js");
type PublicationRuntime = { owner: "node-compute" | "cloudflare"; release: string };
const { assertPublicationOwner, assertRuntimeSource, runtimeFields } = requireModule("../../functions/lib/publication-runtime-owner.js");
const candidateModule = requireModule(
  "../../functions/lib/public-worker-candidate.js",
) as {
  projectCloudflareWorkerVersion: (
    value: unknown,
    expected: { tag: string; message: string },
  ) => { workerVersionId: string; versionCreatedOn: string; noBuildPost?: PublicWorkerCandidateInput["noBuildPost"]; noBuildPage?: PublicWorkerCandidateInput["noBuildPage"]; noBuildRecord?: PublicWorkerCandidateInput["noBuildRecord"] };
  projectPublicWorkerCandidate: (value: unknown) => PublicWorkerCandidate;
  projectPublicWorkerCandidateInput: (value: unknown) => PublicWorkerCandidateInput;
  publicWorkerCandidateMessage: (value: unknown) => string;
  publicWorkerCandidateTag: (value: unknown) => string;
  workerVersionIdFromWranglerOutput: (value: string) => string;
};
const candidateStoreModule = requireModule(
  "../../functions/lib/public-worker-candidate-store.js",
) as {
  recordPublicWorkerCandidate: (input: {
    firestore: Firestore;
    candidate: PublicWorkerCandidateInput;
    runtime?: PublicationRuntime;
  }) => Promise<{ idempotent: boolean; candidate: PublicWorkerCandidate }>;
};
const coordinatorModule = requireModule(
  "../../functions/lib/public-deployment-coordinator.js",
) as {
  publicBuildBatchRef: (
    firestore: Firestore,
    buildBatchId: string,
  ) => DocumentReference;
  publicWorkerCandidateRef: (
    firestore: Firestore,
    buildBatchId: string,
  ) => DocumentReference;
};
const manifestModule = requireModule(
  "../../functions/lib/public-media-manifest.js",
) as {
  createPublicMediaManifest: (input: {
    reservation: unknown;
    artifactInventory: unknown[];
    owners: unknown[];
  }) => PublicMediaManifest;
};
const manifestStoreModule = requireModule(
  "../../functions/lib/public-media-manifest-store.js",
) as {
  markPublicMediaManifestReady: (input: {
    firestore: Firestore;
    manifest: PublicMediaManifest;
  }) => Promise<unknown>;
  stagePublicMediaManifest: (input: {
    firestore: Firestore;
    manifest: PublicMediaManifest;
  }) => Promise<unknown>;
};
const { initFirebase } = requireModule(
  "../../scripts/update-publish-status.cjs",
) as { initFirebase: () => Firestore };

const {
  projectCloudflareWorkerVersion,
  projectPublicWorkerCandidate,
  projectPublicWorkerCandidateInput,
  publicWorkerCandidateMessage,
  publicWorkerCandidateTag,
  workerVersionIdFromWranglerOutput,
} = candidateModule;
const { recordPublicWorkerCandidate } = candidateStoreModule;
const { publicBuildBatchRef, publicWorkerCandidateRef } = coordinatorModule;
const { createPublicMediaManifest } = manifestModule;
const { markPublicMediaManifestReady, stagePublicMediaManifest } =
  manifestStoreModule;

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const wranglerEntry = path.join(
  repoRoot,
  "node_modules",
  "wrangler",
  "bin",
  "wrangler.js",
);
const wranglerConfig = path.join(repoRoot, "workers/wrangler.jsonc");
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CLOUDFLARE_TOKEN = /^[A-Za-z0-9_-]{20,80}$/;
const WRANGLER_VERSION = /^4\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const VERSION_RECEIPT_RETRY_DELAYS_MS = [2_000, 5_000, 10_000] as const;

interface DocumentSnapshot {
  exists: boolean;
  data(): unknown;
}

interface DocumentReference {
  get(): Promise<DocumentSnapshot>;
}

interface Firestore {
  doc(path: string): DocumentReference;
  collection(path: string): unknown;
  runTransaction(callback: unknown): Promise<unknown>;
}

interface PublicMediaManifest {
  buildBatchId: string;
  generation: number;
  commitSha: string;
  mediaManifestDigest: string;
}

interface PublicWorkerCandidateInput {
  noBuildStatic?: StaticPostProof;
  noBuildRecord?: { schemaVersion: 1; rendererSha: string; enabled: boolean; authoritative: true; families: ("programs" | "events")[] };
  noBuildPage?: { schemaVersion: 1; rendererSha: string; enabled: boolean; authoritative: true; dataFigureVersion?: 1; electionResultsVersion?: 1 | 2; dataHubReportingVersion?: 1; dataHubCompositionVersion?: 1 };
  noBuildPost?: { rendererSha: string; enabled: boolean; authoritative: true; dataFigureVersion?: 1; electionResultsVersion?: 1 | 2; liveBlogVersion?: 1 } & (
    { schemaVersion: 1; postId: string } | { schemaVersion: 2; families: ["posts"] }
  );
  schemaVersion: 1;
  buildBatchId: string;
  generation: number;
  commitSha: string;
  workerName: "njpbs-production";
  workerVersionId: string;
  workerVersionTag: string;
  versionCreatedOn: string;
  artifactDigest: string;
  artifactReceiptDigest: string;
  publicationReceiptDigest: string;
  mediaManifestDigest: string;
  artifactFileCount: number;
  artifactBytes: number;
  wranglerVersion: string;
}

interface PublicWorkerCandidate extends PublicWorkerCandidateInput {
  recordedAt: unknown;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (args: string[]) => Promise<CommandResult>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(inputPath: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(inputPath, "utf8"));
  } catch {
    throw new Error(`${label} is missing or invalid`);
  }
}

function assertArtifactAlignment(
  artifact: PublicArtifactInventoryReceipt,
  prepared: PreparedPublicWorkerArtifact,
): void {
  if (
    prepared.buildBatchId !== artifact.buildBatchId ||
    prepared.generation !== artifact.generation ||
    prepared.commitSha !== artifact.commitSha ||
    prepared.mediaManifestDigest !== artifact.mediaManifestDigest ||
    prepared.artifactReceiptDigest !== sha256(JSON.stringify(artifact))
  ) {
    throw new Error("The prepared Worker artifact belongs to another build");
  }
}

export function manifestFromArtifact(
  artifact: PublicArtifactInventoryReceipt,
  reservation: unknown,
): PublicMediaManifest {
  const manifest = createPublicMediaManifest({
    reservation,
    artifactInventory: artifact.families.map((family) => ({
      collection: family.collection,
      complete: true,
      documentIds: family.artifacts.map(({ documentId }) => documentId),
    })),
    owners: artifact.owners,
  });
  if (
    manifest.buildBatchId !== artifact.buildBatchId ||
    manifest.generation !== artifact.generation ||
    manifest.commitSha !== artifact.commitSha ||
    manifest.mediaManifestDigest !== artifact.mediaManifestDigest
  ) {
    throw new Error("The public media manifest belongs to another artifact");
  }
  return manifest;
}

async function defaultCommandRunner(
  args: string[],
  cloudflareApiToken: string | null = null,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wranglerEntry, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: "false",
        ...(cloudflareApiToken === null
          ? {}
          : { CLOUDFLARE_API_TOKEN: cloudflareApiToken }),
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300_000,
      killSignal: "SIGKILL",
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    const append = (field: "stdout" | "stderr", chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        return;
      }
      if (field === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", reject);
    child.once("exit", (status, signal) => {
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        reject(new Error("Wrangler produced excessive output"));
      } else if (signal) {
        reject(new Error(`Wrangler stopped with signal ${signal}`));
      } else if (status !== 0) {
        reject(new Error(
          `Wrangler failed with status ${String(status)}: ${stderr.trim()}`,
        ));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function parseJsonOutput(result: CommandResult, label: string): unknown {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`The Wrangler ${label} receipt is invalid`);
  }
}

export async function retryWorkerVersionReceipt<T>(
  loadReceipt: () => Promise<T>,
  pause: (delayMs: number) => Promise<void> = (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs)),
): Promise<T> {
  for (const delayMs of VERSION_RECEIPT_RETRY_DELAYS_MS) {
    try {
      return await loadReceipt();
    } catch {
      await pause(delayMs);
    }
  }
  return loadReceipt();
}

export function parseNoBuildPostEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  if (["NO_BUILD_POST_ENABLED", "NO_BUILD_POST_ID", "NO_BUILD_POST_BACKGROUND_BUCKET"]
    // config-input: NO_BUILD_POST_BACKGROUND_BUCKET, NO_BUILD_POST_ENABLED, NO_BUILD_POST_ID
    .every(name => environment[name] === undefined)) return {};
  const enabled = environment.NO_BUILD_POST_ENABLED?.trim() ?? "false";
  const postId = environment.NO_BUILD_POST_ID?.trim() ?? "";
  const bucket = environment.NO_BUILD_POST_BACKGROUND_BUCKET?.trim() ?? "";
  if (!["true", "false"].includes(enabled) ||
      (postId && !/^[A-Za-z0-9_-]{1,128}$/.test(postId)) ||
      (bucket && !/^[a-z0-9][a-z0-9._-]{2,220}$/.test(bucket)) ||
      Boolean(postId) !== Boolean(bucket) ||
      (postId && environment.NO_BUILD_POST_ENABLED === undefined) ||
      (enabled === "true" && !postId)) {
    throw new Error("The instant publication configuration is invalid");
  }
  return { NO_BUILD_POST_ENABLED: enabled, NO_BUILD_POST_ID: postId, NO_BUILD_POST_BACKGROUND_BUCKET: bucket };
}

function assertUploadedVariables(receipt: unknown, expected: Record<string, string>): void {
  const bindings = (receipt as { resources?: { bindings?: { name: string; type: string; text?: string }[] } })?.resources?.bindings;
  for (const [name, text] of Object.entries(expected)) {
    const matches = Array.isArray(bindings) ? bindings.filter(binding => binding?.name === name) : [];
    if (matches.length !== 1 || matches[0].type !== "plain_text" || matches[0].text !== text) {
      throw new Error("The uploaded public Worker configuration does not match the publisher settings");
    }
  }
}

async function exactVersionReceipt({
  runCommand,
  workerVersionId,
  tag,
  message,
}: {
  runCommand: CommandRunner;
  workerVersionId: string;
  tag: string;
  message: string;
}) {
  const view = await runCommand([
    "versions",
    "view",
    workerVersionId,
    "--config",
    wranglerConfig,
    "--json",
  ]);
  const receipt = parseJsonOutput(view, "version view");
  return { receipt, version: projectCloudflareWorkerVersion(receipt, { tag, message }) };
}

function candidateMatchesPrepared(
  candidate: PublicWorkerCandidate,
  prepared: PreparedPublicWorkerArtifact,
): boolean {
  return candidate.buildBatchId === prepared.buildBatchId &&
    candidate.generation === prepared.generation &&
    candidate.commitSha === prepared.commitSha &&
    candidate.artifactDigest === prepared.artifactDigest &&
    candidate.artifactReceiptDigest === prepared.artifactReceiptDigest &&
    candidate.publicationReceiptDigest === prepared.publicationReceiptDigest &&
    candidate.mediaManifestDigest === prepared.mediaManifestDigest &&
    candidate.artifactFileCount === prepared.artifactFileCount &&
    candidate.artifactBytes === prepared.artifactBytes;
}

export async function uploadPublicWorkerCandidate({
  artifactReceiptPath,
  preparedArtifactPath,
  distDirectory = path.join(repoRoot, "site", "dist"),
  recoveryVersionId = null,
  cloudflareApiToken = null,
  firestore = initFirebase(),
  runCommand = null,
  publicBuildEnvironment = {},
  runtime,
  preparationId,
}: {
  artifactReceiptPath: string;
  preparedArtifactPath: string;
  distDirectory?: string;
  recoveryVersionId?: string | null;
  cloudflareApiToken?: string | null;
  firestore?: Firestore;
  runCommand?: CommandRunner | null;
  publicBuildEnvironment?: Record<string, string | undefined>;
  runtime?: PublicationRuntime;
  preparationId?: string;
}): Promise<PublicWorkerCandidate> {
  const legacySettings = parseNoBuildPostEnvironment(publicBuildEnvironment);
  const admission = await readNoBuildFamilyAdmission({ firestore, env: publicBuildEnvironment });
  if (!admission.valid && Object.keys(legacySettings).length) {
    throw new Error("The runtime admission record does not match the publisher settings");
  }
  // Uploads preserve every retained owner even when admission needs repair.
  // Refuse conflicting registry claims instead of choosing one Post's reader.
  await listNoBuildPostOwners({ firestore });
  if (!path.isAbsolute(distDirectory)) {
    throw new Error("The public Worker artifact directory path must be absolute");
  }
  if (
    cloudflareApiToken !== null &&
    !CLOUDFLARE_TOKEN.test(cloudflareApiToken)
  ) {
    throw new Error("The Cloudflare API token is invalid");
  }
  const execute = runCommand ?? ((args: string[]) =>
    defaultCommandRunner(args, cloudflareApiToken));
  const artifact = assertPublicArtifactInventoryReceipt(
    await readJson(artifactReceiptPath, "The public artifact inventory receipt"),
  );
  const prepared = assertPreparedPublicWorkerArtifact(
    await readJson(preparedArtifactPath, "The prepared public Worker artifact"),
  );
  assertArtifactAlignment(artifact, prepared);
  if (preparationId !== undefined && prepared.buildBatchId !== `cms-${preparationId}`) {
    throw new Error("The detached upload does not match its preparation");
  }
  const rendererRelease = await readJson(path.join(distDirectory, "posts/_no-build-assets/renderer-release.json"), "The public Post renderer release");
  const dataHubPublic = rendererRelease !== null && typeof rendererRelease === "object" &&
    "dataHubReportingVersion" in rendererRelease && rendererRelease.dataHubReportingVersion === 1;
  const dataHubComposition = dataHubPublic && "dataHubCompositionVersion" in rendererRelease && rendererRelease.dataHubCompositionVersion === 1;
  const electionResults = rendererRelease !== null && typeof rendererRelease === "object" &&
    "electionResultsVersion" in rendererRelease && [1, 2].includes(rendererRelease.electionResultsVersion as number)
    ? rendererRelease.electionResultsVersion as 1 | 2 : undefined;
  const liveBlog = rendererRelease !== null && typeof rendererRelease === "object" &&
    "liveBlogVersion" in rendererRelease && rendererRelease.liveBlogVersion === 1;
  const pageReaderVersion = rendererRelease !== null && typeof rendererRelease === "object" &&
    "pageReaderVersion" in rendererRelease ? rendererRelease.pageReaderVersion : undefined;
  if (pageReaderVersion !== undefined && pageReaderVersion !== 1) throw new Error("Unsupported Page reader contract");
  if (!isDeepStrictEqual(rendererRelease, { schemaVersion: 1, rendererSha: prepared.commitSha,
    ...(dataHubPublic ? { dataHubReportingVersion: 1 } : {}),
    ...(dataHubComposition ? { dataHubCompositionVersion: 1 } : {}),
    ...(liveBlog ? { liveBlogVersion: 1 } : {}),
    ...(pageReaderVersion === 1 ? { pageReaderVersion: 1 } : {}),
    ...(electionResults ? { electionResultsVersion: electionResults } : {}) })) {
    throw new Error("The public Post renderer does not match its prepared production artifact");
  }
  // Fixed metadata attests the family reader. Each request reads admission;
  // neither this marker nor retained legacy variables enable publication.
  const variables = {
    NO_BUILD_RECORD_RENDERER_SHA: prepared.commitSha,
    NO_BUILD_POST_FAMILIES: "posts",
    NO_BUILD_POST_RENDERER_SHA: prepared.commitSha,
    NO_BUILD_PAGE_RENDERER_SHA: prepared.commitSha,
    DATA_FIGURE_VERSION: "1",
    ELECTION_RESULTS_VERSION: electionResults ? String(electionResults) : "0",
    // Explicit zero clears a retained feature marker when --keep-vars is used.
    LIVE_BLOG_VERSION: liveBlog ? "1" : "0",
    DATA_HUB_PUBLIC: dataHubPublic ? "1" : "0",
    DATA_HUB_COMPOSITION_VERSION: dataHubComposition ? "1" : "0",
  };

  let batch: { noBuildStaticInput?: unknown; runtime?: PublicationRuntime };
  if (preparationId !== undefined) {
    batch = await readPublicReleasePreparation({ firestore, preparationId, commitSha: prepared.commitSha });
    await assertPreparedPublicReleaseCheckpoint({ firestore, preparationId, preparedArtifact: prepared });
  } else {
    const snapshot = await publicBuildBatchRef(firestore, artifact.buildBatchId).get();
    if (!snapshot.exists) throw new Error("The public deployment reservation does not exist");
    batch = snapshot.data() as typeof batch;
  }
  const executor = runtime ?? { owner: preparationId === undefined ? "node-compute" : "cloudflare", release: prepared.commitSha };
  assertRuntimeSource(executor, prepared.commitSha);
  assertPublicationOwner(batch, executor);
  const manifest = manifestFromArtifact(artifact, batch);
  let staticProof: StaticPostProof | undefined;
  if (batch.noBuildStaticInput !== undefined) {
    staticProof = await prepareStaticPostProof({ input: batch.noBuildStaticInput, artifact, prepared, distDirectory });
  }

  const tag = publicWorkerCandidateTag(prepared);
  const message = publicWorkerCandidateMessage(prepared);
  const versionOutput = (await execute(["--version"])).stdout.trim();
  if (!WRANGLER_VERSION.test(versionOutput)) {
    throw new Error("Wrangler 4 is required to upload a public Worker candidate");
  }

  const candidateRef = preparationId === undefined ? publicWorkerCandidateRef(firestore, artifact.buildBatchId)
    : preparedPublicWorkerCandidateRef(firestore, preparationId);
  const storedSnapshot = await candidateRef.get();
  let workerVersionId: string | null = null;
  if (storedSnapshot.exists) {
    const stored = projectPublicWorkerCandidate(storedSnapshot.data());
    assertPublicationOwner(stored, executor);
    if (!candidateMatchesPrepared(stored, prepared)) {
      throw new Error("The stored public Worker candidate conflicts with this artifact");
    }
    workerVersionId = stored.workerVersionId;
  } else if (recoveryVersionId !== null) {
    if (!UUID.test(recoveryVersionId)) {
      throw new Error("The recovery Worker version id is invalid");
    }
    workerVersionId = recoveryVersionId.toLowerCase();
  } else {
    const list = await execute([
      "versions",
      "list",
      "--config",
      wranglerConfig,
      "--json",
    ]);
    workerVersionId = findExactRecentWorkerVersion(
      parseJsonOutput(list, "version list"),
      tag,
      message,
    );
  }

  if (workerVersionId === null) {
    await verifyPreparedPublicWorkerArtifact({
      preparedArtifact: prepared,
      distDirectory,
    });
    const upload = await execute([
      "versions",
      "upload",
      "--config",
      wranglerConfig,
      "--tag",
      tag,
      "--message",
      message,
      "--strict",
      "--assets",
      distDirectory,
      "--keep-vars",
      ...Object.entries(variables).flatMap(([name, value]) => ["--var", `${name}:${value}`]),
    ]);
    workerVersionId = workerVersionIdFromWranglerOutput(
      `${upload.stdout}\n${upload.stderr}`,
    );
  }

  const { receipt, version } = await retryWorkerVersionReceipt(() => exactVersionReceipt({
    runCommand: execute,
    workerVersionId,
    tag,
    message,
  }));
  assertUploadedVariables(receipt, variables);
  if (version.noBuildPost) {
    if (version.noBuildPost.rendererSha !== prepared.commitSha) {
      throw new Error("The public Post renderer does not match its prepared artifact");
    }
  }
  if (version.noBuildPage && version.noBuildPage.rendererSha !== prepared.commitSha) {
    throw new Error("The public Page renderer does not match its prepared artifact");
  }
  const candidate = projectPublicWorkerCandidateInput({
    ...runtimeFields(batch.runtime),
    schemaVersion: 1,
    buildBatchId: prepared.buildBatchId,
    generation: prepared.generation,
    commitSha: prepared.commitSha,
    workerName: "njpbs-production",
    workerVersionId: version.workerVersionId,
    workerVersionTag: tag,
    versionCreatedOn: version.versionCreatedOn,
    artifactDigest: prepared.artifactDigest,
    artifactReceiptDigest: prepared.artifactReceiptDigest,
    publicationReceiptDigest: prepared.publicationReceiptDigest,
    mediaManifestDigest: prepared.mediaManifestDigest,
    artifactFileCount: prepared.artifactFileCount,
    artifactBytes: prepared.artifactBytes,
    wranglerVersion: versionOutput,
    ...(version.noBuildPost ? { noBuildPost: version.noBuildPost } : {}),
    ...(version.noBuildPage ? { noBuildPage: version.noBuildPage } : {}),
    ...(version.noBuildRecord ? { noBuildRecord: version.noBuildRecord } : {}),
    ...(staticProof ? { noBuildStatic: staticProof } : {}),
  });
  if (pageReaderVersion === 1) {
    const { preparePageReaderMarker } = requireModule("../../functions/lib/page-reader-compatibility.js");
    await firestore.runTransaction(async (transaction: unknown) => {
      const write = await preparePageReaderMarker({ firestore, transaction, role: "public",
        rendererSha: candidate.commitSha, version: pageReaderVersion });
      write();
    });
  }
  if (preparationId !== undefined) {
    return recordPreparedPublicWorkerCandidate({ firestore, preparationId, candidate });
  }
  await stagePublicMediaManifest({ firestore, manifest });
  await markPublicMediaManifestReady({ firestore, manifest });
  return (await recordPublicWorkerCandidate({
    firestore,
    candidate,
    runtime: executor,
  })).candidate;
}

/** A checkpoint restore populates its retained directory, not site/dist or the
 * compiled graph imported by Wrangler. Restore that exact graph before upload. */
export async function restoreDetachedReleaseUploadPaths(preparedArtifactPath: string,
  rendererDirectory = path.join(repoRoot, "site/.public-post-renderer"),
  git?: Parameters<typeof assertCmsPublicationSourceCheckout>[1]): Promise<string> {
  const directory = path.dirname(preparedArtifactPath);
  const distDirectory = path.join(directory, "dist");
  const prepared = assertPreparedPublicWorkerArtifact(await readJson(preparedArtifactPath, "The prepared public Worker artifact"));
  await assertCmsPublicationSourceCheckout(prepared.commitSha, git);
  await verifyPreparedPublicWorkerArtifact({ preparedArtifact: prepared, distDirectory });
  const server = await readJson(path.join(directory, "renderer/renderer-release.json"), "The retained server renderer seal") as Record<string, unknown>;
  const publicSeal = await readJson(path.join(distDirectory, "posts/_no-build-assets/renderer-release.json"), "The public renderer seal");
  if (server?.schemaVersion !== 1 || server.rendererSha !== prepared.commitSha || !isDeepStrictEqual(server, publicSeal)) {
    throw new Error("The retained server renderer differs from the public artifact");
  }
  await rm(rendererDirectory, { recursive: true, force: true });
  await cp(path.join(directory, "renderer"), rendererDirectory, { recursive: true, errorOnExist: true });
  return distDirectory;
}

/** flock follows the shared open file description. The parent keeps its
 * directory descriptor open through graph restoration and Wrangler's read. */
export async function lockDetachedReleaseCheckout(directory = path.join(repoRoot, "site")) {
  const handle = await open(directory, "r");
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("/usr/bin/flock", ["--exclusive", "--nonblock", "3"],
        { stdio: ["ignore", "ignore", "ignore", handle.fd] });
      child.once("error", reject);
      child.once("close", code => code === 0 ? resolve() : reject(new Error("The CMS publication checkout is in use")));
    });
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [artifactReceiptPath, preparedArtifactPath, ...extra] = argv;
  const preparationId = extra.length === 2 && extra[0] === "--preparation" && /^[A-Za-z0-9]{20}$/.test(extra[1])
    ? extra[1] : undefined;
  if (
    (extra.length > 0 && preparationId === undefined) ||
    !artifactReceiptPath ||
    !preparedArtifactPath ||
    !path.isAbsolute(artifactReceiptPath) ||
    !path.isAbsolute(preparedArtifactPath)
  ) {
    throw new Error(
      "Absolute artifact inventory and prepared Worker receipt paths are required",
    );
  }
  const lock = preparationId ? await lockDetachedReleaseCheckout() : undefined;
  try {
    const candidate = await uploadPublicWorkerCandidate({
      artifactReceiptPath,
      preparedArtifactPath,
      ...(preparationId ? { preparationId, distDirectory: await restoreDetachedReleaseUploadPaths(preparedArtifactPath) } : {}),
      publicBuildEnvironment: parseNoBuildPostEnvironment(process.env),
      recoveryVersionId:
        (process.env.PUBLIC_WORKER_RECOVERY_VERSION_ID ?? "").trim() || null,
    });
    console.log(
      `Recorded ${preparationId ? "detached" : "public"} Worker candidate ${candidate.workerVersionId} for generation ${candidate.generation}`,
    );
  } finally {
    await lock?.close();
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
