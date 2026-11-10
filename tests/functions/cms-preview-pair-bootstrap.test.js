import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { beforeEach, expect, it } from "vitest";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { pair, receipt, candidate, proof } from "../helpers/cms-preview-pairs.js";
const require = createRequire(import.meta.url);
const exec = promisify(execFile);
const api = require("../../functions/lib/cms-preview-pair.js");
const bootstrap = require("../../functions/lib/cms-preview-pair-bootstrap.js");
const { enqueuePreview } = require("../../functions/preview.js");
const db = isolatedFirestore("cms-preview-bootstrap");
const now = Date.now(), old = pair("old"), next = pair("new", "b");
const legacy = { schemaVersion: 1, phase: "paused", rendererSha: old.rendererSha, serializerId: "cloudflare-preview" };
const guardDigest = "9".repeat(64);
let identity, input;
const providerCandidate = (value, runId) => {
  const result = candidate(value, now);
  result.mutation.runId = runId;
  Object.assign(result.mutation.providerIdentities, { applicationId: `application-${value.pairId}`, workerDeploymentId: `deployment-${value.pairId}` });
  return result;
};
const prepareInstalledConsumers = async () => ({ digest: guardDigest, assertCurrentInTransaction: async ({ transaction }) => {
  const row = await transaction.get(db.doc("bootstrapConsumerProof/current"));
  return row.data()?.digest;
} });
const options = () => ({ firestore: db, request: input, clock: () => now, prepareInstalledConsumers });
const current = async () => (await db.doc(api.SELECTOR_PATH).get()).data();
const assertUnchanged = async () => {
  expect(await current()).toEqual(legacy);
  expect((await db.collection(bootstrap.RECEIPTS).get()).empty).toBe(true);
  expect((await db.doc(api.RENDERER_RECEIPT_PATH).get()).exists).toBe(false);
};
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
  await api.registerPair(db, old); await api.registerPair(db, next);
  await db.doc(api.SELECTOR_PATH).set(legacy);
  for (const component of ["functions", "cmsApi", "renderer"]) {
    await db.doc(`cmsDeploymentReceipts/${component}`).set({ schemaVersion: 1, component, state: "complete", mutation: { sourceSha: old.rendererSha } });
    if (component !== "renderer") await db.doc(`${api.READER_RECEIPTS}/${component}`).set(receipt(component, now));
  }
  await db.doc("cmsDeploymentCandidates/renderer-99-1").set(providerCandidate(old, "99"));
  const newCandidate = providerCandidate(next, "100");
  await db.doc("cmsDeploymentCandidates/renderer-100-1").set(newCandidate);
  const evidence = proof(old, next, now);
  evidence.providerReadbackDigest = api.digest(newCandidate.mutation.providerIdentities);
  const proofDigest = await api.recordProof(db, evidence);
  await db.doc("bootstrapConsumerProof/current").set({ digest: guardDigest });
  identity = { operationId: "preview-install", oldPairId: old.pairId, newPairId: next.pairId, oldCandidateReceiptId: "renderer-99-1", proofDigest };
  input = (await bootstrap.planCmsPreviewBootstrap({ firestore: db, identity, clock: () => now, prepareInstalledConsumers })).request;
});

it("plans and dry-runs without writes, installs current OLD atomically, then proves the original receipt", async () => {
  const before = await db.collection("cmsDeploymentReceipts").get();
  expect(await bootstrap.dryRunCmsPreviewBootstrap(options())).toMatchObject({ disposition: "ready-to-install", selector: { selectedPairId: old.pairId } });
  await assertUnchanged();
  const installed = await bootstrap.applyCmsPreviewBootstrap(options());
  expect(await current()).toEqual(installed.selector);
  expect(installed.selector).toMatchObject({ schemaVersion: 2, phase: "ready", epoch: 1, selectedPairId: old.pairId, recoveryPairId: next.pairId, rendererSha: legacy.rendererSha });
  expect((await db.doc(api.RENDERER_RECEIPT_PATH).get()).data()).toMatchObject({ pairId: old.pairId, selectorDigest: installed.selectorDigest });
  expect((await db.collection("cmsDeploymentReceipts").get()).docs.map(row => row.data())).toEqual(before.docs.map(row => row.data()));
  expect(await bootstrap.dryRunCmsPreviewBootstrap({ ...options(), prepareInstalledConsumers: undefined })).toMatchObject({ disposition: "already-installed", receipt: installed });
});

it("returns the original result after proof expiry or a later NEW switch without rewinding selection", async () => {
  const original = await bootstrap.applyCmsPreviewBootstrap(options());
  await api.selectPair(db, { operationId: "preview-later", expectedSelectorDigest: original.selectorDigest, newPairId: next.pairId, proofDigest: identity.proofDigest }, now);
  const advanced = await current();
  const retry = { ...options(), clock: () => now + 1_000_000, prepareInstalledConsumers: undefined };
  expect(await bootstrap.applyCmsPreviewBootstrap(retry)).toEqual(original);
  expect(await bootstrap.dryRunCmsPreviewBootstrap(retry)).toMatchObject({ disposition: "advanced", receipt: original });
  expect((await bootstrap.planCmsPreviewBootstrap({ firestore: db, identity })).receipt).toEqual(original);
  expect(await current()).toEqual(advanced);
  await expect(bootstrap.applyCmsPreviewBootstrap({ ...retry, request: { ...input, installedConsumerDigest: "8".repeat(64) } })).rejects.toMatchObject({ code: "receipt-conflict" });
});

it("accepts the existing saved-preview request contract on OLD after the initial CAS", async () => {
  await db.doc("cmsPages/contact").set({ title: "Saved", description: "Saved page", template: "genericPage", status: "draft",
    blocks: [{ id: "divider", type: "divider", order: 0, visible: true, data: {} }], version: 7 });
  const fields = { actor: { uid: "staff", principal: { id: "staff", grants: [{ role: "admin" }] } },
    collection: "cmsPages", pageId: "contact", sourceVersion: 7, persistent: false };
  const dependencies = { firestore: db, getTransport: () => "serializer", serializerReady: true,
    getRendererSha: () => old.rendererSha, assertBillingEnabledFn: async () => true, now: () => now };
  await expect(enqueuePreview(fields, dependencies)).rejects.toMatchObject({ status: 503 });
  await bootstrap.applyCmsPreviewBootstrap(options());
  const accepted = await enqueuePreview(fields, dependencies);
  expect(accepted).toMatchObject({ previewPairId: old.pairId, rendererSha: legacy.rendererSha });
  expect((await db.doc(`cmsPreviewQueue/${accepted.queueId}`).get()).data()).toMatchObject({
    previewPairId: old.pairId, serializerId: old.serializerId, previewEpoch: 1, previewRequestContract: 1, snapshot: { version: 7 },
  });
});

it.each(["pending", "building"])("refuses outstanding legacy %s rows, never transfers their claims", async status => {
  const row = { transport: "serializer", status, serializerId: legacy.serializerId, claimToken: "original-claim" };
  await db.doc("cmsPreviewQueue/outstanding").set(row);
  await expect(bootstrap.applyCmsPreviewBootstrap(options())).rejects.toMatchObject({ code: "legacy-queue-not-drained" });
  await assertUnchanged();
  expect((await db.doc("cmsPreviewQueue/outstanding").get()).data()).toEqual(row);
});

it.each([legacy.serializerId, old.serializerId, next.serializerId])("requires %s journal empty or absent", async serializerId => {
  await db.doc(`cmsPreviewSerializerJournals/${serializerId}`).set({ schemaVersion: 1, serializerId, job: { queueId: "original" } });
  await expect(bootstrap.applyCmsPreviewBootstrap(options())).rejects.toMatchObject({ code: "legacy-journal-not-drained" });
  await assertUnchanged();
  await db.doc(`cmsPreviewSerializerJournals/${serializerId}`).set({ schemaVersion: 1, serializerId, job: null });
  await expect(bootstrap.applyCmsPreviewBootstrap(options())).resolves.toMatchObject({ selector: { selectedPairId: old.pairId } });
});

it.each(["runtime", "functions", "cmsApi", "renderer", "reader", "oldCandidate", "newCandidate", "proof", "guard", "selected"])("refuses changed %s at the original CAS", async boundary => {
  const paths = { runtime: api.SELECTOR_PATH, functions: "cmsDeploymentReceipts/functions", cmsApi: "cmsDeploymentReceipts/cmsApi",
    renderer: "cmsDeploymentReceipts/renderer", reader: `${api.READER_RECEIPTS}/functions`, oldCandidate: "cmsDeploymentCandidates/renderer-99-1",
    newCandidate: "cmsDeploymentCandidates/renderer-100-1", proof: `${api.PROOFS}/${identity.proofDigest}`, guard: "bootstrapConsumerProof/current", selected: api.RENDERER_RECEIPT_PATH };
  const ref = db.doc(paths[boundary]);
  if (boundary === "runtime") await ref.update({ phase: "ready" });
  else if (boundary === "guard") await ref.update({ digest: "8".repeat(64) });
  else if (boundary === "selected") await ref.set({ unexpected: true });
  else await ref.delete();
  const before = await current();
  await expect(bootstrap.applyCmsPreviewBootstrap(options())).rejects.toThrow();
  expect(await current()).toEqual(before);
  expect((await db.collection(bootstrap.RECEIPTS).get()).empty).toBe(true);
});

it("rejects an expired proof and an unbound consumer bridge", async () => {
  await expect(bootstrap.applyCmsPreviewBootstrap({ ...options(), clock: () => now + 300_001 })).rejects.toMatchObject({ code: "pair-proof-expired" });
  await expect(bootstrap.applyCmsPreviewBootstrap({ ...options(), prepareInstalledConsumers: undefined })).rejects.toMatchObject({ code: "installed-consumer-guard-unbound" });
  await assertUnchanged();
});

it("cancels before preparation and at the last guard without partially installing", async () => {
  const signal = AbortSignal.abort();
  await expect(bootstrap.applyCmsPreviewBootstrap({ ...options(), signal })).rejects.toThrow();
  const controller = new AbortController();
  await expect(bootstrap.applyCmsPreviewBootstrap({ ...options(), signal: controller.signal, prepareInstalledConsumers: async () => ({
    digest: guardDigest, assertCurrentInTransaction: async () => { controller.abort(); return guardDigest; },
  }) })).rejects.toThrow();
  await assertUnchanged();
});

it("serializes concurrent installs with one receipt, preserving exact retry", async () => {
  const results = await Promise.allSettled([bootstrap.applyCmsPreviewBootstrap(options()), bootstrap.applyCmsPreviewBootstrap({ ...options(), request: { ...input, operationId: "preview-racer" } })]);
  expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1);
  expect((await db.collection(bootstrap.RECEIPTS).get()).size).toBe(1);
  expect((await current()).epoch).toBe(1);
});

it("runs the explicit emulator operator before/after apply and never imports a mismatched adapter", async () => {
  const dir = await mkdtemp(join(tmpdir(), "preview-bootstrap-"));
  try {
    const requestPath = join(dir, "request.json"), adapterPath = join(dir, "guard.mjs"), sentinel = join(dir, "imported");
    const adapter = `export async function prepareInstalledConsumers() { return { digest: '${guardDigest}', assertCurrentInTransaction: async ({firestore, transaction}) => (await transaction.get(firestore.doc('bootstrapConsumerProof/current'))).data().digest }; }`;
    const hash = value => createHash("sha256").update(value).digest("hex");
    await writeFile(requestPath, JSON.stringify(input)); await writeFile(adapterPath, adapter);
    const cli = resolve("scripts/bootstrap-cms-preview-pair.cjs");
    const command = (mode, extra = [adapterPath, hash(adapter)], project = db.projectId) => exec(process.execPath,
      [cli, mode, project, requestPath, ...extra], { env: { ...process.env, METADATA_SERVER_DETECTION: "none" } });
    expect(JSON.parse((await command("dry-run")).stdout).disposition).toBe("ready-to-install");
    await expect(command("apply", [])).rejects.toMatchObject({ code: 1, stderr: "Preview bootstrap refused: installed-consumer-guard-unbound.\n" });
    await assertUnchanged();
    const installed = JSON.parse((await command("apply")).stdout);
    expect(installed.selector.selectedPairId).toBe(old.pairId);
    expect(JSON.parse((await command("receipt", [])).stdout).receipt).toEqual(installed);
    const trap = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'imported'); export const prepareInstalledConsumers = () => {};`;
    await writeFile(adapterPath, trap);
    await expect(command("dry-run", [adapterPath, "0".repeat(64)])).rejects.toMatchObject({ code: 1 });
    await expect(command("apply", [adapterPath, hash(trap)], "njpbs-site")).rejects.toMatchObject({ code: 1 });
    await expect(command("apply", [adapterPath, hash(trap)], "njpbs-site-dev")).rejects.toMatchObject({ code: 1 });
    await expect(access(sentinel)).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 20_000);
