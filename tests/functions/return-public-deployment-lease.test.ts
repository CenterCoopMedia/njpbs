import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Firestore } from "firebase-admin/firestore";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { returnPublicDeploymentLease } from "../../site/scripts/return-public-deployment-lease";
import { createPublicArtifactInventoryReceipt } from "../../site/src/lib/public-artifact-inventory";

const requireModule = createRequire(import.meta.url);
const { acquirePublicDeploymentLease, reservePublicBuildBatch } = requireModule("../../functions/lib/public-deployment-coordinator.js");
const { settlePublicDeploymentOutcome } = requireModule("../../functions/lib/public-deployment-outcome-store.js");
const { createPublicMediaManifest } = requireModule("../../functions/lib/public-media-manifest.js");
const { markPublicMediaManifestReady, stagePublicMediaManifest } = requireModule("../../functions/lib/public-media-manifest-store.js");
const { recordPublicWorkerCandidate } = requireModule("../../functions/lib/public-worker-candidate-store.js");
const { publicWorkerCandidateTag } = requireModule("../../functions/lib/public-worker-candidate.js");
const { publicationTarget } = requireModule("../../functions/lib/publication-target.js");

const TARGET = publicationTarget("production");
const ACCOUNT = "https://api.cloudflare.com/client/v4/accounts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const APPLICATION = "99999999-9999-4999-8999-999999999999";
const QUEUE_ID = "Q".repeat(20);
const BATCH = `cms-${QUEUE_ID}`;
const COMMIT = "a".repeat(40);
const RUNTIME = { owner: "cloudflare", release: COMMIT };
const PREDECESSOR = "44444444-4444-4444-8444-444444444444";
const LANDED = "33333333-3333-4333-8333-333333333333";
const MINUTE = 60_000;
let db: Firestore;

const POINTER = { schemaVersion: 1, mediaLifecycleReady: true, state: "idle", activeGeneration: 7, activeDeploymentId: PREDECESSOR,
  activeCommitSha: "b".repeat(40), lastReservedGeneration: 7, newestEligibleGeneration: 7, newestEligibleBuildBatchId: "cms-predecessor" };

const pointerRef = () => db.doc("system/publicDeployment");
const batchRef = () => db.doc(`system/publicDeployment/buildBatches/${BATCH}`);
const requestRef = () => db.doc(`cmsPublicationSerializerJournals/${TARGET.serializerId}/releases/${QUEUE_ID}`);
const journalRef = () => db.doc(`cmsPublicationSerializerJournals/${TARGET.serializerId}`);

/** A release whose lease is held as reconciling after its attempts ended. */
async function heldLease() {
  await pointerRef().set(POINTER);
  const { batch } = await reservePublicBuildBatch({ firestore: db, buildBatchId: BATCH, commitSha: COMMIT, runtime: RUNTIME });
  const artifact = createPublicArtifactInventoryReceipt({ reservation: batch, pages: [], posts: [], programs: [], authors: [], settings: [] });
  const manifest = createPublicMediaManifest({ reservation: batch, owners: artifact.owners,
    artifactInventory: artifact.families.map(family => ({ collection: family.collection, complete: true,
      documentIds: family.artifacts.map(({ documentId }) => documentId) })) });
  await stagePublicMediaManifest({ firestore: db, manifest });
  await markPublicMediaManifestReady({ firestore: db, manifest });
  const sealed = { schemaVersion: 1, buildBatchId: BATCH, generation: batch.generation, commitSha: COMMIT, artifactDigest: "b".repeat(64),
    artifactReceiptDigest: "c".repeat(64), mediaManifestDigest: manifest.mediaManifestDigest,
    publicationReceiptDigest: createHash("sha256").update("receipt").digest("hex"), artifactFileCount: 2, artifactBytes: 1_000 };
  await recordPublicWorkerCandidate({ firestore: db, runtime: RUNTIME, candidate: { ...sealed, runtime: RUNTIME, workerName: "njpbs-production",
    workerVersionId: "22222222-2222-4222-8222-222222222222", workerVersionTag: publicWorkerCandidateTag(sealed),
    versionCreatedOn: "2026-08-27T20:00:00.000Z", wranglerVersion: "4.123.0" } });
  const before = { pointer: (await pointerRef().get()).data()!, batch: (await batchRef().get()).data()! };
  await requestRef().set({ schemaVersion: 1, runtime: RUNTIME, queueId: QUEUE_ID, buildBatchId: BATCH, commitSha: COMMIT, inputSha256: "d".repeat(64),
    artifactCheckpointDigest: "e".repeat(64), status: "failed", attempts: 4, nextAttemptAt: null, failureReason: "activation: exhausted" });
  await journalRef().set({ schemaVersion: 1, serializerId: TARGET.serializerId, runtime: RUNTIME, job: { queueId: QUEUE_ID, buildBatchId: BATCH,
    commitSha: COMMIT, claimToken: "55555555-5555-4555-8555-555555555555", createdAt: "2026-11-25T20:00:00.000Z" } });
  const { lease } = await acquirePublicDeploymentLease({ firestore: db, buildBatchId: BATCH, commitSha: COMMIT, runtime: RUNTIME });
  await settlePublicDeploymentOutcome({ firestore: db, lease, runtime: RUNTIME, evidence: { action: "reconcile" } });
  return { before, lease, leaseAt: lease.leaseAcquiredAt.toMillis() as number };
}

const deployment = (id: string, createdOn: number) => ({ id, source: "api", strategy: "percentage",
  annotations: { "workers/triggered_by": "deployment" }, created_on: new Date(createdOn).toISOString(),
  versions: [{ version_id: "66666666-6666-4666-8666-666666666666", percentage: 100 }] });

/** Cloudflare as the operator reads it. `reads` holds one deployment list for each read. */
function cloudflare(reads: unknown[][], instances: unknown[] | Error = []) {
  const left = [...reads];
  const methods: string[] = [];
  const requestJson = async ({ url, method }: { url: string; method: string }) => {
    methods.push(method);
    if (url === `${ACCOUNT}/containers/applications`) return { success: true, result: [{ id: APPLICATION, name: TARGET.publisherWorker }] };
    if (url === `${ACCOUNT}/containers/dash/applications/${APPLICATION}/instances?per_page=100`) {
      if (instances instanceof Error) throw instances;
      return { success: true, result: { instances, durable_objects: [] } };
    }
    if (url === `${ACCOUNT}/workers/scripts/njpbs-production/deployments` && left.length) return { success: true, result: { deployments: left.shift() } };
    throw new Error(`unexpected request ${method} ${url}`);
  };
  return { requestJson, methods };
}

const everything = async () => Promise.all([pointerRef(), batchRef(), requestRef(), journalRef()].map(async ref => (await ref.get()).data()));

async function run(provider: ReturnType<typeof cloudflare>, leaseAt: number, options: Record<string, unknown> = {}) {
  const lines: Record<string, unknown>[] = [];
  const work = returnPublicDeploymentLease({ firestore: db, cloudflareApiToken: "t".repeat(40), target: TARGET, buildBatchId: BATCH, apply: true,
    requestJson: provider.requestJson as never, pause: async () => {}, now: () => leaseAt + 11 * MINUTE, report: line => { lines.push(line); }, ...options });
  return { lines, result: await work };
}

async function refuses(work: () => Promise<unknown>, message: RegExp) {
  const before = await everything();
  await expect(work()).rejects.toThrow(message);
  expect(await everything()).toEqual(before);
}

beforeAll(() => { db = isolatedFirestore("return-public-deployment-lease.test.ts") as unknown as Firestore; });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`,
    { method: "DELETE" }, db);
});

describe("return of a deployment lease with no deployment write", () => {
  it("gives the lease back so the publisher takes a new one", async () => {
    const { before, lease, leaseAt } = await heldLease();
    const list = [deployment(PREDECESSOR, leaseAt - 60 * MINUTE)];
    const provider = cloudflare([list, list]);
    const { lines, result } = await run(provider, leaseAt);
    expect(result).toMatchObject({ outcome: "returned", buildBatchId: BATCH, container: "gone" });
    expect(lines.map(line => line.check)).toEqual(["publisher container", "first deployment read", "second deployment read"]);
    expect(lines.slice(1).map(line => line.activeDeploymentId)).toEqual([PREDECESSOR, PREDECESSOR]);
    expect(new Set(provider.methods)).toEqual(new Set(["GET"]));
    const [pointer, batch, request] = await everything();
    expect({ ...pointer, updatedAt: null }).toEqual({ ...before.pointer, updatedAt: null });
    expect(batch).toEqual(before.batch);
    expect(request).toMatchObject({ status: "pending", attempts: 0, nextAttemptAt: leaseAt + 11 * MINUTE, failureReason: null });
    const next = await acquirePublicDeploymentLease({ firestore: db, buildBatchId: BATCH, commitSha: COMMIT, runtime: RUNTIME });
    expect(next).toMatchObject({ outcome: "acquired", idempotent: false, lease: { predecessorDeploymentId: PREDECESSOR } });
    expect(next.lease.leaseToken).not.toBe(lease.leaseToken);
  });

  it("writes nothing without --apply", async () => {
    const { leaseAt } = await heldLease();
    const list = [deployment(PREDECESSOR, leaseAt - MINUTE)];
    const before = await everything();
    expect((await run(cloudflare([list, list]), leaseAt, { apply: false })).result.outcome).toBe("dry-run");
    expect(await everything()).toEqual(before);
  });

  it("refuses a write that landed, or that was replaced after it landed", async () => {
    const { leaseAt } = await heldLease();
    const landed = [deployment(LANDED, leaseAt + MINUTE), deployment(PREDECESSOR, leaseAt - MINUTE)];
    await refuses(() => run(cloudflare([landed]), leaseAt), /active deployment is 33333333/);
    const replaced = [deployment(PREDECESSOR, leaseAt - MINUTE), deployment(LANDED, leaseAt + MINUTE)];
    await refuses(() => run(cloudflare([replaced]), leaseAt), /A deployment was made at/);
  });

  it("refuses a write that landed between the two reads", async () => {
    const { leaseAt } = await heldLease();
    const list = [deployment(PREDECESSOR, leaseAt - MINUTE)];
    await refuses(() => run(cloudflare([list, [deployment(LANDED, leaseAt + 11 * MINUTE), ...list]]), leaseAt), /active deployment is 33333333/);
  });

  it("refuses another release's lease, a lease that changed and an idle pointer", async () => {
    const { leaseAt } = await heldLease();
    const list = [deployment(PREDECESSOR, leaseAt - MINUTE)];
    await refuses(() => run(cloudflare([list, list]), leaseAt, { buildBatchId: `cms-${"R".repeat(20)}` }), /The lease belongs to cms-Q/);
    const other = "77777777-7777-4777-8777-777777777777";
    await expect(run(cloudflare([list, list]), leaseAt, { pause: () => Promise.all([pointerRef().update({ leaseToken: other }),
      batchRef().update({ leaseToken: other })]) })).rejects.toThrow("The lease changed");
    expect((await pointerRef().get()).data()).toMatchObject({ state: "reconciling", leaseToken: other });
    await pointerRef().set(POINTER);
    await refuses(() => run(cloudflare([list, list]), leaseAt), /No deployment lease is held/);
  });

  it("refuses a young lease and names when it may run", async () => {
    const { leaseAt } = await heldLease();
    await refuses(() => run(cloudflare([]), leaseAt, { now: () => leaseAt + 9 * MINUTE }),
      new RegExp(`540 seconds old. This may run at ${new Date(leaseAt + 10 * MINUTE).toISOString()}`));
  });

  it("refuses while the container that took the lease runs, and waits for the write limit when it cannot tell", async () => {
    const { leaseAt } = await heldLease();
    const list = [deployment(PREDECESSOR, leaseAt - MINUTE)];
    const instance = (at: number) => ({ id: "one", created_at: new Date(at).toISOString() });
    await refuses(() => run(cloudflare([list, list], [instance(leaseAt + MINUTE), instance(leaseAt - MINUTE)]), leaseAt, { now: () => leaseAt + 60 * MINUTE }),
      /can still hold the write/);
    const denied = new Error("The Cloudflare API returned HTTP 403");
    await refuses(() => run(cloudflare([list, list], denied), leaseAt, { now: () => leaseAt + 30 * MINUTE }), /cannot tell which container.*HTTP 403/);
    expect((await run(cloudflare([list, list], denied), leaseAt, { now: () => leaseAt + 31 * MINUTE, apply: false })).result.container).toBe("unknown");
    expect((await run(cloudflare([list, list], [instance(leaseAt + MINUTE)]), leaseAt)).result.container).toBe("gone");
  });

  it("refuses when the request or the publisher journal names other work", async () => {
    const { leaseAt } = await heldLease();
    const list = [deployment(PREDECESSOR, leaseAt - MINUTE)];
    await journalRef().update({ "job.queueId": "R".repeat(20) });
    await refuses(() => run(cloudflare([list, list]), leaseAt), /journal holds another release/);
    await requestRef().update({ status: "deployed" });
    await refuses(() => run(cloudflare([list, list]), leaseAt), /release request does not match/);
  });
});
