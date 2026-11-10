import { createRequire } from "node:module";
import { beforeEach, expect, it, vi } from "vitest";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { pair, reader, receipt, selector, candidate } from "../helpers/cms-preview-pairs.js";
import { installClosureReaders } from "../helpers/cms-preview-closure-readers.js";
import { startCandidateReceipt, verifyCandidateReceipt, commitLiveReaderReceipt, startReceipt } from "../../scripts/lib/cms-component-receipt.mjs";
import { assertLegacyCmsWorkflow } from "../../scripts/lib/cms-release-plan.mjs";
import { planPairedCmsRelease, assertPairedAdminManifest, publishPairedAdminManifest } from "../../scripts/lib/cms-preview-pair-release.mjs";
import { deployPreviewPairRuntime, previewPairConfiguration } from "../../site/scripts/deploy-cms-preview-pair.js";

const api = createRequire(import.meta.url)("../../functions/lib/cms-preview-pair.js");
const db = isolatedFirestore("cms-preview-pair-deploypath");
const old = pair("old"), next = pair("new", "b"), initial = selector(old, next);
const digest = (letter: string) => letter.repeat(64);
let now: number;
const attempt = (component = "renderer") => ({ component, sourceSha: next.rendererSha,
  trustedWorkflowSha: "e".repeat(40), runId: "100", runAttempt: 1,
  inputFingerprint: digest("f"), configurationFingerprint: digest("d") });
const current = async (path = api.SELECTOR_PATH) => (await db.doc(path).get()).data();
const identities = () => ({ functions: reader("functions", now).providerIdentities, cmsApi: reader("cmsApi", now).providerIdentities });
beforeEach(async () => {
  now = Date.now();
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  await api.registerPair(db, old); await api.registerPair(db, next);
  await db.doc(api.SELECTOR_PATH).set(initial);
  await db.doc(api.RENDERER_RECEIPT_PATH).set({ schemaVersion: 2, component: "renderer", state: "complete",
    pairId: old.pairId, selectorDigest: api.digest(initial), lastComplete: candidate(old, now).mutation });
  for (const component of ["functions", "cmsApi"]) await db.collection(api.READER_RECEIPTS).doc(component).set(receipt(component, now));
  await db.doc("cmsDeploymentReceipts/adminManifest").set({ schemaVersion: 1, state: "complete", lastComplete: { manifestDigest: digest("a") } });
});

it("requires all retained contracts for planning and the selected renderer for Admin", async () => {
  const input = { selector: initial, selectedPair: old, candidatePair: next,
    functionsReceipt: receipt("functions", now), cmsApiReceipt: receipt("cmsApi", now) };
  expect(planPairedCmsRelease(input)).toMatchObject({ previewPaused: false, selectedPairId: old.pairId });
  const incompatible = structuredClone(input); incompatible.candidatePair.requirements.postChrome = 2;
  expect(() => planPairedCmsRelease(incompatible)).toThrow("both retained");
  expect(() => assertPairedAdminManifest({ ...input, rendererReceipt: candidate(next, now) })).toThrow("selected preview receipt");
  expect(assertPairedAdminManifest({ ...input, rendererReceipt: await current(api.RENDERER_RECEIPT_PATH) })).toHaveProperty("previewSelectorDigest", api.digest(initial));
});

it.each([2, 3, null])("refuses legacy writes under protocol %s without changing any receipt", async version => {
  await db.doc(api.SELECTOR_PATH).set(version === null ? { phase: "ready" } : { schemaVersion: version });
  const before = await current("cmsDeploymentReceipts/functions");
  await expect(assertLegacyCmsWorkflow(db)).rejects.toThrow("legacy CMS writes are refused");
  await expect(startReceipt(db, attempt("functions"))).rejects.toThrow("legacy CMS writes are refused");
  expect(await current("cmsDeploymentReceipts/functions")).toEqual(before);
});
it.each([true, false])("allows the schema-one workflow when its runtime exists=%s", async exists => {
  if (exists) await db.doc(api.SELECTOR_PATH).set({ schemaVersion: 1, phase: "ready" });
  else await db.doc(api.SELECTOR_PATH).delete();
  expect(await assertLegacyCmsWorkflow(db)).toBe("schema-one");
  expect((await startReceipt(db, attempt("cmsApi"))).receipt.state).toBe("in_progress");
});
it("retries a legacy transaction against a concurrently bootstrapped selector", async () => {
  await db.doc(api.SELECTOR_PATH).set({ schemaVersion: 1 });
  let raced = false;
  const wrapped = { ...db, doc: db.doc.bind(db), collection: db.collection.bind(db),
    runTransaction: (work: (tx: any) => unknown) => db.runTransaction(async tx => {
      // Change the selector before the transaction can lock it. The exact read
      // in startReceipt, rather than a preflight-only guard, must reject it.
      if (!raced) { raced = true; await db.doc(api.SELECTOR_PATH).set(initial); }
      return work(tx);
    }) };
  await expect(startReceipt(wrapped, attempt("cmsApi"))).rejects.toThrow("legacy CMS writes are refused");
  expect(await current("cmsDeploymentReceipts/cmsApi")).toBeUndefined();
});

async function readerCandidate() {
  const input = attempt("functions");
  await startCandidateReceipt(db, input);
  const collect = vi.fn(async () => ({ deploymentId: "new-deployed" }));
  const verified = await verifyCandidateReceipt(db, input, { collect });
  await db.doc("cmsDeploymentReceipts/functions").set({ schemaVersion: 1, component: "functions", state: "complete",
    mutation: verified.mutation, lastComplete: verified.mutation });
  return { input: { ...input, supported: reader("functions", now).supported }, collect };
}
it("keeps candidates separate and requires fresh matching provider and legacy identities", async () => {
  const { input, collect } = await readerCandidate();
  const legacy = await current("cmsDeploymentReceipts/functions");
  await expect(commitLiveReaderReceipt(db, input, { collect: async () => ({ deploymentId: "changed" }) })).rejects.toThrow("changed after verification");
  const updated = await commitLiveReaderReceipt(db, input, { collect });
  expect(updated.lastComplete.providerIdentities).toEqual(await collect());
  expect((await commitLiveReaderReceipt(db, input, { collect })).lastComplete).toMatchObject({ ...updated.lastComplete, verifiedAt: expect.any(String) });
  expect(await current("cmsDeploymentReceipts/functions")).toEqual(legacy);
  expect(await current()).toEqual(initial);
});
it("refreshes an unchanged reader after its previous evidence has expired", async () => {
  const { input, collect } = await readerCandidate();
  const updated = await commitLiveReaderReceipt(db, input, { collect });
  await db.collection(api.READER_RECEIPTS).doc("functions").set({ ...updated,
    lastComplete: { ...updated.lastComplete, verifiedAt: new Date(now - 300_001).toISOString() } });
  const refreshed = await commitLiveReaderReceipt(db, input, { collect });
  expect(Date.parse(refreshed.lastComplete.verifiedAt)).toBeGreaterThan(now - 1_000);
  expect(refreshed.lastComplete.providerIdentities).toEqual(updated.lastComplete.providerIdentities);
});
it("refuses candidate identity reuse and changed configuration during readback", async () => {
  const input = attempt(); await startCandidateReceipt(db, input);
  await expect(startCandidateReceipt(db, { ...input, configurationFingerprint: digest("c") })).rejects.toThrow("conflicts");
  await expect(verifyCandidateReceipt(db, { ...input, inputFingerprint: digest("c") }, { collect: async () => ({ deploymentId: "x" }) })).rejects.toThrow("conflicts");
});
it.each([true, false])("verifies the private application's image and exact Worker version, matching=%s", async matching => {
  const input = attempt();
  await startCandidateReceipt(db, input, { now: () => new Date(now - 1_000) });
  const verification = verifyCandidateReceipt(db, { ...input, readback: {
    previewPair: next, cloudflareToken: "fixture-token", cloudflareAccount: "fixture-account",
    fetchFn: async (url: string) => ({ ok: true, json: async () => ({ result: url.endsWith("/deployments")
      ? { deployments: [{ id: "new-deployment", versions: [{ version_id: matching ? next.workerVersion : old.workerVersion, percentage: 100 }] }] }
      : url.endsWith("/rollouts") ? [] : [{ id: "new-application", name: next.applicationName,
        version: 1, created_at: new Date(now).toISOString(), configuration: { image: `registry/new@${next.imageDigest}` } }] }) }),
  } });
  if (matching) expect((await verification).mutation.providerIdentities).toMatchObject({ pairId: next.pairId, imageDigest: next.imageDigest, workerVersion: next.workerVersion });
  else await expect(verification).rejects.toThrow("exact version");
  expect(await current()).toEqual(initial);
  expect(await current("cmsDeploymentReceipts/renderer")).toBeUndefined();
});
it.each(["legacy", "compatibility", "candidate"])("preserves a concurrent %s change during reader readback", async boundary => {
  const { input } = await readerCandidate();
  const paths = { legacy: "cmsDeploymentReceipts/functions", compatibility: `${api.READER_RECEIPTS}/functions`, candidate: "cmsDeploymentCandidates/functions-100-1" };
  await expect(commitLiveReaderReceipt(db, input, { collect: async () => {
    await db.doc(paths[boundary]).set({ changed: true }); return { deploymentId: "new-deployed" };
  } })).rejects.toThrow("changed during readback");
  expect(await current(paths[boundary])).toEqual({ changed: true });
});
it("refuses a stale candidate replacing a newer compatibility receipt", async () => {
  const { input, collect } = await readerCandidate();
  await db.collection(api.READER_RECEIPTS).doc("functions").set(receipt("functions", Date.now() + 1_000));
  await expect(commitLiveReaderReceipt(db, input, { collect })).rejects.toThrow("predates");
});
it.each(["in_progress", "unknown"])("does not convert a legacy %s deployment", async state => {
  const { input, collect } = await readerCandidate();
  await db.doc("cmsDeploymentReceipts/functions").update({ state });
  await expect(commitLiveReaderReceipt(db, input, { collect })).rejects.toThrow("not complete");
});

function adminAdapter() {
  let active: any = { manifestDigest: digest("a"), providerReceiptDigest: digest("b") };
  let writes = 0;
  const operations = new Map<string, any>();
  const adapter = { readLiveReaderIdentities: vi.fn(async () => identities()),
    readActiveManifest: vi.fn(async () => active),
    reconcileOperation: vi.fn(async request => {
      let operation = operations.get(request.operationId);
      if (!operation) {
        operation = { ...request, outcome: "not_written", providerSettled: true };
        operations.set(request.operationId, operation);
      }
      if (operation.operationDigest !== request.operationDigest) throw new Error("operation identity differs");
      return operation;
    }),
    publish: vi.fn(async request => {
      const prior = operations.get(request.operationId);
      if (prior) throw new Error("operation was already fenced or uploaded");
      writes++;
      active = { ...request, providerReceiptDigest: digest("c"), providerSettled: true };
      operations.set(request.operationId, { ...active, outcome: "uploaded" });
    }) };
  return { adapter, writes: () => writes, setActive: (value: any) => { active = value; } };
}
const adminRequest = (overrides = {}) => ({ operationId: "preview-admin", manifestDigest: digest("d"), expectedProviderReceiptDigest: digest("b"), ...overrides });
it("publishes once; completed retry returns its receipt after later selection", async () => {
  const { adapter } = adminAdapter();
  const first = await publishPairedAdminManifest(db, adminRequest(), adapter);
  expect(first.state).toBe("complete"); expect(adapter.publish).toHaveBeenCalledTimes(1);
  await db.doc(api.SELECTOR_PATH).set({ changed: true });
  expect(await publishPairedAdminManifest(db, adminRequest(), adapter)).toEqual(first);
  expect(adapter.publish).toHaveBeenCalledTimes(1);
  await expect(publishPairedAdminManifest(db, adminRequest({ manifestDigest: digest("e") }), adapter)).rejects.toThrow("identity conflicts");
});
it("records a same-content no-op without a provider write", async () => {
  const { adapter, setActive } = adminAdapter();
  setActive({ manifestDigest: digest("d"), providerReceiptDigest: digest("c") });
  const result = await publishPairedAdminManifest(db, adminRequest(), adapter);
  expect(result.mutated).toBe(false); expect(adapter.publish).not.toHaveBeenCalled();
});
it("reconciles a lost upload response without another write", async () => {
  const { adapter } = adminAdapter(); const publish = adapter.publish.getMockImplementation()!;
  adapter.publish.mockImplementationOnce(async request => { await publish(request); throw new Error("lost response"); });
  const prior = await current("cmsDeploymentReceipts/adminManifest");
  await expect(publishPairedAdminManifest(db, adminRequest(), adapter)).rejects.toThrow("reconcile");
  expect(await current("cmsDeploymentReceipts/adminManifest")).toEqual(prior);
  expect(await current()).toEqual(initial);
  expect((await publishPairedAdminManifest(db, adminRequest(), adapter)).state).toBe("complete");
  expect(adapter.publish).toHaveBeenCalledTimes(1);
});
it.each(["during", "after"])("permits routine reader-evidence refresh %s upload without wedging reconciliation", async when => {
  const { adapter } = adminAdapter(); const publish = adapter.publish.getMockImplementation()!;
  const refresh = async () => db.collection(api.READER_RECEIPTS).doc("functions").update({ "lastComplete.verifiedAt": new Date(now + 1_000).toISOString() });
  adapter.publish.mockImplementationOnce(async request => {
    await publish(request);
    if (when === "during") await refresh();
    else throw new Error("lost response");
  });
  if (when === "during") expect((await publishPairedAdminManifest(db, adminRequest(), adapter)).state).toBe("complete");
  else {
    await expect(publishPairedAdminManifest(db, adminRequest(), adapter)).rejects.toThrow("reconcile");
    await refresh();
    expect((await publishPairedAdminManifest(db, adminRequest(), adapter)).state).toBe("complete");
  }
  expect(adapter.publish).toHaveBeenCalledTimes(1);
});
it("releases a durably settled old upload after selection changes without certifying that Admin receipt", async () => {
  const { adapter } = adminAdapter(); const publish = adapter.publish.getMockImplementation()!;
  adapter.publish.mockImplementationOnce(async request => { await publish(request); throw new Error("lost response"); });
  const previous = await current("cmsDeploymentReceipts/adminManifest");
  await expect(publishPairedAdminManifest(db, adminRequest(), adapter)).rejects.toThrow("reconcile");
  const selected = { ...initial, epoch: 2, selectedPairId: next.pairId, recoveryPairId: old.pairId, rendererSha: next.rendererSha, serializerId: next.serializerId };
  await db.doc(api.SELECTOR_PATH).set(selected);
  await db.doc(api.RENDERER_RECEIPT_PATH).set({ schemaVersion: 2, component: "renderer", state: "complete",
    pairId: next.pairId, selectorDigest: api.digest(selected), lastComplete: candidate(next, now).mutation });
  await expect(publishPairedAdminManifest(db, adminRequest(), adapter)).rejects.toThrow("settled (cms_evidence_changed)");
  expect(await current("cmsDeploymentReceipts/adminManifest")).toEqual(previous);
  expect((await current("cmsAdminManifestState/writer")).state).toBe("settled");
  expect((await publishPairedAdminManifest(db, adminRequest({ operationId: "preview-current", manifestDigest: digest("e"), expectedProviderReceiptDigest: digest("c") }), adapter)).state).toBe("complete");
  expect(adapter.publish).toHaveBeenCalledTimes(2);
  expect(await current()).toEqual(selected);
});
it("releases a settled operation with unavailable readers without reporting a completed Admin deployment", async () => {
  const { adapter } = adminAdapter(); const publish = adapter.publish.getMockImplementation()!;
  adapter.publish.mockImplementationOnce(async request => { await publish(request); throw new Error("lost response"); });
  const previous = await current("cmsDeploymentReceipts/adminManifest");
  await expect(publishPairedAdminManifest(db, adminRequest(), adapter)).rejects.toThrow("reconcile");
  adapter.readLiveReaderIdentities.mockRejectedValue(new Error("unavailable"));
  await expect(publishPairedAdminManifest(db, adminRequest(), adapter)).rejects.toThrow("settled (reader_readback_unavailable)");
  expect((await current("cmsAdminManifestState/writer")).state).toBe("settled");
  expect(await current("cmsDeploymentReceipts/adminManifest")).toEqual(previous);
  expect(adapter.publish).toHaveBeenCalledTimes(1);
});
it("keeps an uncertain upload locked and forbids a second manifest or repeated write", async () => {
  const { adapter } = adminAdapter(); adapter.publish.mockRejectedValue(new Error("unknown outcome"));
  adapter.reconcileOperation.mockResolvedValue({ providerSettled: false });
  await expect(publishPairedAdminManifest(db, adminRequest(), adapter)).rejects.toThrow("reconcile");
  await expect(publishPairedAdminManifest(db, adminRequest(), adapter)).rejects.toThrow("reconcile");
  await expect(publishPairedAdminManifest(db, adminRequest({ operationId: "preview-other", manifestDigest: digest("e") }), adapter)).rejects.toThrow("unresolved");
  expect(adapter.publish).toHaveBeenCalledTimes(1); expect(await current()).toEqual(initial);
});
it.each(["receipt", "readback", "reader", "cancel"])("releases only its own unused upload permission after %s failure", async boundary => {
  const { adapter } = adminAdapter(); const controller = new AbortController();
  if (boundary === "receipt") adapter.readActiveManifest.mockResolvedValue({ manifestDigest: digest("a"), providerReceiptDigest: digest("e") });
  if (boundary === "readback") adapter.readActiveManifest.mockRejectedValueOnce(new Error("read unavailable"));
  if (boundary === "reader") adapter.readLiveReaderIdentities.mockResolvedValueOnce(identities()).mockResolvedValueOnce({ changed: true } as any);
  if (boundary === "cancel") adapter.readActiveManifest.mockImplementationOnce(async () => { controller.abort(); return { manifestDigest: digest("a"), providerReceiptDigest: digest("b") }; });
  await expect(publishPairedAdminManifest(db, adminRequest(), adapter, controller.signal)).rejects.toThrow("not uploaded");
  expect(adapter.publish).not.toHaveBeenCalled();
  expect((await current("cmsAdminManifestState/writer")).state).toBe("not_written");
  const fresh = adminAdapter().adapter;
  expect((await publishPairedAdminManifest(db, adminRequest({ operationId: "preview-recovered" }), fresh)).state).toBe("complete");
  await expect(publishPairedAdminManifest(db, adminRequest(), fresh)).rejects.toThrow("new operation");
});
it("does not consume permission on pre-cancel or fresh reader drift", async () => {
  const { adapter } = adminAdapter();
  await expect(publishPairedAdminManifest(db, adminRequest(), adapter, AbortSignal.abort())).rejects.toThrow();
  adapter.readLiveReaderIdentities.mockResolvedValue({ changed: true } as any);
  await expect(publishPairedAdminManifest(db, adminRequest(), adapter)).rejects.toThrow("identities changed");
  expect(await current("cmsAdminManifestState/writer")).toBeUndefined(); expect(adapter.publish).not.toHaveBeenCalled();
});
it("allows only one of two concurrent different manifest writers", async () => {
  const { adapter } = adminAdapter();
  const results = await Promise.allSettled([publishPairedAdminManifest(db, adminRequest(), adapter),
    publishPairedAdminManifest(db, adminRequest({ operationId: "preview-other", manifestDigest: digest("e") }), adapter)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(adapter.publish).toHaveBeenCalledTimes(1);
});
it("does not let a read-only retry release the original writer's in-flight permission", async () => {
  const { adapter } = adminAdapter(); const publish = adapter.publish.getMockImplementation()!;
  let proceed!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { proceed = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  adapter.publish.mockImplementationOnce(async request => { entered(); await waiting; await publish(request); });
  adapter.reconcileOperation.mockResolvedValueOnce({ providerSettled: false });
  const first = publishPairedAdminManifest(db, adminRequest(), adapter);
  await started;
  await expect(publishPairedAdminManifest(db, adminRequest(), adapter)).rejects.toThrow("reconcile");
  expect((await current("cmsAdminManifestState/writer")).state).toBe("reserved");
  await expect(publishPairedAdminManifest(db, adminRequest({ operationId: "preview-other" }), adapter)).rejects.toThrow("unresolved");
  proceed(); expect((await first).state).toBe("complete");
  expect(adapter.publish).toHaveBeenCalledTimes(1);
});
it("preserves a concurrent completed upload when a late read-only retry fails", async () => {
  const { adapter } = adminAdapter(); const publish = adapter.publish.getMockImplementation()!;
  let proceed!: () => void, entered!: () => void, failRead!: () => void, reading!: () => void;
  const waiting = new Promise<void>(resolve => { proceed = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const failed = new Promise<void>(resolve => { failRead = resolve; });
  const readStarted = new Promise<void>(resolve => { reading = resolve; });
  adapter.publish.mockImplementationOnce(async request => { entered(); await waiting; await publish(request); });
  const first = publishPairedAdminManifest(db, adminRequest(), adapter); await started;
  const reconcile = adapter.reconcileOperation.getMockImplementation()!;
  const retryAdapter = { ...adapter,
    reconcileOperation: async request => { reading(); await failed; return reconcile(request); },
    readActiveManifest: async () => { throw new Error("late read failure"); } };
  const retry = publishPairedAdminManifest(db, adminRequest(), retryAdapter); await readStarted;
  proceed(); const complete = await first; failRead();
  expect(await retry).toEqual(complete);
  expect((await current("cmsAdminManifestAttempts/preview-admin")).state).toBe("complete");
});
it("requires a durable operation fence before reserving an upload", async () => {
  const { adapter } = adminAdapter();
  await expect(publishPairedAdminManifest(db, adminRequest(), { ...adapter, reconcileOperation: undefined })).rejects.toThrow("durable operation fencing");
  expect(await current("cmsAdminManifestState/writer")).toBeUndefined(); expect(adapter.publish).not.toHaveBeenCalled();
});
it("recovers a killed permission holder by fencing its absent provider operation and rejecting its late upload", async () => {
  const { adapter, writes } = adminAdapter(); const publish = adapter.publish.getMockImplementation()!;
  let proceed!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { proceed = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  // The old caller has its durable permission but the provider has received no
  // operation. This is the persisted state after a process dies before upload.
  adapter.publish.mockImplementationOnce(async request => { entered(); await waiting; return publish(request); });
  const old = publishPairedAdminManifest(db, adminRequest(), adapter); await started;
  await expect(publishPairedAdminManifest(db, adminRequest(), adapter)).rejects.toThrow("durably fenced before upload");
  expect((await current("cmsAdminManifestState/writer")).state).toBe("not_written");
  expect(writes()).toBe(0);
  expect((await publishPairedAdminManifest(db, adminRequest({ operationId: "preview-recovery", manifestDigest: digest("e") }), adapter)).state).toBe("complete");
  const recovered = await adapter.readActiveManifest();
  proceed(); await expect(old).rejects.toThrow("new operation");
  expect(await adapter.readActiveManifest()).toEqual(recovered); expect(writes()).toBe(1);
});
it("refuses a fencing proof for another operation digest and keeps its writer reserved", async () => {
  const { adapter } = adminAdapter(); adapter.publish.mockRejectedValueOnce(new Error("unknown outcome"));
  await expect(publishPairedAdminManifest(db, adminRequest(), adapter)).rejects.toThrow("reconcile");
  adapter.reconcileOperation.mockResolvedValue({ operationId: "preview-admin", operationDigest: digest("f"), outcome: "not_written", providerSettled: true });
  await expect(publishPairedAdminManifest(db, adminRequest(), adapter)).rejects.toThrow("remains uncertain");
  expect((await current("cmsAdminManifestState/writer")).state).toBe("reserved");
});

function privateAdapter() {
  const readers = { functions: receipt("functions", now), cmsApi: receipt("cmsApi", now) };
  const state = { schemaVersion: 2, publicSelectorDigest: digest("a"),
    publicPairs: [old, next].map(value => ({ pairDigest: api.digest(value), requirements: value.requirements })), previewPairs: [old, next], readers };
  const adapter = { deployPrivate: vi.fn(async () => {}), readback: vi.fn(async () => candidate(next, now).mutation.providerIdentities),
    readLiveState: vi.fn(async () => state), replayDeployedReader: vi.fn(async ({ reader, state }: any) => ({ digest: digest("b"), readerDigest: api.digest(reader), stateDigest: api.digest(state) })),
    provePrivate: vi.fn(async () => ({ pairDigest: api.digest(next), savedInputsDigest: digest("c"),
      readerDigests: Object.fromEntries(Object.entries(readers).map(([key, value]) => [key, api.digest(value.lastComplete)])) as Record<"functions" | "cmsApi", string>,
      replays: { functionsOld: digest("b"), functionsNew: digest("b"), cmsApiOld: digest("b"), cmsApiNew: digest("b") } })) };
  return adapter;
}
const privateRequest = (adapter: ReturnType<typeof privateAdapter>, overrides = {}) => ({ firestore: db, pair: next,
  operationId: "preview-deploy", expectedSelectorDigest: api.digest(initial), candidate: attempt(), adapter, ...overrides });
it("creates an immutable offline private config with admission disabled", () => {
  const value = previewPairConfiguration(next, { main: "/app/runtime.js", image: `registry.cloudflare.com/account/image@${next.imageDigest}` });
  expect(value.vars.PREVIEW_RENDERER_ENABLED).toBe("false"); expect(value.workers_dev).toBe(false);
  expect(value.containers[0].max_instances).toBe(1);
  expect(() => previewPairConfiguration(next, { main: "/app/runtime.js", image: "registry.cloudflare.com/account/image:latest" })).toThrow("immutable");
});
it("qualifies NEW without selecting or pausing; retries return the durable original proof", async () => {
  const adapter = privateAdapter();
  const first = await deployPreviewPairRuntime(privateRequest(adapter));
  expect(first.proofDigest).toMatch(/^[a-f0-9]{64}$/); expect(await current()).toEqual(initial);
  await db.doc(api.SELECTOR_PATH).set({ changed: true });
  expect(await deployPreviewPairRuntime(privateRequest(adapter))).toEqual(first);
  expect(adapter.deployPrivate).toHaveBeenCalledTimes(1); expect(adapter.provePrivate).toHaveBeenCalledTimes(1);
  await expect(deployPreviewPairRuntime(privateRequest(adapter, { candidate: { ...attempt(), runId: "101" } }))).rejects.toThrow("conflicts");
});
it("the real qualifier records a third-incarnation proof after closed recovery drains, across compatible reader SHAs", async () => {
  const third = pair("third", "c"), adapter = privateAdapter();
  const readers = await installClosureReaders(db, now), state = await adapter.readLiveState();
  for (const [component, value] of Object.entries(readers)) state.readers[component as "functions" | "cmsApi"].lastComplete = value;
  adapter.readback.mockImplementation(async () => candidate(third, now).mutation.providerIdentities);
  const originalProof = adapter.provePrivate.getMockImplementation()!;
  adapter.provePrivate.mockImplementation(async () => ({ ...await originalProof(), pairDigest: api.digest(third),
    readerDigests: Object.fromEntries(Object.entries(readers).map(([key, value]) => [key, api.digest(value)])) as Record<"functions" | "cmsApi", string> }));
  const request = { ...privateRequest(adapter), pair: third, candidate: { ...attempt(), sourceSha: third.rendererSha } };
  await expect(deployPreviewPairRuntime(request)).rejects.toThrow();
  expect(adapter.deployPrivate).not.toHaveBeenCalled(); expect(await current()).toEqual(initial);
  const closure = createRequire(import.meta.url)("../../functions/lib/cms-preview-pair-reader-closure.js");
  await closure.closeRecoveryReaderIssuance(db, { operationId: "preview-close-recovery", expectedSelectorDigest: api.digest(initial), pairId: next.pairId });
  const qualified = await deployPreviewPairRuntime(request);
  expect(qualified.proofDigest).toMatch(/^[a-f0-9]{64}$/); expect(adapter.deployPrivate).toHaveBeenCalledOnce();
  expect(await current()).toEqual(initial);
  const selected = await api.selectPair(db, qualified);
  expect(selected.selector).toMatchObject({ selectedPairId: third.pairId, recoveryPairId: old.pairId });
  expect(selected.retirement.pairId).toBe(next.pairId);
  await expect(deployPreviewPairRuntime(privateRequest(adapter, { operationId: "preview-displaced-retry",
    candidate: { ...attempt(), runId: "102" }, expectedSelectorDigest: api.digest(selected.selector) }))).rejects.toThrow("Closed preview incarnation");
  expect(adapter.deployPrivate).toHaveBeenCalledOnce();
});
it("a closed recovery incarnation refuses before reserving a provider mutation", async () => {
  const adapter = privateAdapter(), closure = createRequire(import.meta.url)("../../functions/lib/cms-preview-pair-reader-closure.js");
  await installClosureReaders(db, now);
  await closure.closeRecoveryReaderIssuance(db, { operationId: "preview-close-recovery", expectedSelectorDigest: api.digest(initial), pairId: next.pairId });
  await expect(deployPreviewPairRuntime(privateRequest(adapter))).rejects.toThrow("Closed preview incarnation");
  expect(adapter.deployPrivate).not.toHaveBeenCalled();
  expect((await db.doc("cmsPreviewPairRollouts/preview-deploy").get()).exists).toBe(false);
  expect(await current()).toEqual(initial);
});
it("does not consume a private attempt on pre-cancel", async () => {
  const adapter = privateAdapter();
  await expect(deployPreviewPairRuntime(privateRequest(adapter, { signal: AbortSignal.abort() }))).rejects.toThrow();
  expect(await current("cmsPreviewPairRollouts/preview-deploy")).toBeUndefined(); expect(adapter.deployPrivate).not.toHaveBeenCalled();
});
it("reconciles lost private deployment response with readback only", async () => {
  const adapter = privateAdapter(); adapter.deployPrivate.mockRejectedValueOnce(new Error("lost response"));
  await expect(deployPreviewPairRuntime(privateRequest(adapter))).rejects.toThrow("reconcile");
  expect((await deployPreviewPairRuntime(privateRequest(adapter))).proofDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(adapter.deployPrivate).toHaveBeenCalledTimes(1); expect(await current()).toEqual(initial);
});
it("retains the selector and consumes no new write after cancellation following permission", async () => {
  const adapter = privateAdapter(); const controller = new AbortController();
  adapter.deployPrivate.mockImplementationOnce(async () => { controller.abort(); });
  await expect(deployPreviewPairRuntime(privateRequest(adapter, { signal: controller.signal }))).rejects.toThrow("reconcile");
  expect(await current()).toEqual(initial);
  await deployPreviewPairRuntime(privateRequest(adapter)); expect(adapter.deployPrivate).toHaveBeenCalledTimes(1);
});
it("refuses a proof bound to another reader and leaves OLD selected", async () => {
  const adapter = privateAdapter(); const prove = adapter.provePrivate.getMockImplementation()!;
  adapter.provePrivate.mockImplementation(async () => ({ ...await prove(), readerDigests: { functions: digest("e"), cmsApi: digest("e") } }));
  await expect(deployPreviewPairRuntime(privateRequest(adapter))).rejects.toThrow("reconcile");
  expect(await current()).toEqual(initial); expect((await db.collection(api.PROOFS).get()).empty).toBe(true);
});
it("refuses a missing durable private attempt at completion", async () => {
  const adapter = privateAdapter(); const prove = adapter.provePrivate.getMockImplementation()!;
  adapter.provePrivate.mockImplementationOnce(async () => {
    await db.doc("cmsPreviewPairRollouts/preview-deploy").delete(); return prove();
  });
  await expect(deployPreviewPairRuntime(privateRequest(adapter))).rejects.toThrow("attempt_commit");
  expect(await current()).toEqual(initial);
});
