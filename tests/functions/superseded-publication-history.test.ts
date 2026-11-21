import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const history = require("../../scripts/lib/superseded-publication-history.cjs");
const { publicContextDigest } = require("../../functions/lib/public-context-revision.js");
const { publicationTarget } = require("../../functions/lib/publication-target.js");
const { proofKey } = require("../../functions/lib/page-consumer-proof.js");
const { initialPublicDeploymentPointer } = require("../../functions/lib/public-deployment-pointer.js");
const { exhaustedPostProof, postProofDue } = require("../../functions/lib/no-build-post-proof-state.js");

const now = 100_000;
const runtime = { owner: "cloudflare", release: "a".repeat(40) };
const target = publicationTarget("development");
const homeOwner = "system/publicDeployment/noBuildPageOwners/home";
const id = (n: number) => String(n).padStart(20, "0");
const queue = (n: number) => `cmsPublishQueue/${id(n)}`;
const postProof = queue(1);
const preparation = `${queue(2)}/backgroundPreparation/${publicContextDigest(10)}`;
const currentPreparation = `${queue(2)}/backgroundPreparation/${publicContextDigest(20)}`;
const selectedPreparation = `${queue(10)}/backgroundPreparation/${publicContextDigest(11)}`;
const output = `${queue(3)}/backgroundOutputs/authors`;
const selectedOutput = `${queue(7)}/backgroundOutputs/authors`;
const home = `${queue(1)}/homePageRefresh/home`;
const currentHome = `${queue(7)}/homePageRefresh/home`;
const page = (n: number) => `${queue(n)}/confirmation/page-consumers`;
const schedule = { claim: null, nextAttemptAt: now - 200, attempts: 2 };
const record = { schemaVersion: 1, status: "success", runtime };
const claim = "12345678-1234-1234-1234-123456789abc";

type Ref = { path: string };
type Data = Record<string, unknown>;
type Document = { value: Data; created: number; updated: number };

function store(seed: Record<string, Data>) {
  const rows = new Map<string, Document>();
  let revision = 0;
  let audits = 0;
  const put = (path: string, value: Data) => {
    revision++;
    rows.set(path, { value, created: rows.get(path)?.created ?? revision, updated: revision });
  };
  for (const [path, value] of Object.entries(seed)) put(path, value);
  const stamp = (version: number) => ({ seconds: 1, nanoseconds: version,
    isEqual: (other: { nanoseconds: number }) => other.nanoseconds === version });
  const doc = (path: string) => ({ path });
  async function runTransaction<T>(run: (tx: object) => Promise<T>, { readOnly = false } = {}) {
    const writes: Array<() => void> = [];
    const get = (ref: Ref) => {
      expect(writes).toHaveLength(0);
      const row = rows.get(ref.path);
      return { id: ref.path.split("/").at(-1), ref, exists: Boolean(row), data: () => row?.value,
        createTime: row && stamp(row.created), updateTime: row && stamp(row.updated), readTime: { toMillis: () => now } };
    };
    const result = await run({ get: async (ref: Ref) => get(ref), getAll: async (...refs: Ref[]) => refs.map(get),
      update: (ref: Ref, value: Data) => writes.push(() => put(ref.path, { ...rows.get(ref.path)?.value, ...value })),
      create: (ref: Ref, value: Data) => writes.push(() => {
        expect(rows.has(ref.path)).toBe(false);
        put(ref.path, value);
      }),
    });
    if (readOnly) expect(writes).toHaveLength(0);
    for (const write of writes) write();
    return result;
  }
  const firestore = { projectId: target.projectId, doc,
    collection: (path: string) => ({ doc: () => doc(`${path}/${++audits}`) }), runTransaction };
  return { firestore, rows, put, data: (path: string) => rows.get(path)?.value };
}

function fixture() {
  const aggregateQueue = (n: number, revision: number, status = "success") => ({
    ...record, status, transport: "public-context-no-build-v1", changes: [],
    publicContext: { operationId: id(n), contextRevision: revision, contextDigest: publicContextDigest(revision), outputs: ["authors"] },
    settingsPublication: { rendererSha: runtime.release, contextRevision: revision, contextDigest: publicContextDigest(revision) },
  });
  const proof = (n: number, revision: number) => ({ key: proofKey(aggregateQueue(n, revision)),
    status: "running", attempts: 2, claim, nextAttemptAt: now - 100, leaseUntil: now - 200 });
  const homeTask = { ...record, ...schedule, owner: "page-no-build-v1", pageId: "home", revision: 10, status: "failed", rendererSha: runtime.release,
    input: { homeOperationId: id(9), homeSourceVersion: 3, sourceOperationId: id(1), postId: "post", sourceVersion: 1, visible: true } };
  const preparationTask = { ...record, ...schedule, status: "failed", contextDigest: publicContextDigest(10) };
  const outputTask = { ...record, ...schedule, status: "pending", owner: "post-background-v1", output: "authors", revision: 2 };
  const seed = {
    "system/publicDeployment": { ...initialPublicDeploymentPointer(), activeGeneration: 8, activeCommitSha: runtime.release,
      activeDeploymentId: "test-deployment", lastReservedGeneration: 8, newestEligibleGeneration: 8,
      newestEligibleBuildBatchId: "test-batch", mediaLifecycleReady: true },
    "system/publicDeployment/contexts/public": { schemaVersion: 1, revision: 20 },
    "system/publicDeployment/aggregateContexts/current": { ...record, operationId: id(10), namespaceOperationId: id(10),
      preparationOperationId: id(10), contextRevision: 11, contextDigest: publicContextDigest(11) },
    "system/publicDeployment/noBuildPostOwners/post": { ...record, generation: 8, rendererSha: runtime.release,
      servingEnabled: true, slug: "sample-post", ownedSlugs: ["sample-post"], visible: true, postId: "post", operationId: id(7), sourceVersion: 2 },
    "cmsPosts/post": { published: { sourceVersion: 2 }, publicPostProof: { operationId: id(7) } },
    [postProof]: { ...record, transport: "post-no-build-v1", noBuildPost: { postId: "post", operationId: id(1), sourceVersion: 1 },
      postProof: { ...schedule, status: "pending", attempts: 4 }, publicReceipt: { digest: "keep" } },
    [queue(2)]: aggregateQueue(2, 10),
    [preparation]: preparationTask,
    [currentPreparation]: { ...preparationTask, contextDigest: publicContextDigest(20) },
    [queue(3)]: aggregateQueue(3, 10),
    [output]: outputTask,
    [queue(4)]: aggregateQueue(4, 10, "cancelled"),
    [page(4)]: proof(4, 10),
    [queue(5)]: aggregateQueue(5, 10, "cancelled"),
    [page(5)]: { ...proof(5, 10), leaseUntil: now + 50, nextAttemptAt: now + 100 },
    [queue(6)]: aggregateQueue(6, 10, "cancelled"),
    [page(6)]: { ...proof(6, 10), status: "stale", claim: null, leaseUntil: null, nextAttemptAt: null },
    [queue(7)]: { ...record, transport: "post-no-build-v1", noBuildPost: { postId: "post", operationId: id(7), sourceVersion: 2 },
      postProof: { ...schedule, status: "failed" } },
    [queue(8)]: aggregateQueue(8, 20),
    [page(8)]: { ...proof(8, 20), status: "stale", claim: null, leaseUntil: null, nextAttemptAt: null },
    [queue(10)]: aggregateQueue(10, 11),
    [selectedPreparation]: { ...preparationTask, contextDigest: publicContextDigest(11) },
    [page(10)]: proof(10, 11),
    [selectedOutput]: { ...outputTask, revision: 3, status: "verified" },
    "cmsBackgroundOutputs/authors": { ...outputTask, revision: 3, taskPath: selectedOutput, status: "verified" },
    "cmsBackgroundOutputs/home": { schemaVersion: 1, owner: "page-no-build-v1", pageId: "home", ownerPath: homeOwner, operationId: id(9) },
    [homeOwner]: { ...record, operationId: id(9), pageId: "home", path: "/", ownedPaths: ["/", "/_home-sources.json"],
      sourceVersion: 3, generation: 8, rendererSha: runtime.release, visible: true,
      homeRefresh: { schemaVersion: 1, sourceOperationId: id(7), revision: 11, taskPath: currentHome } },
    [home]: homeTask,
    [currentHome]: { ...homeTask, revision: 11, input: { ...homeTask.input, sourceOperationId: id(7) } },
  };
  const request = { schemaVersion: 1, operationId: "history-test", operatorCommitSha: "b".repeat(40), target,
    paths: [postProof, preparation, currentPreparation, selectedPreparation, output, selectedOutput, home, currentHome,
      page(4), page(5), page(6), queue(7), page(8), page(10)] };
  return { ...store(seed), request };
}

describe("publication history retirement", () => {
  it("retires only native superseded work and preserves successful parents and selected receipts", async () => {
    const db = fixture();
    const approved = await history.listSupersededPublicationHistory(db);
    const retired = [postProof, preparation, output, home, page(4), page(6)].sort();
    expect(approved.rows.map((row: { path: string }) => row.path)).toEqual(retired);
    const before = new Map(db.rows);
    const result = await history.retireSupersededPublicationHistory({ ...db, approved });
    expect(result.idempotent).toBe(false);
    expect(db.data(postProof)).toMatchObject({ status: "success", publicReceipt: { digest: "keep" },
      postProof: { status: "superseded", nextAttemptAt: null, attempts: 4 } });
    expect(exhaustedPostProof(db.data(postProof))).toBe(false);
    expect(postProofDue(db.data(postProof), now)).toBe(false);
    expect(db.data(preparation)?.status).toBe("cancelled");
    expect(db.data(output)?.status).toBe("superseded");
    expect(db.data(home)?.status).toBe("superseded");
    expect(db.data(page(4))).toMatchObject({ status: "stale", leaseUntil: null, nextAttemptAt: null, claim: null });
    expect(db.data(page(6))?.retirementReceiptPath).toBe("system/supersededPublicationHistory/retirements/history-test");
    expect(db.data("admin_logs/1")).toMatchObject({ action: "public-release.superseded-publication-history-retired",
      after: { rows: retired.length, listingDigest: approved.listingDigest } });
    for (const [path, row] of before) {
      if (!retired.includes(path)) expect(db.rows.get(path)).toBe(row);
    }
    expect((await history.listSupersededPublicationHistory(db)).rows).toEqual([]);
    expect(await history.retireSupersededPublicationHistory({ ...db, approved })).toEqual({ ...result, idempotent: true });
    expect(db.data("admin_logs/2")).toBeUndefined();
  });

  it("rejects apply when the listed row version or a native selection changes", async () => {
    const db = fixture();
    const approved = await history.listSupersededPublicationHistory(db);
    db.put(home, db.data(home)!);
    await expect(history.retireSupersededPublicationHistory({ ...db, approved })).rejects.toThrow();
    const newListing = await history.listSupersededPublicationHistory(db);
    const selected = db.data("cmsBackgroundOutputs/authors")!;
    db.put("cmsBackgroundOutputs/authors", { ...selected, taskPath: output });
    await expect(history.retireSupersededPublicationHistory({ ...db, approved: newListing })).rejects.toThrow();
    expect(db.data(output)?.status).toBe("pending");
    expect(db.data("admin_logs/1")).toBeUndefined();
  });

  it("preserves pending retries, unknown identity and intact verified output", async () => {
    const db = fixture();
    db.put(preparation, { ...db.data(preparation), nextAttemptAt: now + 1 });
    db.put(page(4), { ...db.data(page(4)), key: "wrong" });
    db.put(output, { ...db.data(output), status: "verified" });
    const listing = await history.listSupersededPublicationHistory(db);
    expect(listing.rows.map((row: { path: string }) => row.path)).toEqual([postProof, home, page(6)].sort());
  });
});
