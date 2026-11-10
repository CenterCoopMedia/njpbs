import { beforeAll, beforeEach, afterAll, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { clearEmulatorFirestore, isolatedFirestore } from "../helpers/emulator-firestore.js";
import { privatePairPublisherScenario } from "../helpers/private-pair-publisher-install.mjs";
import * as fixture from "../helpers/private-pair-publisher-provider.mjs";
import { preparePrivatePairPublisherInstall } from "../../scripts/lib/private-pair-publisher-prepare.mjs";
import { runPrivatePublisherOperator, parsePrivatePublisherOperatorArgs } from "../../scripts/lib/private-pair-publisher-operator.mjs";
import { privatePublisherOperatorFailure } from "../../scripts/install-private-pair-publisher.mjs";
import { PrivatePairProviderError } from "../../scripts/lib/private-pair-publisher-provider.mjs";
import ownership from "../../functions/lib/public-release-pair-work.js";

// Functions shards install root/site dependencies, not publisher dependencies.
// Model only the offline Wrangler subprocess here. The separate publisher
// process test exercises the real pinned bundler and CLI in its owning CI job.
vi.mock("node:child_process", async importActual => ({ ...await importActual(), spawn: (_command, argv) => {
  const child = new EventEmitter();
  queueMicrotask(async () => {
    try {
      const config = JSON.parse(readFileSync(argv[argv.indexOf("--config") + 1], "utf8"));
      writeFileSync(argv[argv.indexOf("--outfile") + 1], await fixture.multipart(fixture.metadata(config)));
      child.emit("exit", 0);
    } catch { child.emit("exit", 1); }
  });
  return child;
} }));

const accountId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const directory = mkdtempSync(join(tmpdir(), "publisher-operator-test-"));
let db, packet;
beforeAll(async () => {
  db = isolatedFirestore("private-pair-publisher-operator.test.js");
  const current = await privatePairPublisherScenario(db, { accountId });
  const pairTemplate = structuredClone(current.input.plan.pairTemplate);
  pairTemplate.commitSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const intent = { pairTemplate, retainedPairs: [], imageReference: current.input.plan.imageReference, executorReady: false,
    legacyConfig: { name: "njpbs-dev-cms-publisher", account_id: accountId, compatibility_date: "2026-10-28",
      vars: { CMS_DEPLOYMENT_ENVIRONMENT: "development" }, r2_buckets: [{ bucket_name: "njpbs-dev-cms-publication" }] } };
  // Actual clean Git checks, preparation parser, installer, target guards and
  // RPC composition. Only the offline subprocess and I/O boundaries are faked.
  const { plan, prepared } = await preparePrivatePairPublisherInstall(intent);
  packet = { schemaVersion: 1, kind: "private-pair-publisher-operator", intent,
    preparation: { schemaVersion: 2, kind: "private-pair-publisher-preparation", plan, executorReady: prepared.executorReady,
      moduleManifest: prepared.moduleManifest, providerWrites: 0, runtimePreflight: "not-run" },
    preflightOperationId: "publisher-operator-proof", credentialIdentity: { projectId: "njpbs-site-dev",
      clientEmail: "pair-test@njpbs-site-dev.iam.gserviceaccount.com", privateKeyId: "a".repeat(40) } };
});
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function args(value = packet, mode, overrides = {}) {
  const bytes = JSON.stringify(value), filename = join(directory, "packet.json");
  writeFileSync(filename, bytes);
  return ["--packet", filename, "--packet-digest", overrides.digest ?? createHash("sha256").update(bytes).digest("hex"), ...mode ? [`--${mode}`] : []];
}
function account(value = packet) {
  return JSON.stringify({ type: "service_account", project_id: value.credentialIdentity.projectId,
    client_email: value.credentialIdentity.clientEmail, private_key_id: value.credentialIdentity.privateKeyId,
    private_key: "synthetic-private-key-at-the-credential-boundary" });
}
async function scenario(options = {}) {
  const current = await privatePairPublisherScenario(db, { accountId, ...options });
  const authority = { session: 0, upload: 0, invoke: 0 };
  let meta, modules;
  const bindings = () => meta.bindings.map(binding => binding.type === "secret_text" ? { name: binding.name, type: "secret_text" }
    : binding.type === "durable_object_namespace" ? { ...binding, ...current.state.deployment ? { namespace_id: fixture.namespaceId } : {} } : binding);
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/workers/subdomain")) return fixture.envelope({ subdomain: "fixture" });
    if (url.pathname.endsWith("/workers/subdomain/edge-preview")) { authority.session++; return fixture.envelope({ token: "synthetic-session" }); }
    if (/\/workers\/scripts\/njpbs-private-preflight-[a-f0-9]{24}\/edge-preview$/.test(url.pathname)) {
      authority.upload++;
      expect(JSON.parse(init.body.get("metadata")).bindings).toEqual([
        { name: "PAIR_PREFLIGHT", type: "service", service: fixture.applicationName, entrypoint: "PairPublicationWake" },
      ]);
      if (options.loseRpcUpload) throw new Error("synthetic-sensitive-error");
      return fixture.envelope({ preview_token: "synthetic-preview" });
    }
    if (url.hostname.endsWith(".fixture.workers.dev")) {
      authority.invoke++;
      expect(url.pathname).toBe("/__private_pair_preflight");
      if (options.retireDuringRpc) await db.doc(`${ownership.publicReleasePairPath(packet.intent.pairTemplate.pairId)}/controls/runtime`).update({ status: "retired" });
      return Response.json(options.notReady ? { ready: false, pairId: packet.intent.pairTemplate.pairId, reason: "waiting-for-executor" }
        : { ready: true, pairId: packet.intent.pairTemplate.pairId, commitSha: packet.intent.pairTemplate.commitSha,
        journalNamespace: packet.intent.pairTemplate.publisher.journalNamespace });
    }
    if (init.method === "POST" && url.pathname.endsWith("/versions")) {
      meta = JSON.parse(init.body.get("metadata"));
      modules = await Promise.all([...init.body].filter(([name]) => name !== "metadata").map(async ([name, blob]) => ({ name,
        content_type: blob.type, content_base64: Buffer.from(await blob.arrayBuffer()).toString("base64") })));
    }
    if (meta && init.method === "GET" && url.pathname.endsWith(`/versions/${fixture.versionId}`)) {
      const body = url.pathname.includes("/workers/workers/") ? { ...fixture.versionCode(), bindings: bindings(), modules,
        main_module: meta.main_module, exports: meta.exports, compatibility_date: meta.compatibility_date, compatibility_flags: meta.compatibility_flags }
        : { ...fixture.version(), resources: { ...fixture.version().resources, bindings: bindings(), script_runtime: {
          ...fixture.version().resources.script_runtime, compatibility_date: meta.compatibility_date, compatibility_flags: meta.compatibility_flags } } };
      if (options.wrongBytes && body.modules) body.modules[0].content_base64 = Buffer.from("changed").toString("base64");
      return fixture.envelope(body);
    }
    return current.input.fetchImpl(input, init);
  };
  const close = vi.fn(async () => {}), openDatabase = vi.fn(async () => ({ firestore: db, close }));
  const dependencies = { fetchImpl, readToken: vi.fn(() => "synthetic-provider-token"),
    readServiceAccount: vi.fn(() => account()), openDatabase };
  return { ...current, authority, dependencies, close };
}

it("defaults to an offline plan without credentials or database reads", async () => {
  const current = await scenario(), argv = args();
  const result = await runPrivatePublisherOperator(argv, current.dependencies);
  expect(result).toMatchObject({ providerWrites: 0, runtimePreflight: "not-run", publicSelectionChanged: false, publicationSuccess: false });
  expect(current.dependencies.readToken).not.toHaveBeenCalled();
  expect(current.dependencies.readServiceAccount).not.toHaveBeenCalled();
  expect(current.dependencies.openDatabase).not.toHaveBeenCalled();
  expect((await db.listCollections())).toHaveLength(0);
});

it.each([[], ["--apply"], ["--packet", "file", "--packet-digest", "a".repeat(64), "--force"]])("rejects malformed arguments %j", argv => {
  expect(() => parsePrivatePublisherOperatorArgs(argv)).toThrow();
});

it("uploads a structurally versionless first-install intent and keeps registration/deployment pending", async () => {
  const first = structuredClone(packet);
  delete first.intent.pairTemplate.publicWorker.versionId;
  delete first.intent.pairTemplate.readerReceiptDigest;
  first.intent.slotInstall = { operationId: "first-install-slots", readerOrigin: "https://reader.example.test" };
  const { plan, prepared } = await preparePrivatePairPublisherInstall(first.intent);
  first.preparation.plan = plan; first.preparation.moduleManifest = prepared.moduleManifest;
  const current = await scenario();
  const result = await runPrivatePublisherOperator(args(first, "upload"), current.dependencies);
  expect(result).toMatchObject({ kind: "private-pair-publisher-uploaded", registered: false, deployed: false,
    version: { workerVersionId: fixture.versionId } });
  expect(current.writes()).toHaveLength(2); expect(current.authority).toEqual({ session: 0, upload: 0, invoke: 0 });
  expect((await db.doc(ownership.publicReleasePairPath(first.intent.pairTemplate.pairId)).get()).exists).toBe(false);
  expect((await runPrivatePublisherOperator(args(first, "readback"), current.dependencies)).upload.workerVersionId).toBe(fixture.versionId);
  expect(await runPrivatePublisherOperator(args(first, "upload"), current.dependencies)).toEqual(result);
  await expect(runPrivatePublisherOperator(args(first, "apply"), current.dependencies)).rejects.toThrow();
  expect(current.writes()).toHaveLength(2);
});

it("validates completion command grammar and slot-plan bytes before credentials", async () => {
  const first = structuredClone(packet);
  delete first.intent.pairTemplate.publicWorker.versionId; delete first.intent.pairTemplate.readerReceiptDigest;
  first.intent.slotInstall = { operationId: "first-install-slots", readerOrigin: "https://reader.example.test" };
  const { plan, prepared } = await preparePrivatePairPublisherInstall(first.intent);
  first.preparation.plan = plan; first.preparation.moduleManifest = prepared.moduleManifest;
  const filename = join(directory, "slot-plan.json"); writeFileSync(filename, "{}");
  const argv = [...args(first), "--complete", "--slot-plan", filename, "--slot-plan-digest", "0".repeat(64)];
  expect(parsePrivatePublisherOperatorArgs(argv)).toMatchObject({ mode: "complete", slotPlanFilename: filename });
  expect(() => parsePrivatePublisherOperatorArgs(argv.slice(0, -1))).toThrow();
  const current = await scenario();
  await expect(runPrivatePublisherOperator(argv, current.dependencies)).rejects.toThrow();
  expect(current.dependencies.readServiceAccount).not.toHaveBeenCalled(); expect(current.dependencies.readToken).not.toHaveBeenCalled();
});

it("refuses changed packet bytes, source and preparation seals before credentials or provider calls", async () => {
  const current = await scenario();
  await expect(runPrivatePublisherOperator(args(packet, "apply", { digest: "0".repeat(64) }), current.dependencies)).rejects.toThrow();
  const changedSource = structuredClone(packet);
  changedSource.intent.pairTemplate.commitSha = "f".repeat(40);
  changedSource.preparation.plan.pairTemplate.commitSha = "f".repeat(40);
  await expect(runPrivatePublisherOperator(args(changedSource, "apply"), current.dependencies)).rejects.toMatchObject({ code: "source-check-failed" });
  const changedSeal = structuredClone(packet);
  changedSeal.preparation.plan.bundleDigest = "0".repeat(64);
  await expect(runPrivatePublisherOperator(args(changedSeal, "apply"), current.dependencies)).rejects.toThrow();
  expect(current.dependencies.readToken).not.toHaveBeenCalled();
  expect(current.dependencies.readServiceAccount).not.toHaveBeenCalled();
  expect(current.requests).toHaveLength(0);
});

it.each(["project_id", "client_email", "private_key_id"])("refuses pre-cancel and a credential with changed %s before opening Firestore", async field => {
  const current = await scenario();
  await expect(runPrivatePublisherOperator(args(packet, "apply"), { ...current.dependencies, signal: AbortSignal.abort() })).rejects.toThrow();
  const wrong = JSON.parse(account()); wrong[field] = "b".repeat(40);
  await expect(runPrivatePublisherOperator(args(packet, "apply"), { ...current.dependencies, readServiceAccount: () => JSON.stringify(wrong) })).rejects.toThrow();
  expect(current.dependencies.openDatabase).not.toHaveBeenCalled();
  expect(current.dependencies.readToken).not.toHaveBeenCalled();
  expect(current.requests).toHaveLength(0);
});

it("installs the original exact resources through the shared RPC and reads their receipt without requesting authority again", async () => {
  const current = await scenario({ loseVersionResponse: true });
  const result = await runPrivatePublisherOperator(args(packet, "apply"), current.dependencies);
  expect(result).toMatchObject({ pair: { publisher: { workerVersionId: fixture.versionId } }, runtime: { ready: true }, publicSelectionChanged: false, publicationSuccess: false });
  expect(current.writes()).toHaveLength(4);
  expect(current.authority).toEqual({ session: 1, upload: 1, invoke: 1 });
  const readback = await runPrivatePublisherOperator(args(packet, "readback"), { ...current.dependencies, readToken: () => { throw new Error("No token needed for historical receipt"); } });
  expect(readback.upload).toMatchObject({ state: "uploaded", workerVersionId: fixture.versionId });
  expect(readback.operations.version).toMatchObject({ state: "verified", response: null }); // Lost POST response, exact GET recovered it.
  expect(readback.preflight).toMatchObject({ state: "complete", operationId: packet.preflightOperationId });
  const repeat = await runPrivatePublisherOperator(args(packet, "apply"), current.dependencies);
  expect(repeat).toEqual(result);
  expect(current.writes()).toHaveLength(4);
  expect(current.authority).toEqual({ session: 1, upload: 1, invoke: 1 });
  expect(current.close).toHaveBeenCalledTimes(3);
  expect((await db.doc("system/publicDeployment").get()).exists).toBe(false);
  expect(JSON.stringify(readback)).not.toContain("synthetic");
});

it("retains a lost shared caller upload as uncertain and never resends it", async () => {
  const current = await scenario({ loseRpcUpload: true });
  await expect(runPrivatePublisherOperator(args(packet, "apply"), current.dependencies)).rejects.toMatchObject({ code: "preflight-request-uncertain", uncertain: true });
  expect((await runPrivatePublisherOperator(args(packet, "readback"), current.dependencies)).preflight).toMatchObject({
    state: "uncertain", refusalCode: "preflight-request-uncertain" });
  await expect(runPrivatePublisherOperator(args(packet, "apply"), current.dependencies)).rejects.toMatchObject({ code: "preflight-attempt-uncertain", uncertain: true });
  expect(current.writes()).toHaveLength(4);
  expect(current.authority).toEqual({ session: 1, upload: 1, invoke: 0 });
});

it("refuses changed provider bytes before private proof", async () => {
  const changed = await scenario({ wrongBytes: true });
  await expect(runPrivatePublisherOperator(args(packet, "apply"), changed.dependencies)).rejects.toMatchObject({ code: "version-bytes" });
  expect(changed.authority).toEqual({ session: 0, upload: 0, invoke: 0 });
  expect(changed.writes()).toHaveLength(2);
});

it("cannot certify readiness if authority retires during the actual shared RPC", async () => {
  const current = await scenario({ retireDuringRpc: true });
  await expect(runPrivatePublisherOperator(args(packet, "apply"), current.dependencies)).rejects.toMatchObject({ code: "preflight-target-unavailable" });
  expect((await runPrivatePublisherOperator(args(packet, "readback"), current.dependencies)).preflight.state).toBe("failed");
  expect((await db.doc("system/publicDeployment").get()).exists).toBe(false);
});


it("keeps inventory GET-only and original missing-attempt readback free of provider authority", async () => {
  const current = await scenario();
  const result = await runPrivatePublisherOperator(args(packet, "inventory"), current.dependencies);
  expect(result).toMatchObject({ providerWrites: 0, runtimePreflight: "not-run", inventory: { intendedWorkerExists: false } });
  expect(current.dependencies.readServiceAccount).not.toHaveBeenCalled();
  expect(current.dependencies.openDatabase).not.toHaveBeenCalled();
  expect(current.requests.length).toBeGreaterThan(0);
  expect(current.requests.every(row => row.method === "GET")).toBe(true);
  const count = current.requests.length;
  const readback = await runPrivatePublisherOperator(args(packet, "readback"), current.dependencies);
  expect(readback).toMatchObject({ upload: null, preflight: null, operations: { identity: null, version: null, deployment: null, container: null } });
  expect(current.requests).toHaveLength(count);
  expect((await db.listCollections())).toHaveLength(0);
});

it("refuses corrupt original preflight receipts without another provider request", async () => {
  const current = await scenario();
  await runPrivatePublisherOperator(args(packet, "apply"), current.dependencies);
  await db.doc(`privatePairPreflightAttempts/${packet.preflightOperationId}`).update({ resultDigest: "0".repeat(64) });
  const before = { ...current.authority };
  await expect(runPrivatePublisherOperator(args(packet, "readback"), current.dependencies)).rejects.toThrow();
  expect(current.authority).toEqual(before);
});


it("projects only safe refusal codes and reasons from the original failed proof", async () => {
  const current = await scenario({ notReady: true });
  await expect(runPrivatePublisherOperator(args(packet, "apply"), current.dependencies)).rejects.toMatchObject({ code: "private-preflight-not-ready" });
  const before = { ...current.authority };
  expect((await runPrivatePublisherOperator(args(packet, "readback"), current.dependencies)).preflight).toMatchObject({
    state: "failed", refusalCode: "private-preflight-not-ready", refusalReason: "waiting-for-executor" });
  await db.doc(`privatePairPreflightAttempts/${packet.preflightOperationId}`).update({
    refusalCode: "synthetic-sensitive-error", "refusalHealth.reason": "synthetic-sensitive-error" });
  const redacted = (await runPrivatePublisherOperator(args(packet, "readback"), current.dependencies)).preflight;
  expect(redacted.refusalCode).toBe("preflight-refusal-unavailable");
  expect(redacted).not.toHaveProperty("refusalReason");
  expect(JSON.stringify(redacted)).not.toContain("synthetic");
  expect(current.authority).toEqual(before);
});


it("keeps deterministic refusal codes separate from unknown boundary errors without exposing raw text", () => {
  expect(privatePublisherOperatorFailure(new PrivatePairProviderError("source-check-failed"))).toContain("source-check-failed; uncertain=false");
  expect(privatePublisherOperatorFailure(new PrivatePairProviderError("preflight-request-uncertain", true))).toContain("preflight-request-uncertain; uncertain=true");
  expect(privatePublisherOperatorFailure(new PrivatePairProviderError("synthetic-sensitive-value", true))).not.toContain("synthetic");
  expect(privatePublisherOperatorFailure(new Error("synthetic-sensitive-value"))).not.toContain("synthetic");
});

it("installs and reads back the sealed continuation trigger through the actual shared RPC composition", async () => {
  const enabled = structuredClone(packet);
  Object.assign(enabled.intent, { executorReady: true, continuationEnabled: true, ingressProofService: "njpbs-private-ingress-development" });
  const { plan, prepared } = await preparePrivatePairPublisherInstall(enabled.intent);
  enabled.preparation.plan = plan; enabled.preparation.executorReady = prepared.executorReady;
  enabled.preparation.moduleManifest = prepared.moduleManifest;
  const current = await scenario({ continuationEnabled: true });
  const result = await runPrivatePublisherOperator(args(enabled, "apply"), current.dependencies);
  expect(result.trigger).toMatchObject({ workerVersionId: fixture.versionId, schedules: [{ cron: "* * * * *" }] });
  expect(current.writes()).toHaveLength(5);
  expect(current.authority).toEqual({ session: 1, upload: 1, invoke: 1 });
  const readback = await runPrivatePublisherOperator(args(enabled, "readback"), { ...current.dependencies,
    readToken: () => { throw new Error("Historical readback must not request authority"); } });
  expect(readback.operations.trigger).toMatchObject({ state: "verified", response: { workerVersionId: fixture.versionId } });
  expect(readback.preflight).toMatchObject({ state: "complete", operationId: enabled.preflightOperationId });
  expect(await runPrivatePublisherOperator(args(enabled, "apply"), current.dependencies)).toEqual(result);
  await expect(runPrivatePublisherOperator(args(packet, "apply"), current.dependencies)).rejects.toThrow();
  expect(current.writes()).toHaveLength(5); // Registered immutable versions are never amended.
  expect(current.authority).toEqual({ session: 1, upload: 1, invoke: 1 });
});
