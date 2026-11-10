import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { refusedOperatorPrelaunch } from "../helpers/operator-prelaunch.mjs";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { publicSlotScenario } from "../helpers/private-public-release-slot-target.mjs";
import { configurePublicReleaseIngress, configurePublicReleaseSlot } from "../../scripts/configure-public-release-ingress.mjs";
import { compilePrivateWorker } from "../../scripts/install-private-public-release.mjs";
import { installPrivateWorker, cloudflarePrivatePairProvider } from "../../scripts/lib/public-release-private-provider.mjs";
import { privateInstallLedger } from "../../scripts/lib/public-release-private-install-ledger.mjs";
import { enableOldPublicReleaseIngress } from "../../scripts/lib/public-release-old-ingress-operator.mjs";
import { readReviewedIngressRateControls } from "../../scripts/lib/public-release-old-ingress-rate-control.mjs";
import { adoptProductionPublicReleaseIngress, productionIngressAdoptionConfiguration } from "../../scripts/lib/production-public-release-ingress-adoption.mjs";
import { readClosedInitialIngressAuthority } from "../../scripts/lib/public-release-bootstrap-ingress-authority.mjs";
import deployment from "../../functions/lib/public-deployment.js";
import adoption from "../../functions/lib/public-release-bootstrap-adoption.js";
import p from "../../functions/lib/public-release-pair.js";
import work from "../../functions/lib/public-release-pair-work.js";
import admissions from "../../functions/lib/public-release-admission.js";
const rawDb = isolatedFirestore("public-release-old-ingress-operator.test.ts"), emulator = process.env.FIRESTORE_EMULATOR_HOST!;
const authEmulator = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const restoreAuthEmulator = () => {
  if (authEmulator === undefined) delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  else process.env.FIREBASE_AUTH_EMULATOR_HOST = authEmulator;
};
const db = new Proxy(rawDb, { get(target, key) { if (key === "projectId") return "njpbs-site";
  const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; } });
const uid = (i: number) => `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`, hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
beforeEach(async () => {
  vi.stubEnv("CLOUDFLARE_PUBLIC_ZONE_ID", "b".repeat(32));
  vi.stubEnv("CLOUDFLARE_PUBLIC_ROUTE_ID", "c".repeat(32));
  process.env.FIRESTORE_EMULATOR_HOST = emulator; restoreAuthEmulator();
  await clearEmulatorFirestore(`http://${emulator}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, rawDb);
  await rawDb.doc("fixture/connection").get(); delete process.env.FIRESTORE_EMULATOR_HOST; delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
});
afterEach(() => { vi.unstubAllEnvs(); process.env.FIRESTORE_EMULATOR_HOST = emulator; restoreAuthEmulator(); });
async function scenario(oldSlotEnabled = true) {
  const f = publicSlotScenario(), currentPair = { ...f.pair, environment: "production" },
    recoveryPair = { ...structuredClone(f.installPlan.newPair), environment: "production" }, plan = structuredClone(f.installPlan);
  plan.oldPair.environment = "production"; plan.newPair.environment = "production";
  currentPair.readerReceiptDigest = p.publicReleaseDigest({ schemaVersion: 1, environment: currentPair.environment, service: currentPair.publicWorker.service,
    versionId: currentPair.publicWorker.versionId, commitSha: currentPair.commitSha, origin: plan.readerOrigins[0], contractDigest: currentPair.readerContractDigest });
  recoveryPair.readerReceiptDigest = p.publicReleaseDigest({ schemaVersion: 1, environment: recoveryPair.environment, service: recoveryPair.publicWorker.service,
    versionId: recoveryPair.publicWorker.versionId, commitSha: recoveryPair.commitSha, origin: plan.readerOrigins[1], contractDigest: recoveryPair.readerContractDigest });
  plan.slotEnabled = [oldSlotEnabled, true];
  const slotConfig = configurePublicReleaseSlot({ pair: plan.oldPair, accountId: plan.accountId, readerOrigin: plan.readerOrigins[0],
    readerAccess: plan.readerAccess[0], slotEnabled: oldSlotEnabled });
  const slotSource = await compilePrivateWorker(slotConfig.main); plan.slotBundleDigest = hash(slotSource);
  const slot: any = { worker: null, version: null, active: null, source: null };
  const nextSlot: any = { worker: null, version: null, active: null, source: null };
  const nextSlotConfig = configurePublicReleaseSlot({ pair: plan.newPair, accountId: plan.accountId, readerOrigin: plan.readerOrigins[1],
    readerAccess: plan.readerAccess[1], slotEnabled: true });
  const slotRows = [{ state: slot, config: slotConfig, pair: currentPair }, { state: nextSlot, config: nextSlotConfig, pair: recoveryPair }];
  const original = configurePublicReleaseIngress({ oldPair: currentPair, newPair: recoveryPair, accountId: plan.accountId, ingressName: plan.ingressName });
  const source = await compilePrivateWorker(original.main); plan.ingressBundleDigest = hash(source);
  const versions = new Map<string, any>(), bodies = new Map<string, Uint8Array>(), writes: string[] = [];
  let worker: any = null, active: any = null, loseRouteBefore = false, loseRouteAfter = false, changeAuthority = false, changeSlot = false, changeRateControls = false;
  let ratePaths: { viewer: string; cmsRpc: string };
  let lost: string | null = null, afterLoss = false;
  let onUpload: (() => Promise<unknown>) | undefined;
  const cmsConfig = { bindings: [{ name: "fixtureRatePolicy", type: "plain_text", text: "reviewed-fixture" }],
    compatibility_date: "2026-07-09", compatibility_flags: ["nodejs_compat"] };
  const cms: any = { active: { id: uid(70), versions: [{ version_id: uid(71), percentage: 100 }] },
    version: { id: uid(71), resources: { bindings: cmsConfig.bindings,
      script_runtime: { compatibility_date: cmsConfig.compatibility_date, compatibility_flags: cmsConfig.compatibility_flags } } } };
  const route: any = { id: "c".repeat(32), pattern: "https://njpbs.org/*", script: "njpbs-production" };
  const account = plan.accountId, zone = "b".repeat(32);
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const path = new URL(String(input)).pathname.replace("/client/v4", ""), method = init.method ?? "GET", envelope = (result: unknown) => Response.json({ success: true, result });
    expect(init.redirect).toBe("error");
    if (path === `/zones/${zone}`) return envelope({ id: zone, name: "njpbs.org", account: { id: account } });
    if (path === "/zones") return envelope([{ id: zone }]);
    if (path.endsWith("/workers/domains")) return envelope([]);
    if (path.endsWith("/workers/routes")) return envelope([route]);
    if (path.endsWith(`/workers/routes/${route.id}`)) {
      if (method === "PUT") {
        writes.push("route"); if (loseRouteBefore) throw new Error("synthetic-uncertain-before-route");
        Object.assign(route, JSON.parse(String(init.body))); if (loseRouteAfter) throw new Error("synthetic-lost-route-reply");
      }
      return envelope(route);
    }
    if (path.includes("/scripts/njpbs-cms-api/")) {
      expect(method).toBe("GET");
      if (path.endsWith("/deployments")) return envelope([cms.active]);
      if (path.endsWith(`/versions/${uid(71)}`)) return envelope(cms.version);
      throw new Error("Unexpected fake CMS version read");
    }
    if (path.includes("/scripts/njpbs-production/deployments")) return envelope([{ id: uid(50), versions: [{ version_id: uid(51), percentage: 100 }] }]);
    if (path.endsWith("/workers/workers")) {
      const body = JSON.parse(String(init.body));
      const target = slotRows.find(row => row.config.name === body.name);
      if (target) { target.state.worker = { ...body, id: "2".repeat(32) }; return envelope(target.state.worker); }
      worker = { ...body, id: "1".repeat(32) }; return envelope(worker);
    }
    const slotRow = slotRows.find(row => path.includes(`/scripts/${row.config.name}/`) || path.includes(`/workers/workers/${row.config.name}`));
    if (slotRow) {
      const state = slotRow.state;
      if (path.includes("/workers/workers/")) return state.worker ? envelope(state.worker) : new Response(null, { status: 404 });
      if (path.endsWith("/versions")) {
        if (method === "POST") {
          const form = init.body as FormData, metadata = JSON.parse(await (form.get("metadata") as Blob).text());
          state.source = new Uint8Array(await (form.get("index.mjs") as Blob).arrayBuffer());
          state.version = { id: slotRow.pair.publicWorker.versionId, annotations: metadata.annotations, resources: { bindings: metadata.bindings,
            script_runtime: { compatibility_date: metadata.compatibility_date, compatibility_flags: metadata.compatibility_flags } } }; return envelope(state.version);
        }
        return envelope({ items: state.version ? [{ id: state.version.id, annotations: state.version.annotations }] : [] });
      }
      if (path.includes("/versions/")) return envelope(state.version);
      if (path.endsWith("/deployments")) {
        if (method === "POST") state.active = { ...JSON.parse(String(init.body)), id: uid(60) };
        return envelope(method === "POST" ? state.active : state.active ? [state.active] : []);
      }
      if (path.endsWith("/content/v2")) return new Response(state.source, { headers: { "content-type": "application/javascript" } });
      if (path.endsWith("/subdomain")) return envelope({ enabled: false, previews_enabled: false });
    }
    if (path.includes("/workers/workers/")) return worker ? envelope(worker) : new Response(null, { status: 404 });
    if (path.endsWith("/versions")) {
      if (method === "POST") {
        writes.push("upload"); if (lost === "upload" && !afterLoss) throw new Error("synthetic-uncertain-upload");
        const form = init.body as FormData, metadata = JSON.parse(await (form.get("metadata") as Blob).text()), id = uid(30 + versions.size);
        const version = { id, annotations: metadata.annotations, resources: { bindings: metadata.bindings,
          script_runtime: { compatibility_date: metadata.compatibility_date, compatibility_flags: metadata.compatibility_flags } } };
        versions.set(id, version); bodies.set(id, new Uint8Array(await (form.get("index.mjs") as Blob).arrayBuffer()));
        await onUpload?.(); if (lost === "upload" && afterLoss) throw new Error("synthetic-lost-upload-reply"); return envelope(version);
      }
      return envelope({ items: [...versions.values()].map(row => ({ id: row.id, annotations: row.annotations })) });
    }
    if (path.includes("/versions/")) return envelope(versions.get(path.split("/").pop()!));
    if (path.endsWith("/subdomain")) return envelope({ enabled: false, previews_enabled: false });
    if (path.endsWith("/deployments")) {
      if (method === "POST") {
        writes.push("deploy"); if (lost === "deploy" && !afterLoss) throw new Error("synthetic-uncertain-deploy");
        active = { ...JSON.parse(String(init.body)), id: uid(40 + versions.size - 1) };
        if (changeRateControls && versions.size > 1) await db.doc(ratePaths.cmsRpc).update({ policyDigest: "f".repeat(64) });
        if (changeSlot && versions.size > 1) slot.active.versions[0].version_id = uid(99);
        if (changeAuthority && versions.size > 1) await db.doc("system/publicReleaseAdmissions/controls/bootstrapFence").update({ status: "open", resumeReceiptDigest: "f".repeat(64) });
        if (lost === "deploy" && afterLoss) throw new Error("synthetic-lost-deploy-reply"); return envelope(active);
      }
      return envelope(active ? [active] : []);
    }
    if (path.endsWith("/content/v2")) return new Response(bodies.get(active.versions[0].version_id), { headers: { "content-type": "application/javascript" } });
    throw new Error(`Unexpected fake provider request ${path}`);
  };
  const readToken = async () => "synthetic-provider-token", provider = cloudflarePrivatePairProvider({ accountId: account, credential: readToken, fetcher: fetchImpl });
  const ledger = privateInstallLedger(db); await ledger.bindAttempt(plan.operationId, p.publicReleaseDigest(plan));
  await installPrivateWorker({ ledger, provider, attemptId: plan.operationId, config: slotConfig, source: slotSource, dryRun: false });
  await installPrivateWorker({ ledger, provider, attemptId: plan.operationId, config: nextSlotConfig, source: slotSource, dryRun: false });
  await installPrivateWorker({ ledger, provider, attemptId: plan.operationId, config: original, source, dryRun: false }); writes.length = 0;
  const pointer = { ...deployment.initialPublicDeploymentPointer(), activeGeneration: 1, activeCommitSha: currentPair.commitSha,
    activeDeploymentId: "fixture-old", lastReservedGeneration: 1, newestEligibleGeneration: 1, newestEligibleBuildBatchId: "fixture-old", mediaLifecycleReady: true };
  await db.doc("system/publicDeployment").set(pointer);
  const operationId = "original-bootstrap";
  await adoption.closePublicReleaseBootstrapAdmission({ firestore: db, attempt: { schemaVersion: 2, operationId, environment: "production", legacyPointerDigest: adoption.legacyBootstrapPointerDigest(pointer) } });
  const attempt = { schemaVersion: 2, operationId, expectedSourceDigest: p.publicReleaseDigest(pointer), currentPair, recoveryPair,
    admittedContractDigest: "a".repeat(64), qualifications: [0, 1].map(i => ({ qualificationId: `original-qualification-${i}`, receiptDigest: String(i + 1).repeat(64) })) };
  const selector = p.parsePublicReleaseSelector({ ...pointer, schemaVersion: 2, epoch: 1, selectedPair: p.publicReleasePairReference(currentPair),
    recoveryPair: p.publicReleasePairReference(recoveryPair), contentHead: { pairId: currentPair.pairId, viewId: "1".repeat(64), manifestDigest: "2".repeat(64), contextSequence: 0 },
    admittedContractDigest: attempt.admittedContractDigest, priorSelectorDigest: attempt.expectedSourceDigest, switchOperationId: operationId, proofDigest: "c".repeat(64) });
  const media = { schemaVersion: 2, epoch: 1, activeGeneration: 1, lastReservedGeneration: 1, newestEligibleGeneration: 1,
    references: [currentPair, recoveryPair].map(pair => ({ pairId: pair.pairId, manifestDigest: selector.contentHead.manifestDigest })) };
  const head = { schemaVersion: 2, sequence: 0, baselineDigest: "d".repeat(64), lastDigest: "d".repeat(64) };
  const records = { "system/publicDeployment": selector, [`system/publicDeployment/bootstrapSelectors/${operationId}`]: {
    schemaVersion: 2, kind: "public-release-bootstrap", operationId, attemptDigest: p.publicReleaseDigest(attempt), sourceDigest: attempt.expectedSourceDigest,
    selectorDigest: p.publicReleaseDigest(selector), storedSelectorDigest: p.publicReleaseDigest(selector), mediaDigest: p.publicReleaseDigest(media), selector },
    "system/cmsPublicationRuntime": { schemaVersion: 1, phase: "ready", commitSha: currentPair.commitSha, serializerId: "cloudflare-publisher",
      cloud: { phase: "ready", commitSha: currentPair.commitSha, serializerId: "cloudflare-publisher" } },
    "system/publicDeployment/pairMedia/current": media, "system/publicReleaseChanges": head,
    "system/publicReleaseChangeLog": { schemaVersion: 2, enabled: false, pair: selector.selectedPair, head, logEpoch: "original-log" },
    [`${admissions.ADMISSIONS}/controls/adoption`]: { schemaVersion: 2, enabled: false }, [admissions.ADMISSIONS]: admissions.initialAdmissionHead() };
  await Promise.all(Object.entries(records).map(([path, row]) => db.doc(path).set(row)));
  for (const pair of [currentPair, recoveryPair]) {
    await db.doc(work.publicReleasePairPath(pair.pairId)).set(pair);
    await db.doc(`${work.publicReleasePairPath(pair.pairId)}/controls/runtime`).set({ schemaVersion: 2, pairId: pair.pairId, status: "retained" });
  }
  const packet: any = { schemaVersion: 1, kind: "old-only-ingress-operator", operatorCommitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    credentialIdentity: { projectId: "njpbs-site", clientEmail: "fixture-operator@njpbs-site.iam.gserviceaccount.com", privateKeyId: "b".repeat(40), secretRef: "pass://fixture/dev/bootstrap" },
    providerCredentialRef: "pass://fixture/private-pair-install", operationId: "original-old-ingress-enable", bootstrapAttempt: attempt, installPlan: plan,
    originalIngressVersionId: uid(30), originalIngressDeploymentId: uid(40), enableOldIngress: true,
    route: { zoneId: zone, routeId: route.id, pattern: route.pattern, legacyWorker: route.script, legacyVersionId: uid(51), legacyDeploymentId: uid(50) } };
  // Model the future trusted owner's immutable observations only at the SDK
  // boundary. This is not an evidence producer or proof that main has limiters.
  const { main: _main, ...enabledConfig } = { ...original, vars: { ...original.vars, PUBLIC_PAIR_INGRESS_ENABLED: "true" } };
  const rateTarget = { environment: "production", operatorCommitSha: packet.operatorCommitSha,
    pairsDigest: p.publicReleaseDigest([currentPair, recoveryPair]),
    ingress: { service: plan.ingressName, sourceDigest: plan.ingressBundleDigest, originalVersionId: uid(30), originalDeploymentId: uid(40),
      configurationDigest: p.publicReleaseDigest(enabledConfig) },
    cmsRpc: { service: "njpbs-cms-api", entrypoint: "PublicContentEntrypoint", method: "getReleaseDecision" } };
  const rateKey = p.publicReleaseDigest(rateTarget), rateBase = "system/publicReleaseIngressRateControls";
  ratePaths = { viewer: `${rateBase}/viewer/${rateKey}`, cmsRpc: `${rateBase}/cmsRpc/${rateKey}` };
  const rateCommon = { schemaVersion: 1, target: rateTarget, implementationCommitSha: packet.operatorCommitSha,
    reviewDigest: "1".repeat(64), policyDigest: "2".repeat(64), observationsDigest: "3".repeat(64) };
  await db.doc(ratePaths.viewer).set({ ...rateCommon, kind: "public-release-viewer-rate-control",
    configurationDigest: rateTarget.ingress.configurationDigest, providerVersionId: uid(30), providerDeploymentId: uid(40) });
  await db.doc(ratePaths.cmsRpc).set({ ...rateCommon, kind: "public-release-cms-rpc-rate-control",
    configurationDigest: p.publicReleaseDigest(cmsConfig), providerVersionId: uid(71), providerDeploymentId: uid(70) });
  return { packet, selector, route, writes, versions, slot, nextSlot, cms, ratePaths, rateTarget,
    lose: (action: string, after: boolean) => { lost = action; afterLoss = after; },
    onUpload: (effect: () => Promise<unknown>) => { onUpload = effect; },
    changeRateControls: () => { changeRateControls = true; }, changeSlot: () => { changeSlot = true; }, input: { firestore: db, packet, readToken, fetchImpl }, loseBefore: () => { loseRouteBefore = true; },
    loseAfter: () => { loseRouteAfter = true; }, changeAuthority: () => { changeAuthority = true; } };
}
it("uses the actual original private installer and one OLD-only upload/deploy/route, keeping admission closed", async () => {
  const f = await scenario(), first = await enableOldPublicReleaseIngress(f.input);
  expect(f.writes).toEqual(["upload", "deploy", "route"]); expect(first).toMatchObject({ admissionResumed: false, terminalPublicationProof: false, oldPairId: f.packet.bootstrapAttempt.currentPair.pairId });
  expect(await enableOldPublicReleaseIngress(f.input)).toEqual(first); expect(f.writes).toHaveLength(3);
  expect(await enableOldPublicReleaseIngress({ ...f.input, readback: true })).toMatchObject({ historical: true, original: true, complete: true, versionId: uid(31), route: { script: f.packet.installPlan.ingressName } });
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(f.selector);
  expect((await db.doc("system/publicReleaseAdmissions/controls/bootstrapFence").get()).data()?.status).toBe("closed");
  expect((await db.doc("system/publicReleaseChangeLog").get()).data()?.enabled).toBe(false);
});
it("keeps false/absent mode offline in the real pinned default process", async () => {
  const f = await scenario(); delete f.packet.enableOldIngress;
  const dir = await mkdtemp(join(tmpdir(), "old-ingress-"));
  try { const bytes = JSON.stringify(f.packet), path = join(dir, "packet.json"); await writeFile(path, bytes);
    const output = execFileSync(process.execPath, ["scripts/enable-old-public-release-ingress.mjs", "--packet", path, "--packet-digest", hash(bytes)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(JSON.parse(output)).toMatchObject({ mode: "plan", enableOldIngress: false, authorityReads: 0, providerWrites: 0 });
  } finally { await rm(dir, { recursive: true, force: true }); }
  expect(f.writes).toEqual([]);
});
it("refuses an originally disabled OLD serving slot before any upload or route effect", async () => {
  const f = await scenario(false);
  await expect(enableOldPublicReleaseIngress(f.input)).rejects.toThrow(); expect(f.writes).toEqual([]);
  expect(f.route.script).toBe("njpbs-production");
});
it.each(["fence", "receipt", "producer", "pins", "media", "pair", "billing"])("refuses changed %s before any provider mutation", async fault => {
  const f = await scenario();
  if (fault === "fence") await db.doc("system/publicReleaseAdmissions/controls/bootstrapFence").update({ status: "open", resumeReceiptDigest: "f".repeat(64) });
  if (fault === "receipt") await db.doc(`system/publicDeployment/bootstrapSelectors/${f.packet.bootstrapAttempt.operationId}`).delete();
  if (fault === "producer") await db.doc("system/publicReleaseChangeLog").update({ enabled: true });
  if (fault === "pins") await db.doc("system/cmsPublicationRuntime").update({ "cloud.phase": "paused" });
  if (fault === "media") await db.doc("system/publicDeployment/pairMedia/current").update({ activeGeneration: 2 });
  if (fault === "pair") await db.doc(work.publicReleasePairPath(f.packet.bootstrapAttempt.currentPair.pairId)).delete();
  if (fault === "billing") await db.doc("system/billing").set({ disabled: true });
  await expect(enableOldPublicReleaseIngress(f.input)).rejects.toThrow(); expect(f.writes).toEqual([]);
});
it("settles a lost route reply only by GET and holds an absent ambiguous route without another PUT", async () => {
  const f = await scenario(); f.loseAfter(); await enableOldPublicReleaseIngress(f.input); await enableOldPublicReleaseIngress(f.input); expect(f.writes).toHaveLength(3);
  // The separate absent-effect case uses its own fixture in a separate test below.
});
it("never resends an absent ambiguous route and refuses authority drift before exposure", async () => {
  const f = await scenario(); f.loseBefore();
  for (let i = 0; i < 2; i++) await expect(enableOldPublicReleaseIngress(f.input)).rejects.toThrow();
  expect(f.writes).toEqual(["upload", "deploy", "route"]); expect(f.route.script).toBe("njpbs-production");
  expect(await enableOldPublicReleaseIngress({ ...f.input, readback: true })).toMatchObject({ original: true, historical: true, complete: false, route: { script: "njpbs-production" } });
  expect(f.writes).toHaveLength(3);
});
it("rechecks actual held authority after private deployment and before the route write", async () => {
  const f = await scenario(); f.changeAuthority(); await expect(enableOldPublicReleaseIngress(f.input)).rejects.toThrow();
  expect(f.writes).toEqual(["upload", "deploy"]); expect(f.route.script).toBe("njpbs-production");
});
it("bounds a stalled read-only authority transaction by the caller abort signal", async () => {
  const f = await scenario(), controller = new AbortController();
  const stalled = new Proxy(db, { get(target, key) { if (key === "runTransaction") return () => new Promise(() => {});
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; } });
  const pending = readClosedInitialIngressAuthority({ firestore: stalled, attempt: f.packet.bootstrapAttempt, signal: controller.signal });
  controller.abort(); await expect(pending).rejects.toThrow(); expect(f.writes).toEqual([]);
});

it.each(["wrong-commit", "dirty-tree"])("refuses %s before credential-capable ingress imports", async mode => {
  const result = await refusedOperatorPrelaunch({ filename: "enable-old-public-release-ingress.mjs",
    businessPath: "scripts/lib/public-release-old-ingress-operator.mjs", mode });
  expect(result.status).toBe(1); expect(result.stdout).toBe(""); expect(result.evaluated).toBe(false);
});

it("refuses development before any effect so its staff Access gateway is never replaced", async () => {
  const f = await scenario();
  const packet = structuredClone(f.packet);
  packet.bootstrapAttempt.currentPair.environment = "development";
  packet.bootstrapAttempt.recoveryPair.environment = "development";
  await expect(enableOldPublicReleaseIngress({ ...f.input, packet })).rejects.toThrow();
  expect(f.writes).toEqual([]); expect(f.route.script).toBe("njpbs-production");
});

it.each(["deleted", "disabled", "other-version", "source"])("refuses actual OLD slot %s before any ingress mutation", async fault => {
  const f = await scenario();
  if (fault === "deleted") f.slot.worker = null;
  if (fault === "disabled") f.slot.version.resources.bindings.find((row: any) => row.name === "PUBLIC_PAIR_SLOT_ENABLED").text = "false";
  if (fault === "other-version") f.slot.active.versions[0].version_id = uid(99);
  if (fault === "source") f.slot.source = new TextEncoder().encode("changed-slot-source");
  await expect(enableOldPublicReleaseIngress(f.input)).rejects.toThrow(); expect(f.writes).toEqual([]); expect(f.route.script).toBe("njpbs-production");
});
it("refuses OLD slot drift after ingress deploy before claiming the public route", async () => {
  const f = await scenario(); f.changeSlot();
  await expect(enableOldPublicReleaseIngress(f.input)).rejects.toThrow();
  expect(f.writes).toEqual(["upload", "deploy"]); expect(f.route.script).toBe("njpbs-production");
});

it.each(["missing-viewer", "missing-rpc", "source", "pair", "review", "implementation", "viewer-version", "rpc-version", "rpc-metadata"])("refuses %s rate-control evidence before any ingress mutation", async fault => {
  const f = await scenario();
  if (fault === "missing-viewer") await db.doc(f.ratePaths.viewer).delete();
  if (fault === "missing-rpc") await db.doc(f.ratePaths.cmsRpc).delete();
  if (fault === "source") await db.doc(f.ratePaths.viewer).update({ "target.ingress.sourceDigest": "f".repeat(64) });
  if (fault === "pair") await db.doc(f.ratePaths.cmsRpc).update({ "target.pairsDigest": "f".repeat(64) });
  if (fault === "review") await db.doc(f.ratePaths.viewer).update({ reviewDigest: "not-a-review" });
  if (fault === "implementation") await db.doc(f.ratePaths.cmsRpc).update({ implementationCommitSha: "f".repeat(40) });
  if (fault === "viewer-version") await db.doc(f.ratePaths.viewer).update({ providerVersionId: uid(99) });
  if (fault === "rpc-version") f.cms.active.versions[0].version_id = uid(99);
  if (fault === "rpc-metadata") f.cms.version.resources.bindings[0].text = "changed-policy-binding";
  await expect(enableOldPublicReleaseIngress(f.input)).rejects.toThrow(); expect(f.writes).toEqual([]); expect(f.route.script).toBe("njpbs-production");
});
it("refuses a caller rate-control success flag instead of using it as evidence", async () => {
  const f = await scenario(); f.packet.rateControlVerified = true;
  await expect(enableOldPublicReleaseIngress(f.input)).rejects.toThrow(); expect(f.writes).toEqual([]);
});
it("rechecks rate-control receipts after deploy before claiming the public route", async () => {
  const f = await scenario(); f.changeRateControls();
  await expect(enableOldPublicReleaseIngress(f.input)).rejects.toThrow(); expect(f.writes).toEqual(["upload", "deploy"]); expect(f.route.script).toBe("njpbs-production");
});
it("binds rate-control receipts into the original attempt across process retries", async () => {
  const f = await scenario(); await enableOldPublicReleaseIngress(f.input);
  await db.doc(f.ratePaths.cmsRpc).update({ policyDigest: "f".repeat(64) });
  await expect(enableOldPublicReleaseIngress(f.input)).rejects.toThrow();
  await expect(enableOldPublicReleaseIngress({ ...f.input, readback: true })).rejects.toThrow(); expect(f.writes).toHaveLength(3);
});
it("bounds a stalled rate-control SDK read by the caller abort signal", async () => {
  const f = await scenario(), controller = new AbortController();
  const pending = readReviewedIngressRateControls({ firestore: { runTransaction: () => new Promise(() => {}) }, target: f.rateTarget, signal: controller.signal });
  controller.abort(); await expect(pending).rejects.toThrow(); expect(f.writes).toEqual([]);
});

// The SDK fixture supplies a completed native resume receipt. The real receipt
// parser, original enable owner, provider transport and immutable ledger run.
async function adoptionScenario() {
  const f = await scenario(); await enableOldPublicReleaseIngress(f.input); f.writes.length = 0;
  const resumeAttempt = { schemaVersion: 2, operationId: "original-logged-resume", bootstrap: f.packet.bootstrapAttempt,
    qualifications: f.packet.bootstrapAttempt.qualifications };
  const fencePath = "system/publicReleaseAdmissions/controls/bootstrapFence", closed = (await db.doc(fencePath).get()).data()!;
  const producer = { ...(await db.doc("system/publicReleaseChangeLog").get()).data(), enabled: true }, adopted = { schemaVersion: 2, enabled: true };
  const receipt = { schemaVersion: 2, kind: "public-release-bootstrap-resume", operationId: resumeAttempt.operationId,
    attempt: resumeAttempt, attemptDigest: p.publicReleaseDigest(resumeAttempt), closeAttemptDigest: closed.attemptDigest,
    selectorDigest: p.publicReleaseDigest(f.selector),
    bootstrapReceiptDigest: p.publicReleaseDigest((await db.doc(`system/publicDeployment/bootstrapSelectors/${resumeAttempt.bootstrap.operationId}`).get()).data()),
    controlsReceiptDigest: "1".repeat(64), enrollmentReceiptDigest: "2".repeat(64), ingress: {}, readMeasurement: {}, producer, adoption: adopted };
  await db.doc(`system/publicReleaseAdmissions/bootstrapResumes/${resumeAttempt.operationId}`).create(receipt);
  await db.doc(fencePath).set({ ...closed, status: "open", resumeReceiptDigest: p.publicReleaseDigest(receipt) });
  await db.doc("system/publicDeployment/releaseWriter/fence").delete();
  await db.doc("system/publicReleaseChangeLog").set(producer); await db.doc("system/publicReleaseAdmissions/controls/adoption").set(adopted);
  const packet = { schemaVersion: 1, kind: "production-public-release-ingress-adoption", operatorCommitSha: f.packet.operatorCommitSha,
    operationId: "original-production-ingress-adoption", oldIngressPacket: f.packet, resumeAttempt, adoptIngress: true };
  return { ...f, packet, input: { ...f.input, packet } };
}
it("adopts one immutable production ingress version without a route or selector write and reconciles original retries", async () => {
  const f = await adoptionScenario(), first = await adoptProductionPublicReleaseIngress(f.input);
  expect(f.writes).toEqual(["upload", "deploy"]);
  expect(first).toMatchObject({ complete: true, recoveryCaptureEnabled: true, liveCaptureObserved: false, terminalPublicationProof: false, selectorChanged: false });
  expect(await adoptProductionPublicReleaseIngress(f.input)).toEqual(first); expect(f.writes).toHaveLength(2);
  const metadata = f.versions.get(first.versionId).resources.bindings;
  expect(metadata.find((row: any) => row.name === "PUBLIC_PAIR_BOOTSTRAP_ID").text).toBe("");
  expect(metadata.find((row: any) => row.name === "PUBLIC_PAIR_RECOVERY_CAPTURE_ENABLED").text).toBe("true");
  expect(JSON.parse(metadata.find((row: any) => row.name === "PUBLIC_PAIR_IDENTITIES_JSON").text)).toEqual([
    f.packet.oldIngressPacket.bootstrapAttempt.currentPair, f.packet.oldIngressPacket.bootstrapAttempt.recoveryPair]);
  expect((await db.doc("system/publicDeployment").get()).data()).toEqual(f.selector);
  const before = (await db.collection("system/publicReleasePrivateInstalls/plans").get()).size;
  expect(await adoptProductionPublicReleaseIngress({ ...f.input, mode: "readback" })).toMatchObject({ original: true, historical: true, complete: true });
  expect((await db.collection("system/publicReleasePrivateInstalls/plans").get()).size).toBe(before);
  expect(f.writes).toHaveLength(2);
});
it("keeps adoption plan credential-free and false apply inert", async () => {
  const f = await adoptionScenario(); f.packet.adoptIngress = false;
  expect(await adoptProductionPublicReleaseIngress({ packet: f.packet, mode: "plan" })).toMatchObject({ authorityReads: 0, providerWrites: 0 });
  await expect(adoptProductionPublicReleaseIngress(f.input)).rejects.toThrow(); expect(f.writes).toEqual([]);
  const directory = await mkdtemp(join(tmpdir(), "production-ingress-adoption-"));
  try {
    const bytes = JSON.stringify(f.packet), filename = join(directory, "packet.json"); await writeFile(filename, bytes);
    const output = execFileSync(process.execPath, ["scripts/adopt-production-public-release-ingress.mjs", "--packet", filename,
      "--packet-digest", hash(bytes)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(JSON.parse(output)).toMatchObject({ mode: "plan", adoptIngress: false, authorityReads: 0, providerWrites: 0 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
it("reports no original adoption without writing a plan and refuses a changed live CMS limiter on readback", async () => {
  const f = await adoptionScenario();
  const before = (await db.collection("system/publicReleasePrivateInstalls/plans").get()).size;
  expect(await adoptProductionPublicReleaseIngress({ ...f.input, mode: "readback" })).toMatchObject({ original: false, complete: false });
  expect((await db.collection("system/publicReleasePrivateInstalls/plans").get()).size).toBe(before); expect(f.writes).toEqual([]);
  await adoptProductionPublicReleaseIngress(f.input);
  f.cms.active.versions[0].version_id = uid(99);
  await expect(adoptProductionPublicReleaseIngress({ ...f.input, mode: "readback" })).rejects.toThrow();
  expect(f.writes).toEqual(["upload", "deploy"]);
});
it.each(["upload", "deploy"])("reconciles a lost %s reply without another send and leaves an absent ambiguous effect pending", async action => {
  const f = await adoptionScenario(); f.lose(action, true);
  const first = await adoptProductionPublicReleaseIngress(f.input);
  expect(await adoptProductionPublicReleaseIngress(f.input)).toEqual(first); expect(f.writes).toEqual(["upload", "deploy"]);
});
it.each(["upload", "deploy"])("never resends an ambiguous absent %s and reads the partial original without writes", async action => {
  const f = await adoptionScenario(); f.lose(action, false);
  for (let i = 0; i < 2; i++) await expect(adoptProductionPublicReleaseIngress(f.input)).rejects.toThrow();
  const expected = action === "upload" ? ["upload"] : ["upload", "deploy"];
  expect(f.writes).toEqual(expected);
  expect(await adoptProductionPublicReleaseIngress({ ...f.input, mode: "readback" })).toMatchObject({ original: true, historical: true, complete: false });
  expect(f.writes).toEqual(expected);
});
it.each(["resume", "fence", "writer", "adoption", "producer", "pins", "billing", "new-slot", "rate", "cms", "route", "enable-claim"])("refuses adoption with changed %s before upload", async fault => {
  const f = await adoptionScenario();
  if (fault === "resume") await db.doc(`system/publicReleaseAdmissions/bootstrapResumes/${f.packet.resumeAttempt.operationId}`).delete();
  if (fault === "fence") await db.doc("system/publicReleaseAdmissions/controls/bootstrapFence").update({ status: "closed" });
  if (fault === "writer") await db.doc("system/publicDeployment/releaseWriter/fence").set({ schemaVersion: 2 });
  if (fault === "adoption") await db.doc("system/publicReleaseAdmissions/controls/adoption").update({ enabled: false });
  if (fault === "producer") await db.doc("system/publicReleaseChangeLog").update({ enabled: false });
  if (fault === "pins") await db.doc("system/cmsPublicationRuntime").update({ "cloud.phase": "paused" });
  if (fault === "billing") await db.doc("system/billing").set({ disabled: true });
  if (fault === "new-slot") f.nextSlot.active.versions[0].version_id = uid(99);
  if (fault === "rate") await db.doc(f.ratePaths.viewer).delete();
  if (fault === "cms") f.cms.active.versions[0].version_id = uid(99);
  if (fault === "route") f.route.script = "njpbs-production";
  if (fault === "enable-claim") {
    const key = p.publicReleaseDigest({ worker: `bootstrap-ingress:${f.packet.oldIngressPacket.installPlan.ingressName}` });
    await db.doc(`system/publicReleasePrivateInstalls/attempts/${f.packet.oldIngressPacket.operationId}/steps/${key}-enable-route`).delete();
  }
  await expect(adoptProductionPublicReleaseIngress(f.input)).rejects.toThrow(); expect(f.writes).toEqual([]);
});
it.each(["rate", "new-slot", "selector"])("holds deployment when %s drifts after adoption upload", async fault => {
  const f = await adoptionScenario(); f.onUpload(async () => {
    if (fault === "rate") await db.doc(f.ratePaths.cmsRpc).update({ policyDigest: "f".repeat(64) });
    if (fault === "new-slot") f.nextSlot.active.versions[0].version_id = uid(99);
    if (fault === "selector") await db.doc("system/publicDeployment").update({ epoch: 2 });
  });
  await expect(adoptProductionPublicReleaseIngress(f.input)).rejects.toThrow(); expect(f.writes).toEqual(["upload"]);
});
it("allows current OLD content to advance during adoption without freezing staff publication", async () => {
  const f = await adoptionScenario(); f.onUpload(() => db.doc("system/publicDeployment").update({ "contentHead.contextSequence": 1 }));
  expect(await adoptProductionPublicReleaseIngress(f.input)).toMatchObject({ complete: true });
  expect((await db.doc("system/publicDeployment").get()).data()?.contentHead.contextSequence).toBe(1);
});
it.each(["zone", "route", "development", "pair", "extra-field"])("refuses adoption packet %s identity drift", async fault => {
  const f = await adoptionScenario(), raw: any = structuredClone(f.packet);
  if (fault === "zone") raw.oldIngressPacket.route.zoneId = "f".repeat(32);
  if (fault === "route") raw.oldIngressPacket.route.routeId = "f".repeat(32);
  if (fault === "development") raw.oldIngressPacket.bootstrapAttempt.currentPair.environment = "development";
  if (fault === "pair") raw.resumeAttempt.bootstrap.recoveryPair.commitSha = "f".repeat(40);
  if (fault === "extra-field") raw.configuration = {};
  expect(() => productionIngressAdoptionConfiguration(raw)).toThrow(); expect(f.writes).toEqual([]);
});
it.each(["wrong-commit", "dirty-tree"])("refuses adoption %s before credential-capable imports", async mode => {
  const result = await refusedOperatorPrelaunch({ filename: "adopt-production-public-release-ingress.mjs",
    businessPath: "scripts/lib/production-public-release-ingress-adoption.mjs", mode });
  expect(result.status).toBe(1); expect(result.stdout).toBe(""); expect(result.evaluated).toBe(false);
});
