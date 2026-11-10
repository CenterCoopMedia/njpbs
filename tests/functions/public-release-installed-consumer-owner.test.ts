import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { functionsInventoryIdentity } from "../../scripts/lib/cms-component-receipt.mjs";
import consumers from "../../functions/lib/public-release-installed-consumers.js";
import protocol from "../../functions/lib/public-release-pair.js";
import admission from "../../functions/lib/public-release-admission.js";
import { readInstalledPublicReleaseConsumerDeployment, prepareInstalledPublicReleaseConsumers, assertInstalledPublicReleaseConsumersInTransaction } from "../../site/scripts/public-release-installed-consumer-owner";
import { installedConsumerFixture as fixture, sourceSha } from "../helpers/public-release-installed-consumers";

it("uses the actual production and development export names", () => {
  for (const name of ["cmsGetPublicPage", "cmsSaveContent", "cmsTransitionContent", "onScheduledPublish"]) {
    expect(readFileSync("functions/index.js", "utf8")).toContain(`lazyExport("${name}",`);
    expect(readFileSync("functions/dev-manifest.js", "utf8")).toContain(`${name}:`);
  }
});

it("prepares actual provider/source-receipt evidence and accepts only its original opaque SDK-bound handle", async () => {
  const f = fixture(), proof = await prepareInstalledPublicReleaseConsumers(f.options);
  expect(proof).toMatchObject({ sourceSha, sourceDigest: protocol.publicReleaseDigest(f.files), contractDigest: f.contractDigest });
  expect(await f.assert(proof)).toBe(proof);
  await expect(f.assert({ ...proof })).rejects.toThrow("not proven");
  await expect(f.assert(proof, { firestore: { ...f.firestore } })).rejects.toThrow("not proven");
  await expect(f.assert(proof, { environment: "production" })).rejects.toThrow("not proven");
  await expect(f.assert(proof, { contractDigest: "f".repeat(64) })).rejects.toThrow("not proven");
});
it.each(["root", "deployment", "reader", "contract", "expiry", "clock-reversed"])("refuses late %s drift", async fault => {
  const f = fixture(), proof = await prepareInstalledPublicReleaseConsumers(f.options);
  if (fault === "root") f.data.set("system/publicDeployment", { ...f.root, activeGeneration: 2, lastReservedGeneration: 2, newestEligibleGeneration: 2 });
  if (fault === "deployment") f.data.set("cmsDeploymentReceipts/functions", { ...f.data.get("cmsDeploymentReceipts/functions"), state: "in_progress" });
  if (fault === "reader") f.data.delete("cmsReaderCompatibilityReceipts/functions");
  if (fault === "contract") f.data.set(`${admission.CONTRACTS}/${f.contractDigest}`, { schemaVersion: 2, families: [], features: [] });
  if (fault === "expiry") f.advance(60_001);
  if (fault === "clock-reversed") f.advance(-1);
  await expect(f.assert(proof)).rejects.toThrow();
});
it.each([60_001, -1])("refuses a proof whose freshness changes by %i ms while the final SDK read is pending", async delay => {
  const f = fixture(), proof = await prepareInstalledPublicReleaseConsumers(f.options), read = f.transaction.getAll;
  f.transaction.getAll = async (...refs: unknown[]) => { const rows = await read(...refs); f.advance(delay); return rows; };
  await expect(f.assert(proof)).rejects.toThrow("not proven");
});
it.each(["source", "archive", "graph", "stale-receipt", "missing", "inactive", "split-traffic", "revision", "flags", "nonce", "inventory-change", "configuration"])("refuses initial %s mismatch", async fault => {
  const f = fixture();
  if (fault === "source") f.source.files[0] = { ...f.source.files[0], sha256: "0".repeat(64) };
  if (fault === "archive") f.inventory[1].buildConfig.source.storageSource.generation = "8";
  if (fault === "graph") f.source.functionGraph.exports.cmsSaveContent.fingerprint = "0".repeat(64);
  if (fault === "stale-receipt") f.data.get("cmsDeploymentReceipts/functions").mutation.sourceSha = "0".repeat(40);
  if (fault === "missing") f.inventory.splice(1, 1);
  if (fault === "inactive") f.inventory[1].state = "DEPLOYING";
  if (fault === "split-traffic") f.inventory[1].serviceConfig.allTrafficOnLatestRevision = false;
  if (fault === "revision") f.inventory[0].serviceConfig.revision = "different-revision";
  const originalProbe = f.provider.readProbe;
  if (fault === "source" || fault === "revision" || fault === "flags" || fault === "nonce") f.provider.readProbe = async (rows, nonce) => {
    const observed = await originalProbe(rows, nonce);
    if (fault === "source") return { ...observed, files: consumers.INSTALLED_CONSUMER_FILES.map(path => ({ path, sha256: "c".repeat(64) })) };
    if (fault === "revision") return { ...observed, revision: "cmsgetpublicpage-00001-abc" };
    if (fault === "flags") return { ...observed, flags: { ...observed.flags, PUBLIC_RELEASE_READERS_ENABLED: false } };
    return { ...observed, nonce: "0".repeat(64) };
  };
  if (fault === "inventory-change") { let reads = 0; const original = f.provider.readInventory;
    f.provider.readInventory = async () => { const rows = await original(); if (++reads === 2) rows[0].updateTime = "2026-10-29T00:00:01Z"; return rows; }; }
  if (fault === "configuration") { const reader = structuredClone(f.data.get("cmsReaderCompatibilityReceipts/functions"));
    reader.lastComplete.configurationFingerprint = "0".repeat(64); f.data.set("cmsReaderCompatibilityReceipts/functions", reader); }
  await expect(prepareInstalledPublicReleaseConsumers(f.options)).rejects.toThrow();
});
it("starts freshness at the first SDK observation, not the end of provider preparation", async () => {
  const f = fixture(), original = f.provider.readInventory;
  f.provider.readInventory = async () => { f.advance(30_000); return original(); };
  const proof = await prepareInstalledPublicReleaseConsumers(f.options);
  expect(await f.assert(proof)).toBe(proof);
  f.advance(1); await expect(f.assert(proof)).rejects.toThrow("not proven");
});
it("refuses a probe-only revision mismatch against otherwise unchanged live inventory and receipts", async () => {
  const f = fixture(), read = f.provider.readProbe;
  f.provider.readProbe = async (rows, nonce) => ({ ...await read(rows, nonce), revision: "unrelated-revision" });
  await expect(prepareInstalledPublicReleaseConsumers(f.options)).rejects.toThrow("not proven");
});
it.each(["missing", "inactive", "environment", "entry-point", "missing-generation"])("refuses %s even if a receipt captured that inventory", async fault => {
  const f = fixture();
  if (fault === "missing") f.inventory.splice(1, 1);
  if (fault === "inactive") f.inventory[1].state = "DEPLOYING";
  if (fault === "environment") f.inventory[1].environment = "GEN_1";
  if (fault === "entry-point") f.inventory[1].buildConfig.entryPoint = "cmsGetPublicPage";
  if (fault === "missing-generation") f.inventory[1].buildConfig.source.storageSource.generation = "";
  const identities = functionsInventoryIdentity(f.inventory);
  f.data.get("cmsDeploymentReceipts/functions").mutation.providerIdentities = identities;
  f.data.get("cmsReaderCompatibilityReceipts/functions").lastComplete.providerIdentities = identities;
  await expect(prepareInstalledPublicReleaseConsumers(f.options)).rejects.toThrow("not proven");
});

it("reads deployment probe evidence before a public contract/root exists without granting an opaque control proof", async () => {
  const f = fixture();
  f.data.delete("system/publicDeployment");
  for (const key of f.data.keys()) if (key.endsWith(f.contractDigest)) f.data.delete(key);
  const report = await readInstalledPublicReleaseConsumerDeployment(f.options);
  expect(report.sourceSha).toBe(f.options.sourceSha);
  expect(report.probe.flags).toEqual({ PUBLIC_RELEASE_READERS_ENABLED: true, PUBLIC_RELEASE_COMPOSED_READERS_ENABLED: true });
  await expect(prepareInstalledPublicReleaseConsumers(f.options)).rejects.toThrow();
});
it("refuses a deployment report when a native receipt changes during the probe", async () => {
  const f = fixture(), readProbe = f.provider.readProbe;
  f.provider.readProbe = async (...args) => {
    const value = await readProbe(...args);
    f.data.get("cmsDeploymentReceipts/functions").state = "in_progress";
    return value;
  };
  await expect(readInstalledPublicReleaseConsumerDeployment(f.options)).rejects.toThrow("not proven");
});
