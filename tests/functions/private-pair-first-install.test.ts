import { beforeAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { firstInstallScenario, compile } from "../helpers/private-pair-first-install.mjs";
import { installPrivatePairPublisher } from "../../scripts/lib/private-pair-publisher-install.mjs";
import { completePrivatePairPublisherInstall } from "../../scripts/lib/private-pair-first-install-completion.mjs";
import { installPrivatePublicRelease } from "../../scripts/install-private-public-release.mjs";
import { privateInstallLedger } from "../../scripts/lib/public-release-private-install-ledger.mjs";
import { privatePublicReleaseSlotTarget } from "../../scripts/lib/private-public-release-slot-target.mjs";
import protocol from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import rollout from "../../functions/lib/public-release-pair-rollout.js";
import serving from "../../functions/lib/public-release-serving.js";
import { readPrivatePairRecord } from "../../publisher/pair-work-reader";
import slotWorker, { PublicReleaseSlotEntrypoint } from "../../workers/src/public-release-slot-worker";
import { releaseSelector } from "../helpers/private-public-release-pair.js";
import { PAIR_READER_PATH } from "../../packages/content-core/src/private-pair-http";
import { preparePrivatePublicReleaseSlots } from "../../scripts/prepare-private-public-release-slots.mjs";

let db: ReturnType<typeof isolatedFirestore>, signing: Awaited<ReturnType<typeof generateKeyPair>>, jwk: any;
beforeAll(async () => {
  db = isolatedFirestore("private-pair-first-install.test.ts");
  signing = await generateKeyPair("RS256"); jwk = { ...await exportJWK(signing.publicKey), kid: "first-install", alg: "RS256" };
});
beforeEach(async () => { await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db); });
afterEach(() => vi.unstubAllGlobals());

async function uploaded(options: Record<string, boolean> = {}) {
  const scenario = await firstInstallScenario(); Object.assign(scenario.faults, options);
  const uploads = [];
  for (let index = 0; index < 2; index++) uploads.push(await installPrivatePairPublisher({ ...scenario.publisherInput(db, index), uploadOnly: true }));
  const partial = scenario.slotPlan();
  partial.oldPair = scenario.intents[0].plan.pairTemplate; partial.newPair = scenario.intents[1].plan.pairTemplate;
  const plan = await preparePrivatePublicReleaseSlots({ template: { schemaVersion: 1, kind: "private-pair-first-install-slots",
    installPlan: partial, publisherPlans: scenario.intents.map((intent: any) => intent.plan) }, uploads, compile });
  const runSlots = () => installPrivatePublicRelease({ plan, ledger: privateInstallLedger(db), provider: scenario.provider, compile, dryRun: false });
  const complete = (index = 0, overrides: Record<string, any> = {}) => completePrivatePairPublisherInstall({ firestore: db,
    plan: scenario.intents[index].plan, installPlan: plan, readToken: scenario.readToken, fetchImpl: scenario.fetchImpl, compile, authorized: true, ...overrides });
  return { ...scenario, plan, runSlots, complete };
}

it("composes native publisher/slot owners with four distinct assigned UUIDs and one immutable final identity", async () => {
  const current = await uploaded();
  expect(current.effects).toHaveLength(4);
  for (const intent of current.intents) {
    expect((await db.doc(work.publicReleasePairPath(intent.plan.pairTemplate.pairId)).get()).exists).toBe(false);
    const indexed = (await db.doc("system/publicReleasePairUploads").get()).data()!.plans;
    expect(indexed.find((plan: any) => plan.pairTemplate.pairId === intent.plan.pairTemplate.pairId).pairTemplate).not.toHaveProperty("readerReceiptDigest");
    expect(intent.plan.pairTemplate.publicWorker).not.toHaveProperty("versionId");
    expect(intent.plan.pairTemplate.publisher).not.toHaveProperty("workerVersionId");
  }
  const installed = await current.runSlots();
  const assigned = installed.pairs.flatMap((pair: any) => [pair.publicWorker.versionId, pair.publisher.workerVersionId]);
  expect(new Set(assigned).size).toBe(4);
  for (let index = 0; index < 2; index++) {
    const completed = await current.complete(index), pair = installed.pairs[index];
    expect(completed.pair).toEqual(pair);
    const stored = (await db.doc(work.publicReleasePairPath(pair.pairId)).get()).data();
    expect(stored).toEqual(pair);
    const seal = (await db.doc(rollout.publicReleasePairUploadCompletionPath(pair.pairId)).get()).data()!;
    expect(seal.pair).toEqual(pair); expect(seal.planDigest).toBe(protocol.publicReleaseDigest(current.intents[index].plan));
    const result = await installPrivatePairPublisher(current.publisherInput(db, index));
    expect(result.pair).toEqual(pair); expect(result.runtime.ready).toBe(true);
    const target = privatePublicReleaseSlotTarget({ pair, installPlan: current.plan });
    const embedded = JSON.parse(current.workers.get(pair.publicWorker.service).metadata.bindings.find((binding: any) => binding.name === "PUBLIC_PAIR_IDENTITY_JSON").text);
    expect(embedded.publisher.workerVersionId).toBe(pair.publisher.workerVersionId);
    expect(embedded.publicWorker.versionId).toBeUndefined(); expect(embedded.readerReceiptDigest).toBeUndefined();
    expect(target.pair).toEqual(pair);
    expect(await rollout.readPublicReleasePairUploadPair({ firestore: db, plan: current.intents[index].plan,
      workerVersionId: pair.publisher.workerVersionId })).toEqual(pair);
  }
  const ingress = current.workers.get(current.plan.ingressName);
  expect(JSON.parse(ingress.metadata.bindings.find((binding: any) => binding.name === "PUBLIC_PAIR_IDENTITIES_JSON").text)).toEqual(installed.pairs);
  const before = current.effects.length;
  expect(await current.runSlots()).toEqual(installed);
  for (let index = 0; index < 2; index++) {
    expect((await current.complete(index)).idempotent).toBe(true);
    expect((await installPrivatePairPublisher(current.publisherInput(db, index))).pair).toEqual(installed.pairs[index]);
  }
  expect(current.effects).toHaveLength(before);
  expect((await db.doc("system/publicDeployment").get()).exists).toBe(false);
  expect((await db.doc("system/publicReleaseAdmissions/controls/adoption").get()).exists).toBe(false);
});

it("leaves no usable half pair after slot deployment and resumes the same original effects", async () => {
  const current = await uploaded(), installed = await current.runSlots(), pair = installed.pairs[0];
  const target = privatePublicReleaseSlotTarget({ pair, installPlan: current.plan });
  const identity = { pairId: pair.pairId, commitSha: pair.commitSha, environment: pair.environment, journalNamespace: pair.publisher.journalNamespace };
  const read = async (path: string) => (await db.doc(path).get()).data();
  // The actual publisher record reader refuses the absent immutable registry;
  // slot HTTP and installation exercise this same native trust boundary.
  const readPublisher = async (supplied: unknown) => {
    const registered = await readPrivatePairRecord({ read } as any, identity, pair.publisher.workerVersionId);
    expect(registered).toEqual(supplied);
    throw new Error("Publisher is uploaded but not deployed");
  };
  const env: any = { ...target.config.vars, PAIR_WORKER_VERSION: { id: pair.publicWorker.versionId }, PAIR_CONTENT: {},
    PAIR_READER: { readerInstallation: readPublisher, readPrivatePair: (_request: Request, supplied: unknown) => readPublisher(supplied) },
    CMS_API: { getReleaseDecision: (selection: any, value: any, path: string) => serving.readPublicReleaseDecision({ firestore: db,
      environment: "development", selection, pair: value, path }) } };
  const entry = Object.create(PublicReleaseSlotEntrypoint.prototype); entry.env = env;
  const selector = releaseSelector(); selector.selectedPair = protocol.publicReleasePairReference(pair);
  selector.recoveryPair = protocol.publicReleasePairReference(installed.pairs[1]); selector.contentHead.pairId = pair.pairId;
  await expect(entry.serve(new Request("https://dev-public.example.org/"), { environment: "development", selector, readStartedAt: Date.now() }, pair)).rejects.toThrow();
  await expect(entry.readerInstallation()).rejects.toThrow();
  vi.stubGlobal("fetch", async () => Response.json({ keys: [jwk] }));
  const now = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({ iss: "https://fixture.cloudflareaccess.com", aud: ["a".repeat(64)], type: "app", sub: "",
    common_name: "reader123.access", iat: now, exp: now + 60 }).setProtectedHeader({ alg: "RS256", kid: "first-install" }).sign(signing.privateKey);
  const response = await slotWorker.fetch(new Request(`${env.PAIR_PRIVATE_ORIGIN}${PAIR_READER_PATH}`, { method: "POST",
    headers: { "cf-access-jwt-assertion": jwt, "content-type": "application/json", "content-length": "2" }, body: "{}" }), env);
  expect(response.status).toBe(503);
  const before = current.effects.length;
  await expect(installPrivatePairPublisher(current.publisherInput(db, 0))).rejects.toThrow();
  expect(current.effects).toHaveLength(before);
  expect((await db.doc(work.publicReleasePairPath(pair.pairId)).get()).exists).toBe(false);
  await current.complete(0);
  expect((await installPrivatePairPublisher(current.publisherInput(db, 0))).pair).toEqual(pair);
  expect(current.effects.slice(before).map((effect: any) => effect.path)).toEqual([
    `/workers/scripts/${pair.publisher.application}/deployments`, "/containers/applications" ]);
});

it("reconciles lost publisher and slot upload replies without allocating a second version", async () => {
  const current = await uploaded({ losePublisherUpload: true, loseSlotUpload: true });
  const installed = await current.runSlots(); await current.runSlots();
  await current.complete(); await current.complete();
  const uploads = current.effects.filter((effect: any) => effect.method === "POST" && effect.path.endsWith("/versions"));
  expect(uploads).toHaveLength(5); // two publishers, two slots, one ingress
  expect((await installPrivatePairPublisher(current.publisherInput(db, 0))).pair).toEqual(installed.pairs[0]);
});

it("never resends an absent ambiguous publisher upload or registers a placeholder", async () => {
  const current = await firstInstallScenario(); current.faults.pendingPublisherUpload = true;
  const run = () => installPrivatePairPublisher({ ...current.publisherInput(db, 0), uploadOnly: true });
  await expect(run()).rejects.toMatchObject({ code: "operation-readback-pending" });
  const before = current.effects.length; await expect(run()).rejects.toThrow();
  expect(current.effects).toHaveLength(before);
  expect((await db.doc(work.publicReleasePairPath(current.intents[0].plan.pairTemplate.pairId)).get()).exists).toBe(false);
});

it.each(["publisher", "origin", "slot-source", "slot-config", "operation"])("refuses mismatched %s before completion/registration/publisher deployment", async fault => {
  const current = await uploaded(); await current.runSlots();
  const plan = structuredClone(current.plan);
  if (fault === "publisher") plan.oldPair.publisher.workerVersionId = current.plan.newPair.publisher.workerVersionId;
  if (fault === "origin") plan.readerOrigins[0] = "https://wrong.example.test";
  if (fault === "slot-source") plan.slotBundleDigest = "f".repeat(64);
  if (fault === "slot-config") current.faults.wrongSlotConfig = true;
  if (fault === "operation") plan.operationId = "replacement-original";
  const before = current.effects.length;
  await expect(current.complete(0, { installPlan: plan })).rejects.toThrow();
  expect(current.effects).toHaveLength(before);
  const pairId = current.intents[0].plan.pairTemplate.pairId;
  expect((await db.doc(rollout.publicReleasePairUploadCompletionPath(pairId)).get()).exists).toBe(false);
  expect((await db.doc(work.publicReleasePairPath(pairId)).get()).exists).toBe(false);
});

it("preserves the original immutable completion after registration and refuses a replacement identity", async () => {
  const current = await uploaded(), installed = await current.runSlots(); await current.complete();
  const plan = current.intents[0].plan, path = rollout.publicReleasePairUploadCompletionPath(plan.pairTemplate.pairId);
  const completed = (await db.doc(path).get()).data()!;
  await expect(rollout.completePublicReleasePairUpload({ firestore: db, plan,
    pair: { ...installed.pairs[0], publicWorker: { ...installed.pairs[0].publicWorker, versionId: installed.pairs[1].publicWorker.versionId } },
    installation: completed.installation })).rejects.toThrow();
  expect((await db.doc(path).get()).data()).toEqual(completed);
  await expect(work.registerPublicReleasePair({ firestore: db, pair: { ...installed.pairs[0], readerReceiptDigest: "f".repeat(64) } })).rejects.toThrow();
});

it.each([false, true])("reconciles a crash at registration (write committed: %s) without another provider effect", async committed => {
  const current = await uploaded(); await current.runSlots();
  const register = work.registerPublicReleasePair;
  const failure = vi.spyOn(work, "registerPublicReleasePair").mockImplementationOnce(async input => {
    if (committed) await register(input);
    throw new Error("Lost registration completion");
  });
  try { await expect(current.complete()).rejects.toThrow(); } finally { failure.mockRestore(); }
  const pairId = current.intents[0].plan.pairTemplate.pairId;
  expect((await db.doc(rollout.publicReleasePairUploadCompletionPath(pairId)).get()).exists).toBe(true);
  expect((await db.doc(work.publicReleasePairPath(pairId)).get()).exists).toBe(committed);
  const before = current.effects.length;
  const completed = await current.complete(); expect(completed.pair.pairId).toBe(pairId);
  expect(current.effects).toHaveLength(before);
});

it("rejects a copied publisher UUID or changed original slot plan before any slot effect", async () => {
  const current = await uploaded(); current.plan.oldPair.publisher.workerVersionId = current.plan.newPair.publisher.workerVersionId;
  const before = current.effects.length;
  await expect(current.runSlots()).rejects.toThrow();
  expect(current.effects).toHaveLength(before);
  expect((await db.doc(`system/publicReleasePrivateInstalls/plans/${current.plan.operationId}`).get()).exists).toBe(false);
});
