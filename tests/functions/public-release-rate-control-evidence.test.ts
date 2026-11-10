import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { publicSlotScenario } from "../helpers/private-public-release-slot-target.mjs";
import { configurePublicReleaseIngress } from "../../scripts/configure-public-release-ingress.mjs";
import { compilePrivateWorker } from "../../scripts/install-private-public-release.mjs";
import { installPrivateWorker } from "../../scripts/lib/public-release-private-provider.mjs";
import { privateInstallLedger } from "../../scripts/lib/public-release-private-install-ledger.mjs";
import { produceIngressRateControls, ingressRateEvidenceConfiguration } from "../../scripts/lib/public-release-rate-control-evidence.mjs";
import { prepareCmsRateControlBundle } from "../../scripts/lib/public-release-rate-control-bundle.mjs";
import { readReviewedIngressRateControls, assertReviewedCmsRpcRateControl } from "../../scripts/lib/public-release-old-ingress-rate-control.mjs";
import { operatorCloudflareApi } from "../../scripts/lib/public-release-private-bridge-operator.mjs";
import p from "../../functions/lib/public-release-pair.js";

const rawDb = isolatedFirestore("public-release-rate-control-evidence.test.ts"), emulator = process.env.FIRESTORE_EMULATOR_HOST!;
const authEmulator = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const db = new Proxy(rawDb, { get(target, key) { if (key === "projectId") return "njpbs-site";
  const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; } });
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const uid = (n: number) => `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`;
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
let cmsBundle: any, ingressSource: Uint8Array;
beforeAll(async () => {
  // Real credential-free Wrangler modules and real compiled ingress bytes.
  cmsBundle = await prepareCmsRateControlBundle(); ingressSource = await compilePrivateWorker("workers/src/public-release-ingress-worker.ts");
});
beforeEach(async () => {
  process.env.FIRESTORE_EMULATOR_HOST = emulator;
  await clearEmulatorFirestore(`http://${emulator}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, rawDb);
  await rawDb.doc("fixture/connection").get();
  delete process.env.FIRESTORE_EMULATOR_HOST; delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
});
afterEach(() => {
  process.env.FIRESTORE_EMULATOR_HOST = emulator;
  if (authEmulator === undefined) delete process.env.FIREBASE_AUTH_EMULATOR_HOST; else process.env.FIREBASE_AUTH_EMULATOR_HOST = authEmulator;
});
async function fixture() {
  const f = publicSlotScenario(), plan = structuredClone(f.installPlan);
  const pairs = [f.pair, plan.newPair].map((value: any, index) => {
    const pair = { ...structuredClone(value), environment: "production" };
    pair.readerReceiptDigest = p.publicReleaseDigest({ schemaVersion: 1, environment: "production", service: pair.publicWorker.service,
      versionId: pair.publicWorker.versionId, commitSha: pair.commitSha, origin: plan.readerOrigins[index], contractDigest: pair.readerContractDigest });
    return pair;
  });
  plan.oldPair.environment = "production"; plan.newPair.environment = "production"; plan.slotEnabled = [true, true];
  plan.ingressBundleDigest = hash(ingressSource);
  const config = configurePublicReleaseIngress({ oldPair: pairs[0], newPair: pairs[1], accountId: plan.accountId, ingressName: plan.ingressName });
  let worker: any = null, ingressVersion: any = null, ingressDeployment: any = null;
  const nativeProvider: any = {
    worker: async () => worker, create: async (_name: string, tag: string) => { worker = { id: "1".repeat(32), name: config.name,
      tags: [`private-pair:${tag}`], subdomain: { enabled: false, previews_enabled: false } }; },
    versions: async () => ingressVersion ? [ingressVersion] : [],
    upload: async (_name: string, metadata: any) => { ingressVersion = { id: uid(30), annotations: metadata.annotations,
      resources: { bindings: metadata.bindings, script_runtime: { compatibility_date: metadata.compatibility_date, compatibility_flags: metadata.compatibility_flags } } }; },
    version: async () => ingressVersion, sourceDigest: async () => hash(ingressSource), assertNoPublicRoutes: async () => {},
    subdomain: async () => worker.subdomain, disableSubdomain: async () => {},
    deployment: async () => ingressDeployment, deploy: async (_name: string, version: string, tag: string) => {
      ingressDeployment = { id: uid(40), versions: [{ version_id: version, percentage: 100 }], annotations: { "workers/message": `private-pair:${tag}` } };
    },
  };
  const ledger = privateInstallLedger(db); await ledger.bindAttempt(plan.operationId, p.publicReleaseDigest(plan));
  // The original installer writes the real SDK claims/readbacks. Provider only
  // is synthetic; no accepted evidence receipt is seeded directly.
  await installPrivateWorker({ ledger, provider: nativeProvider, attemptId: plan.operationId, config, source: ingressSource, dryRun: false });
  // Ancestry/review are external host-process fixtures. The real clean HEAD
  // source pin remains enforced even in CI's one-commit checkout.
  const commit = git("rev-parse", "HEAD"), base = "e".repeat(40);
  const oldIngressPacket = { schemaVersion: 1, kind: "old-only-ingress-operator", operatorCommitSha: commit,
    credentialIdentity: { projectId: "njpbs-site", clientEmail: "fixture-operator@njpbs-site.iam.gserviceaccount.com", privateKeyId: "b".repeat(40), secretRef: "pass://fixture/operator" },
    providerCredentialRef: "pass://fixture/provider", operationId: "original-enable", bootstrapAttempt: {
      schemaVersion: 2, operationId: "original-bootstrap", expectedSourceDigest: "a".repeat(64), currentPair: pairs[0], recoveryPair: pairs[1],
      admittedContractDigest: "b".repeat(64), qualifications: [0, 1].map(i => ({ qualificationId: `original-${i}`, receiptDigest: String(i + 1).repeat(64) })) },
    installPlan: plan, originalIngressVersionId: uid(30), originalIngressDeploymentId: uid(40), enableOldIngress: true,
    route: { zoneId: "2".repeat(32), routeId: "3".repeat(32), pattern: "https://njpbs.org/*", legacyWorker: "njpbs-production", legacyVersionId: uid(51), legacyDeploymentId: uid(50) } };
  const packet = { schemaVersion: 1, kind: "public-release-rate-control-evidence", operatorCommitSha: commit, reviewBaseCommitSha: base, oldIngressPacket };
  const repo = await realpath(process.cwd()), tree = git("rev-parse", "HEAD^{tree}");
  // The trusted verifier owns policy validation; this is a synthetic envelope.
  const verifier = "/opt/example/bin/full-review-verifier", receiptSchema = "example-full-review/v1";
  const reviewRecord: any = { receiptSchema, scope: "complete-diff", verdict: "pass", repo,
    operatorCommitSha: commit, reviewBaseCommitSha: base, snapshotTreeSha: tree, reviewReceiptDigest: "f".repeat(64) };
  let reviewCalls = 0, recordReads = 0;
  const hostCalls: { command: string; args: string[] }[] = [];
  const recordPaths: string[] = [];
  const state = { fault: "", reviewRecord, get reviewCalls() { return reviewCalls; }, get recordReads() { return recordReads; } };
  const host = { configuration: { command: verifier, receiptSchema }, run: (command: string, args: string[]) => {
    hostCalls.push({ command, args });
    if (command === "git") {
      if (args.includes("merge-base")) return base;
      if (args.includes("HEAD^{tree}")) return tree;
      throw new Error("Unexpected host Git query");
    }
    reviewCalls++;
    if (state.fault === "gate") throw new Error("Host review gate unavailable");
    return state.fault === "invented-status" ? "not a receipt" : JSON.stringify(reviewRecord);
  }, read: async (path: string) => { recordReads++; recordPaths.push(path); throw new Error("Unexpected internal review-state read"); } };
  const cms: any = { deployment: { id: uid(70), versions: [{ version_id: uid(71), percentage: 100 }] },
    version: { id: uid(71), resources: { bindings: [
      ...Object.entries({ PUBLIC_RELEASE_RATE_CONTROLS_ENABLED: "true", PUBLIC_RELEASE_READERS_ENABLED: "true", FIREBASE_PROJECT_ID: "njpbs-site",
        FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site.cloudfunctions.net" }).map(([name, text]) => ({ name, type: "plain_text", text })),
      { name: "RATE_LIMITERS", type: "durable_object_namespace", class_name: "CmsRateLimiter", namespace_id: "9".repeat(32) },
    ], script_runtime: structuredClone(cmsBundle.runtime) } },
    code: { id: uid(71), main_module: cmsBundle.bundle.mainModule, modules: structuredClone(cmsBundle.code) },
    namespaces: [{ id: "9".repeat(32), class: "CmsRateLimiter", script: "njpbs-cms-api", use_sqlite: true }] };
  const calls: string[] = []; let deploymentReads = 0;
  const providerState = { cms, ingressVersion, ingressDeployment };
  const fetchImpl: typeof fetch = async (input, options = {}) => {
    expect(options.method ?? "GET").toBe("GET"); expect(options.redirect).toBe("error");
    const url = new URL(String(input)), path = url.pathname; calls.push(path);
    const result = (data: any) => Response.json({ success: true, result: structuredClone(data) });
    if (path.endsWith("/durable_objects/namespaces")) return result(cms.namespaces);
    if (path.endsWith("/workers/domains") || path.endsWith("/workers/routes")) return result([]);
    if (path === "/client/v4/zones") return result([{ id: "2".repeat(32) }]);
    if (path.includes("/workers/workers/njpbs-cms-api/")) return result(cms.code);
    if (path.includes("/scripts/njpbs-cms-api/")) {
      if (path.endsWith("/deployments")) { deploymentReads++; const value = structuredClone(cms.deployment);
        if (state.fault === "deployment-drift" && deploymentReads > 1) value.id = uid(72); return result([value]); }
      return result(cms.version);
    }
    if (path.endsWith("/deployments")) return result([ingressDeployment]);
    if (path.endsWith(`/versions/${uid(30)}`)) return result(ingressVersion);
    if (path.endsWith("/subdomain")) return result({ enabled: false, previews_enabled: false });
    if (path.endsWith("/content/v2")) return new Response(state.fault === "ingress-source" ? "foreign" : ingressSource,
      { headers: { "content-type": "application/javascript" } });
    throw new Error("Unexpected synthetic provider path");
  };
  const input = { firestore: db, packet, readToken: async () => "synthetic-provider-token", fetchImpl, host, apply: true };
  const target = ingressRateEvidenceConfiguration(packet).rateTarget;
  const refs = ["viewer", "cmsRpc"].map(role => db.doc(`system/publicReleaseIngressRateControls/${role}/${p.publicReleaseDigest(target)}`));
  return { input, packet, state: Object.assign(state, providerState), calls, hostCalls, recordPaths, target, refs, config, base, verifier, receiptSchema, repo };
}

it("default plan performs no SDK, credential or provider work", async () => {
  const f = await fixture();
  const result = await produceIngressRateControls({ packet: f.packet });
  expect(result).toMatchObject({ mode: "plan", providerWrites: 0, receiptsWritten: 0 });
  expect(f.calls).toEqual([]); expect(f.state.reviewCalls).toBe(0);
  expect((await f.refs[0].get()).exists).toBe(false);
});
it("runs the exact Bash plan fixture in the pinned clean checkout", async () => {
  const f = await fixture(), directory = await mkdtemp(join(tmpdir(), "rate-control-plan-"));
  try {
    const bytes = JSON.stringify(f.packet), path = join(directory, "packet.json"); await writeFile(path, bytes);
    const block = await readFile(new URL("../fixtures/rate-control-plan.sh", import.meta.url), "utf8");
    const result = JSON.parse(execFileSync("bash", ["-c", block], { encoding: "utf8",
      env: { ...process.env, RATE_PACKET: path, RATE_PACKET_SHA256: hash(bytes) } }));
    expect(result).toMatchObject({ mode: "plan", providerWrites: 0, receiptsWritten: 0 });
    expect(result.targetDigest).toBe(p.publicReleaseDigest(f.target)); expect(f.calls).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it("creates two native SDK receipts accepted by the unchanged enable preflight, and preserves originals", async () => {
  const f = await fixture(), result = await produceIngressRateControls(f.input);
  const evidence = await readReviewedIngressRateControls({ firestore: db, target: f.target });
  expect(result).toMatchObject({ mode: "recorded", providerWrites: 0, evidenceDigest: evidence.digest });
  expect(evidence.records.map((row: any) => row.kind)).toEqual(["public-release-viewer-rate-control", "public-release-cms-rpc-rate-control"]);
  await assertReviewedCmsRpcRateControl({ evidence, api: operatorCloudflareApi({ readToken: f.input.readToken, fetchImpl: f.input.fetchImpl }) });
  const before = await Promise.all(f.refs.map((ref: any) => ref.get()));
  await expect(produceIngressRateControls(f.input)).resolves.toEqual(result);
  const after = await Promise.all(f.refs.map((ref: any) => ref.get()));
  expect(after.map((row: any) => row.updateTime.toMillis())).toEqual(before.map((row: any) => row.updateTime.toMillis()));
  expect(f.state.reviewCalls).toBe(4);
  expect(f.hostCalls.filter(row => row.command === f.verifier).every(row =>
    JSON.stringify(row.args) === JSON.stringify(["--repo", f.repo, "--operator-commit", f.packet.operatorCommitSha,
      "--base", f.base, "--tree", f.state.reviewRecord.snapshotTreeSha, "--receipt-schema", f.receiptSchema]))).toBe(true);
  expect(f.recordPaths).toEqual([]);
});
it("uses the configured verifier independently of the home layout", async () => {
  const previous = process.env.HOME;
  try {
    process.env.HOME = "/home/example-runner";
    const f = await fixture();
    await expect(produceIngressRateControls(f.input)).resolves.toMatchObject({ mode: "recorded", providerWrites: 0 });
    expect(f.hostCalls.filter(row => row.command === f.verifier)).toHaveLength(2);
    expect(f.recordPaths).toEqual([]);
  } finally { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; }
});
it.each([undefined, { command: "relative-verifier", receiptSchema: "example-full-review/v1" },
  { command: "/opt/example/bin/full-review-verifier", receiptSchema: "" },
  { command: "/opt/example/bin/full-review-verifier", receiptSchema: "invalid\nvalue" }])(
  "refuses unavailable verifier configuration before host or provider work (%j)", async configuration => {
    const f = await fixture(); (f.input.host as any).configuration = configuration;
    await expect(produceIngressRateControls(f.input)).rejects.toThrow("refused");
    expect(f.hostCalls).toEqual([]); expect(f.calls).toEqual([]);
    for (const ref of f.refs) expect((await ref.get()).exists).toBe(false);
  });
it.each(["disabled", "missing-limiter", "namespace", "policy-source", "ingress-source", "version", "deployment-drift", "runtime"])(
  "refuses actual provider %s mismatch without creating either receipt", async fault => {
    const f = await fixture(); f.state.fault = fault;
    if (fault === "disabled") f.state.cms.version.resources.bindings.find((row: any) => row.name === "PUBLIC_RELEASE_RATE_CONTROLS_ENABLED").text = "false";
    if (fault === "missing-limiter") f.state.cms.version.resources.bindings = f.state.cms.version.resources.bindings.filter((row: any) => row.name !== "RATE_LIMITERS");
    if (fault === "namespace") f.state.cms.namespaces[0].class = "OtherLimiter";
    if (fault === "policy-source") f.state.cms.code.modules[0].content_base64 = Buffer.from("foreign policy").toString("base64");
    if (fault === "version") f.state.cms.version.id = uid(99);
    if (fault === "runtime") f.state.cms.version.resources.script_runtime.compatibility_flags = [];
    await expect(produceIngressRateControls(f.input)).rejects.toThrow("refused");
    expect(f.state.reviewCalls).toBe(1); expect(f.state.recordReads).toBe(0);
    expect(f.calls.length).toBeGreaterThan(0);
    const boundary = fault === "policy-source" ? `/workers/workers/njpbs-cms-api/versions/${uid(71)}` :
      fault === "namespace" ? "/workers/durable_objects/namespaces" : fault === "ingress-source" ? "/content/v2" :
      fault === "deployment-drift" ? "/scripts/njpbs-cms-api/deployments" : `/scripts/njpbs-cms-api/versions/${uid(71)}`;
    expect(f.calls.some(path => path.endsWith(boundary))).toBe(true);
    for (const ref of f.refs) expect((await ref.get()).exists).toBe(false);
  });
it.each(["gate", "focused", "failed-policy", "foreign-source", "invented-status", "foreign-schema", "incomplete", "foreign-operator", "foreign-base", "foreign-repository", "digest-array"])("rejects %s review evidence before provider observations", async fault => {
  const f = await fixture();
  f.state.fault = fault;
  if (fault === "focused") f.state.reviewRecord.scope = "focused";
  if (fault === "failed-policy") f.state.reviewRecord.verdict = "fail";
  if (fault === "foreign-schema") f.state.reviewRecord.receiptSchema = "foreign-review/v1";
  if (fault === "incomplete") f.state.reviewRecord.reviewReceiptDigest = "";
  if (fault === "foreign-operator") f.state.reviewRecord.operatorCommitSha = "a".repeat(40);
  if (fault === "foreign-source") f.state.reviewRecord.snapshotTreeSha = "a".repeat(40);
  if (fault === "foreign-base") f.state.reviewRecord.reviewBaseCommitSha = "a".repeat(40);
  if (fault === "foreign-repository") f.state.reviewRecord.repo = "/tmp/example-other-source";
  if (fault === "digest-array") f.state.reviewRecord.reviewReceiptDigest = ["f".repeat(64)];
  await expect(produceIngressRateControls(f.input)).rejects.toThrow("refused"); expect(f.calls).toEqual([]);
  expect(f.state.reviewCalls).toBe(1); expect(f.state.recordReads).toBe(0);
  for (const ref of f.refs) expect((await ref.get()).exists).toBe(false);
});
it("a corrupt preexisting receipt cannot be overwritten or partially completed", async () => {
  const f = await fixture(); await f.refs[0].create({ callerAllowed: true });
  await expect(produceIngressRateControls(f.input)).rejects.toThrow("refused");
  expect((await f.refs[0].get()).data()).toEqual({ callerAllowed: true }); expect((await f.refs[1].get()).exists).toBe(false);
});
it("missing original installation claims and caller success fields never authorize evidence", async () => {
  const f = await fixture();
  await db.doc(`system/publicReleasePrivateInstalls/plans/${f.packet.oldIngressPacket.installPlan.operationId}`).delete();
  await expect(produceIngressRateControls(f.input)).rejects.toThrow("refused"); expect(f.calls).toEqual([]);
  expect(f.state.reviewCalls).toBe(1); expect(f.state.recordReads).toBe(0);
  for (const field of ["allowed", "reviewDigest", "observations", "installed"]) {
    await expect(produceIngressRateControls({ ...f.input, packet: { ...f.packet, [field]: true } })).rejects.toThrow("refused");
  }
});
