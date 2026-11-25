import { beforeAll, beforeEach, afterAll, expect, it, vi } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { installPrivatePublicRelease, compilePrivateWorker } from "../../scripts/install-private-public-release.mjs";
import { cloudflarePrivatePairProvider, PrivateProviderNotSent, workerReadbackAfterWrite } from "../../scripts/lib/public-release-private-provider.mjs";
import { privateInstallLedger } from "../../scripts/lib/public-release-private-install-ledger.mjs";
import { releasePair } from "../helpers/private-public-release-pair.js";
import { sealedPair } from "../helpers/sealed-public-release-pair";
import protocol from "../../functions/lib/public-release-pair.js";
import { PAIR_READER_CONTRACT } from "../../packages/content-core/src/private-pair-http";
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const slotSource = new TextEncoder().encode("export default {fetch(){return new Response(null,{status:404})}}"), ingressSource = new TextEncoder().encode("export default {fetch(){return new Response(null,{status:404})}} // ingress");
const compile = async (main: string) => main.includes("-slot-") ? slotSource : ingressSource;
let app: ReturnType<typeof initializeApp>, db: Firestore, provider: any, plan: any, records: Map<string, any>, workers: Map<string,any>, counter: number;
beforeAll(() => {
  if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? "")) throw new Error("Use assigned demo emulator");
  app = initializeApp({ projectId: "demo-layer4-private-install" }, "layer4-private-install"); db = getFirestore(app);
});
afterAll(async () => { await deleteApp(app); });
beforeEach(async () => {
  await db.recursiveDelete(db.collection("system")); records = new Map(); workers=new Map(); counter = 0;
  plan = { schemaVersion: 1, operationId: "private-install-one", accountId: "a".repeat(32), ingressName: "njpbs-private-ingress-development",
    oldPair: sealedPair("https://reader-old.example.test").pair,
    newPair: sealedPair("https://reader-new.example.test", releasePair("b", "b".repeat(40))).pair,
    readerOrigins: ["https://reader-old.example.test", "https://reader-new.example.test"],
    readerAccess: [{ enabled: false, audience: "", clientId: "" }, { enabled: false, audience: "", clientId: "" }],
    slotEnabled: [false, false],
    slotBundleDigest: hash(slotSource), ingressBundleDigest: hash(ingressSource) };
  const id = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
  provider = {
    worker:vi.fn(async(name:string)=>workers.get(name)??null),
    create:vi.fn(async(name:string,tag:string)=>{if(workers.has(name))throw new Error("Duplicate create");
      workers.set(name,{id:createHash("md5").update(name).digest("hex"),name,tags:[`private-pair:${tag}`],subdomain:{enabled:false,previews_enabled:false}});}),
    versions: vi.fn(async (name: string) => records.has(name) ? [records.get(name).version] : []),
    upload: vi.fn(async (name: string, metadata: any, source: Uint8Array) => { if(!workers.has(name)||workers.get(name).subdomain.enabled!==false)throw new Error("Uncreated or exposed parent");const versionId = id();
      records.set(name, { version: { id: versionId, annotations: metadata.annotations, resources: { bindings: metadata.bindings, script_runtime: { compatibility_date: metadata.compatibility_date, compatibility_flags: metadata.compatibility_flags } } }, sourceDigest: hash(source),
        subdomain: { enabled: false, previews_enabled: false }, deployment: null }); return versionId; }),
    version: vi.fn(async (name: string) => records.get(name).version),
    assertNoPublicRoutes: vi.fn(async () => {}),
    disableSubdomain: vi.fn(async (name: string) => { records.get(name).subdomain = { enabled: false, previews_enabled: false }; }),
    subdomain: vi.fn(async (name: string) => records.get(name).subdomain),
    deployment: vi.fn(async (name: string) => records.get(name).deployment),
    deploy: vi.fn(async (name: string, version: string, tag: string) => { records.get(name).deployment = { id: id(),
      annotations: { "workers/message": `private-pair:${tag}` }, versions: [{ version_id: version, percentage: 100 }] };
      return records.get(name).deployment; }),
    sourceDigest: vi.fn(async (name: string) => records.get(name).sourceDigest),
  };
});
const run = (dryRun = false, signal?: AbortSignal) => installPrivatePublicRelease({ plan, provider, ledger: privateInstallLedger(db), compile,
  dryRun, signal });
it("ends the readback of a deployment that a newer one replaced", async () => {
  const rows = [{ id: "99999999-9999-4999-8999-999999999999", created_on: "2026-11-25T10:01:00Z" }, { id: "88888888-8888-4888-8888-888888888888", created_on: "2026-11-25T10:00:00Z" }];
  const real = cloudflarePrivatePairProvider({ accountId: "a".repeat(32), credential: async () => "fixture-token",
    fetcher: (async () => Response.json({ success: true, result: { deployments: rows } })) as typeof fetch });
  const ours = { id: rows[1].id, created_on: rows[1].created_on };
  const callbacks = workerReadbackAfterWrite(async () => ours, async (response: typeof ours) => real.deployment("njpbs-private-reader-fixture", undefined, response), undefined);
  await callbacks.effect();
  await expect(callbacks.observe()).rejects.toThrow("was superseded");
  // Still below ours in age, so the read can be late: no final answer.
  rows.splice(0, 1, { id: "77777777-7777-4777-8777-777777777777", created_on: "2026-11-25T09:59:00Z" }); rows.splice(1, 1);
  await expect(real.deployment("njpbs-private-reader-fixture", undefined, ours)).resolves.toMatchObject({ id: rows[0].id });
  // The installer hands its own confirmed deployment to the provider.
  await run();
  const deployed = await provider.deploy.mock.results[0].value;
  expect(provider.deployment.mock.calls.some((call: unknown[]) => (call[2] as { id?: string } | undefined)?.id === deployed.id)).toBe(true);
});
it("dry-runs both private slots and fixed OLD/NEW ingress without any SDK/provider effect", async () => {
  const result = await run(true); expect(result.readbacks).toHaveLength(3); expect(provider.upload).not.toHaveBeenCalled();
  expect((await db.doc(`system/publicReleasePrivateInstalls/plans/${plan.operationId}`).get()).exists).toBe(false);
  for (const row of result.readbacks) expect(row.metadata.bindings.filter((binding: any) => /ENABLED$/.test(binding.name)).every((binding: any) => binding.text === "false")).toBe(true);
});
it("installs distinct immutable private versions and reconciles the same original attempt with no second effect", async () => {
  const first = await run(), again = await run();
  expect(first).toEqual(again); expect(first.pairs[0].publicWorker.versionId).not.toBe(first.pairs[1].publicWorker.versionId);
  expect(first.bootstrapPairId).toBe(plan.oldPair.pairId); expect(provider.upload).toHaveBeenCalledTimes(3); expect(provider.deploy).toHaveBeenCalledTimes(3);
  for (const [index, pair] of first.pairs.entries()) {
    expect(pair.readerReceiptDigest).toBe(protocol.publicReleaseDigest({ schemaVersion: 1, environment: pair.environment,
      service: pair.publicWorker.service, versionId: pair.publicWorker.versionId, commitSha: pair.commitSha,
      origin: plan.readerOrigins[index], contractDigest: protocol.publicReleaseDigest(PAIR_READER_CONTRACT) }));
    expect(pair.readerReceiptDigest).not.toBe([plan.oldPair, plan.newPair][index].readerReceiptDigest);
    const bindings = records.get(pair.publicWorker.service).version.resources.bindings;
    const embedded = JSON.parse(bindings.find((binding: any) => binding.name === "PUBLIC_PAIR_IDENTITY_JSON").text);
    expect(embedded.readerReceiptDigest).toBeUndefined(); expect(embedded.publicWorker.versionId).toBeUndefined();
  }
  expect((await db.doc("system/publicDeployment").get()).exists).toBe(false);
  expect((await db.doc("system/cmsPublicationRuntime").get()).exists).toBe(false);
});
it.each([1])("checks exact private Worker metadata after %s stale reads", async staleReads => {
  const worker = plan.oldPair.publicWorker.service;
  const previous = "00000000-0000-4000-8000-999999999999";
  const counters = { versions: 0, version: 0, subdomain: 0, deployment: 0 };
  const stale = (method: keyof typeof counters, name: string) => name === worker && records.has(name) && counters[method]++ < staleReads;
  const versions = provider.versions.getMockImplementation();
  provider.versions.mockImplementation(async (name: string) => stale("versions", name) ? [] : versions(name));
  const version = provider.version.getMockImplementation();
  provider.version.mockImplementation(async (name: string) => stale("version", name) ? { id: previous } : version(name));
  const subdomain = provider.subdomain.getMockImplementation();
  provider.subdomain.mockImplementation(async (name: string) => stale("subdomain", name) ? { enabled: true, previews_enabled: false } : subdomain(name));
  const deployment = provider.deployment.getMockImplementation();
  provider.deployment.mockImplementation(async (name: string) => stale("deployment", name)
    ? { ...records.get(name).deployment, id: previous } : deployment(name));
  const key = protocol.publicReleaseDigest({ worker });
  const readback = (action: string) => db.doc(`system/publicReleasePrivateInstalls/attempts/${plan.operationId}/readbacks/${key}-${action}`).get();
  await run();
  expect((await readback("upload")).data()?.result).toEqual({ versionId: records.get(worker).version.id });
  expect((await readback("deploy")).data()?.result).toEqual({ deploymentId: records.get(worker).deployment.id, versionId: records.get(worker).version.id });
  for (const effect of ["create", "upload", "disableSubdomain", "deploy"]) {
    expect(provider[effect].mock.calls.filter(([name]: [string]) => name === worker)).toHaveLength(1);
  }
});
it.each(["source", "public-route"])("refuses mismatched provider readback: %s", async kind => {
  if (kind === "version") provider.version.mockImplementation(async (name: string) => ({ ...records.get(name).version, id: "00000000-0000-4000-8000-999999999999" }));
  if (["binding", "asset-bucket"].includes(kind)) provider.version.mockImplementation(async (name: string) => {
    const row = structuredClone(records.get(name).version);
    if (kind === "binding") row.resources.bindings.pop();
    else row.resources.bindings.find((binding: any) => binding.name === "PAIR_CONTENT").bucket_name = "wrong-assets";
    return row;
  });
  if (kind === "source") provider.sourceDigest.mockResolvedValue("0".repeat(64));
  if (kind === "public-route") provider.assertNoPublicRoutes.mockRejectedValue(new Error("Public route exists"));
  await expect(run()).rejects.toThrow(); expect(provider.upload.mock.calls.length).toBe(1);
});
it.each(["create", "upload", "deploy"])("reconciles a lost %s reply without another upload or rollout", async method => {
  const effect = provider[method].getMockImplementation(); let lost = false;
  provider[method].mockImplementation(async (...args: unknown[]) => { const value = await effect(...args); if (!lost) { lost = true; throw new Error("Lost reply"); } return value; });
  const result = await run(); expect(result.readbacks).toHaveLength(3); await run();
  expect(provider.upload).toHaveBeenCalledTimes(3); expect(provider.deploy).toHaveBeenCalledTimes(3);
});
it("refuses an existing parent owned by another attempt before upload",async()=>{
 workers.set(plan.oldPair.publicWorker.service,{id:"1".repeat(32),name:plan.oldPair.publicWorker.service,tags:["foreign"],subdomain:{enabled:false,previews_enabled:false}});
 await expect(run()).rejects.toThrow();expect(provider.upload).not.toHaveBeenCalled();expect(provider.create).not.toHaveBeenCalled();
});
it("refuses changed plans, existing retained incarnations and cancellation before any effect", async () => {
  const abort = new AbortController(); abort.abort(); await expect(run(false, abort.signal)).rejects.toThrow(); expect(provider.upload).not.toHaveBeenCalled();
  await run(); plan = { ...plan, ingressName: "njpbs-private-ingress-changed" };
  await expect(run()).rejects.toThrow(); expect(provider.upload).toHaveBeenCalledTimes(3);
  plan = { ...plan, operationId: "different-attempt", ingressName: "njpbs-private-ingress-development" };
  await expect(run()).rejects.toThrow(); expect(provider.upload).toHaveBeenCalledTimes(3);
});
it("rejects mixed environments and unexpected source bundles before claiming any provider step", async () => {
  plan.newPair = { ...plan.newPair, environment: "production" }; await expect(run()).rejects.toThrow();
  plan.newPair = sealedPair(plan.readerOrigins[1], releasePair("b", "b".repeat(40))).pair;
  plan.ingressBundleDigest = "0".repeat(64); await expect(run()).rejects.toThrow();
  expect(provider.upload).not.toHaveBeenCalled();
});
it.each(["readerContractDigest", "capabilityDigest"])("refuses stale %s before claiming or calling any provider step", async field => {
  plan.oldPair = { ...plan.oldPair, [field]: "f".repeat(64) };
  await expect(run()).rejects.toThrow();
  expect(provider.worker).not.toHaveBeenCalled(); expect(provider.create).not.toHaveBeenCalled();
  expect(provider.upload).not.toHaveBeenCalled(); expect(provider.deploy).not.toHaveBeenCalled();
  expect((await db.doc(`system/publicReleasePrivateInstalls/plans/${plan.operationId}`).get()).exists).toBe(false);
});
it("compiles the actual private entrypoints without Firebase or provider credentials", async () => {
  for (const main of ["workers/src/public-release-slot-worker.ts", "workers/src/public-release-ingress-worker.ts", "workers/src/private-pair-operator-worker.ts", "workers/src/private-pair-reader-gateway.ts"]) {
    const bytes = await compilePrivateWorker(main); expect(bytes.length).toBeGreaterThan(1); expect(bytes.length).toBeLessThan(512 * 1024);
  }
});
it("loads the real operator CLI without TypeScript stripping before safe plan refusal", () => {
  const result = spawnSync(process.execPath, ["--no-experimental-strip-types", "scripts/install-private-public-release.mjs"], {
    cwd: process.cwd(), env: { PATH: process.env.PATH }, encoding: "utf8" });
  expect(result.status).toBe(1);
  expect(result.stderr).toBe("Private public-release installation was refused at plan; no provider step was invoked\n");
});
it("seals the explicitly approved reader enablement and Access fields in the original slot upload", async () => {
  plan.readerAccess = [0, 1].map(() => ({ enabled: true, audience: "d".repeat(64), clientId: "reader123.access" }));
  plan.slotEnabled = [true, true];
  const first = await run();
  for (const pair of first.pairs) {
    const bindings = records.get(pair.publicWorker.service).version.resources.bindings;
    expect(bindings.find((binding: any) => binding.name === "PAIR_PRIVATE_HTTP_ENABLED").text).toBe("true");
    expect(bindings.find((binding: any) => binding.name === "PUBLIC_PAIR_SLOT_ENABLED").text).toBe("true");
    expect(bindings.find((binding: any) => binding.name === "PAIR_ACCESS_AUDIENCE").text).toBe("d".repeat(64));
    expect(bindings.find((binding: any) => binding.name === "PAIR_ACCESS_CLIENT_ID").text).toBe("reader123.access");
  }
  plan.readerAccess[0].audience = "e".repeat(64);
  await expect(run()).rejects.toThrow(); expect(provider.upload).toHaveBeenCalledTimes(3);
});

it("recovers a confirmed pre-send cancellation under the same original attempt", async () => {
  provider.upload.mockRejectedValueOnce(new PrivateProviderNotSent());
  await expect(run()).rejects.toThrow(); expect(records.size).toBe(0);
  expect((await run()).readbacks).toHaveLength(3);
  expect(provider.upload).toHaveBeenCalledTimes(4); expect(provider.deploy).toHaveBeenCalledTimes(3);
});
it("installs enabled development ingress and recovery capture in the original immutable plan", async () => {
  plan.developmentIngress = true;
  plan.slotEnabled = [true, true];
  plan.readerAccess = [0, 1].map(() => ({ enabled: true, audience: "d".repeat(64), clientId: "reader123.access" }));
  const first = await run();
  const ingress = records.get(plan.ingressName).version.resources.bindings;
  expect(ingress.find((row: any) => row.name === "PUBLIC_PAIR_INGRESS_ENABLED").text).toBe("true");
  expect(ingress.find((row: any) => row.name === "PUBLIC_PAIR_RECOVERY_CAPTURE_ENABLED").text).toBe("true");
  expect(JSON.parse(ingress.find((row: any) => row.name === "PUBLIC_PAIR_IDENTITIES_JSON").text)).toEqual(first.pairs);
  expect((await db.doc(`system/publicReleasePrivateInstalls/plans/${plan.operationId}`).get()).data()?.planDigest).toBe(protocol.publicReleaseDigest(plan));
  expect(await run()).toEqual(first); expect(provider.upload).toHaveBeenCalledTimes(3);
  delete plan.developmentIngress; await expect(run()).rejects.toThrow();
});
it.each(["production", "disabled-slot", "disabled-reader", "false-flag"])("refuses unsupported development ingress plan %s before any claim", async fault => {
  plan.developmentIngress = true; plan.slotEnabled = [true, true];
  plan.readerAccess = [0, 1].map(() => ({ enabled: true, audience: "d".repeat(64), clientId: "reader123.access" }));
  if (fault === "production") { plan.oldPair.environment = "production"; plan.newPair.environment = "production"; }
  if (fault === "disabled-slot") plan.slotEnabled[1] = false;
  if (fault === "disabled-reader") plan.readerAccess[1].enabled = false;
  if (fault === "false-flag") plan.developmentIngress = false;
  await expect(run()).rejects.toThrow(); expect(provider.worker).not.toHaveBeenCalled();
  expect((await db.doc(`system/publicReleasePrivateInstalls/plans/${plan.operationId}`).get()).exists).toBe(false);
});
