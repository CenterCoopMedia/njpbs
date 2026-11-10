import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { createRequire } from "node:module";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Firestore } from "firebase-admin/firestore";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import adminPkg from "../helpers/firebase-admin.js";
import { lockDetachedReleaseCheckout, restoreDetachedReleaseUploadPaths, uploadPublicWorkerCandidate } from
  "../../site/scripts/upload-public-worker-candidate";
import { createPublicArtifactInventoryReceipt } from
  "../../site/src/lib/public-artifact-inventory";
import type { PublicBuildReservation } from "../../site/src/lib/public-artifact-inventory";
import { preparePublicWorkerArtifact } from
  "../../site/src/lib/public-worker-artifact";

const requireModule = createRequire(import.meta.url);
const { preparePublicRelease, recordPreparedPublicReleaseCheckpoint, recordPreparedPublicWorkerCandidate } =
  requireModule("../../functions/lib/public-release-preparation.js");
const { initialPublicDeploymentPointer } = requireModule("../../functions/lib/public-deployment.js");
const { reservePublicBuildBatch } = requireModule(
  "../../functions/lib/public-deployment-coordinator.js",
);
const {
  publicWorkerCandidateMessage,
  publicWorkerCandidateTag,
} = requireModule("../../functions/lib/public-worker-candidate.js");

const admin = adminPkg;
const PROJECT = process.env.GCLOUD_PROJECT ?? "demo-njpbs";
const COMMIT_SHA = "a".repeat(40);
const VERSION_ID = "11111111-1111-4111-8111-111111111111";
const temporaryDirectories: string[] = [];
let db: Firestore;

async function clearFirestore() {
  await clearEmulatorFirestore(
    `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`,
    { method: "DELETE" }, db,
  );
}

async function fixture(buildBatchId: string, environment?: "development", dataHubPublic = false, dataHubComposition = false,
  liveBlog = false, preparedReservation?: PublicBuildReservation, electionResultsVersion?: number) {
  const batch = preparedReservation ?? (await reservePublicBuildBatch({
    firestore: db,
    buildBatchId,
    commitSha: COMMIT_SHA,
  })).batch;
  const artifact = createPublicArtifactInventoryReceipt({
    reservation: batch,
    pages: [],
    posts: [],
    programs: [],
    authors: [],
    settings: [],
  });
  const directory = await mkdtemp(
    path.join(tmpdir(), "njpbs-worker-candidate-upload-"),
  );
  temporaryDirectories.push(directory);
  const distDirectory = path.join(directory, "dist");
  const artifactReceiptPath = path.join(directory, "artifact.json");
  const preparedArtifactPath = path.join(directory, "prepared.json");
  await mkdir(distDirectory);
  await writeFile(
    path.join(distDirectory, "index.html"),
    "<!doctype html>\n",
    "utf8",
  );
  await writeFile(
    artifactReceiptPath,
    `${JSON.stringify(artifact, null, 2)}\n`,
    "utf8",
  );
  await mkdir(path.join(distDirectory, "posts/_no-build-assets"), { recursive: true });
  await writeFile(path.join(distDirectory, "posts/_no-build-assets/renderer-release.json"),
    JSON.stringify({ schemaVersion: 1, rendererSha: COMMIT_SHA, ...(environment ? { environment } : {}), ...(dataHubPublic ? {dataHubReportingVersion:1} : {}), ...(dataHubComposition ? {dataHubCompositionVersion:1} : {}), ...(liveBlog ? {liveBlogVersion:1} : {}), ...(electionResultsVersion !== undefined ? { electionResultsVersion } : {}) }));
  const prepared = await preparePublicWorkerArtifact({
    artifactReceipt: artifact,
    distDirectory,
    outputPath: preparedArtifactPath,
  });
  return {
    artifactReceiptPath,
    distDirectory,
    preparedArtifactPath,
    prepared,
    tag: publicWorkerCandidateTag(prepared),
    message: publicWorkerCandidateMessage(prepared),
  };
}

const DEFAULT_VARIABLES = {
  DATA_HUB_COMPOSITION_VERSION: "0",
  NO_BUILD_RECORD_RENDERER_SHA: COMMIT_SHA,
  NO_BUILD_POST_FAMILIES: "posts",
  NO_BUILD_POST_RENDERER_SHA: COMMIT_SHA,
  NO_BUILD_PAGE_RENDERER_SHA: COMMIT_SHA,
  DATA_FIGURE_VERSION: "1",
  ELECTION_RESULTS_VERSION: "0",
  LIVE_BLOG_VERSION: "0",
  DATA_HUB_PUBLIC: "0",
};
const FAMILY_CAPABILITY = { schemaVersion: 2, families: ["posts"], enabled: true,
  rendererSha: COMMIT_SHA, authoritative: true, dataFigureVersion: 1 };
const PILOT_ENVIRONMENT = {
  NO_BUILD_POST_ENABLED: "true",
  NO_BUILD_POST_ID: "pilot-post",
  NO_BUILD_POST_BACKGROUND_BUCKET: "njpbs-pilot-background",
};

function versionReceipt(versionId: string, tag: string, message: string, variables: Record<string, string>) {
  return {
    id: versionId,
    metadata: {
      source: "wrangler",
      created_on: "2026-08-27T20:00:00.000Z",
    },
    annotations: {
      "workers/tag": tag,
      "workers/message": message,
      "workers/triggered_by": "version_upload",
    },
    resources: {
      script: { etag: "script-etag" },
      script_runtime: { assets: { html_handling: "force-trailing-slash", run_worker_first: true } },
      bindings: [
        ...Object.entries(variables).map(([name, text]) => ({ name, type: "plain_text", text })),
        { name: "ASSETS", type: "assets" },
        {
          name: "CMS_API",
          type: "service",
          service: "njpbs-cms-api",
          entrypoint: "PublicContentEntrypoint",
        },
      ],
    },
  };
}

function fakeWrangler({
  tag,
  message,
  listedVersionId = null,
  variables = DEFAULT_VARIABLES,
}: {
  tag: string;
  message: string;
  listedVersionId?: string | null;
  variables?: Record<string, string>;
}) {
  const commands: string[][] = [];
  const runCommand = async (args: string[]) => {
    commands.push([...args]);
    if (args[0] === "--version") {
      return { stdout: "4.123.0\n", stderr: "" };
    }
    if (args[0] === "versions" && args[1] === "list") {
      const versions = listedVersionId === null
        ? []
        : [{
            id: listedVersionId,
            annotations: {
              "workers/tag": tag,
              "workers/message": message,
            },
          }];
      return { stdout: JSON.stringify(versions), stderr: "" };
    }
    if (args[0] === "versions" && args[1] === "upload") {
      return {
        stdout: `Uploaded njpbs-production\nWorker Version ID: ${VERSION_ID}\n`,
        stderr: "",
      };
    }
    if (args[0] === "versions" && args[1] === "view") {
      return {
        stdout: JSON.stringify(versionReceipt(args[2], tag, message, variables)),
        stderr: "",
      };
    }
    throw new Error(`Unexpected Wrangler command: ${args.join(" ")}`);
  };
  return { commands, runCommand };
}

function commandCount(commands: string[][], name: string) {
  return commands.filter(
    (args) => args[0] === "versions" && args[1] === name,
  ).length;
}

beforeAll(() => {
  if (!PROJECT.startsWith("demo-") || !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) throw new Error("Use a local demo emulator");
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  db = isolatedFirestore("public-worker-candidate-upload.test.ts");
});

beforeEach(clearFirestore);

async function seedAdmission(enabled = true) {
  await db.doc("system/noBuildPostAdmission").set({ schemaVersion: 1, revision: 1, enabled,
    postId: "pilot-post", backgroundBucket: "njpbs-pilot-background" });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app.delete()));
});

describe("public Worker candidate upload orchestration", () => {
  async function detachedFixture(checkpoint = true) {
    const oldCommitSha = "b".repeat(40), preparationId = "Release0000000000001";
    await db.doc("system/publicDeployment").set({ ...initialPublicDeploymentPointer(), mediaLifecycleReady: true,
      activeGeneration: 7, activeDeploymentId: "deployment-seven", activeCommitSha: oldCommitSha,
      lastReservedGeneration: 7, newestEligibleGeneration: 7, newestEligibleBuildBatchId: "batch-seven" });
    await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: oldCommitSha,
      serializerId: "node-compute-primary", cloud: { phase: "ready", commitSha: oldCommitSha, serializerId: "cloudflare-publisher" } });
    await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 11 });
    const reservation = await preparePublicRelease({ firestore: db, preparationId, oldCommitSha, commitSha: COMMIT_SHA });
    const prepared = await fixture(`cms-${preparationId}`, undefined, false, false, false, reservation);
    if (checkpoint) await recordPreparedPublicReleaseCheckpoint({ firestore: db, preparationId, commitSha: COMMIT_SHA,
      inputSha256: "e".repeat(64), artifactCheckpointDigest: "f".repeat(64), preparedArtifact: prepared.prepared });
    const wrangler = fakeWrangler(prepared);
    const input = { ...prepared, firestore: db, runCommand: wrangler.runCommand, preparationId };
    return { prepared, wrangler, input, preparationId };
  }

  it("uploads a detached version without changing live readiness, admission, traffic or eligibility", async () => {
    const { input, preparationId } = await detachedFixture();
    const paths = ["system/publicDeployment", "system/cmsPublicationRuntime", "system/noBuildPostAdmission"];
    const before = await Promise.all(paths.map(async name => (await db.doc(name).get()).data()));
    const result = await uploadPublicWorkerCandidate(input);
    expect(result).toMatchObject({ workerVersionId: VERSION_ID, generation: 8, commitSha: COMMIT_SHA,
      runtime: { owner: "cloudflare", release: COMMIT_SHA } });
    expect((await db.doc(`system/publicReleasePreparations/entries/${preparationId}/candidates/worker`).get()).data()).toEqual(result);
    expect(await Promise.all(paths.map(async name => (await db.doc(name).get()).data()))).toEqual(before);
    expect((await db.collection("system/publicDeployment/buildBatches").get()).empty).toBe(true);
    expect((await db.collection("cmsPublicationSerializerJournals/cloudflare-publisher/releases").get()).empty).toBe(true);
  });

  it("reuses a detached upload receipt without another version upload", async () => {
    const { input, wrangler } = await detachedFixture();
    const candidate = await uploadPublicWorkerCandidate(input);
    expect(await uploadPublicWorkerCandidate(input)).toEqual(candidate);
    expect(commandCount(wrangler.commands, "upload")).toBe(1);
    expect((await db.doc("system/publicDeployment").get()).data()!.lastReservedGeneration).toBe(7);
  });

  it("refuses a complete on-disk build without a durable checkpoint before any provider command", async () => {
    const { input, wrangler, preparationId } = await detachedFixture(false);
    await expect(uploadPublicWorkerCandidate(input)).rejects.toThrow("no matching durable checkpoint");
    expect(wrangler.commands).toEqual([]);
    expect((await db.doc(`system/publicReleasePreparations/entries/${preparationId}/candidates/worker`).get()).exists).toBe(false);
    expect((await db.doc("system/publicDeployment").get()).data()!.lastReservedGeneration).toBe(7);
  });

  it("keeps the checkpoint immutable and refuses a different artifact before upload", async () => {
    const { input, prepared, preparationId, wrangler } = await detachedFixture();
    await expect(recordPreparedPublicReleaseCheckpoint({ firestore: db, preparationId, commitSha: COMMIT_SHA,
      inputSha256: "e".repeat(64), artifactCheckpointDigest: "a".repeat(64), preparedArtifact: prepared.prepared }))
      .rejects.toThrow("checkpoint cannot change");
    await writeFile(prepared.preparedArtifactPath, JSON.stringify({ ...prepared.prepared, artifactDigest: "f".repeat(64) }));
    await expect(uploadPublicWorkerCandidate(input)).rejects.toThrow("differs from its durable checkpoint");
    expect(wrangler.commands).toEqual([]);
  });

  it("requires the matching checkpoint in the candidate-recording transaction too", async () => {
    const { input, preparationId } = await detachedFixture();
    const { recordedAt: _at, ...candidate } = await uploadPublicWorkerCandidate(input);
    await db.doc(`system/publicReleasePreparations/entries/${preparationId}/checkpoints/artifact`).delete();
    await expect(recordPreparedPublicWorkerCandidate({ firestore: db, preparationId, candidate }))
      .rejects.toThrow("no matching durable checkpoint");
  });

  it("uploads retained assets and restores the retained server graph after a clean-checkout recovery", async () => {
    const { input, prepared, wrangler } = await detachedFixture();
    const directory = path.dirname(prepared.preparedArtifactPath);
    const renderer = path.join(directory, "renderer");
    const restoredRenderer = path.join(directory, "checkout/.public-post-renderer");
    await mkdir(path.join(renderer, "server"), { recursive: true });
    const seal = await readFile(path.join(prepared.distDirectory, "posts/_no-build-assets/renderer-release.json"));
    await writeFile(path.join(renderer, "renderer-release.json"), seal);
    await writeFile(path.join(renderer, "server/entry.mjs"), "export const retained = true;\n");
    const git = async (args: string[]) => args[0] === "rev-parse" ? COMMIT_SHA : "";
    const distDirectory = await restoreDetachedReleaseUploadPaths(prepared.preparedArtifactPath, restoredRenderer, git);
    expect(distDirectory).toBe(prepared.distDirectory);
    expect(await readFile(path.join(restoredRenderer, "server/entry.mjs"), "utf8")).toBe("export const retained = true;\n");
    await uploadPublicWorkerCandidate({ ...input, distDirectory });
    const upload = wrangler.commands.find(args => args[1] === "upload")!;
    expect(upload[upload.indexOf("--assets") + 1]).toBe(prepared.distDirectory);
    // A damaged checkpoint must leave the previously restored graph in place.
    await writeFile(path.join(prepared.distDirectory, "index.html"), "damaged checkpoint");
    await expect(restoreDetachedReleaseUploadPaths(prepared.preparedArtifactPath, restoredRenderer, git)).rejects.toThrow("changed after preparation");
    expect(await readFile(path.join(restoredRenderer, "server/entry.mjs"), "utf8")).toBe("export const retained = true;\n");
  });

  it("refuses a retained server seal that differs from its sealed public copy", async () => {
    const { prepared } = await detachedFixture();
    const directory = path.dirname(prepared.preparedArtifactPath);
    await mkdir(path.join(directory, "renderer"));
    await writeFile(path.join(directory, "renderer/renderer-release.json"), JSON.stringify({ schemaVersion: 1, rendererSha: "f".repeat(40) }));
    const git = async (args: string[]) => args[0] === "rev-parse" ? COMMIT_SHA : "";
    await expect(restoreDetachedReleaseUploadPaths(prepared.preparedArtifactPath, path.join(directory, "checkout-graph"), git))
      .rejects.toThrow("retained server renderer differs");
  });

  it.each(["wrong-source", "dirty-source"])("refuses %s before replacing the checkout renderer", async mode => {
    const { prepared } = await detachedFixture();
    const renderer = path.join(path.dirname(prepared.preparedArtifactPath), "checkout-graph");
    await mkdir(renderer);
    await writeFile(path.join(renderer, "previous.mjs"), "previous graph");
    const git = async (args: string[]) => args[0] === "rev-parse"
      ? mode === "wrong-source" ? "c".repeat(40) : COMMIT_SHA : " M workers/src/public-no-build-entry.ts\n";
    await expect(restoreDetachedReleaseUploadPaths(prepared.preparedArtifactPath, renderer, git))
      .rejects.toThrow("checkout does not match");
    expect(await readFile(path.join(renderer, "previous.mjs"), "utf8")).toBe("previous graph");
  });

  it("holds the producer's directory lock through detached upload and releases it on close", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "release-checkout-lock-"));
    temporaryDirectories.push(directory);
    const lock = await lockDetachedReleaseCheckout(directory);
    try {
      await expect(lockDetachedReleaseCheckout(directory)).rejects.toThrow("checkout is in use");
    } finally {
      await lock.close();
    }
    const next = await lockDetachedReleaseCheckout(directory);
    await next.close();
  });

  it("refuses altered detached bytes before an upload and leaves OLD ready", async () => {
    const { input, prepared, wrangler, preparationId } = await detachedFixture();
    await writeFile(path.join(prepared.distDirectory, "index.html"), "changed after sealing");
    await expect(uploadPublicWorkerCandidate(input)).rejects.toThrow();
    expect(commandCount(wrangler.commands, "upload")).toBe(0);
    expect((await db.doc(`system/publicReleasePreparations/entries/${preparationId}/candidates/worker`).get()).exists).toBe(false);
    expect((await db.doc("system/cmsPublicationRuntime").get()).data()!.phase).toBe("ready");
    expect((await db.doc("system/publicDeployment").get()).data()!.lastReservedGeneration).toBe(7);
  });

  it("keeps an upload failure detached from live publishing", async () => {
    const { input, wrangler, preparationId } = await detachedFixture();
    await expect(uploadPublicWorkerCandidate({ ...input, runCommand: async args => {
      if (args[0] === "versions" && args[1] === "upload") throw new Error("Fixture upload failed");
      return wrangler.runCommand(args);
    } })).rejects.toThrow("Fixture upload failed");
    expect((await db.doc(`system/publicReleasePreparations/entries/${preparationId}/candidates/worker`).get()).exists).toBe(false);
    expect((await db.collection("system/publicDeployment/buildBatches").get()).empty).toBe(true);
    expect((await db.doc("system/cmsPublicationRuntime").get()).data()!.cloud.phase).toBe("ready");
  });

  it("attests the first record reader without registering or admitting record work", async () => {
    const prepared = await fixture("build-first-record-reader");
    const wrangler = fakeWrangler({ ...prepared, variables: {
      ...DEFAULT_VARIABLES, NO_BUILD_RECORD_RENDERER_SHA: COMMIT_SHA,
    } });
    const namespace = db.doc("system/publicDeployment/noBuildRecordFamilies/current");
    const admission = db.doc("system/noBuildPostAdmission");
    expect((await namespace.get()).exists).toBe(false);
    expect((await admission.get()).exists).toBe(false);

    const candidate = await uploadPublicWorkerCandidate({
      artifactReceiptPath: prepared.artifactReceiptPath, distDirectory: prepared.distDirectory,
      preparedArtifactPath: prepared.preparedArtifactPath, firestore: db, runCommand: wrangler.runCommand,
    });

    const upload = wrangler.commands.find(args => args[0] === "versions" && args[1] === "upload")!;
    expect(upload.filter((_, index) => upload[index - 1] === "--var"))
      .toContain(`NO_BUILD_RECORD_RENDERER_SHA:${COMMIT_SHA}`);
    expect(candidate.noBuildRecord).toEqual({ schemaVersion: 1, rendererSha: COMMIT_SHA,
      enabled: true, authoritative: true, families: ["programs", "events"] });
    expect((await namespace.get()).exists).toBe(false);
    expect((await admission.get()).exists).toBe(false);
    expect((await db.collection("system/publicDeployment/noBuildRecordOwners").get()).empty).toBe(true);
    expect((await db.doc("system/publicDeployment/noBuildRecords/capability").get()).exists).toBe(false);
  });

  it("carries the composition marker only from the exact immutable renderer seal", async () => {
    const prepared = await fixture("build-hub-composition", undefined, true, true);
    const wrangler = fakeWrangler({ ...prepared, variables: { ...DEFAULT_VARIABLES, DATA_HUB_PUBLIC: "1", DATA_HUB_COMPOSITION_VERSION: "1" } });
    const result = await uploadPublicWorkerCandidate({ artifactReceiptPath: prepared.artifactReceiptPath, distDirectory: prepared.distDirectory, preparedArtifactPath: prepared.preparedArtifactPath, firestore: db, runCommand: wrangler.runCommand });
    expect(result.noBuildPage).toMatchObject({ dataHubReportingVersion: 1, dataHubCompositionVersion: 1, rendererSha: COMMIT_SHA });
  });
  it("carries the gated renderer capability into its exact Worker variable receipt",async()=>{
    const prepared=await fixture("build-hub",undefined,true);
    const wrangler=fakeWrangler({...prepared,variables:{...DEFAULT_VARIABLES,DATA_HUB_PUBLIC:"1"}});
    const candidate=await uploadPublicWorkerCandidate({artifactReceiptPath:prepared.artifactReceiptPath,distDirectory:prepared.distDirectory,preparedArtifactPath:prepared.preparedArtifactPath,firestore:db,runCommand:wrangler.runCommand});
    expect(candidate.noBuildPage).toMatchObject({dataHubReportingVersion:1,rendererSha:COMMIT_SHA});
    const upload=wrangler.commands.find(args=>args[0]==="versions"&&args[1]==="upload")!;
    expect(upload.filter((_,index)=>upload[index-1]==="--var")).toContain("DATA_HUB_PUBLIC:1");
    expect(upload.filter((_,index)=>upload[index-1]==="--var")).toContain("DATA_HUB_COMPOSITION_VERSION:0");
    expect(candidate.noBuildPage).not.toHaveProperty("dataHubCompositionVersion");
  });

  it.each([1, 2])("carries election version %s from the immutable seal through upload and candidate receipt", async version => {
    const prepared = await fixture(`build-election-${version}`, undefined, false, false, false, undefined, version);
    const wrangler = fakeWrangler({ ...prepared, variables: { ...DEFAULT_VARIABLES, ELECTION_RESULTS_VERSION: String(version) } });
    const candidate = await uploadPublicWorkerCandidate({ artifactReceiptPath: prepared.artifactReceiptPath,
      distDirectory: prepared.distDirectory, preparedArtifactPath: prepared.preparedArtifactPath,
      firestore: db, runCommand: wrangler.runCommand });
    expect(candidate.noBuildPage).toMatchObject({ electionResultsVersion: version });
    expect(candidate.noBuildPost).toMatchObject({ electionResultsVersion: version });
    const upload = wrangler.commands.find(args => args[0] === "versions" && args[1] === "upload")!;
    expect(upload.filter((_, index) => upload[index - 1] === "--var")).toContain(`ELECTION_RESULTS_VERSION:${version}`);
  });
  it("refuses election version 3 in the immutable seal before uploading", async () => {
    const prepared = await fixture("build-election-unknown", undefined, false, false, false, undefined, 3);
    const wrangler = fakeWrangler(prepared);
    await expect(uploadPublicWorkerCandidate({ artifactReceiptPath: prepared.artifactReceiptPath,
      distDirectory: prepared.distDirectory, preparedArtifactPath: prepared.preparedArtifactPath,
      firestore: db, runCommand: wrangler.runCommand })).rejects.toThrow("does not match");
    expect(wrangler.commands.some(args => args[0] === "versions" && args[1] === "upload")).toBe(false);
  });

  it("stages, uploads, verifies, and records one exact candidate", async () => {
    const prepared = await fixture("build-upload");
    const wrangler = fakeWrangler(prepared);

    const candidate = await uploadPublicWorkerCandidate({
      artifactReceiptPath: prepared.artifactReceiptPath,
      distDirectory: prepared.distDirectory,
      preparedArtifactPath: prepared.preparedArtifactPath,
      firestore: db,
      runCommand: wrangler.runCommand,
    });

    expect(candidate).toMatchObject({
      buildBatchId: "build-upload",
      workerVersionId: VERSION_ID,
      workerVersionTag: prepared.tag,
      artifactDigest: prepared.prepared.artifactDigest,
      publicationReceiptDigest:
        prepared.prepared.publicationReceiptDigest,
    });
    const upload = wrangler.commands.find(
      (args) => args[0] === "versions" && args[1] === "upload",
    );
    expect(upload).toEqual(expect.arrayContaining([
      "--strict",
      "--keep-vars",
      "--tag",
      prepared.tag,
      "--message",
      prepared.message,
    ]));
    expect(upload?.filter((_, index) => upload[index - 1] === "--var")).toEqual([
      `NO_BUILD_RECORD_RENDERER_SHA:${COMMIT_SHA}`, "NO_BUILD_POST_FAMILIES:posts", `NO_BUILD_POST_RENDERER_SHA:${COMMIT_SHA}`,
      `NO_BUILD_PAGE_RENDERER_SHA:${COMMIT_SHA}`, "DATA_FIGURE_VERSION:1", "ELECTION_RESULTS_VERSION:0", "LIVE_BLOG_VERSION:0", "DATA_HUB_PUBLIC:0", "DATA_HUB_COMPOSITION_VERSION:0",
    ]);
    expect(upload?.[upload.indexOf("--assets") + 1]).toBe(prepared.distDirectory);
    expect(candidate.noBuildPost).toEqual(FAMILY_CAPABILITY);
    expect(wrangler.commands.some((args) => args[1] === "deploy")).toBe(false);
    expect(commandCount(wrangler.commands, "list")).toBe(1);
    expect(commandCount(wrangler.commands, "upload")).toBe(1);
    expect(commandCount(wrangler.commands, "view")).toBe(1);

    const pointer = (
      await db.collection("system").doc("publicDeployment").get()
    ).data();
    expect(pointer).toMatchObject({
      state: "idle",
      newestEligibleGeneration: 1,
      newestEligibleBuildBatchId: "build-upload",
    });
  });

  it("reads operator admission without legacy flags and preserves a paused candidate", async () => {
    await seedAdmission();
    const prepared = await fixture("build-runtime-admission");
    const wrangler = fakeWrangler(prepared);
    const input = { ...prepared, firestore: db, runCommand: wrangler.runCommand, publicBuildEnvironment: {} };
    const candidate = await uploadPublicWorkerCandidate(input);
    expect(candidate.noBuildPost).toEqual(FAMILY_CAPABILITY);
    await db.doc("system/noBuildPostAdmission").update({ enabled: false, revision: 2 });
    expect(await uploadPublicWorkerCandidate(input)).toEqual(candidate);
    expect(commandCount(wrangler.commands, "upload")).toBe(1);
  });

  it.each([{ mode: "all" }, { mode: "ids", ids: ["first-post", "second-post"] }])(
    "uploads one family capability for the Post selector %j without choosing an owner", async posts => {
    await db.doc("system/noBuildPostAdmission").set({ schemaVersion: 2, revision: 1, enabled: true,
      families: { posts }, backgroundBucket: "njpbs-pilot-background" });
    const owners = [
      { postId: "first-post", operationId: "A".repeat(20), slug: "first-story" },
      { postId: "second-post", operationId: "B".repeat(20), slug: "second-story" },
    ].map(value => ({ schemaVersion: 1, servingEnabled: true, generation: 1,
      rendererSha: "b".repeat(40), sourceVersion: 1, visible: true, ownedSlugs: [value.slug], ...value }));
    for (const owner of owners) await db.doc(`system/publicDeployment/noBuildPostOwners/${owner.postId}`).set(owner);
    const prepared = await fixture("build-family-capability");
    const wrangler = fakeWrangler(prepared);
    const input = { ...prepared, firestore: db, runCommand: wrangler.runCommand };
    const candidate = await uploadPublicWorkerCandidate(input);
    expect(candidate.noBuildPost).toEqual(FAMILY_CAPABILITY);
    for (const owner of owners) {
      expect((await db.doc(`system/publicDeployment/noBuildPostOwners/${owner.postId}`).get()).data()).toEqual(owner);
    }
    await db.doc("system/noBuildPostAdmission").update({ revision: 2, enabled: false });
    expect(await uploadPublicWorkerCandidate(input)).toEqual(candidate);
    expect(commandCount(wrangler.commands, "upload")).toBe(1);
  });

  it("refuses supplied legacy settings with schema2 admission before upload", async () => {
    await db.doc("system/noBuildPostAdmission").set({ schemaVersion: 2, revision: 1, enabled: true,
      families: { posts: { mode: "all" } }, backgroundBucket: "njpbs-pilot-background" });
    const prepared = await fixture("build-family-environment-conflict");
    const wrangler = fakeWrangler(prepared);
    await expect(uploadPublicWorkerCandidate({ ...prepared, firestore: db,
      runCommand: wrangler.runCommand, publicBuildEnvironment: PILOT_ENVIRONMENT }))
      .rejects.toThrow("runtime admission record");
    expect(wrangler.commands).toEqual([]);
  });

  it("refuses ambiguous retained ownership before upload", async () => {
    const prepared = await fixture("build-owner-conflict");
    const owner = { schemaVersion: 1, postId: "pilot-post", operationId: "A".repeat(20),
      rendererSha: COMMIT_SHA, sourceVersion: 1, slug: "pilot-story", visible: true,
      servingEnabled: true, generation: 1, ownedSlugs: ["pilot-story"] };
    await db.doc("system/publicDeployment/noBuildPosts/current").set(owner);
    await db.doc("system/publicDeployment/noBuildPostOwners/pilot-post").set(owner);
    const wrangler = fakeWrangler(prepared);
    await expect(uploadPublicWorkerCandidate({ ...prepared, firestore: db, runCommand: wrangler.runCommand }))
      .rejects.toThrow("Two documents claim the same instant Post");
    expect(wrangler.commands).toEqual([]);
  });

  it.each(["false", "yes"])("retains family reader metadata when legacy uploaded enablement is %s", async enabled => {
    const prepared = await fixture("build-retained-pilot-variables");
    const wrangler = fakeWrangler({ ...prepared, variables: { ...DEFAULT_VARIABLES,
      NO_BUILD_POST_ID: "another-post", NO_BUILD_POST_ENABLED: enabled } });
    expect((await uploadPublicWorkerCandidate({ ...prepared, firestore: db, runCommand: wrangler.runCommand })).noBuildPost)
      .toEqual(FAMILY_CAPABILITY);
    const upload = wrangler.commands.find(args => args[1] === "upload")!;
    expect(upload.filter((_, index) => upload[index - 1] === "--var")).toEqual([
      `NO_BUILD_RECORD_RENDERER_SHA:${COMMIT_SHA}`, "NO_BUILD_POST_FAMILIES:posts", `NO_BUILD_POST_RENDERER_SHA:${COMMIT_SHA}`,
      `NO_BUILD_PAGE_RENDERER_SHA:${COMMIT_SHA}`, "DATA_FIGURE_VERSION:1", "ELECTION_RESULTS_VERSION:0", "LIVE_BLOG_VERSION:0", "DATA_HUB_PUBLIC:0", "DATA_HUB_COMPOSITION_VERSION:0",
    ]);
  });

  it("refuses legacy admission that disagrees with the operator record before upload", async () => {
    await seedAdmission(false);
    const prepared = await fixture("build-admission-conflict");
    const wrangler = fakeWrangler(prepared);
    await expect(uploadPublicWorkerCandidate({ ...prepared, firestore: db,
      runCommand: wrangler.runCommand, publicBuildEnvironment: PILOT_ENVIRONMENT })).rejects.toThrow("runtime admission record");
    expect(wrangler.commands).toEqual([]);
  });

  it.each(["missing", "malformed", "different Post"])("retains owned reader capability through %s admission and repair", async failure => {
    const prepared = await fixture("build-retained-reader");
    await db.doc("system/publicDeployment/noBuildPosts/current").set({ schemaVersion: 1, postId: "pilot-post",
      operationId: "11111111111111111111", rendererSha: COMMIT_SHA, sourceVersion: 1, slug: "pilot-story",
      visible: true, servingEnabled: true, generation: 1, ownedSlugs: ["pilot-story"] });
    if (failure === "malformed") await db.doc("system/noBuildPostAdmission").set({ enabled: true });
    if (failure === "different Post") {
      await seedAdmission();
      await db.doc("system/noBuildPostAdmission").update({ postId: "other-post", revision: 2 });
    }
    const wrangler = fakeWrangler(prepared);
    const input = { ...prepared, firestore: db, runCommand: wrangler.runCommand, publicBuildEnvironment: {} };
    const candidate = await uploadPublicWorkerCandidate(input);
    expect(candidate.noBuildPost).toEqual(FAMILY_CAPABILITY);
    await seedAdmission();
    expect(await uploadPublicWorkerCandidate(input)).toEqual(candidate);
    expect(commandCount(wrangler.commands, "upload")).toBe(1);
  });

  it.each(["true", "false"])("seals configured serving while admission is %s", async (enabled) => {
    await seedAdmission(enabled === "true");
    const prepared = await fixture(`build-pilot-${enabled}`);
    const wrangler = fakeWrangler(prepared);
    const input = { ...prepared, firestore: db, runCommand: wrangler.runCommand,
      publicBuildEnvironment: { ...PILOT_ENVIRONMENT, NO_BUILD_POST_ENABLED: enabled } };
    const candidate = await uploadPublicWorkerCandidate(input);
    expect(candidate.noBuildPost).toEqual(FAMILY_CAPABILITY);
    const upload = wrangler.commands.find(args => args[1] === "upload")!;
    expect(upload.filter((_, index) => upload[index - 1] === "--var")).toEqual([
      `NO_BUILD_RECORD_RENDERER_SHA:${COMMIT_SHA}`, "NO_BUILD_POST_FAMILIES:posts", `NO_BUILD_POST_RENDERER_SHA:${COMMIT_SHA}`,
      `NO_BUILD_PAGE_RENDERER_SHA:${COMMIT_SHA}`, "DATA_FIGURE_VERSION:1", "ELECTION_RESULTS_VERSION:0", "LIVE_BLOG_VERSION:0", "DATA_HUB_PUBLIC:0", "DATA_HUB_COMPOSITION_VERSION:0",
    ]);
    const stored = await db.doc(`system/publicDeployment/buildBatches/${candidate.buildBatchId}/candidates/worker`).get();
    expect(stored.data()?.noBuildPost).toEqual(candidate.noBuildPost);
    expect(await uploadPublicWorkerCandidate(input)).toEqual(candidate);
    expect(commandCount(wrangler.commands, "upload")).toBe(1);
  });

  it.each([
    { NO_BUILD_POST_RENDERER_SHA: COMMIT_SHA },
    { ...DEFAULT_VARIABLES, NO_BUILD_POST_RENDERER_SHA: "b".repeat(40) },
    { ...DEFAULT_VARIABLES, NO_BUILD_PAGE_RENDERER_SHA: "b".repeat(40) },
  ])("refuses mismatched uploaded or recovered settings: %j", async variables => {
    await seedAdmission();
    const prepared = await fixture("build-wrong-settings");
    const wrangler = fakeWrangler({ ...prepared, variables, listedVersionId: VERSION_ID });
    await expect(uploadPublicWorkerCandidate({ ...prepared, firestore: db, runCommand: wrangler.runCommand,
      publicBuildEnvironment: PILOT_ENVIRONMENT })).rejects.toThrow(/configuration does not match/);
    expect(commandCount(wrangler.commands, "upload")).toBe(0);
    expect((await db.doc("system/publicDeployment/buildBatches/build-wrong-settings/candidates/worker").get()).exists).toBe(false);
  });

  it("refuses an unsupported data figure marker before uploading or recording a candidate", async () => {
    await seedAdmission();
    const prepared = await fixture("build-wrong-figure-marker");
    const wrangler = fakeWrangler({ ...prepared, variables: { ...DEFAULT_VARIABLES, DATA_FIGURE_VERSION: "2" }, listedVersionId: VERSION_ID });
    // Keep the real refusal/recovery path while advancing only its documented
    // receipt backoffs. Firestore's network and deadline timers stay real.
    const nativeTimeout = globalThis.setTimeout, receiptDelays: number[] = [];
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
      if ([2_000, 5_000, 10_000].includes(Number(delay))) {
        receiptDelays.push(Number(delay)); return nativeTimeout(callback, 0, ...args);
      }
      return nativeTimeout(callback, delay, ...args);
    });
    try {
      await expect(uploadPublicWorkerCandidate({ ...prepared, firestore: db, runCommand: wrangler.runCommand,
        publicBuildEnvironment: PILOT_ENVIRONMENT })).rejects.toThrow("The candidate data figure metadata is invalid");
    } finally { timer.mockRestore(); }
    expect(receiptDelays).toEqual([2_000, 5_000, 10_000]);
    expect(commandCount(wrangler.commands, "upload")).toBe(0);
    expect((await db.doc("system/publicDeployment/buildBatches/build-wrong-figure-marker/candidates/worker").get()).exists).toBe(false);
  });

  it("requires family capability metadata in the uploaded receipt", async () => {
    const prepared = await fixture("build-missing-settings");
    const wrangler = fakeWrangler({ ...prepared, variables: {} });
    await expect(uploadPublicWorkerCandidate({ ...prepared, firestore: db, runCommand: wrangler.runCommand }))
      .rejects.toThrow(/configuration does not match/);
    expect((await db.doc("system/publicDeployment/buildBatches/build-missing-settings/candidates/worker").get()).exists).toBe(false);
  });

  it("requires the copied renderer seal to match the configured version", async () => {
    await seedAdmission();
    const prepared = await fixture("build-wrong-renderer");
    const wrangler = fakeWrangler({ ...prepared, listedVersionId: VERSION_ID });
    await writeFile(path.join(prepared.distDirectory, "posts/_no-build-assets/renderer-release.json"),
      JSON.stringify({ schemaVersion: 1, rendererSha: "b".repeat(40) }));
    await expect(uploadPublicWorkerCandidate({ ...prepared, firestore: db, runCommand: wrangler.runCommand,
      publicBuildEnvironment: PILOT_ENVIRONMENT })).rejects.toThrow(/renderer does not match/);
    expect((await db.doc("system/publicDeployment/buildBatches/build-wrong-renderer/candidates/worker").get()).exists).toBe(false);
  });
  it("refuses a dev compiler seal at the same source before a production upload", async () => {
    const prepared = await fixture("build-dev-renderer", "development");
    const wrangler = fakeWrangler(prepared);
    await expect(uploadPublicWorkerCandidate({ ...prepared, firestore: db, runCommand: wrangler.runCommand }))
      .rejects.toThrow("prepared production artifact");
    expect(wrangler.commands).toEqual([]);
    expect((await db.doc("system/publicDeployment/buildBatches/build-dev-renderer/candidates/worker").get()).exists).toBe(false);
  });

  it("refuses partial settings before invoking Wrangler", async () => {
    const prepared = await fixture("build-partial-settings");
    const wrangler = fakeWrangler(prepared);
    await expect(uploadPublicWorkerCandidate({ ...prepared, firestore: db, runCommand: wrangler.runCommand,
      publicBuildEnvironment: { NO_BUILD_POST_ID: "pilot-post" } })).rejects.toThrow(/configuration is invalid/);
    expect(wrangler.commands).toEqual([]);
  });

  it("reuses the stored candidate without another list or upload", async () => {
    const prepared = await fixture("build-retry");
    const wrangler = fakeWrangler(prepared);
    const input = {
      artifactReceiptPath: prepared.artifactReceiptPath,
      distDirectory: prepared.distDirectory,
      preparedArtifactPath: prepared.preparedArtifactPath,
      firestore: db,
      runCommand: wrangler.runCommand,
    };

    const first = await uploadPublicWorkerCandidate(input);
    const retry = await uploadPublicWorkerCandidate(input);

    expect(retry).toEqual(first);
    expect(commandCount(wrangler.commands, "list")).toBe(1);
    expect(commandCount(wrangler.commands, "upload")).toBe(1);
    expect(commandCount(wrangler.commands, "view")).toBe(2);
  });

  it("recovers an explicit version without listing or uploading", async () => {
    const prepared = await fixture("build-recovery");
    const wrangler = fakeWrangler(prepared);

    const candidate = await uploadPublicWorkerCandidate({
      artifactReceiptPath: prepared.artifactReceiptPath,
      distDirectory: prepared.distDirectory,
      preparedArtifactPath: prepared.preparedArtifactPath,
      recoveryVersionId: VERSION_ID.toUpperCase(),
      firestore: db,
      runCommand: wrangler.runCommand,
    });

    expect(candidate.workerVersionId).toBe(VERSION_ID);
    expect(commandCount(wrangler.commands, "list")).toBe(0);
    expect(commandCount(wrangler.commands, "upload")).toBe(0);
    expect(commandCount(wrangler.commands, "view")).toBe(1);
  });

  it("recovers the exact tagged version without another upload", async () => {
    const prepared = await fixture("build-list-recovery");
    const wrangler = fakeWrangler({
      ...prepared,
      listedVersionId: VERSION_ID,
    });

    const candidate = await uploadPublicWorkerCandidate({
      artifactReceiptPath: prepared.artifactReceiptPath,
      distDirectory: prepared.distDirectory,
      preparedArtifactPath: prepared.preparedArtifactPath,
      firestore: db,
      runCommand: wrangler.runCommand,
    });

    expect(candidate.workerVersionId).toBe(VERSION_ID);
    expect(commandCount(wrangler.commands, "list")).toBe(1);
    expect(commandCount(wrangler.commands, "upload")).toBe(0);
    expect(commandCount(wrangler.commands, "view")).toBe(1);
  });

  it("refuses to upload bytes changed after preparation", async () => {
    const prepared = await fixture("build-changed");
    const wrangler = fakeWrangler(prepared);
    await writeFile(
      path.join(prepared.distDirectory, "index.html"),
      "changed after preparation\n",
      "utf8",
    );

    await expect(uploadPublicWorkerCandidate({
      artifactReceiptPath: prepared.artifactReceiptPath,
      distDirectory: prepared.distDirectory,
      preparedArtifactPath: prepared.preparedArtifactPath,
      firestore: db,
      runCommand: wrangler.runCommand,
    })).rejects.toThrow(/changed after preparation/i);

    expect(commandCount(wrangler.commands, "upload")).toBe(0);
    const pointer = (
      await db.collection("system").doc("publicDeployment").get()
    ).data();
    expect(pointer).toMatchObject({
      state: "idle",
      newestEligibleGeneration: 0,
      newestEligibleBuildBatchId: null,
    });
    expect((
      await db.collection("publicWorkerCandidates").doc("build-changed").get()
    ).exists).toBe(false);
  });
});

it("retains immutable Page capability from the uploaded version in the durable candidate", async () => {
  const prepared = await fixture("build-page-upload");
  const wrangler = fakeWrangler({ ...prepared, variables: { ...DEFAULT_VARIABLES,
    NO_BUILD_PAGE_RENDERER_SHA: COMMIT_SHA } });
  const result = await uploadPublicWorkerCandidate({ ...prepared, firestore: db, runCommand: wrangler.runCommand });
  const expected = { schemaVersion: 1, rendererSha: COMMIT_SHA, enabled: true, authoritative: true,
    dataFigureVersion: 1 };
  expect(result.noBuildPage).toEqual(expected);
  const stored = await db.doc("system/publicDeployment/buildBatches/build-page-upload/candidates/worker").get();
  expect(stored.data()?.noBuildPage).toEqual(expected);
});


it("advertises live blog support only from the exact sealed renderer artifact", async () => {
  const prepared = await fixture("build-live-blog", undefined, false, false, true);
  const wrangler = fakeWrangler({ ...prepared, variables: { ...DEFAULT_VARIABLES, LIVE_BLOG_VERSION: "1" } });
  const result = await uploadPublicWorkerCandidate({ ...prepared, firestore: db, runCommand: wrangler.runCommand });
  expect(result.noBuildPost).toEqual({ ...FAMILY_CAPABILITY, liveBlogVersion: 1 });
  const upload = wrangler.commands.find(args => args[1] === "upload")!;
  expect(upload.filter((_, index) => upload[index - 1] === "--var")).toContain("LIVE_BLOG_VERSION:1");
  expect((await db.doc("system/publicDeployment/buildBatches/build-live-blog/candidates/worker").get()).data()?.noBuildPost)
    .toEqual({ ...FAMILY_CAPABILITY, liveBlogVersion: 1 });
});

it("refuses an uploaded live blog marker that its compiled artifact did not seal", async () => {
  const prepared = await fixture("build-forged-live-blog");
  const wrangler = fakeWrangler({ ...prepared, variables: { ...DEFAULT_VARIABLES, LIVE_BLOG_VERSION: "1" }, listedVersionId: VERSION_ID });
  await expect(uploadPublicWorkerCandidate({ ...prepared, firestore: db, runCommand: wrangler.runCommand }))
    .rejects.toThrow("configuration does not match");
  expect(commandCount(wrangler.commands, "upload")).toBe(0);
  expect((await db.doc("system/publicDeployment/buildBatches/build-forged-live-blog/candidates/worker").get()).exists).toBe(false);
});

it("refuses unknown live blog renderer artifact versions before an upload", async () => {
  const prepared = await fixture("build-unknown-live-blog");
  await writeFile(path.join(prepared.distDirectory, "posts/_no-build-assets/renderer-release.json"),
    JSON.stringify({ schemaVersion: 1, rendererSha: COMMIT_SHA, liveBlogVersion: 2 }));
  const wrangler = fakeWrangler(prepared);
  await expect(uploadPublicWorkerCandidate({ ...prepared, firestore: db, runCommand: wrangler.runCommand }))
    .rejects.toThrow("renderer does not match");
  expect(commandCount(wrangler.commands, "upload")).toBe(0);
});
