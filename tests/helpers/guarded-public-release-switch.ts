import { access, mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Firestore } from "firebase-admin/firestore";
import type { PairViewStore } from "../../site/scripts/public-release-pair-view-storage";
import { PUBLIC_PAGES } from "../../packages/content-core/src/public-pages";
import { switchedPairFixture } from "./public-release-switched-pair";
import { publicReleaseCodePackFixture } from "./public-release-code-pack";
import { stagedPublicReleasePairCompositeFixture } from "./staged-public-release-pair-composite";
import { privateReaderTransport } from "./private-pair-reader-fixture";
import { releasePair } from "./private-public-release-pair.js";
import { sealedPair } from "./sealed-public-release-pair";
import { schedulePacketFixture } from "../functions/page-schedule-packet-fixture";
import { frozenReplayProgramRead } from "./public-release-replay-inputs";
import { publicReleasePairSourceInputsBytes } from "../../site/scripts/public-release-pair-source-inputs";
import { derivePublicReleasePairCodePack } from "../../site/scripts/public-release-pair-code-pack";
import { capturePublicReleasePairCodePackBaselineInput, captureHistoricalPublicReleasePairBaselineInput,
  captureHistoricalPublicReleasePairInput } from "../../site/scripts/public-release-pair-source-owner";
import { createPublicReleasePairExecutor } from "../../site/scripts/public-release-pair-executor";
import { runPublicReleasePairWorkOnce } from "../../site/scripts/public-release-pair-runtime";
import { openStagedPublicReleasePairCodePack } from "../../site/scripts/public-release-pair-code-pack-executor";
import { initializePublicReleasePairReplayBaseline, replayPublicReleasePairToHead } from "../../site/scripts/public-release-pair-log-replay";
import { createPrivatePairReader, readerSealPath } from "../../site/scripts/public-release-pair-private-reader";
import { sealPublicReleasePairCodePublication } from "../../site/scripts/public-release-switch-code";
import { finalizePublicArtifactInventoryReceipt } from "../../site/src/lib/public-artifact-inventory";
import { preparePublicWorkerArtifact } from "../../site/src/lib/public-worker-artifact";
import { publicationFromPrepared } from "../../site/src/lib/public-publication-receipt";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import replay from "../../functions/lib/public-release-pair-replay.js";
import { bumpPublicContextRevision } from "../../functions/lib/public-context-revision.js";
import admissions from "../../functions/lib/public-release-admission.js";

/** B and C have actual independent CODE/H/G/replay/private HTTP proofs. The
 * initial A->B fixture supplies only the pre-existing selected-root boundary;
 * the tested B->C operator must run both real qualification owners. Bodies are
 * small sealed artifacts, not a compiled renderer/deployment qualification. */
export async function guardedPublicReleaseSwitchFixture(database: Firestore, store: PairViewStore) {
  const selected = await switchedPairFixture(database, store), transport = await privateReaderTransport();
  const firestore = selected.firestore;
  const directory = await mkdtemp(path.join(os.tmpdir(), "guarded-switch-"));
  let packet: Awaited<ReturnType<typeof schedulePacketFixture>> | undefined;
  try {
    const current = await selected.captureCode();
    const oldTask = await firestore.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({ firestore, transaction,
      pair: selected.pair, input: { ...current.receipt.scope, inputManifestDigest: current.receipt.inputManifestDigest } }));
    const oldStaged = await stagedPublicReleasePairCompositeFixture({ ...selected, taskId: oldTask.taskId }, store);
    const oldView = { identity: oldStaged.claim.identity, claimDigest: oldStaged.owner.claimDigest,
      manifestDigest: oldStaged.rendered.manifestDigest, manifestBytes: oldStaged.rendered.manifestBytes };
    await replayPublicReleasePairToHead({ firestore, store, pair: selected.pair, resolveView: async () => oldView });
    const artifacts = await publicReleaseCodePackFixture(directory, "c".repeat(40),
      publicReleasePairSourceInputsBytes(selected.global.receipt, selected.global.logBaselineDigest));
    const pageRef = firestore.doc("system/publicDeployment/noBuildPages/capability"), pageBefore = (await pageRef.get()).data()!;
    packet = await schedulePacketFixture({ firestore, rendererSha: "c".repeat(40), generation: 3,
      includeHomeSources: true, attachExternalInputs: false, programRead: frozenReplayProgramRead("c".repeat(40)),
      postDocuments: [(await firestore.doc("cmsPosts/story").get()).data() as any], preparePublication: async ({ codeContext }) => {
        const add = async (route: string, bytes: Uint8Array) => {
          const file = path.join(artifacts.distDirectory, route.endsWith("/") ? `${route.slice(1)}index.html` : route.slice(1));
          try { await access(file); } catch { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes); }
        };
        for (const page of PUBLIC_PAGES) for (const route of [page.path, ...("aliases" in page ? page.aliases : [])])
          await add(route, new TextEncoder().encode(`<html>Candidate fixture ${route}</html>`));
        for (const family of codeContext.receipt.families) for (const record of family.artifacts) if (record.canonicalPath)
          for (const route of [record.canonicalPath, ...record.aliases]) await add(route, new TextEncoder().encode(`<html>Candidate source ${route}</html>`));
        for (const route of codeContext.receipt.aggregateRoutes) await add(route, new TextEncoder().encode(`<html>Candidate aggregate ${route}</html>`));
        for (const file of codeContext.programImageDescriptors?.files ?? []) await add(file.path, new Uint8Array(Buffer.from(file.base64, "base64")));
        await finalizePublicArtifactInventoryReceipt({ receipt: codeContext.receipt, distDirectory: artifacts.distDirectory,
          outputPath: path.join(directory, "inventory.json") });
        artifacts.preparedArtifact = await preparePublicWorkerArtifact({ artifactReceipt: codeContext.receipt,
          distDirectory: artifacts.distDirectory, outputPath: path.join(directory, "prepared.json") });
        await writeFile(path.join(directory, "public-context.json"), JSON.stringify(codeContext), { mode: 0o600 });
        return publicationFromPrepared(artifacts.preparedArtifact);
      } });
    packet.refuseCode(); await pageRef.set(pageBefore);
    const built = await derivePublicReleasePairCodePack(artifacts);
    const candidate = sealedPair(transport.origin, { ...releasePair("c", "c".repeat(40)),
      rendererDigest: artifacts.pair.rendererDigest, codeAssetManifestDigest: built.manifest.codeAssetManifestDigest });
    const pair = candidate.pair, base = work.publicReleasePairPath(pair.pairId);
    await work.registerPublicReleasePair({ firestore, pair }); await firestore.doc(readerSealPath(pair)).create(candidate.seals);
    await firestore.doc(`${base}/controls/runtime`).set({ schemaVersion: 2, pairId: pair.pairId, status: "candidate" });
    await firestore.doc(`${base}/rollouts/publisher`).set({ schemaVersion: 2, pairId: pair.pairId,
      pairDigest: protocol.publicReleaseDigest(pair), state: "verified", readbackDigest: "c".repeat(64) });
    const capture = { firestore, store, pair, providerStore: selected.providerStore,
      resourceRequest: async () => { throw new Error("No mutable resources"); } };
    const code = await capturePublicReleasePairCodePackBaselineInput({ ...capture,
      logBaselineDigest: selected.global.logBaselineDigest, codePackArtifacts: artifacts });
    await firestore.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({ firestore, transaction, pair,
      input: { ...code.receipt.scope, inputManifestDigest: code.receipt.inputManifestDigest } }));
    const executor = createPublicReleasePairExecutor({ firestore, store, pair });
    if (await runPublicReleasePairWorkOnce({ firestore, pair, ...executor }) !== "complete") throw new Error("Candidate CODE refused");
    const baseline = await captureHistoricalPublicReleasePairBaselineInput({ ...capture, logBaselineDigest: selected.global.logBaselineDigest });
    const baselineTask = await firestore.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({ firestore, transaction, pair,
      input: { ...baseline.receipt.scope, inputManifestDigest: baseline.receipt.inputManifestDigest } }));
    const stage = (taskId: string) => stagedPublicReleasePairCompositeFixture({ ...selected, pair, taskId }, store);
    const baselineG = await stage(baselineTask.taskId), pack = await openStagedPublicReleasePairCodePack({ firestore, store, pair });
    const packView = (await firestore.doc(`${base}/views/${pack.record.viewManifestDigest}`).get()).data()!;
    const reference = (staged: typeof baselineG) => ({ identity: staged.claim.identity, claimDigest: staged.owner.claimDigest,
      manifestDigest: staged.rendered.manifestDigest, manifestBytes: staged.rendered.manifestBytes });
    await initializePublicReleasePairReplayBaseline({ firestore, store, pair, logBaselineDigest: selected.global.logBaselineDigest,
      views: [reference(baselineG)], codePackView: { identity: pack.record.identity, claimDigest: pack.record.claimDigest,
        manifestDigest: pack.record.viewManifestDigest, manifestBytes: packView.manifestBytes } });
    await sealPublicReleasePairCodePublication({ firestore, store, pair, publicContextPath: path.join(directory, "public-context.json") });
    const head = await captureHistoricalPublicReleasePairInput({ ...capture, sourceOperationId: selected.codeOperationId, kind: "qualification" });
    const headTask = await firestore.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({ firestore, transaction, pair,
      input: { ...head.receipt.scope, inputManifestDigest: head.receipt.inputManifestDigest } }));
    const headG = await stage(headTask.taskId);
    await replayPublicReleasePairToHead({ firestore, store, pair, resolveView: async () => reference(headG) });
    transport.install(createPrivatePairReader({ firestore, store, pair, installed: candidate.seals }));
    const media = firestore.doc("system/publicDeployment/pairMedia/current"), mediaBefore = (await media.get()).data()!;
    const newWitness = await replay.sealPublicReleasePairReplayWitness({ firestore, pair });
    // The media reference is live authority. Both H heads must cover that exact
    // source seal before qualification; append it through the actual producer.
    const mediaNext = { ...mediaBefore, references: [...mediaBefore.references,
      { pairId: pair.pairId, manifestDigest: newWitness.witness.contentViewDigest }] };
    // Admission configuration is an explicit fixture precondition. The actual
    // accepted context event below seals its root and media projections.
    const rootRef = firestore.doc("system/publicDeployment"), rootBefore = (await rootRef.get()).data()!;
    const contract = { schemaVersion: 2, families: ["posts", "context"], features: [] };
    await firestore.doc(`${admissions.CONTRACTS}/${protocol.publicReleaseDigest(contract)}`).create(contract);
    const rootNext = { ...rootBefore, admittedContractDigest: protocol.publicReleaseDigest(contract) };
    await rootRef.set(rootNext);
    const mediaOperationId = "candidate-media-ready";
    await firestore.runTransaction(async transaction => {
      const context = (await transaction.get(firestore.doc("system/publicDeployment/contexts/public"))).data()!;
      if (!context.externalInputs?.files) throw new Error("Actual fixture provider inputs missing");
      const change = { kind: "provider" as const, id: "external-inputs", action: "dependency" as const, sourceVersion: 1, snapshot: context.externalInputs,
        sourceDocuments: [{ path: media.path, data: mediaNext }, { path: rootRef.path, data: rootNext }] };
      const accepted = await admissions.preparePairPublicationInTransaction({ firestore, transaction, operationId: mediaOperationId,
        source: admissions.publicationSource(change), change, contextRevision: context.revision + 1 });
      accepted.write(); transaction.set(media, mediaNext); bumpPublicContextRevision(transaction, firestore);
    });
    async function replayOperation(operationId: string) {
      for (const side of [selected.pair, pair]) {
        const accepted = (await firestore.doc(`${admissions.ADMISSIONS}/operations/${operationId}`).get()).data();
        const runtime = (await firestore.doc(`${work.publicReleasePairPath(side.pairId)}/controls/runtime`).get()).data()!;
        const kind = runtime.status === "candidate" ? "qualification" : accepted?.pair.pairId === side.pairId ? "accepted" : "recovery";
        const content = await captureHistoricalPublicReleasePairInput({ ...capture, pair: side,
          sourceOperationId: operationId, kind });
        const queued = await firestore.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({ firestore, transaction, pair: side,
          input: { ...content.receipt.scope, inputManifestDigest: content.receipt.inputManifestDigest } }));
        const staged = await stagedPublicReleasePairCompositeFixture({ ...selected, pair: side, taskId: queued.taskId }, store);
        await replayPublicReleasePairToHead({ firestore, store, pair: side, resolveView: async () => reference(staged) });
      }
    }
    await replayOperation(mediaOperationId);
    return { selected, pair, candidate, oldView, headG, transport, replayOperation,
      async close() { await packet?.close(); await selected.close(); await transport.close(); await rm(directory, { recursive: true, force: true }); } };
  } catch (error) { await packet?.close(); await selected.close(); await transport.close(); await rm(directory, { recursive: true, force: true }); throw error; }
}
