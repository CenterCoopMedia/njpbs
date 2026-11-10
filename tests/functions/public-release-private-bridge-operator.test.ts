import { beforeEach, afterEach, expect, it } from "vitest";
import { refusedOperatorPrelaunch } from "../helpers/operator-prelaunch.mjs";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { releasePair } from "../helpers/private-public-release-pair.js";
import { installPrivatePairAccess, runPrivateAccessOperator } from "../../scripts/lib/public-release-private-access-operator.mjs";
import { installPrivatePairBridge, parsePrivateBridgePacket, privateBridgeConfiguration } from "../../scripts/lib/public-release-private-bridge-operator.mjs";
import { parseRehearsalOperatorAccessTarget, createRehearsalOperatorAccess, assertRehearsalOperatorAccessCurrent } from "../../scripts/lib/rehearsal-operator-access.mjs";
import { configurePublicReleaseIngress } from "../../scripts/configure-public-release-ingress.mjs";
import { privateInstallLedger } from "../../scripts/lib/public-release-private-install-ledger.mjs";
import { cloudflarePrivatePairProvider, installPrivateWorker } from "../../scripts/lib/public-release-private-provider.mjs";
import { compilePrivateWorker } from "../../scripts/install-private-public-release.mjs";
import { PAIR_READER_CONTRACT, privatePairReaderCapabilities } from "../../packages/content-core/src/private-pair-http.mjs";
import protocol from "../../functions/lib/public-release-pair.js";
const rawDb = isolatedFirestore("public-release-private-bridge-operator.test.ts"), account = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", zoneId = "2".repeat(32);
const emulator = process.env.FIRESTORE_EMULATOR_HOST!, authEmulator = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const restoreAuthEmulator = () => {
  if (authEmulator === undefined) delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  else process.env.FIREBASE_AUTH_EMULATOR_HOST = authEmulator;
};
// A logical target at the SDK boundary, with its physical channel connected
// only to this file's isolated demo project before the provider guard is tested.
const db = new Proxy(rawDb, { get(target, key) {
  if (key === "projectId") return "njpbs-site-dev";
  const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
} });
const uid = (index: number) => `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`;
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
async function reset() {
  process.env.FIRESTORE_EMULATOR_HOST = emulator; restoreAuthEmulator();
  await clearEmulatorFirestore(`http://${emulator}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, rawDb);
  await rawDb.doc("fixture/connection").get();
  delete process.env.FIRESTORE_EMULATOR_HOST; delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
}
beforeEach(reset);
afterEach(() => { process.env.FIRESTORE_EMULATOR_HOST = emulator; restoreAuthEmulator(); });
async function scenario(role = "old-reader", enabled: boolean | null = true, operatorSuffix = "fixture", domainIdLength: 32 | 40 = 40) {
  const operatorCommitSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const accessPacket = { schemaVersion: 1, kind: "private-pair-access-operator", operatorCommitSha, environment: "development", operationId: "original-access", accountId: account,
    credentialIdentity: { projectId: "njpbs-site-dev", clientEmail: "fixture-operator@njpbs-site-dev.iam.gserviceaccount.com", privateKeyId: "b".repeat(40), secretRef: "pass://fixture/dev/bootstrap" },
    providerCredentialRef: "pass://fixture/private-pair-install", targets: ["old-reader", "new-reader", "operator"].map((role, i) => ({ role,
      origin: `https://dev-pair-${i === 2 ? `operator-${operatorSuffix}` : `reader-${i}`}.njpbs.org`, serviceTokenId: uid(i + 1), clientId: `synthetic${i}.access`, credentialRef: `pass://fixture/dev/pair-${i}` })) };
  const apps: any[] = [], policies = new Map<string, any[]>(), domains: any[] = [], writes: string[] = [];
  const workers = new Map<string, any>();
  let loseDomainBefore = false, loseDomainAfter = false, failDnsRead = false;
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)), path = url.pathname.replace("/client/v4", ""), method = init.method ?? "GET";
    expect(init.redirect).toBe("error"); const envelope = (result: unknown) => Response.json({ success: true, result });
    if (path.includes("/access/")) {
      if (path.includes("/service_tokens/")) { const target = accessPacket.targets.find(row => path.endsWith(row.serviceTokenId))!;
        return envelope({ id: target.serviceTokenId, client_id: target.clientId, enabled: true, expires_at: "2099-01-01T00:00:00Z" }); }
      if (method === "POST") {
        const body = JSON.parse(String(init.body));
        if (path.endsWith("/apps")) { const row = { ...body, id: uid(10 + apps.length), aud: String(apps.length + 1).repeat(64) };
          apps.push(row); policies.set(row.id, []); return envelope(row); }
        const rows = policies.get(path.split("/").at(-2)!)!; const row = { ...body, id: uid(20 + apps.length) }; rows.push(row); return envelope(row);
      }
      return envelope(path.endsWith("/apps") ? apps : apps.find(row => path.endsWith(`/${row.id}`)) ?? policies.get(path.split("/").at(-2)!) ?? []);
    }
    if (path === `/zones/${zoneId}`) return envelope({ id: zoneId, name: "njpbs.org", account: { id: account } });
    if (path.includes("/dns_records") && failDnsRead) { failDnsRead = false; return new Response(null, { status: 503 }); }
    if (path.includes("/dns_records") || path.endsWith("/workers/routes")) return envelope([]);
    if (path === "/zones") return envelope([{ id: zoneId }]);
    if (path.endsWith("/workers/domains")) {
      if (method === "PUT") {
        writes.push("domain"); if (loseDomainBefore) throw new Error("synthetic-unknown-before-domain");
        domains.push({ ...JSON.parse(String(init.body)), id: "d".repeat(domainIdLength) }); if (loseDomainAfter) throw new Error("synthetic-lost-domain-reply");
      }
      return envelope(method === "GET" ? domains : domains[0]);
    }
    if (path.endsWith("/workers/workers")) {
      writes.push("create"); const worker = { ...JSON.parse(String(init.body)), id: String(workers.size + 1).repeat(32) };
      workers.set(worker.name, { worker, version: null, deployment: null, source: new Uint8Array() }); return envelope(worker);
    }
    const name = path.match(/\/(?:scripts|workers\/workers)\/([^/]+)/)?.[1], state = name ? workers.get(name) : null;
    if (path.includes("/workers/workers/")) return state ? envelope(state.worker) : new Response(null, { status: 404 });
    if (path.endsWith("/versions")) {
      if (method === "POST") {
        writes.push("upload"); const form = init.body as FormData;
        const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
        state.source = new Uint8Array(await (form.get("index.mjs") as Blob).arrayBuffer());
        state.version = { id: uid(30 + [...workers.keys()].indexOf(name!)), annotations: metadata.annotations, resources: { bindings: metadata.bindings,
          script_runtime: { compatibility_date: metadata.compatibility_date, compatibility_flags: metadata.compatibility_flags } } }; return envelope(state.version);
      }
      return envelope({ items: state?.version ? [{ id: state.version.id, annotations: state.version.annotations }] : [] });
    }
    if (path.includes("/versions/")) return envelope(state.version);
    if (path.endsWith("/deployments")) {
      if (method === "POST") { writes.push("deploy"); state.deployment = { ...JSON.parse(String(init.body)), id: uid(40 + [...workers.keys()].indexOf(name!)) }; return envelope(state.deployment); }
      return envelope(state?.deployment ? [state.deployment] : []);
    }
    if (path.endsWith("/subdomain")) { if (method === "POST") writes.push("private-subdomain"); return envelope({ enabled: false, previews_enabled: false }); }
    if (path.endsWith("/content/v2")) return new Response(state.source, { headers: { "content-type": "application/javascript" } });
    throw new Error(`Unexpected fake provider request ${path}`);
  };
  const io = { firestore: db, readToken: async () => "synthetic-provider-token", fetchImpl };
  await installPrivatePairAccess({ ...io, packet: accessPacket });
  const accessReadback = await installPrivatePairAccess({ ...io, packet: accessPacket, readback: true });
  const pairs = ["a", "b"].map((slot, index) => {
    const pair = releasePair(slot); pair.readerContractDigest = protocol.publicReleaseDigest(PAIR_READER_CONTRACT);
    pair.capabilityDigest = protocol.publicReleaseDigest(privatePairReaderCapabilities(pair.commitSha));
    pair.readerReceiptDigest = protocol.publicReleaseDigest({ schemaVersion: 1, environment: pair.environment, service: pair.publicWorker.service,
      versionId: pair.publicWorker.versionId, commitSha: pair.commitSha, origin: accessPacket.targets[index].origin, contractDigest: pair.readerContractDigest });
    return pair;
  });
  const packet: any = { schemaVersion: 1, kind: "private-pair-bridge-operator", operatorCommitSha, credentialIdentity: accessPacket.credentialIdentity,
    providerCredentialRef: accessPacket.providerCredentialRef, operationId: "original-private-bridge", accessPacket, accessReadback, pairs,
    ingressName: "njpbs-private-ingress-fixture", zoneId, role, workerName: role === "operator" ? `njpbs-private-operator-${operatorSuffix}` : "njpbs-private-reader-fixture", sourceDigest: "0".repeat(64),
    ...enabled === null ? {} : { enabled } };
  if (role === "operator") {
    const ingress = configurePublicReleaseIngress({ oldPair: pairs[0], newPair: pairs[1], accountId: account, ingressName: packet.ingressName });
    const source = await compilePrivateWorker(ingress.main), ledger = privateInstallLedger(db);
    const plan = { schemaVersion: 1, operationId: "original-private-ingress", accountId: account, ingressName: packet.ingressName,
      oldPair: pairs[0], newPair: pairs[1], slotEnabled: [true, true], readerOrigins: accessPacket.targets.slice(0, 2).map(row => row.origin),
      readerAccess: accessPacket.targets.slice(0, 2).map((row, i) => ({ audience: accessReadback.targets[i].audience, clientId: row.clientId })),
      slotBundleDigest: hash(await compilePrivateWorker("./workers/src/public-release-slot-worker.ts")), ingressBundleDigest: hash(source) };
    await ledger.bindAttempt(plan.operationId, protocol.publicReleaseDigest(plan));
    await installPrivateWorker({ ledger, provider: cloudflarePrivatePairProvider({ accountId: account, credential: io.readToken, fetcher: fetchImpl }),
      attemptId: plan.operationId, config: ingress, source, dryRun: false }); writes.length = 0;
  }
  const { config } = privateBridgeConfiguration(packet); packet.sourceDigest = hash(await compilePrivateWorker(config.main));
  return { packet, workers, input: { ...io, packet }, writes, domains, apps, policies, config,
    loseBefore: () => { loseDomainBefore = true; }, loseAfter: () => { loseDomainAfter = true; }, failDnsOnce: () => { failDnsRead = true; },
    corruptSource: () => { workers.get(packet.workerName).source = new TextEncoder().encode("corrupt"); } };
}
it.each(["old-reader", "operator"])("installs the real %s bundle privately before its guarded Access-only hostname", async role => {
  const f = await scenario(role); const first = await installPrivatePairBridge(f.input);
  expect(f.writes).toEqual(["create", "upload", "private-subdomain", "deploy", "domain"]);
  expect(first.domain?.hostname).toBe(new URL(f.packet.accessReadback.targets[role === "operator" ? 2 : 0].origin).hostname);
  expect(f.domains[0]).toMatchObject({ enabled: true, previews_enabled: false, zone_name: "njpbs.org" });
  expect(await installPrivatePairBridge(f.input)).toEqual(first); expect(f.writes).toHaveLength(5);
  expect(await installPrivatePairBridge({ ...f.input, readback: true })).toEqual(first); expect(f.writes).toHaveLength(5);
  expect((await db.doc("system/publicDeployment").get()).exists).toBe(false);
});
it.each(["a", "a".repeat(40)].flatMap(suffix => [32, 40].map(length => [suffix, length] as const)))(
  "agrees with launcher parsers on the original operator install/readback (%s, %i-hex domain)", async (suffix, length) => {
  const f = await scenario("operator", true, suffix, length as 32 | 40);
  // Both packets and receipts cross the same JSON boundary as launcher files.
  // Access, ingress and bridge claims come from their native SDK owners above.
  const packet = parsePrivateBridgePacket(JSON.parse(JSON.stringify(f.packet)));
  const installed = await installPrivatePairBridge({ ...f.input, packet });
  const original = JSON.parse(JSON.stringify(await installPrivatePairBridge({ ...f.input, packet, readback: true })));
  expect(original).toEqual(installed);
  const { config, target: access } = privateBridgeConfiguration(packet);
  const target = parseRehearsalOperatorAccessTarget({ accountId: config.account_id, workerName: original.domain.service,
    versionId: original.versionId, origin: `https://${original.domain.hostname}`, domainId: original.domain.id, zoneId: packet.zoneId,
    audience: access.audience, clientId: access.clientId, applicationId: access.applicationId,
    policyId: access.policy.policyId, serviceTokenId: packet.accessPacket.targets[2].serviceTokenId });
  expect(target.workerName).toBe(config.name); expect(target.origin).toBe(config.vars.PAIR_PRIVATE_ORIGIN);
  expect(target.domainId).toHaveLength(length);
  const handle = createRehearsalOperatorAccess({ target, readToken: f.input.readToken, fetchImpl: f.input.fetchImpl, authorized: true });
  await expect(assertRehearsalOperatorAccessCurrent(handle, { accountId: target.accountId, workerName: target.workerName,
    versionId: target.versionId })).resolves.toHaveProperty("receiptDigest");
  for (const workerName of ["njpbs-private-ingress-op-fixture", "njpbs-private-operator-", `njpbs-private-operator-${"a".repeat(41)}`]) {
    expect(() => parsePrivateBridgePacket({ ...packet, workerName })).toThrow();
    expect(() => parseRehearsalOperatorAccessTarget({ ...target, workerName })).toThrow();
  }
  for (const origin of ["https://pair-operator-fixture.njpbs.org", "https://pair-operator-dev-fixture.njpbs.org",
    "https://dev-pair-operator-.njpbs.org", "https://dev-pair-operator--a.njpbs.org", `https://dev-pair-operator-${"a".repeat(41)}.njpbs.org`]) {
    expect(() => parseRehearsalOperatorAccessTarget({ ...target, origin })).toThrow();
  }
  for (const domainId of ["", ...[31, 33, 39, 41].map(size => "d".repeat(size)), "g".repeat(length)]) {
    expect(() => parseRehearsalOperatorAccessTarget({ ...target, domainId })).toThrow();
  }
  f.domains[0].id = "e".repeat(length);
  await expect(assertRehearsalOperatorAccessCurrent(handle, { accountId: target.accountId, workerName: target.workerName,
    versionId: target.versionId })).rejects.toThrow();
  expect(f.writes).toEqual(["create", "upload", "private-subdomain", "deploy", "domain"]);
});
it("refuses preview URL drift in actual domain readback without sending another PUT", async () => {
  const f = await scenario(); await installPrivatePairBridge(f.input);
  f.domains[0].previews_enabled = true;
  await expect(installPrivatePairBridge({ ...f.input, readback: true })).rejects.toThrow(); expect(f.writes).toHaveLength(5);
});
it("defaults to a private disabled version and executes the actual pinned CLI plan", async () => {
  const f = await scenario("old-reader", null);
  expect(f.config.vars.PAIR_READER_GATEWAY_ENABLED).toBe("false");
  const dir = await mkdtemp(join(tmpdir(), "bridge-plan-"));
  try {
    const { sourceDigest: _digest, ...intent } = f.packet, intentPath = join(dir, "intent.json"), prepared = join(dir, "prepared.json");
    await writeFile(intentPath, JSON.stringify(intent));
    const preparation = JSON.parse(execFileSync(process.execPath, ["scripts/prepare-private-pair-bridge.mjs", "--input", intentPath, "--output", prepared],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    expect(preparation).toMatchObject({ sourceDigest: f.packet.sourceDigest, providerWrites: 0, authorityReads: 0 });
    const bytes = JSON.stringify(f.packet), path = join(dir, "packet.json"); await writeFile(path, bytes);
    const result = execFileSync(process.execPath, ["scripts/install-private-pair-bridge.mjs", "--packet", path, "--packet-digest", hash(bytes)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(JSON.parse(result)).toMatchObject({ mode: "plan", enabled: false, providerWrites: 0, authorityReads: 0 });
  } finally { await rm(dir, { recursive: true, force: true }); }
  expect((await installPrivatePairBridge(f.input)).domain).toBe(null); expect(f.writes).toHaveLength(4);
});
it("leaves the domain grant unused after a failed DNS read and resumes the original installation", async () => {
  const f = await scenario(); f.failDnsOnce();
  await expect(installPrivatePairBridge(f.input)).rejects.toThrow(); expect(f.writes).toHaveLength(4);
  const rows = await db.collection(`system/publicReleasePrivateInstalls/attempts/${f.packet.operationId}/steps`).get();
  expect(rows.docs.some(row => row.data().action === "domain")).toBe(false);
  expect((await installPrivatePairBridge(f.input)).domain).not.toBe(null); expect(f.writes).toHaveLength(5);
});
it("reconciles a lost hostname reply without another PUT and refuses absent ambiguous effects", async () => {
  const f = await scenario(); f.loseAfter(); const first = await installPrivatePairBridge(f.input);
  expect(first.domain).not.toBe(null); await installPrivatePairBridge(f.input); expect(f.writes).toHaveLength(5);
  await reset();
  const absent = await scenario(); absent.loseBefore();
  await expect(installPrivatePairBridge(absent.input)).rejects.toThrow();
  await expect(installPrivatePairBridge(absent.input)).rejects.toThrow(); expect(absent.writes).toHaveLength(5);
  await expect(installPrivatePairBridge({ ...absent.input, readback: true })).rejects.toThrow(); expect(absent.writes).toHaveLength(5);
});
it.each([null, { policyId: "invalid", policyDigest: "0".repeat(64) }])("refuses an incomplete policy receipt %j before any Worker mutation", async policy => {
  const f = await scenario(); f.packet.accessReadback.targets[0].policy = policy;
  await expect(installPrivatePairBridge(f.input)).rejects.toThrow(); expect(f.writes).toEqual([]);
});
it("refuses changed Access policy before upload and source drift in recovery without repair", async () => {
  const f = await scenario(); f.policies.get(f.apps[0].id)!.push({ decision: "bypass", include: [{ everyone: {} }] });
  await expect(installPrivatePairBridge(f.input)).rejects.toThrow(); expect(f.writes).toEqual([]);
  f.policies.get(f.apps[0].id)!.pop(); await installPrivatePairBridge(f.input); f.corruptSource();
  await expect(installPrivatePairBridge({ ...f.input, readback: true })).rejects.toThrow(); expect(f.writes).toHaveLength(5);
});

it.each(["wrong-commit", "dirty-tree"])("refuses %s before credential-capable bridge imports", async mode => {
  const result = await refusedOperatorPrelaunch({ filename: "install-private-pair-bridge.mjs",
    businessPath: "scripts/lib/public-release-private-bridge-operator.mjs", mode });
  expect(result.status).toBe(1); expect(result.stdout).toBe(""); expect(result.evaluated).toBe(false);
});

it.each(["missing-owner", "missing-receipt", "other-pair", "provider-pairs"])("refuses %s ingress evidence before any proof-operator mutation", async fault => {
  const f = await scenario("operator"), key = protocol.publicReleaseDigest({ worker: f.packet.ingressName });
  if (fault === "missing-owner") await db.doc(`system/publicReleasePrivateInstalls/workers/${key}`).delete();
  if (fault === "missing-receipt") await db.doc(`system/publicReleasePrivateInstalls/attempts/original-private-ingress/readbacks/${key}-deploy`).delete();
  if (fault === "other-pair") f.packet.pairs[1].capabilityDigest = "f".repeat(64);
  if (fault === "provider-pairs") f.workers.get(f.packet.ingressName).version.resources.bindings
    .find((row: any) => row.name === "PUBLIC_PAIR_IDENTITIES_JSON").text = "[]";
  await expect(installPrivatePairBridge(f.input)).rejects.toThrow(); expect(f.writes).toEqual([]);
});
it("refuses an unclaimed attached domain in the original-attempt readback", async () => {
  const f = await scenario(); f.failDnsOnce(); await expect(installPrivatePairBridge(f.input)).rejects.toThrow();
  f.domains.push({ id: "d".repeat(40), hostname: f.packet.accessReadback.targets[0].domain, service: f.packet.workerName,
    zone_id: zoneId, zone_name: "njpbs.org", environment: "production", enabled: true, previews_enabled: false });
  await expect(installPrivatePairBridge({ ...f.input, readback: true })).rejects.toThrow(); expect(f.writes).toHaveLength(4);
});
it("refuses a reattached domain whose provider ID differs from the original receipt", async () => {
  const f = await scenario(); await installPrivatePairBridge(f.input); f.domains[0].id = "e".repeat(40);
  await expect(installPrivatePairBridge({ ...f.input, readback: true })).rejects.toThrow(); expect(f.writes).toHaveLength(5);
});

it("accepts older documented 32-hex custom-domain IDs as well as live 40-hex IDs", async () => {
  const f = await scenario(); await installPrivatePairBridge(f.input);
  expect(f.domains[0].id).toHaveLength(40);
  // Use a separate fresh attempt for the older provider response, never amend a receipt.
  await reset(); const legacy = await scenario();
  const originalFetch = legacy.input.fetchImpl;
  legacy.input.fetchImpl = async (url, init) => {
    const result = await originalFetch(url, init);
    if (String(url).endsWith("/workers/domains") && init?.method === "PUT") legacy.domains[0].id = "d".repeat(32);
    return result;
  };
  expect((await installPrivatePairBridge(legacy.input)).domain?.id).toHaveLength(32);
});
it("accepts the actual Access readback command wrapper and seals its original evidence", async () => {
  const f = await scenario(), dir = await mkdtemp(join(tmpdir(), "bridge-access-wrapper-"));
  try {
    const bytes = JSON.stringify(f.packet.accessPacket), path = join(dir, "access.json"); await writeFile(path, bytes);
    const identity = f.packet.credentialIdentity;
    const wrapper = await runPrivateAccessOperator(["--packet", path, "--packet-digest", hash(bytes), "--readback"], {
      readToken: f.input.readToken, readServiceAccount: async () => JSON.stringify({ type: "service_account", project_id: identity.projectId,
        client_email: identity.clientEmail, private_key_id: identity.privateKeyId, private_key: "synthetic-not-a-real-key-value-1234567890" }),
      openDatabase: async () => ({ firestore: db, close: async () => {} }), fetchImpl: f.input.fetchImpl });
    expect(wrapper.mode).toBe("readback"); f.packet.accessReadback = wrapper;
    expect((await installPrivatePairBridge(f.input)).domain).not.toBe(null); expect(f.writes).toHaveLength(5);
    const changed = structuredClone(f.packet); changed.accessReadback.mode = "apply";
    await expect(installPrivatePairBridge({ ...f.input, packet: changed })).rejects.toThrow(); expect(f.writes).toHaveLength(5);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
