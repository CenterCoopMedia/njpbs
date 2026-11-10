import { beforeEach, expect, it, vi } from "vitest";
import { refusedOperatorPrelaunch } from "../helpers/operator-prelaunch.mjs";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { isolatedFirestore, clearEmulatorFirestore } from "../helpers/emulator-firestore.js";
import { installPrivatePairAccess, runPrivateAccessOperator } from "../../scripts/lib/public-release-private-access-operator.mjs";
const db = isolatedFirestore("public-release-private-access-operator.test.ts");
const uid = (index: number) => `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`;
const packet = () => ({ schemaVersion: 1, kind: "private-pair-access-operator", operatorCommitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  environment: "development", operationId: "original-access-install", accountId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  credentialIdentity: { projectId: "njpbs-site-dev", clientEmail: "fixture-operator@njpbs-site-dev.iam.gserviceaccount.com", privateKeyId: "b".repeat(40), secretRef: "pass://fixture/dev/bootstrap" },
  providerCredentialRef: "pass://fixture/private-pair-install", targets: ["old-reader", "new-reader", "operator"].map((role, i) => ({ role,
    origin: `https://dev-pair-${i === 2 ? "operator" : "reader"}-${i}.njpbs.org`, serviceTokenId: uid(i + 1), clientId: `synthetic${i}.access`, credentialRef: `pass://fixture/dev/pair-${i}` })) });
beforeEach(async () => {
  await clearEmulatorFirestore(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/demo-njpbs/databases/(default)/documents`, { method: "DELETE" }, db);
});
function scenario() {
  const p = packet(), apps: any[] = [], policies = new Map<string, any[]>(), posts: string[] = [];
  let loseAppReply = false, loseAppBefore = false, failPolicyRead = false, tokenEnabled = true;
  const fetchImpl = vi.fn(async (input: any, init: any) => {
    const url = new URL(String(input)), path = url.pathname.replace(`/client/v4/accounts/${p.accountId}/access`, "");
    expect(init.redirect).toBe("error"); expect(init.headers.authorization).toBe("Bearer synthetic-api-token");
    const envelope = (result: unknown) => Response.json({ success: true, result });
    if (path.startsWith("/service_tokens/")) { const target = p.targets.find(row => row.serviceTokenId === path.split("/").pop())!;
      return envelope({ id: target.serviceTokenId, client_id: target.clientId, expires_at: "2099-01-01T00:00:00Z", enabled: tokenEnabled, client_secret: "synthetic-must-not-enter-receipts" }); }
    if (init.method === "POST") {
      // Verify durable authority exists before every network mutation.
      const saved = await db.collection(`system/publicReleasePrivateInstalls/attempts/${p.operationId}/steps`).get();
      expect(saved.docs.some(row => row.data().action === (path === "/apps" ? "access-app" : "access-policy"))).toBe(true);
      posts.push(path); const body = JSON.parse(init.body);
      if (path === "/apps") {
        if (loseAppBefore) throw new Error("synthetic-lost-before-effect");
        const row = { ...body, id: uid(10 + apps.length), aud: String(apps.length + 1).repeat(64) };
        apps.push(row); policies.set(row.id, []);
        if (loseAppReply) throw new Error("synthetic-lost-after-effect");
        return envelope(row);
      }
      const id = path.split("/")[2], rows = policies.get(id)!;
      const row = { ...body, id: uid(20 + apps.length) }; rows.push(row); return envelope(row);
    }
    if (path === "/apps") return envelope(apps);
    const id = path.split("/")[2]; if (path.endsWith("/policies")) {
      if (failPolicyRead) { failPolicyRead = false; return new Response(null, { status: 503 }); }
      return envelope(policies.get(id) ?? []);
    }
    throw new Error("Unexpected provider request");
  });
  const input = { firestore: db, packet: p, readToken: vi.fn(async () => "synthetic-api-token"), fetchImpl };
  return { p, input, apps, policies, posts, disableToken: () => { tokenEnabled = false; }, loseAfter: () => { loseAppReply = true; }, loseBefore: () => { loseAppBefore = true; }, failPolicyReadOnce: () => { failPolicyRead = true; } };
}
it("leaves policy authority unconsumed when its pre-POST GET fails and resumes the same hostname", async () => {
  const f = scenario(); f.failPolicyReadOnce();
  await expect(installPrivatePairAccess(f.input)).rejects.toThrow();
  expect(f.posts).toEqual(["/apps"]);
  const steps = await db.collection(`system/publicReleasePrivateInstalls/attempts/${f.p.operationId}/steps`).get();
  expect(steps.docs.some(row => row.data().action === "access-policy")).toBe(false);
  expect((await installPrivatePairAccess({ ...f.input, readback: true })).targets[0]).toMatchObject({ original: true, policy: null, policyUnclaimed: true });
  f.policies.get(f.apps[0].id)!.push({ id: uid(90), decision: "bypass", include: [{ everyone: {} }] });
  await expect(installPrivatePairAccess({ ...f.input, readback: true })).rejects.toThrow(); expect(f.posts).toEqual(["/apps"]);
  f.policies.get(f.apps[0].id)!.pop();
  expect((await installPrivatePairAccess(f.input)).targets).toHaveLength(3);
  expect(f.posts.filter(path => path === "/apps")).toHaveLength(3); expect(f.posts).toHaveLength(6);
});
it.each(["access-app", "access-policy"])("reports confirmed not-sent %s and retries only the original grant", async action => {
  const f = scenario(); let fail = true;
  f.input.readToken.mockImplementation(async () => {
    const steps = await db.collection(`system/publicReleasePrivateInstalls/attempts/${f.p.operationId}/steps`).get();
    if (fail && steps.docs.some(row => row.data().action === action && row.data().notSent !== true)) {
      fail = false; throw new Error("synthetic-credential-boundary-unavailable");
    }
    return "synthetic-api-token";
  });
  await expect(installPrivatePairAccess(f.input)).rejects.toThrow(); expect(f.posts).toEqual(action === "access-app" ? [] : ["/apps"]);
  const steps = await db.collection(`system/publicReleasePrivateInstalls/attempts/${f.p.operationId}/steps`).get();
  expect(steps.docs.find(row => row.data().action === action)!.data().notSent).toBe(true);
  const readback = await installPrivatePairAccess({ ...f.input, readback: true });
  expect(readback.targets[0]).toMatchObject(action === "access-app" ? { original: false, notSent: true } : { original: true, policy: null, policyNotSent: true });
  expect((await installPrivatePairAccess(f.input)).targets).toHaveLength(3); expect(f.posts).toHaveLength(6);
});
it("installs three isolated applications and exact machine-only policies through original-attempt claims", async () => {
  const f = scenario(); const first = await installPrivatePairAccess(f.input);
  expect(first.targets).toHaveLength(3); expect(f.posts).toHaveLength(6);
  expect(new Set(first.targets.map((row: any) => row.audience)).size).toBe(3);
  expect(await installPrivatePairAccess(f.input)).toEqual(first); expect(f.posts).toHaveLength(6);
  expect(await installPrivatePairAccess({ ...f.input, readback: true })).toMatchObject({ original: true, targets: first.targets.map((row: any) => ({ ...row, original: true })) });
  expect(f.posts).toHaveLength(6);
  const evidence = await db.collection(`system/publicReleasePrivateInstalls/attempts/${f.p.operationId}/readbacks`).get();
  expect(evidence.size).toBe(6); expect(JSON.stringify(evidence.docs.map(row => row.data()))).not.toContain("synthetic-must-not-enter-receipts");
  expect((await db.doc("system/publicDeployment").get()).exists).toBe(false);
  expect((await db.doc("system/publicReleasePairs").get()).exists).toBe(false);
});
it("recovers a lost app reply by exact GET without another provider mutation", async () => {
  const f = scenario(); f.loseAfter();
  await installPrivatePairAccess(f.input);
  expect(f.posts).toHaveLength(6);
  await installPrivatePairAccess(f.input); expect(f.posts).toHaveLength(6);
});
it("keeps an absent ambiguous app uncertain and never resends its original POST", async () => {
  const f = scenario(); f.loseBefore();
  for (let i = 0; i < 2; i++) await expect(installPrivatePairAccess(f.input)).rejects.toThrow();
  expect(f.posts).toEqual(["/apps"]);
  await expect(installPrivatePairAccess({ ...f.input, readback: true })).rejects.toThrow();
  expect(f.posts).toEqual(["/apps"]);
});
it("refuses existing hostname ownership and extra policies without replacing anything", async () => {
  const f = scenario(); f.apps.push({ name: "foreign", domain: new URL(f.p.targets[0].origin).hostname });
  await expect(installPrivatePairAccess(f.input)).rejects.toThrow(); expect(f.posts).toEqual([]);
  f.apps.length = 0; await installPrivatePairAccess(f.input);
  f.policies.get(f.apps[0].id)!.push({ id: uid(50), decision: "bypass", include: [{ everyone: {} }] });
  await expect(installPrivatePairAccess(f.input)).rejects.toThrow(); expect(f.posts).toHaveLength(6);
});
it.each(["secondary", "secondary-path", "secondary-wildcard", "destination"])("refuses %s Access ownership before any application POST", async kind => {
  const f = scenario(), hostname = new URL(f.p.targets[0].origin).hostname.toUpperCase();
  f.apps.push({ name: "foreign", domain: "unrelated.example.test", ...kind === "destination"
    ? { destinations: [{ type: "public", uri: `${hostname}/private/*` }] }
    : { self_hosted_domains: [kind === "secondary-wildcard" ? "*.NJPBS.ORG" : hostname + (kind === "secondary-path" ? "/private/*" : "")] } });
  await expect(installPrivatePairAccess(f.input)).rejects.toThrow(); expect(f.posts).toEqual([]);
});
it("does not adopt a changed packet or shared reader/operator credential", async () => {
  const f = scenario(); await installPrivatePairAccess(f.input);
  await expect(installPrivatePairAccess({ ...f.input, packet: { ...f.p, providerCredentialRef: "pass://different/token" } })).rejects.toThrow();
  f.p.targets[2].clientId = f.p.targets[0].clientId;
  await expect(installPrivatePairAccess(f.input)).rejects.toThrow(); expect(f.posts).toHaveLength(6);
});
it("runs actual default CLI without credentials, SDK or provider I/O and refuses invalid modes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "access-operator-"));
  try {
    const p = packet(), bytes = JSON.stringify(p), filename = join(dir, "packet.json"); await writeFile(filename, bytes);
    const args = ["--packet", filename, "--packet-digest", createHash("sha256").update(bytes).digest("hex")];
    const result = execFileSync(process.execPath, ["scripts/install-private-pair-access.mjs", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(JSON.parse(result)).toMatchObject({ mode: "plan", authorityReads: 0, authorityWrites: 0, providerWrites: 0 });
    const readToken = vi.fn(), readServiceAccount = vi.fn(), openDatabase = vi.fn();
    await expect(runPrivateAccessOperator([...args, "--write"], { readToken, readServiceAccount, openDatabase })).rejects.toThrow();
    await expect(runPrivateAccessOperator([...args, "--apply"], { readToken, readServiceAccount, openDatabase, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(readToken).not.toHaveBeenCalled(); expect(readServiceAccount).not.toHaveBeenCalled(); expect(openDatabase).not.toHaveBeenCalled();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it.each(["wrong-commit", "dirty-tree"])("refuses %s before credential-capable Access imports", async mode => {
  const result = await refusedOperatorPrelaunch({ filename: "install-private-pair-access.mjs",
    businessPath: "scripts/lib/public-release-private-access-operator.mjs", mode });
  expect(result.status).toBe(1); expect(result.stdout).toBe(""); expect(result.evaluated).toBe(false);
});

it.each(["application-id", "audience", "policy-id"])("refuses recreated %s in readback against the original durable receipt", async changed => {
  const f = scenario(); await installPrivatePairAccess(f.input);
  if (changed === "application-id") { const prior = f.apps[0].id; f.apps[0].id = uid(90); f.policies.set(f.apps[0].id, f.policies.get(prior)!); }
  if (changed === "audience") f.apps[0].aud = "f".repeat(64);
  if (changed === "policy-id") f.policies.get(f.apps[0].id)![0].id = uid(91);
  await expect(installPrivatePairAccess({ ...f.input, readback: true })).rejects.toThrow(); expect(f.posts).toHaveLength(6);
});
it("refuses a disabled unexpired service token before any app claim and on original readback", async () => {
  const f = scenario(); f.disableToken();
  await expect(installPrivatePairAccess(f.input)).rejects.toThrow(); expect(f.posts).toEqual([]);
  expect((await db.collection(`system/publicReleasePrivateInstalls/attempts/${f.p.operationId}/steps`).get()).empty).toBe(true);
});
it("refuses a subsequently disabled original token without accepting its installed application", async () => {
  const f = scenario(); await installPrivatePairAccess(f.input); f.disableToken();
  await expect(installPrivatePairAccess({ ...f.input, readback: true })).rejects.toThrow(); expect(f.posts).toHaveLength(6);
});
