import { prepareOriginalStaticPairArtifact } from "./public-release-static-source-artifact";
import { performance } from "node:perf_hooks";
import { prepareStaticPostProof } from "../../site/scripts/prepare-static-post-proof";
import staticReturn from "../../functions/lib/no-build-post-static-return.js";
import path from "node:path";
import { readFile } from "node:fs/promises";
import type { Firestore } from "firebase-admin/firestore";
import type { PairViewStore } from "../../site/scripts/public-release-pair-view-storage";
import deployment from "../../functions/lib/public-deployment.js";
import work from "../../functions/lib/public-release-pair-work.js";
import log from "../../functions/lib/public-release-change-log.js";
import producer from "../../functions/lib/public-release-producer.js";
import baseline from "../../functions/lib/public-release-change-baseline.js";
import snapshots from "../../functions/lib/publish-snapshot.js";
import media from "../../functions/lib/media-contract.js";
import protocol from "../../functions/lib/public-release-pair.js";
import { releasePair, pairReference } from "./private-public-release-pair.js";
import { frozenReplayProgramRead } from "./public-release-replay-inputs";
import { publicReleaseCodePackFixture } from "./public-release-code-pack";
import { schedulePacketFixture } from "../functions/page-schedule-packet-fixture";
import { derivePublicReleasePairCodePack } from "../../site/scripts/public-release-pair-code-pack";
import { publicReleasePairSourceInputsBytes } from "../../site/scripts/public-release-pair-source-inputs";
import { capturePublicReleasePairCodePackBaselineInput, captureHistoricalPublicReleasePairBaselineInput, captureHistoricalPublicReleasePairInput } from "../../site/scripts/public-release-pair-source-owner";
import { createPublicReleasePairExecutor } from "../../site/scripts/public-release-pair-executor";
import { runPublicReleasePairWorkOnce } from "../../site/scripts/public-release-pair-runtime";
import { parseReaderSeals, type ReaderSeals } from "../../site/scripts/public-release-pair-reader-contract";
import { readerSealPath } from "../../site/scripts/public-release-pair-private-reader";
import type { PublicReleasePair } from "../../packages/content-core/src/public-release";

function sealedIdentity(pair: PublicReleasePair, seals: ReaderSeals | undefined, capabilityDigest?: string) {
  if (seals && capabilityDigest && capabilityDigest !== protocol.publicReleaseDigest(seals.capabilities))
    throw new Error("Fixture reader capability identity differs");
  const result = protocol.parsePublicReleasePair({ ...pair, ...(seals ? {
    readerContractDigest: seals.deployment.contractDigest, readerReceiptDigest: protocol.publicReleaseDigest(seals.deployment),
    capabilityDigest: protocol.publicReleaseDigest(seals.capabilities),
  } : capabilityDigest ? { capabilityDigest } : {}) });
  if (seals) parseReaderSeals(seals, result);
  return result;
}

/** Real source-owner + Firestore + CODE/provider HTTP/Storage boundaries. The
 * small dist/compiled artifact is a sealed test artifact, not a renderer proof.
 * Callers own isolated DB/store reset and the supplied temporary directory. */
export async function publicReleasePairCompositeFixture(options: { firestore: Firestore; store: PairViewStore; directory: string;
  content?: "baseline" | "post-entry"; staticOwner?: boolean; staticWithdrawn?: boolean; epoch?: string; ownerOperations?: 1 | 2; capabilityGeneration?: number; pairCapabilityDigest?: string; sourcePairCapabilityDigest?: string; seed?: (firestore: Firestore) => Promise<void>;
  sourceReaderSeals?: ReaderSeals; readerSeals?: ReaderSeals;
  prepareArtifacts?(directory: string, sourceInputs: Uint8Array): Promise<Awaited<ReturnType<typeof publicReleaseCodePackFixture>>> }) {
  const db = options.firestore, sourcePair = sealedIdentity(protocol.parsePublicReleasePair(releasePair()),
    options.sourceReaderSeals, options.sourcePairCapabilityDigest), epoch = options.epoch ?? "composite-source-epoch";
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "") || !/^demo-[a-z0-9-]+$/.test(db.projectId)) throw new Error("Composite fixture requires an isolated local emulator");
  const generation = options.capabilityGeneration ?? 1;
  await db.doc("system/publicDeployment").set({ ...deployment.initialPublicDeploymentPointer(), activeGeneration: generation, activeDeploymentId: "composite-code",
    activeCommitSha: sourcePair.commitSha, lastReservedGeneration: generation, newestEligibleGeneration: generation, newestEligibleBuildBatchId: "composite-code" });
  await work.registerPublicReleasePair({ firestore: db, pair: sourcePair });
  if (options.sourceReaderSeals) await db.doc(readerSealPath(sourcePair)).create(options.sourceReaderSeals);
  const head = log.initialPublicReleaseChangeHead("f".repeat(64)); await db.doc(log.PUBLIC_RELEASE_CHANGES_PATH).set(head);
  await db.doc(producer.PUBLIC_RELEASE_CHANGE_LOG_CONTROL).set({ schemaVersion: 2, enabled: true, logEpoch: epoch, pair: pairReference(sourcePair), head });
  await db.doc("system/publicDeployment/contexts/public").set({ schemaVersion: 1, revision: 1 });
  const story = JSON.parse(await readFile(new URL("../../site/tests/fixtures/shadow-posts/post.json", import.meta.url), "utf8")).document;
  if (options.staticOwner) {
    story.published.metadata.previousSlugs = ["former-story"];
    story.status = "published"; story.publishAt = story.published.publishedAt;
  }
  if (options.staticWithdrawn) { story.publiclyVisible = false; story.status = "draft"; }
  await db.doc("cmsPosts/story").set({ ...story, id: "story", version: 9 });
  const programRead = frozenReplayProgramRead(sourcePair.commitSha), program = programRead.documents[0], art = programRead.assets[0];
  Object.assign(program.published, { publishedBy: "original-editor" }); await db.doc(`cmsPosts/${program.id}`).set(program);
  const privateArt = { ...art, altText: "Frozen Program art", lifecycle: "active", source: "site_seed" };
  await db.doc(`media_assets/${art.id}`).set(privateArt); await db.doc(`media_assets_public/${art.id}`).set(media.mediaProjection(privateArt));
  await db.doc("system/publicDeployment/noBuildRecordOwners/one").set({ schemaVersion: 1, family: "programs", documentId: program.id, visible: true,
    ownedPaths: ["/programs/one/", "/shows/one/"] });
  const schedule = snapshots.createPublishedSnapshot({ collection: "cmsPages", document: { id: "schedule", version: 1, title: "Schedule", blocks: [] },
    publishedAt: "2026-10-01T12:00:00.000Z", publishedBy: "editor" });
  await db.doc("cmsPages/schedule").set({ version: 1, status: "published", publiclyVisible: true, publishAt: schedule.publishedAt, published: schedule });
  const firestore = new Proxy(db, { get(target, key) { if (key === "projectId") return "njpbs-site-dev";
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; } });
  let originalStatic: Awaited<ReturnType<typeof prepareOriginalStaticPairArtifact>> | undefined;
  const packet = await schedulePacketFixture({ firestore, rendererSha: sourcePair.commitSha, generation, includeHomeSources: true,
    programRead, postDocuments: [{ ...story, id: "story", version: 9 }], ...(options.staticOwner ? { preparePublication: async ({ codeContext }: any) => {
      originalStatic = await prepareOriginalStaticPairArtifact(path.join(options.directory, "original-static"), codeContext, options.store);
      return originalStatic.publication;
    } } : {}) });
  try {
    const ownerPath = "system/publicDeployment/noBuildPostOwners/story";
    const ownerFor = (sourceVersion: number, generation: number, operationId: string) => ({ schemaVersion: 1, postId: "story", operationId,
      generation, sourceVersion, rendererSha: sourcePair.commitSha, servingEnabled: true, visible: true,
      slug: story.published.metadata.slug, ownedSlugs: [story.published.metadata.slug] });
    if (options.ownerOperations) {
      await db.doc(ownerPath).set(ownerFor(story.published.sourceVersion, 1, "I".repeat(20)));
      await db.doc("system/noBuildPostAdmission").set({ schemaVersion: 2, revision: 1, enabled: true,
        families: { posts: { mode: "all" } }, backgroundBucket: "njpbs-dev-public-content" });
    }
    if (options.staticOwner) {
      if (!originalStatic) throw new Error("Original static fixture was not prepared");
      const state = { ...ownerFor(story.published.sourceVersion, generation, "I".repeat(20)), mode: "static", visible: story.publiclyVisible,
        ownedSlugs: [story.published.metadata.slug, ...story.published.metadata.previousSlugs].sort() };
      const input = await db.runTransaction(transaction => staticReturn.currentStaticInput({ firestore: db, transaction, state }));
      const staticProof = await prepareStaticPostProof({ input, artifact: originalStatic.artifact, prepared: originalStatic.prepared, distDirectory: originalStatic.distDirectory });
      await db.doc(ownerPath).set({ ...state, staticProof });
    }
    if (options.capabilityGeneration) await db.doc("system/publicDeployment/noBuildPosts/capability").set({ schemaVersion: 2,
      rendererSha: sourcePair.commitSha, servingEnabled: true, generation });
    await db.doc("system/publicDeployment/noBuildPages/capability").update({ dataHubReportingVersion: 1 });
    await options.seed?.(db);
    const global = await baseline.capturePublicReleaseChangeBaseline({ firestore, logEpoch: epoch,
      currentCodeRequest: (input, init) => packet.request(String(input), init ?? {}) });
    const sourceInputs = publicReleasePairSourceInputsBytes(global.receipt, global.logBaselineDigest);
    const artifacts = await (options.prepareArtifacts ? options.prepareArtifacts(options.directory, sourceInputs) : publicReleaseCodePackFixture(options.directory, "b".repeat(40), sourceInputs));
    const inventory = await derivePublicReleasePairCodePack(artifacts), pair = sealedIdentity({ ...protocol.parsePublicReleasePair(releasePair("b", artifacts.pair.commitSha)), rendererDigest: artifacts.pair.rendererDigest,
      codeAssetManifestDigest: inventory.manifest.codeAssetManifestDigest,
    }, options.readerSeals, options.pairCapabilityDigest);
    await work.registerPublicReleasePair({ firestore: db, pair });
    if (options.readerSeals) await db.doc(readerSealPath(pair)).create(options.readerSeals);
    const providerStore: PairViewStore = { async put() { throw new Error("Read only provider"); }, async get(key) {
      const bytes = packet.boundary.objects.get(key); return bytes ? { size: bytes.length, body: new Response(new Uint8Array(bytes)).body! } : null;
    } };
    packet.refuseCode();
    const codePack = await capturePublicReleasePairCodePackBaselineInput({ firestore, pair, store: options.store, providerStore,
      logBaselineDigest: global.logBaselineDigest, codePackArtifacts: artifacts, ...(options.staticOwner ? { contentStore: options.store } : {}) });
    const { taskId: baselineTaskId } = await db.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({ firestore: db, transaction, pair,
      input: { ...codePack.root.scope, inputManifestDigest: codePack.receipt.inputManifestDigest } }));
    const operations = createPublicReleasePairExecutor({ firestore: db, store: options.store, pair });
    if (await runPublicReleasePairWorkOnce({ firestore: db, pair, ...operations }) !== "complete") throw new Error("Actual baseline copy/stage refused");
    const captureOptions = { firestore, pair, store: options.store, providerStore, ...(options.staticOwner ? { contentStore: options.store } : {}), resourceRequest: async () => { throw new Error("No mutable resource fallback"); } };
    let content, operation = 0, captureMs = 0;
    const appendPost = async (title = "Accepted composite change") => {
      const started = performance.now();
      operation++;
      const published = { ...story.published, sourceVersion: 9 + operation, metadata: { ...story.published.metadata, title } };
      const operationId = operation === 1 ? "composite-post-change" : `composite-post-change-${operation}`;
      const owner = ownerFor(published.sourceVersion, 1 + operation, String(operation).repeat(20));
      await db.runTransaction(async transaction => {
        const append = await producer.preparePublicReleaseProducerInTransaction({ firestore: db, transaction, operationId,
          changes: [producer.publicContentChange("cmsPosts", "story", { published }, true, options.ownerOperations ? { path: ownerPath, data: owner } : undefined)] });
        append(); transaction.set(db.doc("cmsPosts/story"), { ...story, id: "story", version: published.sourceVersion, published });
        if (options.ownerOperations) transaction.set(db.doc(ownerPath), owner);
        transaction.update(db.doc("system/publicDeployment/contexts/public"), { revision: 1 + operation });
      });
      const content = await captureHistoricalPublicReleasePairInput({ ...captureOptions, sourceOperationId: operationId });
      captureMs = performance.now() - started; return content;
    };
    if ((options.content ?? "post-entry") === "post-entry") {
      for (let index = 0; index < (options.ownerOperations ?? 1); index++) content = await appendPost();
    } else content = await captureHistoricalPublicReleasePairBaselineInput({ ...captureOptions, logBaselineDigest: global.logBaselineDigest });
    const queuedAt = performance.now();
    const { taskId } = await db.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({ firestore: db, transaction, pair,
      input: { ...content.root.scope, inputManifestDigest: content.receipt.inputManifestDigest } }));
    const initialCaptureAndQueueMs = captureMs + performance.now() - queuedAt;
    const prepareNext = async (title?: string) => {
      const started = performance.now(), content = await appendPost(title);
      const captureMs = performance.now() - started;
      return { async enqueue() {
        const started = performance.now();
        const queued = await db.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({ firestore: db, transaction, pair,
          input: { ...content.root.scope, inputManifestDigest: content.receipt.inputManifestDigest } }));
        return { ...queued, captureAndQueueMs: captureMs + performance.now() - started };
      } };
    };
    return { firestore, pair, sourcePair, global, codePack, content, taskId, baselineTaskId, operations, packet, providerStore, originalStatic, prepareNext, initialCaptureAndQueueMs, artifacts,
      base: work.publicReleasePairPath(pair.pairId), close: packet.close };
  } catch (error) { await packet.close(); throw error; }
}
