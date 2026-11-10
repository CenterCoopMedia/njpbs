import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { FieldValue } from "firebase-admin/firestore";
import { isolatedFirestore } from "../helpers/emulator-firestore.js";
import { switchedPairFixture } from "../helpers/public-release-switched-pair";
import { stagedPublicReleasePairCompositeFixture } from "../helpers/staged-public-release-pair-composite";
import { openInstalledPublicationTimingTransport, openPublicationTimingCensus, type InstalledPublicationTimingSetup,
  type PublicationTimingCase, type PublicationTimingCensus } from "../../site/scripts/public-release-pair-publication-timing";
import { recoverOriginalPublicReleaseWork } from "../../site/scripts/public-release-original-work-recovery";
import { activateStagedPublicReleasePairPublication } from "../../site/scripts/public-release-pair-content-activation";
import { preparePublicReleasePublicationTerminal, settlePreparedPublicReleasePublication } from "../../site/scripts/public-release-publication-terminal";
import { createPublicReleaseRouter } from "../../workers/src/public-release-router";
import { createPublicReleaseSlot } from "../../workers/src/public-release-slot";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import serving from "../../functions/lib/public-release-serving.js";
import admission from "../../functions/lib/public-release-admission.js";
import { runInstalledPublicationTimingPacket } from "../../site/scripts/measure-public-release-pair-publication";

// SDK/R2 owner contracts, with the existing explicit route-body fixture. This
// is not a provider install, compiled SSR run or remote latency measurement.
const family = createRequire(import.meta.url)("../../functions/lib/public-release-family-admission.js");
const signal = new AbortController().signal, operationId = "J".repeat(20);
let runtime: Miniflare, fixture: Awaited<ReturnType<typeof switchedPairFixture>>;
let store: Awaited<ReturnType<Miniflare["getR2Bucket"]>>;
let setup: InstalledPublicationTimingSetup, census: PublicationTimingCensus, input: PublicationTimingCase;
let dispatchDocument: Record<string, any>;
beforeAll(async () => {
  runtime = new Miniflare({ workers: [{ config: { name: "installed-timing", type: "worker", compatibilityDate: "2026-07-09",
    manifest: { mainModule: "index.js", modules: { "index.js": { type: "esm", contents: "export default {fetch(){return new Response(null,{status:404})}}" } } },
    env: { CONTENT: { type: "r2", name: "installed-timing" } } } }] });
  store = await runtime.getR2Bucket("CONTENT");
  fixture = await switchedPairFixture(isolatedFirestore("installed-publication-timing"), store);
  const { firestore, pair, sourcePair } = fixture;
  const code = await fixture.captureCode();
  const codeTask = await firestore.runTransaction(transaction => work.enqueuePublicReleasePairWorkInTransaction({ firestore, transaction, pair,
    input: { ...code.root.scope, inputManifestDigest: code.receipt.inputManifestDigest } }));
  await stagedPublicReleasePairCompositeFixture({ ...fixture, content: code, taskId: codeTask.taskId }, store);
  census = await openPublicationTimingCensus({ distDirectory: fixture.artifacts.distDirectory,
    preparedArtifact: fixture.artifacts.preparedArtifact });
  const story = (await firestore.doc("cmsPosts/story").get()).data()!;
  const nextDocument = { ...story, version: 10, publishBuildPending: true, publishBuildQueueId: operationId,
    published: { ...story.published, sourceVersion: 10, metadata: { ...story.published.metadata, title: "Timing owner contract" } } };
  dispatchDocument = nextDocument;
  const source = admission.publicationSource({ kind: "post", id: "story", action: "publish", snapshot: nextDocument.published });
  input = { operationId, sourceVersion: source.sourceVersion, snapshotDigest: source.snapshotDigest,
    path: `/posts/${story.published.metadata.slug}/`, status: 200 };
  expect(census.htmlPaths).toContain(input.path);
  expect(census.htmlPaths).toContain("/");
  const router = createPublicReleaseRouter({ environment: "development",
    readSelector: () => serving.readPublicReleaseSelector({ firestore, environment: "development" }),
    slots: [pair, sourcePair].map(side => createPublicReleaseSlot({ pair: side, workerVersionId: side.publicWorker.versionId, store,
      getDecision: (selection, path) => serving.readPublicReleaseDecision({ firestore, environment: "development", pair: side,
        selection, path, composedReadersEnabled: true }) })) });
  setup = { firestore, store, ingress: { prove: (request, digest, expected) => router.prove(request, digest, expected) },
    // The real launcher supplies its installed-publisher preflight. The local
    // contract uses the actual retained pair work owner without provider I/O.
    assertInstalled: async pair => { await work.readPublicReleasePairWork({ firestore, pair }); },
    dispatch: async original => {
      expect(original).toEqual(input);
      await firestore.runTransaction(async transaction => {
        const prepared = await family.preparePairContentPublication({ firestore, transaction, collection: "cmsPosts", documentId: "story",
          nextDocument: dispatchDocument, queueRef: firestore.doc(`cmsPublishQueue/${original.operationId}`), actor: { uid: "fixture-editor" }, kind: "post", family: "posts" });
        prepared.write(); transaction.set(firestore.doc("cmsPosts/story"), dispatchDocument);
      });
    } };
}, 120_000);
afterAll(async () => { await fixture?.close(); await runtime?.dispose(); });

it("keeps disabled and production targets inert before setup or SDK access", async () => {
  const unopened = new Proxy({} as InstalledPublicationTimingSetup, { get() { throw new Error("Setup accessed"); } });
  await expect(openInstalledPublicationTimingTransport({ setup: unopened })).rejects.toThrow("installed-publication-timing-bindings-missing");
  const transport = await openInstalledPublicationTimingTransport({ enabled: true, setup });
  await expect(transport.publish(input, signal)).rejects.toThrow("timing-preflight-required");
  await expect(transport.preflight({ pair: { ...fixture.pair, environment: "production" }, census })).rejects.toThrow("non-production-target-required");
});

it("refuses a packet census that differs from the actual retained full baseline", async () => {
  const transport = await openInstalledPublicationTimingTransport({ enabled: true, setup });
  await expect(transport.preflight({ pair: fixture.pair, census: { ...census, htmlPaths: ["/"],
    htmlPathsDigest: protocol.publicReleaseDigest(["/"]) } })).rejects.toThrow("installed-timing-census-mismatch");
});

it("follows original admission, full staged bytes, activation, canonical proof and terminal settlement without issuing any receipt", async () => {
  const { firestore, pair } = fixture;
  const transport = await openInstalledPublicationTimingTransport({ enabled: true, setup });
  await transport.preflight({ pair, census });
  await transport.preflight({ pair, census });
  await transport.publish(input, signal);
  expect(await transport.observe(input, signal)).toBeNull();
  await expect(transport.publish(input, signal)).rejects.toThrow("timing-original-dispatch-repeated");
  const queued = await recoverOriginalPublicReleaseWork({ firestore, store, pair, operationId,
    capture: { providerStore: fixture.providerStore, resourceRequest: async () => { throw new Error("No latest resources"); } } });
  expect(queued.status).toBe("queued");
  const staged = await stagedPublicReleasePairCompositeFixture({ ...fixture, taskId: queued.taskId! }, store);
  expect((await recoverOriginalPublicReleaseWork({ firestore, store, pair, operationId, now: () => Date.now() + 31_000 })).status).toBe("rendered");
  await activateStagedPublicReleasePairPublication({ firestore, store, pair, identity: staged.claim.identity,
    claimDigest: staged.owner.claimDigest, manifestDigest: staged.rendered.manifestDigest });
  const observed = await transport.observe(input, signal);
  expect(observed?.terminalReceiptDigest).toBeNull();
  expect(observed?.response.status).toBe(200);
  expect(await observed!.response.text()).toBe(`<main>Frozen ${input.path}</main>`);
  expect((await firestore.doc(`${admission.ADMISSIONS}/terminalReceipts/${operationId}`).get()).exists).toBe(false);
  const proof = await preparePublicReleasePublicationTerminal({ firestore, store, ingress: setup.ingress, operationId, fieldValues: FieldValue });
  const settled = await settlePreparedPublicReleasePublication({ firestore, proof });
  const complete = await transport.observe(input, signal);
  expect(complete?.terminalReceiptDigest).toBe(protocol.publicReleaseDigest(settled.receipt));
  expect(complete?.admissionDigest).toBe(settled.receipt.admissionDigest);
  expect(complete?.activationReceiptDigest).toBe(settled.receipt.activation.receiptDigest);
  await complete?.response.body?.cancel();
  expect((await firestore.doc(`cmsPublishQueue/${operationId}`).get()).data()?.status).toBe("success");
  await expect(transport.observe({ ...input, snapshotDigest: "0".repeat(64) }, signal)).rejects.toThrow("timing-original-dispatch-required");
  const resumed = await openInstalledPublicationTimingTransport({ enabled: true, setup });
  await resumed.preflight({ pair, census });
  await expect(resumed.publish(input, signal)).rejects.toThrow("timing-original-dispatch-repeated");
  const terminalRef = firestore.doc(`${admission.ADMISSIONS}/terminalReceipts/${operationId}`);
  await terminalRef.update({ activation: { ...settled.receipt.activation, receiptDigest: "0".repeat(64) } });
  try { await expect(transport.observe(input, signal)).rejects.toThrow(); }
  finally { await terminalRef.set(settled.receipt); }
}, 120_000);

it.each([308, 410] as const)("proves actual %i redirect or withdrawal bytes and original terminal settlement", async status => {
  const { firestore, pair } = fixture;
  const story = (await firestore.doc("cmsPosts/story").get()).data()!;
  const originalSlug = story.published.metadata.slug;
  const nextOperation = (status === 308 ? "K" : "L").repeat(20);
  dispatchDocument = { ...story, version: story.version + 1, publishBuildPending: true, publishBuildQueueId: nextOperation,
    ...(status === 308 ? { published: { ...story.published, sourceVersion: story.version + 1,
      metadata: { ...story.published.metadata, slug: "timing-new-route", previousSlugs: [originalSlug] } } } :
      { status: "unpublished", publiclyVisible: false }) };
  const source = admission.publicationSource({ kind: "post", id: "story", action: status === 410 ? "withdraw" : "publish", snapshot: dispatchDocument.published });
  input = { operationId: nextOperation, sourceVersion: source.sourceVersion, snapshotDigest: source.snapshotDigest,
    path: `/posts/${originalSlug}/`, status };
  const transport = await openInstalledPublicationTimingTransport({ enabled: true, setup });
  await transport.preflight({ pair, census });
  await transport.publish(input, signal);
  const queued = await recoverOriginalPublicReleaseWork({ firestore, store, pair, operationId: nextOperation,
    capture: { providerStore: fixture.providerStore, resourceRequest: async () => { throw new Error("No latest resources"); } } });
  expect(queued.status).toBe("queued");
  const staged = await stagedPublicReleasePairCompositeFixture({ ...fixture, taskId: queued.taskId! }, store);
  expect((await recoverOriginalPublicReleaseWork({ firestore, store, pair, operationId: nextOperation, now: () => Date.now() + 31_000 })).status).toBe("rendered");
  await activateStagedPublicReleasePairPublication({ firestore, store, pair, identity: staged.claim.identity,
    claimDigest: staged.owner.claimDigest, manifestDigest: staged.rendered.manifestDigest });
  const proof = await preparePublicReleasePublicationTerminal({ firestore, store, ingress: setup.ingress, operationId: nextOperation, fieldValues: FieldValue });
  const settled = await settlePreparedPublicReleasePublication({ firestore, proof });
  const observed = await transport.observe(input, signal);
  expect(observed?.response.status).toBe(status);
  expect(observed?.contentType).toBeNull();
  expect(await observed!.response.text()).toBe("");
  expect(observed?.bodyDigest).toBe(createHash("sha256").update("").digest("hex"));
  expect(observed?.terminalReceiptDigest).toBe(protocol.publicReleaseDigest(settled.receipt));
  if (status === 308) expect(observed?.response.headers.get("location")).toBe("/posts/timing-new-route/");
}, 120_000);

it.each(["production", "case", "duplicate", "extra"] as const)("rejects a %s packet before the setup can read credentials", async fault => {
  const packet: Record<string, any> = { schemaVersion: 2, pair: fixture.pair, cases: [input],
    distDirectory: "/must-not-read", preparedArtifact: {}, setup: {} };
  const reason = { production: "non-production-target-required", case: "case-invalid",
    duplicate: "sample-operation-repeated", extra: "installed-timing-packet-invalid" }[fault];
  if (fault === "production") packet.pair = { ...fixture.pair, environment: "production" };
  if (fault === "case") packet.cases = [{ ...input, sourceVersion: 0 }];
  if (fault === "duplicate") packet.cases = [input, input];
  if (fault === "extra") packet.credential = "disallowed-field";
  await expect(runInstalledPublicationTimingPacket({ packet, outputDirectory: "/must-not-write",
    openSetup: async () => { throw new Error("Setup consumed credentials"); } })).rejects.toThrow(reason);
});

it("rejects the actual installed-development setup in an emulator before credential access", async () => {
  await expect(runInstalledPublicationTimingPacket({ outputDirectory: "/must-not-write",
    packet: { schemaVersion: 2, pair: fixture.pair, cases: [input],
      distDirectory: fixture.artifacts.distDirectory, preparedArtifact: fixture.artifacts.preparedArtifact, setup: {} },
  })).rejects.toThrow("Installed development timing setup refused");
});

it("preserves the original setup failure when resource cleanup also fails", async () => {
  const failure = new Error("Installation failed"), exitCode = process.exitCode;
  const diagnostic = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    await expect(runInstalledPublicationTimingPacket({ outputDirectory: "/must-not-write",
      packet: { schemaVersion: 2, pair: fixture.pair, cases: [input],
        distDirectory: fixture.artifacts.distDirectory, preparedArtifact: fixture.artifacts.preparedArtifact, setup: {} },
      openSetup: async () => ({ setup: { ...setup, assertInstalled: async () => { throw failure; } },
        close: async () => { throw new Error("Private SDK cleanup detail"); } }),
    })).rejects.toBe(failure);
    expect(diagnostic.mock.calls).toEqual([["Publication timing cleanup failed\n"]]);
    expect(process.exitCode).toBe(1);
  } finally { diagnostic.mockRestore(); process.exitCode = exitCode; }
});

it("runs the development packet through actual original owners and keeps setup data out of evidence", async () => {
  const { firestore, pair } = fixture;
  const story = (await firestore.doc("cmsPosts/story").get()).data()!;
  const nextOperation = "M".repeat(20);
  dispatchDocument = { ...story, version: story.version + 1, status: "published", publiclyVisible: true,
    publishBuildPending: true, publishBuildQueueId: nextOperation,
    published: { ...story.published, sourceVersion: story.version + 1 } };
  const source = admission.publicationSource({ kind: "post", id: "story", action: "publish", snapshot: dispatchDocument.published });
  input = { operationId: nextOperation, sourceVersion: source.sourceVersion, snapshotDigest: source.snapshotDigest,
    path: `/posts/${dispatchDocument.published.metadata.slug}/`, status: 200 };
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "installed-timing-packet-"));
  const exitCode = process.exitCode, diagnostic = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    const report = await runInstalledPublicationTimingPacket({ outputDirectory,
      packet: { schemaVersion: 2, pair, cases: [input], distDirectory: fixture.artifacts.distDirectory,
        preparedArtifact: fixture.artifacts.preparedArtifact, setup: { originalSource: "owned-by-setup" } },
      // The process boundary supplies actual local SDK/R2/router handles. It
      // does not substitute a provider installation or a remote timing result.
      openSetup: async () => ({ close: async () => { throw new Error("Private SDK cleanup detail"); }, setup: { ...setup, async dispatch(original, signal) {
        await setup.dispatch(original, signal);
        const queued = await recoverOriginalPublicReleaseWork({ firestore, store, pair, operationId: original.operationId,
          capture: { providerStore: fixture.providerStore, resourceRequest: async () => { throw new Error("No latest resources"); } } });
        expect(queued.status).toBe("queued");
        const staged = await stagedPublicReleasePairCompositeFixture({ ...fixture, taskId: queued.taskId! }, store);
        expect((await recoverOriginalPublicReleaseWork({ firestore, store, pair, operationId: original.operationId,
          now: () => Date.now() + 31_000 })).status).toBe("rendered");
        await activateStagedPublicReleasePairPublication({ firestore, store, pair, identity: staged.claim.identity,
          claimDigest: staged.owner.claimDigest, manifestDigest: staged.rendered.manifestDigest });
        const proof = await preparePublicReleasePublicationTerminal({ firestore, store, ingress: setup.ingress,
          operationId: original.operationId, fieldValues: FieldValue });
        await settlePreparedPublicReleasePublication({ firestore, proof });
      } } }),
    });
    expect(report.summary).toMatchObject({ sampleCount: 1, completedCount: 1, failedCount: 0, gatePassed: false });
    expect(report.samples[0].terminalReceiptDigest).toBe((await firestore.doc(`cmsPublishQueue/${nextOperation}`).get()).data()?.terminalReceipt);
    expect(report.samples[0].bodyDigest).toBe(createHash("sha256").update(`<main>Frozen ${input.path}</main>`).digest("hex"));
    expect(JSON.parse(await readFile(path.join(outputDirectory, "packet.json"), "utf8"))).not.toHaveProperty("setup");
    expect(diagnostic.mock.calls).toEqual([["Publication timing cleanup failed\n"]]);
    expect(process.exitCode).toBe(1);
  } finally { diagnostic.mockRestore(); process.exitCode = exitCode; await rm(outputDirectory, { recursive: true, force: true }); }
}, 120_000);
