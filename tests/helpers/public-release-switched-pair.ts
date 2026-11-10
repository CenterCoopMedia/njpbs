import { access, mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Firestore } from "firebase-admin/firestore";
import type { PairViewStore } from "../../site/scripts/public-release-pair-view-storage";
import { PUBLIC_PAGES } from "../../packages/content-core/src/public-pages";
import { publicReleasePairCompositeFixture } from "./public-release-pair-composite";
import { publicReleaseCodePackFixture } from "./public-release-code-pack";
import { stagedPublicReleasePairCompositeFixture } from "./staged-public-release-pair-composite";
import { schedulePacketFixture } from "../functions/page-schedule-packet-fixture";
import { frozenReplayProgramRead } from "./public-release-replay-inputs";
import { capabilities, fixtureGuard, fixtureReadOwner } from "./public-release-switch.js";
import { releasePair, releaseSelector, pairReference } from "./private-public-release-pair.js";
import { sealedPair } from "./sealed-public-release-pair";
import { privateReaderTransport } from "./private-pair-reader-fixture";
import { createPrivatePairReader } from "../../site/scripts/public-release-pair-private-reader";
import { createPrivatePairReaderClient } from "../../site/scripts/public-release-pair-reader-client";
import { finalizePublicArtifactInventoryReceipt } from "../../site/src/lib/public-artifact-inventory";
import { preparePublicWorkerArtifact } from "../../site/src/lib/public-worker-artifact";
import { publicationFromPrepared } from "../../site/src/lib/public-publication-receipt";
import { initializePublicReleasePairReplayBaseline } from "../../site/scripts/public-release-pair-log-replay";
import { captureHistoricalPublicReleasePairInput } from "../../site/scripts/public-release-pair-source-owner";
import { sealPublicReleasePairCodePublication } from "../../site/scripts/public-release-switch-code";
import p from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import replay from "../../functions/lib/public-release-pair-replay.js";
import switches from "../../functions/lib/public-release-switch.js";
import admission from "../../functions/lib/public-release-admission.js";
import { openStagedPublicReleasePairCodePack } from "../../site/scripts/public-release-pair-code-pack-executor";

/** Real source/SDK/R2/CODE sealing and guarded CODE append. Switch qualification
 * and rollout rows are explicit test preconditions, not provider/bootstrap or
 * SSR readiness. The small route bodies come from the existing closed roster. */
export async function switchedPairFixture(firestore: Firestore, store: PairViewStore) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "terminal-pair-"));
  const oldReader = await privateReaderTransport(), nextReader = await privateReaderTransport();
  const oldSeals = sealedPair(oldReader.origin).seals, nextSeals = sealedPair(nextReader.origin, releasePair("b", "b".repeat(40))).seals;
  let fixture: Awaited<ReturnType<typeof publicReleasePairCompositeFixture>> | undefined;
  let nextPacket: Awaited<ReturnType<typeof schedulePacketFixture>> | undefined;
  try {
    fixture = await publicReleasePairCompositeFixture({ firestore, store, directory, content: "baseline",
      sourceReaderSeals: oldSeals, readerSeals: nextSeals,
      seed: async db => {
        await db.doc("system/publicDeployment/noBuildRecordOwners/one").delete();
        await db.doc("system/noBuildPostAdmission").set({ schemaVersion: 2, revision: 1, enabled: true,
          families: { posts: { mode: "all" } }, backgroundBucket: "njpbs-dev-public-background" });
        await db.doc("system/publicDeployment/noBuildRecordFamilies/current").set({ schemaVersion: 1, families: [] });
      },
      prepareArtifacts: async (directory, sourceInputs) => {
        const artifacts = await publicReleaseCodePackFixture(directory, "b".repeat(40), sourceInputs);
        const pageCapability = (await firestore.doc("system/publicDeployment/noBuildPages/capability").get()).data()!;
        const sourceDb = new Proxy(firestore, { get(target, key) { if (key === "projectId") return "njpbs-site-dev";
          const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; } });
        nextPacket = await schedulePacketFixture({ firestore: sourceDb, rendererSha: "b".repeat(40), generation: 2,
          includeHomeSources: true, attachExternalInputs: false, programRead: frozenReplayProgramRead("b".repeat(40)),
          postDocuments: [(await firestore.doc("cmsPosts/story").get()).data() as any], preparePublication: async ({ codeContext }) => {
            const add = async (route: string, bytes: Uint8Array) => {
              const file = path.join(artifacts.distDirectory, route.endsWith("/") ? `${route.slice(1)}index.html` : route.slice(1));
              try { await access(file); } catch { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes); }
            };
            for (const page of PUBLIC_PAGES) for (const route of [page.path, ...("aliases" in page ? page.aliases : [])])
              await add(route, new TextEncoder().encode(`<html>Sealed fixture ${route}</html>`));
            for (const family of codeContext.receipt.families) for (const record of family.artifacts) if (record.canonicalPath)
              for (const route of [record.canonicalPath, ...record.aliases]) await add(route, new TextEncoder().encode(`<html>Sealed source ${route}</html>`));
            for (const route of codeContext.receipt.aggregateRoutes) await add(route, new TextEncoder().encode(`<html>Sealed aggregate ${route}</html>`));
            for (const file of codeContext.programImageDescriptors?.files ?? []) await add(file.path, new Uint8Array(Buffer.from(file.base64, "base64")));
            await finalizePublicArtifactInventoryReceipt({ receipt: codeContext.receipt, distDirectory: artifacts.distDirectory,
              outputPath: path.join(directory, "next-inventory.json") });
            artifacts.preparedArtifact = await preparePublicWorkerArtifact({ artifactReceipt: codeContext.receipt,
              distDirectory: artifacts.distDirectory, outputPath: path.join(directory, "next-prepared.json") });
            await writeFile(path.join(directory, "next-public-context.json"), JSON.stringify(codeContext), { mode: 0o600 });
            return publicationFromPrepared(artifacts.preparedArtifact);
          } });
        nextPacket.refuseCode();
        await firestore.doc("system/publicDeployment/noBuildPages/capability").set(pageCapability);
        return artifacts;
      } });
    const { pair, sourcePair, base } = fixture, db = fixture.firestore;
    const staged = await stagedPublicReleasePairCompositeFixture(fixture, store);
    const pack = await openStagedPublicReleasePairCodePack({ firestore: db, store, pair });
    const codeRow = (await db.doc(`${base}/views/${pack.record.viewManifestDigest}`).get()).data()!;
    const reference = { identity: staged.claim.identity, claimDigest: staged.owner.claimDigest,
      manifestDigest: staged.rendered.manifestDigest, manifestBytes: staged.rendered.manifestBytes };
    nextReader.install(createPrivatePairReader({ firestore: db, store, pair, installed: nextSeals }));
    const read = createPrivatePairReaderClient({ pair, seals: nextSeals, credentials: nextReader.credentials });
    await read({ ...reference, paths: [staged.outputs.find(row => row.path === "/")!.path] });
    await initializePublicReleasePairReplayBaseline({ firestore: db, store, pair, logBaselineDigest: fixture.global.logBaselineDigest,
      views: [reference], codePackView: { identity: pack.record.identity, claimDigest: pack.record.claimDigest,
        manifestDigest: pack.record.viewManifestDigest, manifestBytes: codeRow.manifestBytes } });
    const baseline = await replay.sealPublicReleasePairReplayWitness({ firestore: db, pair });
    await sealPublicReleasePairCodePublication({ firestore: db, store, pair, publicContextPath: path.join(directory, "next-public-context.json") });
    const oldHead = { pairId: sourcePair.pairId, viewId: "fixture-old-head", manifestDigest: "e".repeat(64), contextSequence: 0 };
    const contract = { schemaVersion: 2, families: ["posts"], features: [] };
    const selector = { ...releaseSelector(), activeGeneration: 1, lastReservedGeneration: 1, newestEligibleGeneration: 1,
      admittedContractDigest: p.publicReleaseDigest(contract),
      selectedPair: pairReference(sourcePair), recoveryPair: pairReference(pair), activeCommitSha: sourcePair.commitSha,
      activeDeploymentId: "composite-code", contentHead: oldHead };
    await db.doc(switches.ROOT).set(selector);
    await db.doc("system/cmsPublicationRuntime").set({ schemaVersion: 1, phase: "ready", commitSha: sourcePair.commitSha,
      serializerId: "cloudflare-dev-publisher", cloud: { phase: "ready", commitSha: sourcePair.commitSha, serializerId: "cloudflare-dev-publisher" } });
    for (const [family, capabilityPath] of Object.entries(switches.CAPABILITY_PATHS)) await db.doc(capabilityPath).set({
      ...capabilities(sourcePair.commitSha)[family as "posts" | "pages" | "records"], generation: 1 });
    await db.doc("system/noBuildPostAdmission").set({ schemaVersion: 2, revision: 1, enabled: true, families: { posts: { mode: "all" } }, backgroundBucket: "njpbs-dev-public-background" });
    await db.doc("system/publicDeployment/noBuildRecordFamilies/current").set({ schemaVersion: 1, families: [] });
    await db.doc(admission.ADMISSIONS).set(admission.initialAdmissionHead()); await db.doc("system/billing").set({ disabled: false });
    await db.doc(`${admission.CONTRACTS}/${p.publicReleaseDigest(contract)}`).set(contract);
    await db.doc(`${admission.ADMISSIONS}/controls/adoption`).set({ schemaVersion: 2, enabled: true });
    await db.doc(switches.MEDIA).set({ schemaVersion: 2, epoch: 1, activeGeneration: 1, lastReservedGeneration: 1, newestEligibleGeneration: 1,
      references: [{ pairId: sourcePair.pairId, manifestDigest: oldHead.manifestDigest }, { pairId: pair.pairId, manifestDigest: baseline.witness.contentViewDigest }] });
    for (const side of [sourcePair, pair]) {
      await db.doc(`${work.publicReleasePairPath(side.pairId)}/controls/runtime`).set({ schemaVersion: 2, pairId: side.pairId, status: side === sourcePair ? "retained" : "candidate" });
      await db.doc(`${work.publicReleasePairPath(side.pairId)}/rollouts/publisher`).set({ schemaVersion: 2, pairId: side.pairId,
        pairDigest: p.publicReleaseDigest(side), state: "verified", readbackDigest: "c".repeat(64) });
    }
    const paths = ["system/publicDeployment/contexts/public", "system/publicReleaseChanges", "system/publicReleaseChangeLog", "system/noBuildPostAdmission",
      "system/publicDeployment/noBuildRecordFamilies/current", switches.MEDIA, admission.ADMISSIONS, "system/billing"];
    const rows = await db.getAll(...paths.map(path => db.doc(path))), validators = rows.map((row, index) => ({ path: paths[index], digest: p.publicReleaseDigest(row.data()) }));
    const cursor = rows[1].data(), acceptedWorkDigest = p.publicReleaseDigest(rows[6].data());
    const qualifications = [sourcePair, pair].map((side, index) => ({ schemaVersion: 2, pairDigest: p.publicReleaseDigest(side),
      contentHead: index ? { pairId: pair.pairId, viewId: baseline.witnessDigest, manifestDigest: baseline.witness.contentViewDigest, contextSequence: 0 } : oldHead,
      cursor, validatorDigest: p.publicReleaseDigest(validators), capabilities: capabilities(side.commitSha), coverageDigest: "d".repeat(64),
      controlsDigest: p.publicReleaseDigest(capabilities(side.commitSha)),
      acceptedWorkDigest, admittedContractDigest: selector.admittedContractDigest, readerReceiptDigest: side.readerReceiptDigest, providerReadbackDigest: "c".repeat(64) }));
    for (const [index, side] of [sourcePair, pair].entries()) await db.doc(`${work.publicReleasePairPath(side.pairId)}/switchQualifications/${p.publicReleaseDigest(qualifications[index])}`).set(qualifications[index]);
    const witness = { schemaVersion: 2, oldPairDigest: p.publicReleaseDigest(sourcePair), newPairDigest: p.publicReleaseDigest(pair),
      oldQualificationDigest: p.publicReleaseDigest(qualifications[0]), newQualificationDigest: p.publicReleaseDigest(qualifications[1]), cursor, validators,
      admittedContractDigest: selector.admittedContractDigest, acceptedWorkDigest };
    await db.doc(`${switches.WITNESSES}/${p.publicReleaseDigest(witness)}`).set(witness);
    const attempt = { schemaVersion: 2 as const, operationId: "terminal-fixture-switch", expectedSelectorDigest: p.publicReleaseDigest(selector),
      oldPair: sourcePair, newPair: pair, witnessDigest: p.publicReleaseDigest(witness) };
    await switches.reservePublicReleaseSwitch({ firestore: db, attempt });
    await switches.applyPublicReleaseSwitch({ firestore: db, attempt, qualificationReadOwner: fixtureReadOwner,
      assertQualificationsCurrentInTransaction: fixtureGuard, assertAcceptedWorkIncludedInTransaction: fixtureGuard });
    const codeOperationId = p.publicReleaseDigest({ kind: "public-release-switch", operationId: attempt.operationId });
    return { ...fixture, baseline, codeOperationId, nextPacket, readerCalls: () => nextReader.received, async captureCode() {
      return captureHistoricalPublicReleasePairInput({ firestore: db, store, pair, sourceOperationId: codeOperationId,
        kind: "recovery", providerStore: fixture!.providerStore, resourceRequest: async () => { throw new Error("No latest resource"); } });
    }, close: async () => { await nextPacket?.close(); await fixture!.close(); await oldReader.close(); await nextReader.close(); await rm(directory, { recursive: true, force: true }); } };
  } catch (error) { await nextPacket?.close(); await fixture?.close(); await oldReader.close(); await nextReader.close(); await rm(directory, { recursive: true, force: true }); throw error; }
}
