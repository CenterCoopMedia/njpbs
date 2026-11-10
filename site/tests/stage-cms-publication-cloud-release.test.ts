// @vitest-environment node
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  assertProductionReleaseTarget,
  assertProductionRendererSeals,
  main,
  parseReleaseArguments,
  retireCmsPublicationCloudReleaseReservation,
  stageCmsPublicationCloudRelease,
} from "../scripts/stage-cms-publication-cloud-release";

const deployment = createRequire(import.meta.url)("../../functions/lib/public-deployment.js");
const release = "a".repeat(40);
const active = "b".repeat(40);
const queueId = "Release0000000000001";
const buildBatchId = `cms-${queueId}`;
const cutoff = 1_800_000_000_000;
let root: string;
let distDirectory: string;
let rendererDirectory: string;
let stateDirectory: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "cloud-release-"));
  distDirectory = path.join(root, "dist");
  rendererDirectory = path.join(root, "renderer");
  stateDirectory = path.join(root, "state");
  // A compiled graph left by another source must not reach the staged release.
  await mkdir(rendererDirectory, { recursive: true });
  await writeFile(path.join(rendererDirectory, "stale.mjs"), "stale");
});
afterEach(() => rm(root, { recursive: true, force: true }));

function database({ cloudCommit = release, state = "idle", activeCommitSha = active,
  extra = {} as Record<string, object> } = {}) {
  const documents: Record<string, object> = {
    "system/cmsPublicationRuntime": { schemaVersion: 1, phase: "paused", commitSha: active, serializerId: "node-compute-publisher",
      cloud: { phase: "paused", commitSha: cloudCommit, serializerId: "cloudflare-publisher" } },
    "system/publicDeployment": { state, activeCommitSha },
    ...extra,
  };
  return { doc: (name: string) => ({ get: async () => ({ exists: name in documents, data: () => documents[name] }) }) };
}

// The two seals of a compiled renderer: the server graph and its public copy.
const serverSeal = JSON.stringify({ schemaVersion: 1, rendererSha: release, files: {} });
async function writeSeals(renderer: string, dist: string, publicSeal: object = { schemaVersion: 1, rendererSha: release }) {
  await mkdir(renderer, { recursive: true });
  await writeFile(path.join(renderer, "renderer-release.json"), serverSeal);
  await mkdir(path.join(dist, "posts/_no-build-assets"), { recursive: true });
  await writeFile(path.join(dist, "posts/_no-build-assets/renderer-release.json"), JSON.stringify(publicSeal));
}

it("accepts the gated production compiler seal and rejects unknown capability versions",async()=>{
  await writeSeals(rendererDirectory,distDirectory,{schemaVersion:1,rendererSha:release,dataHubReportingVersion:1});
  await expect(assertProductionRendererSeals(root,release)).resolves.toBeUndefined();
  await writeSeals(rendererDirectory,distDirectory,{schemaVersion:1,rendererSha:release,pageReaderVersion:1});
  await expect(assertProductionRendererSeals(root,release)).resolves.toBeUndefined();
  await writeSeals(rendererDirectory,distDirectory,{schemaVersion:1,rendererSha:release,pageReaderVersion:2});
  await expect(assertProductionRendererSeals(root,release)).rejects.toThrow("not a production release");
  await writeSeals(rendererDirectory,distDirectory,{schemaVersion:1,rendererSha:release,dataHubReportingVersion:1,dataHubCompositionVersion:1});
  await expect(assertProductionRendererSeals(root,release)).resolves.toBeUndefined();
  // The release 23 production build seal (October 26, 2026) carries the live blog marker.
  await writeSeals(rendererDirectory,distDirectory,{schemaVersion:1,rendererSha:release,liveBlogVersion:1,dataHubReportingVersion:1,dataHubCompositionVersion:1});
  await expect(assertProductionRendererSeals(root,release)).resolves.toBeUndefined();
  for (const extra of [{dataHubReportingVersion:2},{dataHubReportingVersion:1,environment:"development"},{dataHubReportingVersion:1,unexpected:true},{dataHubReportingVersion:1,dataHubCompositionVersion:2},{dataHubCompositionVersion:1},{liveBlogVersion:2},{liveBlogVersion:"1"}]) {
    await writeSeals(rendererDirectory,distDirectory,{schemaVersion:1,rendererSha:release,...extra});
    await expect(assertProductionRendererSeals(root,release)).rejects.toThrow("not a production release");
  }
});

function storage({ frozen = null as Buffer | null, restored = false, publicSeal = undefined as object | undefined } = {}) {
  let input = frozen;
  return {
    assertReady: vi.fn(async () => undefined),
    readInput: vi.fn(async () => input),
    freezeInput: vi.fn(async (_queueId: string, bytes: Buffer) => (input = bytes)),
    restoreArtifact: vi.fn(async (_identity: object, directory: string) => {
      if (restored) await writeSeals(path.join(directory, "renderer"), path.join(directory, "dist"), publicSeal);
      return restored;
    }),
  };
}

function dependencies({ generation = 298, publicSeal = undefined as object | undefined } = {}) {
  const prepared = { commitSha: release, buildBatchId, generation, artifactDigest: "c".repeat(64) };
  return {
    assertSourceCheckout: vi.fn(async () => undefined),
    reserveBatch: vi.fn(async () => ({ batch: { generation: 298, cutoffAt: { toMillis: () => cutoff } } })),
    prepareDetached: vi.fn(async () => ({ generation: 298, cutoffAt: { toMillis: () => cutoff } })),
    readContent: vi.fn(async () => Buffer.from("frozen content")),
    freezeExternalInputs: vi.fn(async () => []),
    build: vi.fn(async ({ artifactReceiptPath, retainedInputDirectory }: { artifactReceiptPath: string; retainedInputDirectory?: string }) => {
      // The build may use only the retained input it was given.
      const content = await readFile(path.join(retainedInputDirectory ?? "", "input.json"), "utf8");
      await mkdir(path.join(distDirectory, "posts"), { recursive: true });
      await writeFile(path.join(distDirectory, "posts/index.html"), `built from ${content}`);
      await writeSeals(rendererDirectory, distDirectory, publicSeal);
      await writeFile(artifactReceiptPath, "{}");
      return { receipt: true };
    }),
    prepareArtifact: vi.fn(async () => prepared),
    readPreparedArtifact: vi.fn(async () => prepared),
    stage: vi.fn(async () => undefined),
    checkpoint: vi.fn(async () => ({ prepared, artifactCheckpointDigest: "d".repeat(64) })),
    recordCheckpoint: vi.fn(async () => undefined),
  };
}

const run = (overrides: { firestore?: object; storage?: object; dependencies?: object; stateDirectory?: string; now?: () => number;
  interrupted?: () => boolean; prepareAgainstCommitSha?: string } = {}) =>
  stageCmsPublicationCloudRelease({
    firestore: (overrides.firestore ?? database()) as never, storage: (overrides.storage ?? storage()) as never,
    queueId, commitSha: release, stateDirectory: overrides.stateDirectory ?? stateDirectory, distDirectory, rendererDirectory,
    buildEnvironment: { PUBLIC_REPORT_ENDPOINT: "https://report.example" }, now: overrides.now ?? (() => cutoff + 1_000),
    ...(overrides.interrupted ? { interrupted: overrides.interrupted } : {}),
    ...(overrides.prepareAgainstCommitSha ? { prepareAgainstCommitSha: overrides.prepareAgainstCommitSha } : {}),
    dependencies: (overrides.dependencies ?? dependencies()) as never,
  });

it("builds and checkpoints NEW while OLD stays pinned, without creating executable release work", async () => {
  const fakes = dependencies();
  const result = await run({ firestore: database({ cloudCommit: active }), dependencies: fakes, prepareAgainstCommitSha: active });
  expect(result).toEqual({ queueId, buildBatchId, commitSha: release, generation: 298,
    artifactDigest: "c".repeat(64), artifactCheckpointDigest: "d".repeat(64), status: "prepared" });
  expect(await readFile(path.join(stateDirectory, "releases", queueId, "dist/posts/index.html"), "utf8"))
    .toBe("built from frozen content");
  expect(fakes.prepareDetached).toHaveBeenCalledWith(expect.objectContaining({ preparationId: queueId,
    commitSha: release, oldCommitSha: active }));
  expect(fakes.readContent).toHaveBeenCalledWith(expect.anything(), { buildBatchId, commitSha: release, preparationId: queueId }, stateDirectory);
  expect(fakes.reserveBatch).not.toHaveBeenCalled();
  expect(fakes.stage).not.toHaveBeenCalled();
});

it("reuses the retained detached build and never stages it on a retry", async () => {
  const fakes = dependencies();
  const result = await run({ firestore: database({ cloudCommit: active }), dependencies: fakes,
    prepareAgainstCommitSha: active, storage: storage({ frozen: Buffer.from("first attempt"), restored: true }) });
  expect(result.status).toBe("prepared");
  expect(fakes.readContent).not.toHaveBeenCalled();
  expect(fakes.build).not.toHaveBeenCalled();
  expect(fakes.reserveBatch).not.toHaveBeenCalled();
  expect(fakes.stage).not.toHaveBeenCalled();
});

it("rejects a detached renderer seal failure before checkpoint or staging", async () => {
  const fakes = dependencies({ publicSeal: { schemaVersion: 1, rendererSha: release, liveBlogVersion: 2 } });
  await expect(run({ firestore: database({ cloudCommit: active }), dependencies: fakes,
    prepareAgainstCommitSha: active })).rejects.toThrow("not a production release");
  expect(fakes.checkpoint).not.toHaveBeenCalled();
  expect(fakes.reserveBatch).not.toHaveBeenCalled();
  expect(fakes.stage).not.toHaveBeenCalled();
});

it("abandons an expired detached operation without asking for a live reservation retirement", async () => {
  const fakes = dependencies();
  await expect(run({ firestore: database({ cloudCommit: active }), dependencies: fakes,
    prepareAgainstCommitSha: active, now: () => cutoff + 60_001 })).rejects.toThrow(
    "The preparation expired before its input was frozen; use a new operation id");
  expect(fakes.reserveBatch).not.toHaveBeenCalled();
  expect(fakes.stage).not.toHaveBeenCalled();
});

it.each(["prepare", "apply"])("refuses %s input owned by the other mode before storage or reservation", async mode => {
  const fakes = dependencies(), store = storage();
  const prepareAgainstCommitSha = mode === "prepare" ? active : undefined;
  const path = mode === "prepare" ? `system/publicDeployment/buildBatches/${buildBatchId}`
    : `system/publicReleasePreparations/entries/${queueId}`;
  await expect(run({ firestore: database({ cloudCommit: mode === "prepare" ? active : release,
    extra: { [path]: { schemaVersion: 1 } } }), storage: store, dependencies: fakes,
    prepareAgainstCommitSha })).rejects.toThrow("other release mode");
  expect(store.assertReady).not.toHaveBeenCalled();
  expect(fakes.reserveBatch).not.toHaveBeenCalled();
  expect(fakes.prepareDetached).not.toHaveBeenCalled();
  expect(fakes.stage).not.toHaveBeenCalled();
});

it("builds offline from the frozen input and stages it for the pinned cloud publisher", async () => {
  const fakes = dependencies();
  const store = storage();
  const result = await run({ storage: store, dependencies: fakes });

  expect(fakes.reserveBatch).toHaveBeenCalledWith(expect.objectContaining({
    buildBatchId, commitSha: release, runtime: { owner: "cloudflare", release } }));
  const retained = path.join(stateDirectory, "inputs", queueId);
  expect(fakes.freezeExternalInputs).toHaveBeenCalledWith(expect.objectContaining({ retainedInputDirectory: retained }));
  expect(fakes.build).toHaveBeenCalledWith(expect.objectContaining({ retainedInputDirectory: retained,
    buildEnvironment: { PUBLIC_REPORT_ENDPOINT: "https://report.example", PUBLIC_ARTIFACT_BATCH_MODE: "background",
      CMS_DEPLOYMENT_ENVIRONMENT: "production" } }));
  const directory = path.join(stateDirectory, "releases", queueId);
  expect(fakes.stage).toHaveBeenCalledWith(expect.objectContaining({
    serializerId: "cloudflare-publisher", directory,
    identity: { queueId, buildBatchId, commitSha: release,
      inputSha256: createHash("sha256").update("frozen content").digest("hex") } }));
  expect(await readFile(path.join(directory, "dist/posts/index.html"), "utf8")).toBe("built from frozen content");
  expect(await readFile(path.join(directory, "renderer/renderer-release.json"), "utf8")).toBe(serverSeal);
  await expect(readFile(path.join(directory, "renderer/stale.mjs"))).rejects.toThrow();
  expect(result).toEqual({ queueId, buildBatchId, commitSha: release, generation: 298,
    artifactDigest: "c".repeat(64), status: "staged" });
});

it("builds a late retry from the input frozen by the first attempt, with no database read", async () => {
  const fakes = dependencies();
  const store = storage({ frozen: Buffer.from("first attempt") });
  await run({ storage: store, dependencies: fakes, now: () => cutoff + 3_600_000 });

  expect(fakes.readContent).not.toHaveBeenCalled();
  expect(store.freezeInput).not.toHaveBeenCalled();
  expect(await readFile(path.join(stateDirectory, "releases", queueId, "dist/posts/index.html"), "utf8"))
    .toBe("built from first attempt");
  expect(fakes.stage).toHaveBeenCalledWith(expect.objectContaining({
    identity: expect.objectContaining({ inputSha256: createHash("sha256").update("first attempt").digest("hex") }) }));
});

it("stages the stored build on a retry and does not build again", async () => {
  const fakes = dependencies();
  const store = storage({ frozen: Buffer.from("first attempt"), restored: true });
  const result = await run({ storage: store, dependencies: fakes });

  const directory = path.join(stateDirectory, "releases", queueId);
  expect(store.restoreArtifact).toHaveBeenCalledWith(expect.objectContaining({ queueId, buildBatchId }), directory);
  expect(fakes.freezeExternalInputs).not.toHaveBeenCalled();
  expect(fakes.build).not.toHaveBeenCalled();
  expect(fakes.stage).toHaveBeenCalledWith(expect.objectContaining({ directory }));
  expect(result.artifactDigest).toBe("c".repeat(64));
});

it("refuses when the reservation expired before its input was frozen", async () => {
  const fakes = dependencies();
  await expect(run({ dependencies: fakes, now: () => cutoff + 60_001 })).rejects.toThrow("retire it");
  expect(fakes.readContent).not.toHaveBeenCalled();
  expect(fakes.build).not.toHaveBeenCalled();
});

it.each([
  ["the cloud publisher runs another release", database({ cloudCommit: active })],
  ["a public deployment is in progress", database({ state: "deploying" })],
  ["the release is already active", database({ activeCommitSha: release })],
])("reserves nothing when %s", async (_reason, firestore) => {
  const fakes = dependencies();
  await expect(run({ firestore, dependencies: fakes })).rejects.toThrow();
  expect(fakes.reserveBatch).not.toHaveBeenCalled();
  expect(fakes.build).not.toHaveBeenCalled();
});

it.each([["built", false], ["stored", true]])("does not stage a %s artifact that differs from its reservation", async (_kind, restored) => {
  const fakes = dependencies({ generation: 299 });
  await expect(run({ storage: storage({ restored }), dependencies: fakes })).rejects.toThrow("differs from its reservation");
  expect(fakes.stage).not.toHaveBeenCalled();
});

it("does not stage when the build produced no compiled renderer", async () => {
  const fakes = dependencies();
  fakes.build.mockImplementation(async () => ({ receipt: true }));
  await expect(run({ dependencies: fakes })).rejects.toThrow();
  expect(fakes.stage).not.toHaveBeenCalled();
});

it.each([["built", false], ["stored", true]])("does not stage a %s renderer that is not a production release", async (_kind, restored) => {
  // The compiler writes this seal when a development target reaches the build.
  const publicSeal = { schemaVersion: 1, rendererSha: release, environment: "development" };
  const fakes = dependencies({ publicSeal });
  await expect(run({ storage: storage({ restored, publicSeal }), dependencies: fakes })).rejects.toThrow("not a production release");
  expect(fakes.stage).not.toHaveBeenCalled();
});

it("refuses a development target before it opens a credential", async () => {
  expect(() => assertProductionReleaseTarget({})).not.toThrow();
  expect(() => assertProductionReleaseTarget({ CMS_DEPLOYMENT_ENVIRONMENT: "production" })).not.toThrow();
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const exitCode = process.exitCode;
  try {
    await main(["--apply", queueId, release], { CMS_DEPLOYMENT_ENVIRONMENT: "development" });
    expect(write.mock.calls).toEqual([["Cloud release refused: The cloud release target must be production\n"]]);
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = exitCode;
    write.mockRestore();
  }
});

it("stops after an interrupted build and stages nothing", async () => {
  const fakes = dependencies();
  let interrupted = false;
  const build = fakes.build.getMockImplementation()!;
  fakes.build.mockImplementation(async (input) => {
    interrupted = true;
    return build(input);
  });
  await expect(run({ dependencies: fakes, interrupted: () => interrupted })).rejects.toThrow("interrupted; retry with the same operation id");
  expect(fakes.build).toHaveBeenCalledTimes(1);
  expect(fakes.prepareArtifact).not.toHaveBeenCalled();
  expect(fakes.stage).not.toHaveBeenCalled();
});

it("survives SIGTERM while a build runs and reports the interrupt afterward", async () => {
  const guard = new URL("../scripts/release-interrupt-guard.ts", import.meta.url).href;
  const loader = path.resolve(import.meta.dirname, "../node_modules/tsx/dist/loader.mjs");
  const script = [
    `import { installInterruptGuard } from ${JSON.stringify(guard)};`,
    "const interrupted = installInterruptGuard(process, () => {});",
    'process.stdout.write("ready\\n");',
    // The timer stands for the awaited build child.
    "await new Promise((resolve) => setTimeout(resolve, 1500));",
    'process.stdout.write(interrupted() ? "interrupted\\n" : "not interrupted\\n");',
  ].join("\n");
  const child = spawn(process.execPath, ["--import", loader, "--input-type=module", "--eval", script],
    { stdio: ["ignore", "pipe", "inherit"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  await vi.waitFor(() => expect(output).toContain("ready"), { timeout: 20_000, interval: 50 });
  child.kill("SIGTERM");
  const [code, signal] = await once(child, "exit");
  expect([code, signal, output]).toEqual([0, null, "ready\ninterrupted\n"]);
}, 30_000);

it("refuses scratch state inside the source checkout", async () => {
  const fakes = dependencies();
  const inside = path.resolve(import.meta.dirname, "../.cloud-release-state");
  await expect(run({ stateDirectory: inside, dependencies: fakes })).rejects.toThrow("input is invalid");
  expect(fakes.assertSourceCheckout).not.toHaveBeenCalled();
});

it("accepts exact stage, retire and default-dry-run recovery commands", () => {
  expect(parseReleaseArguments(["--apply", queueId, release])).toEqual({ action: "apply", queueId, commitSha: release });
  expect(parseReleaseArguments(["--retire", queueId, release])).toEqual({ action: "retire", queueId, commitSha: release });
  expect(parseReleaseArguments(["--prepare", queueId, release, active])).toEqual({ action: "prepare", queueId, commitSha: release, oldCommitSha: active });
  expect(parseReleaseArguments(["--retry", queueId, release, active])).toEqual({ action: "retry", queueId, commitSha: release, oldCommitSha: active, apply: false });
  expect(parseReleaseArguments(["--retry", queueId, release, active, "--apply"])).toEqual({ action: "retry", queueId, commitSha: release, oldCommitSha: active, apply: true });
  expect(parseReleaseArguments(["--supersede-upload-exhausted", queueId, release])).toEqual({ action: "supersede-upload-exhausted", queueId, commitSha: release, apply: false });
  expect(parseReleaseArguments(["--supersede-upload-exhausted", queueId, release, "--apply"])).toEqual({ action: "supersede-upload-exhausted", queueId, commitSha: release, apply: true });
  for (const args of [["--supersede-upload-exhausted", queueId], ["--supersede-upload-exhausted", queueId, release, "--force"],
    ["--supersede-upload-exhausted", "short", release], ["--supersede-upload-exhausted", queueId, release.toUpperCase()],
    ["--supersede-upload-exhausted", queueId, release, "--apply", "extra"], [], ["--apply", queueId], ["--apply", "short", release], ["--plan", queueId, release],
    ["--retire", queueId, release.toUpperCase()], ["--retry", queueId, release], ["--retry", queueId, release, release],
    ["--retry", queueId, release, active, "--force"], ["--retry", queueId, release, active, "--apply", "extra"],
    ["--retry", queueId, release, active.toUpperCase()]]) {
    expect(() => parseReleaseArguments(args)).toThrow("Usage");
  }
});

const batchPath = `system/publicDeployment/buildBatches/${buildBatchId}`;
const requestPath = `cmsPublicationSerializerJournals/cloudflare-publisher/releases/${queueId}`;
const timestamp = (millis: number) => ({ toMillis: () => millis });

function retirementDatabase(extra: Record<string, object> = {}) {
  const documents: Record<string, object> = {
    "system/publicDeployment": { state: "idle", activeGeneration: 297, activeCommitSha: active, activeDeploymentId: "deployment-297" },
    [batchPath]: { schemaVersion: 1, buildBatchId, generation: 298, status: "reserved", commitSha: release,
      runtime: { owner: "cloudflare", release }, reservedAgainstGeneration: 297, reservedAgainstDeploymentId: "deployment-297",
      reservedAgainstCommitSha: active, cutoffAt: timestamp(cutoff), reservedAt: timestamp(cutoff) },
    ...extra,
  };
  const ref = (name: string): object => ({ name, collection: (child: string) => ({ doc: (id: string) => ref(`${name}/${child}/${id}`) }) });
  const transaction = {
    get: async (target: { name: string }) => ({ exists: target.name in documents, data: () => documents[target.name] }),
    set: (target: { name: string }, value: object) => { documents[target.name] = value; },
  };
  return { documents, firestore: { doc: ref, runTransaction: async (work: (tx: typeof transaction) => unknown) => work(transaction) } };
}

const retire = (firestore: object) => retireCmsPublicationCloudReleaseReservation({
  firestore: firestore as never, queueId, commitSha: release, serverTimestamp: () => timestamp(cutoff + 120_000) });

it("retires a reservation that was never staged and keeps its evidence", async () => {
  const { documents, firestore } = retirementDatabase();
  const reserved = documents[batchPath];
  expect(await retire(firestore)).toEqual({ queueId, buildBatchId, commitSha: release, generation: 298, status: "retired" });

  const retired = documents[batchPath];
  expect(retired).toMatchObject({ ...reserved, status: "retired", retirementReceipt: {
    reason: "cloud_release_not_staged", activeGeneration: 297, activeCommitSha: active, activeDeploymentId: "deployment-297" } });
  expect(deployment.assertPublicDeploymentRetiredCloudReleaseBatch(retired, buildBatchId)).toBe(retired);
  // Every reservation reader refuses a retired row, so no retry can use it.
  expect(() => deployment.projectPublicBuildReservation(retired, buildBatchId)).toThrow(/retired/);
  // The historical node-compute receipt and the cloud receipt are not interchangeable.
  expect(() => deployment.assertPublicDeploymentRetiredBatch(retired, buildBatchId)).toThrow(/invalid/);
  for (const change of [{ runtime: undefined }, { retiredAt: timestamp(0) }, { readyAt: timestamp(cutoff + 1) },
    { retirementReceipt: { ...(retired as { retirementReceipt: object }).retirementReceipt, reason: "historical_reserved_below_active" } }]) {
    expect(() => deployment.assertPublicDeploymentRetiredCloudReleaseBatch({ ...retired, ...change }, buildBatchId)).toThrow(/invalid/);
  }
  expect(await retire(firestore)).toMatchObject({ status: "retired" });
  expect(documents[batchPath]).toBe(retired);
});

it.each([
  ["a staged release request", { [requestPath]: { status: "pending" } }],
  ["an uploaded candidate", { [`${batchPath}/candidates/worker`]: { generation: 298 } }],
  ["a publish queue row", { [`cmsPublishQueue/${queueId}`]: { status: "pending" } }],
  ["a deployment in progress", { "system/publicDeployment": { state: "deploying", activeGeneration: 297,
    activeCommitSha: active, activeDeploymentId: "deployment-297" } }],
])("does not retire a reservation with %s", async (_reason, extra) => {
  const { documents, firestore } = retirementDatabase(extra);
  await expect(retire(firestore)).rejects.toThrow();
  expect(documents[batchPath]).toMatchObject({ status: "reserved" });
});

it.each([
  ["an node-compute reservation", { runtime: undefined }],
  ["another commit", { commitSha: active, runtime: { owner: "cloudflare", release: active } }],
  ["a reservation that already advanced", { status: "ready", readyAt: timestamp(cutoff + 1) }],
])("does not retire %s", async (_reason, change) => {
  const { documents, firestore } = retirementDatabase();
  const before = documents[batchPath] = { ...documents[batchPath], ...change };
  await expect(retire(firestore)).rejects.toThrow();
  expect(documents[batchPath]).toBe(before);
});

// The wrapper is the process boundary. It guards the inherited environment and the checkout.
const wrapperPath = path.resolve(import.meta.dirname, "../../scripts/stage-cms-publication-cloud-release.sh");
const guardedVariables = (file: string) =>
  /credential_environment_variables=\(([^)]*)\)/.exec(readFileSync(file, "utf8"))![1].trim().split(/\s+/);

async function wrapperCheckout() {
  const site = path.join(root, "checkout/site");
  const wrapper = path.join(root, "checkout/scripts/stage-cms-publication-cloud-release.sh");
  const credentials = path.join(root, "credentials");
  for (const directory of [site, path.dirname(wrapper), credentials]) await mkdir(directory, { recursive: true });
  await copyFile(wrapperPath, wrapper);
  const runWrapper = (inherited: Record<string, string> = {}) => spawnSync("bash", [wrapper, "--apply", queueId, release],
    { encoding: "utf8", env: { PATH: process.env.PATH ?? "", CREDENTIALS_DIRECTORY: credentials, ...inherited } });
  return { site, runWrapper };
}

it("preserves inherited credential refusals after serializer retirement", async () => {
  // Retained contract from the serializer wrapper at b5e78d2c6:16-29.
  // The cloud release guard must keep every refusal after that file is removed.
  const serializer = [
    "CF_API_KEY", "CF_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_EMAIL", "FIREBASE_CONFIG", "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_APPLICATION_CREDENTIALS_JSON",
    "MEDIA_MANAGER_API_KEY", "MEDIA_MANAGER_API_SECRET", "NODE_OPTIONS",
  ];
  expect(serializer).toEqual(expect.arrayContaining(["CF_API_KEY", "CF_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_API_TOKEN"]));
  expect(guardedVariables(wrapperPath)).toEqual(expect.arrayContaining(serializer));
  const { runWrapper } = await wrapperCheckout();
  for (const variable of serializer) {
    const refused = runWrapper({ [variable]: "inherited" });
    expect([variable, refused.status, refused.stderr]).toEqual(
      [variable, 78, "CMS publication cloud release inherited process environment is not allowed\n"]);
  }
});

it("allows one release command per checkout", async () => {
  const { site, runWrapper } = await wrapperCheckout();
  // With no holder the wrapper passes the lock and stops at the first absent credential file.
  const free = runWrapper();
  expect([free.status, free.stderr.includes("firebase-service-account")]).toEqual([1, true]);
  const holder = spawn("/usr/bin/flock", ["--exclusive", "--nonblock", site, "sleep", "30"], { detached: true, stdio: "ignore" });
  try {
    await vi.waitFor(() => expect(runWrapper().status).toBe(75), { timeout: 5_000, interval: 50 });
    expect(runWrapper().stderr).toBe("Another CMS publication cloud release command is using this checkout\n");
  } finally {
    process.kill(-holder.pid!, "SIGKILL");
    await once(holder, "exit");
  }
  await vi.waitFor(() => expect(runWrapper().status).toBe(1), { timeout: 5_000, interval: 50 });
});
