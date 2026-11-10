import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { qualifiedPairFixture } from "../helpers/qualified-public-release-pair";
import { stagedPublicReleasePairCompositeFixture } from "../helpers/staged-public-release-pair-composite";
import { releaseSelector } from "../helpers/private-public-release-pair.js";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import replay from "../../functions/lib/public-release-pair-replay.js";
import producer from "../../functions/lib/public-release-producer.js";
import admission from "../../functions/lib/public-release-admission.js";
import switches from "../../functions/lib/public-release-switch.js";
import baselineOwner from "../../functions/lib/public-release-change-baseline.js";
import { captureHistoricalPublicReleasePairInput } from "../../site/scripts/public-release-pair-source-owner";
import { openPublicReleasePairCompositeAuthority } from "../../site/scripts/public-release-pair-composite-storage";
import { openPublicReleasePairRenderPlans } from "../../site/scripts/public-release-pair-render-plans";
import { isPublicReleasePairProjection, projectPublicReleasePairReplay } from "../../site/scripts/public-release-pair-replay";
import { createPublicReleasePairExecutor } from "../../site/scripts/public-release-pair-executor";
import type { PairPreviewContextOutput } from "../../site/scripts/public-release-pair-preview-context";
import activation from "../../functions/lib/public-release-content-activation.js";
import { replayPublicReleasePairToHead } from "../../site/scripts/public-release-pair-log-replay";
import { trackQualificationTransactionReads, assertQualificationTransactionReadBudget } from "../../site/scripts/public-release-pair-publication-seals";
import type { PairViewStore } from "../../site/scripts/public-release-pair-view-storage";
import { decodePublicReleasePairCodePackChunk, PAIR_CODE_PACK_CHUNK_BYTES } from "../../site/scripts/public-release-pair-code-pack";

// The actual H/G/composite/replay/activation owners run below. Replaying the
// existing fixture child bytes proves orchestration, not native SSR parity.
const child = vi.hoisted(() => ({ directory: "", files: new Map<string, Uint8Array>() }));
vi.mock("../../site/scripts/public-release-pair-renderer-release.mjs", () => ({ verifyPublicReleasePairRenderer: async () => {} }));
vi.mock("../../site/scripts/public-release-pair-pagefind-engine", () => ({ restorePublicReleasePairPagefindEngine: async () => {} }));
vi.mock("../../site/scripts/public-release-pair-semantic-engine", () => ({ restorePublicReleasePairSemanticEngine: async () => {} }));
vi.mock("../../site/scripts/process-cms-preview", () => ({ privatePreviewSandbox: async (_env: unknown, directory: string) => {
  child.directory = directory; return { args: ["fixture"] };
} }));
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), spawn: () => {
  const process = new EventEmitter();
  void mkdir(child.directory, { recursive: true }).then(() => Promise.all([...child.files].map(([name, bytes]) => writeFile(path.join(child.directory, name), bytes))))
    .then(() => process.emit("close", 0), error => { process.emit("error", error); process.emit("close", 1); });
  return process;
} }));
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
let sequence = 0;
it.each(["reject", "pending", "transient"])("actual executor staging advances the guarded publication head while its optional write is %s", async outcome => {
  const firestore = isolatedFirestore(`editorial-real-publication-${++sequence}`), objects = new Map<string, { bytes: Uint8Array; customMetadata: Record<string, string> }>();
  const store: PairViewStore = { async put(key, bytes, options) { if (!objects.has(key)) objects.set(key, { bytes: new Uint8Array(bytes), customMetadata: options.customMetadata }); },
    async get(key) { const row = objects.get(key); return row ? { size: row.bytes.length, customMetadata: row.customMetadata,
      body: new Response(new Uint8Array(row.bytes)).body! } : null; } };
  const captureBaseline = baselineOwner.capturePublicReleaseChangeBaseline;
  const seedAdmission = vi.spyOn(baselineOwner, "capturePublicReleaseChangeBaseline").mockImplementation(async options => {
    await firestore.doc("system/noBuildPostAdmission").set({ schemaVersion: 2, revision: 1, enabled: true,
      families: { posts: { mode: "all" } }, backgroundBucket: "njpbs-dev-public-content" });
    return captureBaseline(options);
  });
  const fixture = await qualifiedPairFixture(firestore, store).finally(() => seedAdmission.mockRestore());
  const originalReference = (await firestore.doc("system/publicReleaseChangeLog").get()).data()!.pair;
  const originalPair = protocol.parsePublicReleasePair((await firestore.doc(work.publicReleasePairPath(originalReference.pairId)).get()).data());
  const sourceDb = new Proxy(firestore, { get(target, key) { if (key === "projectId") return "njpbs-site-dev";
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value; } });
  const baselineInput = await openPublicReleasePairCompositeAuthority({ firestore, store, pair: fixture.pair, identity: fixture.contentView.identity });
  const roster = JSON.parse(new TextDecoder().decode(await baselineInput.frozen.readFile("provider-inputs.json")));
  const providerBytes = new Map<string, Uint8Array>();
  for (const member of roster.files) {
    const chunks = [];
    for (let index = 0; index < member.chunkFiles.length; index++) chunks.push(decodePublicReleasePairCodePackChunk(
      JSON.parse(new TextDecoder().decode(await baselineInput.frozen.readFile(member.chunkFiles[index]))),
      Math.min(PAIR_CODE_PACK_CHUNK_BYTES, member.bytes - index * PAIR_CODE_PACK_CHUNK_BYTES)));
    providerBytes.set(member.key, new Uint8Array(Buffer.concat(chunks)));
  }
  const providerStore: PairViewStore = { async put() { throw new Error("No provider writes"); }, async get(key) {
    const bytes = providerBytes.get(key); if (!bytes) throw new Error("No mutable provider fallback");
    return { size: bytes.length, body: new Response(new Uint8Array(bytes)).body! };
  } };
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let attempts = 0;
  const output = vi.fn(async (input: PairPreviewContextOutput) => {
    attempts++;
    if (outcome === "reject") throw new Error("Fixture side output unavailable");
    if (outcome === "transient" && attempts === 1) throw Object.assign(new Error("Fixture SDK unavailable"), { code: 14 });
    await pending;
    if (outcome === "transient") {
      // This fixture's child uses placeholder Home HTML. Real DTO encoding has
      // separate source/store tests; here the injected output proves retries,
      // independent immutable-H access and actual SDK I/O after publication.
      const census = await input.readFrozenFile("source-census.json");
      const head = (await firestore.doc(`${work.publicReleasePairPath(input.pair.pairId)}/heads/current`).get()).data()!;
      expect(head.contentHead.contextSequence).toBe(1);
      await firestore.doc(`fixturePrivatePreviewRetention/${input.viewManifestDigest}`).create({
        viewManifestDigest: input.viewManifestDigest, afterHeadSequence: head.contentHead.contextSequence, censusBytes: census.byteLength });
    }
  });
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const baseline = await replay.sealPublicReleasePairReplayWitness({ firestore, pair: fixture.pair });
    await firestore.doc("system/publicDeployment").set({ ...releaseSelector(), selectedPair: protocol.publicReleasePairReference(originalPair),
      recoveryPair: protocol.publicReleasePairReference(fixture.pair), activeCommitSha: originalPair.commitSha });
    await firestore.doc(`${work.publicReleasePairPath(fixture.pair.pairId)}/controls/runtime`).set({ schemaVersion: 2, pairId: fixture.pair.pairId, status: "retained" });
    const operationId = (outcome === "reject" ? "R" : "P").repeat(20), story = (await firestore.doc("cmsPosts/story").get()).data()!;
    const published = { ...story.published, sourceVersion: 10 };
    await firestore.runTransaction(async transaction => {
      const ownerRef = firestore.doc("system/publicDeployment/noBuildPostOwners/story"), previous = (await transaction.get(ownerRef)).data()!;
      const owner = { ...previous, operationId, generation: 2, sourceVersion: 10, snapshotDigest: protocol.publicReleaseDigest(published) };
      const append = await producer.preparePublicReleaseProducerInTransaction({ firestore, transaction, operationId,
        changes: [producer.publicContentChange("cmsPosts", "story", { published }, true, { path: ownerRef.path, data: owner })] });
      append(); transaction.set(ownerRef, owner); transaction.set(firestore.doc("cmsPosts/story"), { ...story, version: 10, published });
      transaction.update(firestore.doc("system/publicDeployment/contexts/public"), { revision: 2 });
    });
    const captured = await captureHistoricalPublicReleasePairInput({ firestore: sourceDb, store, pair: fixture.pair,
      providerStore: providerStore, sourceOperationId: operationId, kind: "recovery" });
    const { taskId } = await firestore.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({ firestore, transaction, pair: fixture.pair,
      input: { ...captured.root.scope, inputManifestDigest: captured.receipt.inputManifestDigest } }));
    const base = work.publicReleasePairPath(fixture.pair.pairId), journalPath = `${base}/journals/${fixture.pair.publisher.journalNamespace}`;
    let runningTask: any, runningJournal: any;
    const observed = new Proxy(firestore, { get(target, key) {
      if (key === "runTransaction") return async (update: any, options: any) => {
        const result = await target.runTransaction(update, options);
        if ((result as any)?.identity?.sourceOperationId === operationId && typeof (result as any)?.token === "string") {
          const rows = await target.getAll(target.doc(`${base}/work/${taskId}`), target.doc(journalPath));
          runningTask = rows[0].data(); runningJournal = rows[1].data();
        }
        return result;
      };
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    const staged = await stagedPublicReleasePairCompositeFixture({ firestore: observed, pair: fixture.pair, taskId } as Parameters<typeof stagedPublicReleasePairCompositeFixture>[0], store);
    // Prepare the documented child byte fixture, then restore the exact state
    // captured from its real claim, before completion. No task shape or lease
    // is fabricated; execution, renewal and settlement below use that owner.
    expect(runningTask.status).toBe("running");
    await firestore.runTransaction(async transaction => {
      transaction.set(firestore.doc(`${base}/work/${taskId}`), runningTask);
      transaction.set(firestore.doc(journalPath), runningJournal);
      transaction.delete(firestore.doc(`${base}/receipts/${taskId}`));
      transaction.delete(firestore.doc(`${base}/staging/${taskId}`));
    });
    const identity = staged.claim.identity, claimDigest = staged.owner.claimDigest;
    const contentHead = { pairId: fixture.pair.pairId, viewId: baseline.witnessDigest, manifestDigest: baseline.witness.contentViewDigest, contextSequence: 0 };
    const selector = { ...releaseSelector(), selectedPair: protocol.publicReleasePairReference(fixture.pair),
      recoveryPair: protocol.publicReleasePairReference(originalPair), activeCommitSha: fixture.pair.commitSha, contentHead };
    await firestore.doc("system/publicDeployment").set(selector);
    await firestore.doc(`${base}/controls/runtime`).set({ schemaVersion: 2, pairId: fixture.pair.pairId, status: "retained" });
    await firestore.doc(`${base}/heads/current`).set({ schemaVersion: 2, pairDigest: protocol.publicReleaseDigest(fixture.pair), contentHead });
    await firestore.doc(switches.MEDIA).set({ schemaVersion: 2, epoch: selector.epoch, activeGeneration: selector.activeGeneration,
      lastReservedGeneration: selector.activeGeneration, newestEligibleGeneration: selector.activeGeneration,
      references: [{ pairId: fixture.pair.pairId, manifestDigest: contentHead.manifestDigest }, { pairId: originalPair.pairId, manifestDigest: "a".repeat(64) }] });
    const accepted = admission.parseAdmission({ schemaVersion: 2, operationId,
      source: admission.publicationSource({ kind: "post", id: "story", action: "publish", snapshot: published }), pair: protocol.publicReleasePairReference(originalPair),
      pairDigest: protocol.publicReleaseDigest(originalPair), epoch: selector.epoch, changeSequence: 1, contextRevision: 2, admissionSequence: 1,
      admittedContractDigest: selector.admittedContractDigest });
    const admissionDigest = protocol.publicReleaseDigest(accepted);
    await firestore.doc(`${admission.ADMISSIONS}/operations/${operationId}`).create(accepted);
    await firestore.doc(`${admission.ADMISSIONS}/pending/${operationId}`).create({ schemaVersion: 2, operationId, admissionDigest });
    await firestore.doc(`cmsPublishQueue/${operationId}`).create({ schemaVersion: 2, transport: admission.TRANSPORT, operationId, admissionDigest,
      pair: accepted.pair, status: "pending", execution: null, terminalReceipt: null });
    const opened = await openPublicReleasePairCompositeAuthority({ firestore, store, pair: fixture.pair, identity });
    const plans = await openPublicReleasePairRenderPlans(opened.frozen.root, opened.frozen.readFile);
    const byPath = new Map(staged.outputs.map(row => [row.path, row])); child.files.clear();
    for (const [prefix, plan] of [["", plans.ordinaryPlan], ["aggregate-", plans.aggregatePlan!]] as const) {
      for (let index = 0; index < plan.routes.length; index++) {
        const route = plan.routes[index], row = byPath.get(route.path)!;
        child.files.set(`${prefix}${index}.body`, row.bytes);
        if (row.status === 308) child.files.set(`${prefix}${index}.location`, new TextEncoder().encode(row.headers.location));
        if (isPublicReleasePairProjection(route.renderer)) child.files.set(`${prefix}${index}.target.json`, encode((await projectPublicReleasePairReplay(await opened.context(route))).receipt));
      }
    }
    const routes = new Set(plans.plan.routes.map(route => route.path));
    const actions = staged.outputs.filter(row => !routes.has(row.path) && row.role !== "catalog").map((row, index) => {
      const file = `aux-${index}.body`; child.files.set(file, row.bytes);
      return { path: row.path, role: row.role, kind: row.kind, status: row.status, mime: row.headers["content-type"], size: row.bytes.length,
        sha256: createHash("sha256").update(row.bytes).digest("hex"), file };
    });
    child.files.set("auxiliary.json", encode({ schemaVersion: 1, actions, metrics: {} }));
    const operations = createPublicReleasePairExecutor({ firestore, store, pair: fixture.pair, previewContextOutput: output,
      publication: { activate: async input => {
        const originalView = { identity: input.identity, claimDigest: input.claimDigest, manifestDigest: input.manifestDigest,
          manifestBytes: (await firestore.doc(`${base}/views/${input.manifestDigest}`).get()).data()!.manifestBytes };
        const advanced = await replayPublicReleasePairToHead({ firestore, store, pair: fixture.pair, resolveView: async () => originalView });
        if (advanced.status !== "complete") throw new Error("Actual replay did not complete");
        const proof = await replay.openPublicReleasePairReplayWitnessProof({ firestore, pair: fixture.pair, headCursor: advanced.witness.headCursor, witnessDigest: advanced.witnessDigest });
        const [root, head] = await firestore.getAll(firestore.doc("system/publicDeployment"), firestore.doc(`${base}/heads/current`));
        const attempt = activation.parseContentActivationAttempt({ schemaVersion: 2, operationId, admissionDigest, pair: fixture.pair,
          expectedSelectorDigest: protocol.publicReleaseDigest(root.data()), expectedHeadDigest: protocol.publicReleaseDigest(head.data()),
          witnessDigest: advanced.witnessDigest, headCursor: advanced.witness.headCursor, originalView });
        // Inject only the external qualification seam. The actual executor,
        // replay owner, read-budget owner, atomic head/media writer and durable
        // outbox acknowledgement all run; deployed reader proof is not claimed.
        return activation.activatePublicReleasePairContent({ firestore, attempt, replayProof: proof,
          publicationReadOwner: { trackQualificationTransactionReads, assertQualificationTransactionReadBudget },
          assertPublicationCurrentInTransaction: async ({ transaction }: any) => {
            expect((await transaction.get(firestore.doc(`${admission.ADMISSIONS}/operations/${operationId}`))).data()).toEqual(accepted);
          } });
      } } });
    // The original live claim executes through fixture child transport. Actual
    // settlement, stage/handoff and guarded activation must finish while the
    // optional retention rejects or remains pending.
    const rendered = await operations.execute({ identity, outputPrefix: staged.claim.outputPrefix,
      renew: () => work.renewPublicReleasePairWork({ firestore, pair: fixture.pair, taskId, token: staged.claim.token }), signal: new AbortController().signal });
    await work.settlePublicReleasePairWork({ firestore, pair: fixture.pair, taskId, token: staged.claim.token, manifestDigest: rendered.manifestDigest });
    await operations.stage({ identity, claimDigest, manifestDigest: rendered.manifestDigest });
    expect((await firestore.doc(`${base}/heads/current`).get()).data()!.contentHead.contextSequence).toBe(1);
    expect((await firestore.doc(`cmsPublishQueue/${operationId}`).get()).data()!.status).toBe("pending");
    if (outcome === "transient") {
      // Let the retried private write complete only after the real public head
      // has advanced. Neither its backoff nor its I/O holds that publication.
      release();
      await vi.waitFor(() => expect(output).toHaveBeenCalledTimes(2));
      await output.mock.results[1].value;
      expect((await firestore.doc(`fixturePrivatePreviewRetention/${rendered.manifestDigest}`).get()).data()).toMatchObject({
        viewManifestDigest: rendered.manifestDigest, afterHeadSequence: 1, censusBytes: expect.any(Number) });
      expect(output).toHaveBeenCalledTimes(2); expect(warning).not.toHaveBeenCalled();
    } else await vi.waitFor(() => expect(output).toHaveBeenCalledOnce());
  } finally { release(); warning.mockRestore(); await fixture.close(); }
}, 60_000);
