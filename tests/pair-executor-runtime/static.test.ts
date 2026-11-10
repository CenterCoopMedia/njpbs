import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { publicReleasePairCompositeFixture } from "../helpers/public-release-pair-composite";
import { compiledPublicReleasePairCompositeArtifacts } from "../helpers/compiled-public-release-pair-composite";
import { runPublicReleasePairWorkOnce } from "../../site/scripts/public-release-pair-runtime";
import { openPublicReleasePairCompositeAuthority, openStagedPublicReleasePairComposite } from "../../site/scripts/public-release-pair-composite-storage";
import { readPublicReleasePairStaticTargetClaim, recordPublicReleasePairStaticTargetClaim } from "../../site/scripts/public-release-pair-static-target-storage";
import staticTarget from "../../functions/lib/public-release-pair-static-target.js";
import work from "../../functions/lib/public-release-pair-work.js";
import protocol from "../../functions/lib/public-release-pair.js";
import type { PairViewStore } from "../../site/scripts/public-release-pair-view-storage";
import { initializePublicReleasePairReplayBaseline } from "../../site/scripts/public-release-pair-log-replay";
import { reconcilePublicReleasePairReplay } from "../../site/scripts/public-release-pair-replay-runner";
import { openStagedPublicReleasePairCodePack } from "../../site/scripts/public-release-pair-code-pack-executor";
import producer from "../../functions/lib/public-release-producer.js";
import replay from "../../functions/lib/public-release-pair-replay.js";
import log from "../../functions/lib/public-release-change-log.js";
import settings from "../../functions/lib/cms-settings-contract.js";
import { readPublicContentStatus } from "../../admin/src/lib/public-content-status";
import { prepareStaticPostProof } from "../../site/scripts/prepare-static-post-proof";
import staticProof from "../../functions/lib/no-build-post-static-proof.js";
import publicContext from "../../functions/lib/public-context-revision.js";
vi.mock("../../admin/src/lib/staff-site-read", () => ({ fetchStaffSiteRead: () => { throw new Error("No live Admin reads"); } }));
vi.mock("../../admin/src/lib/dev-origins", () => ({ publicSiteOrigin: "https://dev-public.example.org" }));
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let runtime: Miniflare;
beforeAll(async () => { runtime = new Miniflare({ workers: [{ config: { name: "pair-static", type: "worker", compatibilityDate: "2026-07-09",
  manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
  env: { CONTENT: { type: "r2", name: "pair-static" } } } }] }); });
afterAll(async () => { await runtime?.dispose(); });
beforeEach(async () => {
  const bucket = await runtime.getR2Bucket("CONTENT");
  for (;;) {
    const listed = await bucket.list();
    if (!listed.objects.length) break;
    await bucket.delete(listed.objects.map(object => object.key));
  }
});
it.each([true, false])("recomputes the full NEW static artifact from frozen H and resumes the original completion (visible %s)", async visible => {
  const firestore = isolatedFirestore(`pair-static-${visible}-${Date.now()}`), bucket = await runtime.getR2Bucket("CONTENT"), store = bucket as unknown as PairViewStore, directory = await mkdtemp(path.join(os.tmpdir(), "pair-static-"));
  let fixture: Awaited<ReturnType<typeof publicReleasePairCompositeFixture>> | undefined;
  try {
    fixture = await publicReleasePairCompositeFixture({ firestore, store, directory, content: "baseline", staticOwner: true,
      staticWithdrawn: !visible, prepareArtifacts: (directory, inputs) => compiledPublicReleasePairCompositeArtifacts(directory, inputs,
        { "posts/index.html": "<html>Immutable NEW code baseline Post listing</html>",
          "events/index.html": "<html>Immutable NEW code baseline Events</html>",
          "programs/index.html": "<html>Immutable NEW code baseline Programs</html>",
          "staff/index.html": "<html>Immutable NEW code baseline Staff</html>" }) });
    const identity = { schemaVersion: 2 as const, pair: protocol.publicReleasePairReference(fixture.pair), ...fixture.content!.root.scope,
      inputManifestDigest: fixture.content!.receipt.inputManifestDigest };
    const source = await openPublicReleasePairCompositeAuthority({ firestore, store, pair: fixture.pair, identity });
    const original = source.staticSource!.source!;
    expect(original.publication).toEqual(fixture.originalStatic!.publication);
    const frozenReceipt = fixture.content!.root.files.find(file => file.name.startsWith("static-source/objects/"))!;
    const retainedSource = await bucket.get(frozenReceipt.objectKey), retainedBytes = await retainedSource!.arrayBuffer();
    for (const mode of ["missing", "corrupt"]) {
      if (mode === "missing") await bucket.delete(frozenReceipt.objectKey);
      else await bucket.put(frozenReceipt.objectKey, "changed receipt", { customMetadata: retainedSource!.customMetadata });
      await expect(openPublicReleasePairCompositeAuthority({ firestore, store, pair: fixture.pair, identity })).rejects.toThrow();
      await bucket.put(frozenReceipt.objectKey, retainedBytes, { customMetadata: retainedSource!.customMetadata });
    }
    // All subsequent work must survive loss of the mutable CMS/provider and
    // original immutable store, because those bytes are now retained in H.
    await firestore.doc("cmsPosts/story").delete(); await firestore.doc("cmsPosts/one").delete();
    await firestore.doc("system/publicDeployment/noBuildPostOwners/story").delete();
    fixture.packet.boundary.objects.clear();
    for (const object of (await bucket.list({ prefix: "public-content-baseline/" })).objects) await bucket.delete(object.key);
    let renders = 0, failure: unknown;
    const execute = async (args: Parameters<typeof fixture.operations.execute>[0]) => {
      renders++;
      try { return await fixture!.operations.execute(args); } catch (error) { failure = error; throw error; }
    };
    const result = await runPublicReleasePairWorkOnce({ firestore, pair: fixture.pair, ...fixture.operations, execute,
      stage: async () => { throw new Error("static completion crash"); } }).catch(error => error);
    expect(result instanceof Error ? result.message : result,
      failure instanceof Error ? `${(failure as any).code}: ${failure.stack}\nCause: ${failure.cause}` : String(failure)).toBe("static completion crash");
    const receipt = (await firestore.doc(`${fixture.base}/receipts/${fixture.taskId}`).get()).data()!;
    expect(receipt).toBeTruthy();
    const owner = { firestore, store, pair: fixture.pair, identity: receipt.identity, claimDigest: receipt.claimDigest, viewManifestDigest: receipt.manifestDigest };
    await expect(openStagedPublicReleasePairComposite(owner)).rejects.toThrow();
    const claim = (await firestore.doc(staticTarget.publicReleasePairStaticTargetClaimPath(fixture.pair, owner.claimDigest)).get()).data()!;
    const retained = await readPublicReleasePairStaticTargetClaim(owner, original, claim.descriptor.digest);
    expect(retained.root.source.publicationDigest).toBe(hash(original.publicationBytes));
    expect(retained.root.target.prepared.commitSha).toBe(fixture.pair.commitSha);
    expect(retained.root.target.prepared.artifactDigest).not.toBe(original.publication.artifactDigest);
    expect(retained.root.target.baseline.files).toContainEqual({ path: "posts/index.html", bytes: 53,
      digest: hash(new TextEncoder().encode("<html>Immutable NEW code baseline Post listing</html>")) });
    const alias = retained.aliases.find(row => row.path === "/posts/former-story/");
    if (visible) {
      expect(alias).toBeTruthy();
      const html = new TextDecoder().decode(await alias!.read());
      expect(html).toContain("noindex"); expect(html).toContain("/posts/shadow-fixture/");
    } else expect(alias).toBeUndefined();
    // A missing dependency never turns into a successful recovery. Restoring
    // the exact private bytes resumes without claiming or rendering again.
    const dependency = retained.root.aliases[0]?.chunks[0] ?? retained.descriptor;
    const before = await bucket.get(dependency.key), bytes = await before!.arrayBuffer();
    await bucket.delete(dependency.key);
    await fixture.operations.recover();
    expect((await firestore.doc(`${fixture.base}/staging/${fixture.taskId}`).get()).data()?.attempts).toBe(1);
    expect((await firestore.doc(`${fixture.base}/compositeViews/${receipt.manifestDigest}`).get()).exists).toBe(false);
    await bucket.put(dependency.key, bytes, { customMetadata: before!.customMetadata });
    await fixture.operations.retryQuarantined(fixture.taskId);
    const opened = await openStagedPublicReleasePairComposite(owner); await opened.verifyAll();
    const publicationBytes = (await opened.readMember("/_publication.json")).body;
    expect(hash(publicationBytes)).toBe(retained.root.target.prepared.publicationReceiptDigest);
    const publication = JSON.parse(new TextDecoder().decode(publicationBytes));
    expect(publication.commitSha).toBe(fixture.pair.commitSha);
    expect(Object.keys(publication)).toHaveLength(8);
    const status = JSON.parse(new TextDecoder().decode((await opened.readMember("/_content-status.json")).body));
    const inventory = readPublicContentStatus(status, publication);
    expect(inventory.some(row => row.path === "/posts/shadow-fixture/")).toBe(visible);
    expect(() => readPublicContentStatus(status, original.publication)).toThrow();
    expect(status.routes.some((row: any) => row.path === "/posts/shadow-fixture/")).toBe(visible);
    expect((await opened.readMember("/posts/shadow-fixture/")).member.status).toBe(visible ? 200 : 410);
    expect((await opened.readMember("/posts/former-story/")).member.status).toBe(visible ? 308 : 410);
    const proof = (await firestore.doc(staticTarget.publicReleasePairStaticTargetProofPath(fixture.pair, receipt.manifestDigest)).get()).data()!;
    expect(proof.sourcePublicationDigest).toBe(hash(original.publicationBytes));
    expect(proof.targetPublicationDigest).toBe(hash(publicationBytes));
    await expect(readPublicReleasePairStaticTargetClaim({ ...owner, claimDigest: "f".repeat(64) }, original, retained.descriptor.digest)).rejects.toThrow();
    await expect(recordPublicReleasePairStaticTargetClaim({ ...owner, claimDigest: "f".repeat(64) }, retained.descriptor)).rejects.toThrow();
    expect(await work.claimPublicReleasePairWork({ firestore, pair: fixture.pair, taskId: fixture.taskId })).toBeNull();
    await fixture.operations.recover();
    expect(renders).toBe(1);
    expect((await firestore.doc(`${fixture.base}/receipts/${fixture.taskId}`).get()).data()).toEqual(receipt);
  } finally { await fixture?.close(); await rm(directory, { recursive: true, force: true }); }
}, 120_000);


it("reconciles an uncaptured sole-static entry only with its explicit read-only content store", async () => {
  const firestore = isolatedFirestore("pair-static-uncaptured-reconcile"), bucket = await runtime.getR2Bucket("CONTENT"),
    store = bucket as unknown as PairViewStore, directory = await mkdtemp(path.join(os.tmpdir(), "pair-static-replay-"));
  let fixture: Awaited<ReturnType<typeof publicReleasePairCompositeFixture>> | undefined;
  try {
    fixture = await publicReleasePairCompositeFixture({ firestore, store, directory, content: "baseline", staticOwner: true,
      prepareArtifacts: (directory, inputs) => compiledPublicReleasePairCompositeArtifacts(directory, inputs,
        { "posts/index.html": "<html>Immutable NEW code baseline Post listing</html>",
          "events/index.html": "<html>Immutable NEW code baseline Events</html>",
          "programs/index.html": "<html>Immutable NEW code baseline Programs</html>",
          "staff/index.html": "<html>Immutable NEW code baseline Staff</html>" }) });
    let executionFailure: unknown;
    const execute = async (args: Parameters<typeof fixture.operations.execute>[0]) => {
      try { return await fixture!.operations.execute(args); }
      catch (error) { executionFailure = error; throw error; }
    };
    const run = async () => {
      executionFailure = undefined;
      const result = await runPublicReleasePairWorkOnce({ firestore, pair: fixture!.pair, ...fixture!.operations, execute });
      expect(result, executionFailure instanceof Error ? `${(executionFailure as any).code}: ${executionFailure.stack}` : String(executionFailure)).toBe("complete");
    };
    await run();
    const receipt = (await firestore.doc(`${fixture.base}/receipts/${fixture.taskId}`).get()).data()!;
    const staged = (await firestore.doc(`${fixture.base}/views/${receipt.manifestDigest}`).get()).data()!;
    const pack = await openStagedPublicReleasePairCodePack({ firestore, store, pair: fixture.pair });
    const packView = (await firestore.doc(`${fixture.base}/views/${pack.record.viewManifestDigest}`).get()).data()!;
    await initializePublicReleasePairReplayBaseline({ firestore, store, pair: fixture.pair,
      logBaselineDigest: fixture.global.logBaselineDigest,
      views: [{ identity: receipt.identity, claimDigest: receipt.claimDigest, manifestDigest: receipt.manifestDigest, manifestBytes: staged.manifestBytes }],
      codePackView: { identity: pack.record.identity, claimDigest: pack.record.claimDigest,
        manifestDigest: pack.record.viewManifestDigest, manifestBytes: packView.manifestBytes } });
    const before = (await firestore.doc("system/publicDeployment").get()).data(), operationId = "uncaptured-static-settings";
    const published = settings.createCmsSettingsPublishedSnapshot({ schema: settings.cmsSettingsSchemaFor("public-homepage-banner", 1),
      sourceVersion: 1, publishedAt: "2026-10-28T00:00:00.000Z", values: { enabled: false, message: "Static replay fixture" } });
    const ownerPath = "system/publicDeployment/noBuildPostOwners/story", owner = (await firestore.doc(ownerPath).get()).data()!;
    // A retained static owner must carry the next context's actual immutable
    // artifact proof, as the static-return settlement contract requires.
    const nextOwner = { ...owner, staticProof: await prepareStaticPostProof({
      input: { ...staticProof.staticProofInput(owner.staticProof), contextDigest: publicContext.publicContextDigest(2) },
      artifact: fixture.originalStatic!.artifact, prepared: fixture.originalStatic!.prepared,
      distDirectory: fixture.originalStatic!.distDirectory }) };
    await firestore.runTransaction(async transaction => {
      const write = await producer.preparePublicReleaseProducerInTransaction({ firestore, transaction, operationId,
        changes: [{ kind: "settings", id: "public-homepage-banner", action: "publish", sourceVersion: 1, snapshot: published,
          sourceDocuments: [{ path: "cmsSettings/public-homepage-banner", data: { version: 1, published } }, { path: ownerPath, data: nextOwner }] }] });
      write(); transaction.set(firestore.doc("cmsSettings/public-homepage-banner"), { version: 1, published });
      transaction.set(firestore.doc(ownerPath), nextOwner);
      transaction.update(firestore.doc("system/publicDeployment/contexts/public"), { revision: 2 });
    });
    const binding = firestore.doc(`${fixture.base}/sourceInputs/${protocol.publicReleaseDigest({ kind: "qualification", sourceOperationId: operationId })}`);
    const checkpoint = firestore.doc(replay.checkpointPath(fixture.pair)), originalCursor = (await checkpoint.get()).data()!.cursor;
    const emptyContentStore = { get: async () => null };
    const options = { firestore: fixture.firestore, store, pair: fixture.pair, providerStore: fixture.providerStore,
      contentStore: { get: (key: string) => store.get(key) } };
    expect((await binding.get()).exists).toBe(false);
    for (const contentStore of [undefined, emptyContentStore]) {
      await expect(reconcilePublicReleasePairReplay({ ...options, contentStore: contentStore as any }))
        .rejects.toMatchObject({ code: "input-unavailable", reason: "pair-static-source-missing" });
      expect((await binding.get()).exists).toBe(false);
      expect((await checkpoint.get()).data()!.cursor).toEqual(originalCursor);
    }
    const pending = await reconcilePublicReleasePairReplay(options);
    expect(pending.status).not.toBe("complete");
    const captured = (await binding.get()).data()!;
    const identity = { schemaVersion: 2 as const, pair: protocol.publicReleasePairReference(fixture.pair), ...captured.scope,
      inputManifestDigest: captured.inputManifestDigest };
    const authority = await openPublicReleasePairCompositeAuthority({ firestore, store, pair: fixture.pair, identity });
    expect(authority.staticSource!.source!.publication).toEqual(fixture.originalStatic!.publication);
    // H now owns the immutable receipt bytes; loss of their original store
    // cannot force another capture, claim, acceptance or publication.
    for (const object of (await bucket.list({ prefix: "public-content-baseline/" })).objects) await bucket.delete(object.key);
    await run();
    const complete = await reconcilePublicReleasePairReplay({ ...options, contentStore: emptyContentStore });
    expect(complete.status).toBe("complete");
    if (complete.status !== "complete") throw new Error("Expected complete static replay");
    expect(complete.witness.headCursor.sequence).toBe(1);
    const taskId = protocol.publicReleaseDigest(identity), completed = (await firestore.doc(`${fixture.base}/receipts/${taskId}`).get()).data();
    expect((await firestore.doc(`${fixture.base}/work/${taskId}`).get()).data()!.attempts).toBe(1);
    expect(await reconcilePublicReleasePairReplay({ ...options, contentStore: emptyContentStore })).toEqual({ ...complete, idempotent: true });
    expect((await firestore.doc(`${fixture.base}/receipts/${taskId}`).get()).data()).toEqual(completed);
    expect((await firestore.collection(`${log.PUBLIC_RELEASE_CHANGES_PATH}/operations`).get()).size).toBe(1);
    expect((await firestore.doc("system/publicDeployment").get()).data()).toEqual(before);
  } finally { await fixture?.close(); await rm(directory, { recursive: true, force: true }); }
}, 240_000);
