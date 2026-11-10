import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Transaction } from "@google-cloud/firestore";
import { Timestamp } from "firebase-admin/firestore";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import publication from "../../functions/lib/no-build-post-publication.js";
import deployment from "../../functions/lib/public-deployment.js";
import snapshots from "../../functions/lib/publish-snapshot.js";
import cache from "../../functions/lib/public-decision-cache.js";
import content from "../../functions/public-content.js";

const db = isolatedFirestore("post-catalog-reconciliation.test.js");
const sha = "a".repeat(40);
const candidateSha = "b".repeat(40);
const ids = Array.from({ length: 48 }, (_, i) => `post-${String(i).padStart(2, "0")}`);

async function seed() {
  const now = Timestamp.now();
  const pointer = { ...deployment.initialPublicDeploymentPointer(), state: "reconciling",
    activeGeneration: 1, activeDeploymentId: "11111111-1111-4111-8111-111111111111", activeCommitSha: sha,
    lastReservedGeneration: 2, newestEligibleGeneration: 2, newestEligibleBuildBatchId: "release",
    mediaLifecycleReady: true, leaseToken: "fixture-lease", leaseAcquiredAt: now, reconcilingAt: now,
    candidateGeneration: 2, candidateBuildBatchId: "release", candidateCommitSha: candidateSha,
    predecessorGeneration: 1, predecessorDeploymentId: "11111111-1111-4111-8111-111111111111", predecessorCommitSha: sha,
    cloudflareEvidenceDigest: "c".repeat(64) };
  deployment.assertPublicDeploymentPointer(pointer);
  const batch = db.batch();
  batch.set(db.doc("system/publicDeployment"), pointer);
  batch.set(db.doc("system/publicDeployment/noBuildPosts/capability"), {
    schemaVersion: 2, rendererSha: sha, servingEnabled: true, generation: 1 });
  batch.set(db.doc("system/publicDeployment/contexts/public"), { schemaVersion: 1, revision: 1 });
  batch.set(db.doc("system/noBuildPostAdmission"), { schemaVersion: 2, revision: 1, enabled: true,
    families: { posts: { mode: "all" } }, backgroundBucket: "fixture-bucket" });
  batch.set(db.doc("system/publicDeployment/buildBatches/release/candidates/worker"), {
    commitSha: candidateSha, generation: 2, noBuildPost: { schemaVersion: 2,
      rendererSha: candidateSha, enabled: true, authoritative: true, families: ["posts"] } });
  for (const id of ids) {
    const document = { id, type: "post", title: `Published ${id}`, status: "published", publiclyVisible: true,
      section: "news", slug: id, previousSlugs: [], version: 1, firstPublishedAt: "2026-10-26T17:00:00.000Z",
      credits: [], tags: [], categories: [], blocks: [], locale: "en" };
    document.published = snapshots.createPublishedSnapshot({ collection: "cmsPosts", document,
      publishedAt: "2026-10-26T17:00:00.000Z", publishedBy: "fixture-editor" });
    batch.set(db.doc(`cmsPosts/${id}`), document);
    batch.set(db.doc(`system/publicDeployment/noBuildPostOwners/${id}`), {
      schemaVersion: 1, postId: id, rendererSha: sha, servingEnabled: true, generation: 1,
      operationId: id.replace("-", "").padEnd(20, "x"), sourceVersion: 1, slug: id, ownedSlugs: [id], visible: true });
  }
  await batch.commit();
}

beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${db.projectId}/databases/(default)/documents`, { method: "DELETE" });
  await seed();
});
afterEach(() => vi.restoreAllMocks());

describe("48-owner Post catalog during reconciliation", () => {
  it.each([sha, candidateSha])("validates every owner freshly with renderer %s", async rendererSha => {
    let active = 0;
    let peak = 0;
    let reads = 0;
    const original = Transaction.prototype.get;
    vi.spyOn(Transaction.prototype, "get").mockImplementation(async function (ref, ...args) {
      if (!ref.path?.startsWith("cmsPosts/")) return original.call(this, ref, ...args);
      active++;
      peak = Math.max(peak, active);
      reads++;
      try { return await original.call(this, ref, ...args); }
      finally { active--; }
    });
    const start = performance.now();
    const result = await publication.readNoBuildPostDecision({ firestore: db, path: "/_publication.json", rendererSha });
    console.info(JSON.stringify({ owners: ids.length, rendererSha, elapsedMs: Math.round(performance.now() - start), postReads: reads, peak }));
    expect(result.kind).toBe("receipts");
    expect(result.catalog.posts.map(post => post.postId)).toEqual(ids);
    expect(result.catalog.posts.every(post => post.rendererSha === rendererSha)).toBe(true);
    expect(reads).toBe(48);
    // Prove bounded overlap without a timing assertion tied to emulator load.
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    expect((await cache.readPublicDecisionValidator(db)).cacheable).toBe(false);
  });

  it("refuses the whole catalog when any owner snapshot is inconsistent", async () => {
    await db.doc("cmsPosts/post-47").update({ "published.sourceVersion": 2 });
    await expect(publication.readNoBuildPostDecision({ firestore: db, path: "/_publication.json", rendererSha: sha })).rejects.toThrow();
  });

  it("does not reuse a cached catalog while reconciling and sees a withdrawal immediately", async () => {
    const handler = content.createCmsGetPublicPageHandler({ firestore: db,
      decisionCache: cache.createPublicDecisionCache(), log: { error() {} } });
    const request = { method: "POST", headers: {}, body: { mode: "no-build-post-v1", path: "/_publication.json", rendererSha: sha } };
    const call = async () => {
      const response = { statusCode: 200, set() { return this; }, status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }, send(body) { this.body = JSON.parse(body); return this; } };
      await handler(request, response);
      expect(response.statusCode).toBe(200);
      return response.body;
    };
    expect((await call()).catalog.posts[47].visible).toBe(true);
    const batch = db.batch();
    batch.update(db.doc("cmsPosts/post-47"), { publiclyVisible: false });
    batch.update(db.doc("system/publicDeployment/noBuildPostOwners/post-47"), { visible: false });
    await batch.commit();
    expect((await call()).catalog.posts[47].visible).toBe(false);
  });
});
