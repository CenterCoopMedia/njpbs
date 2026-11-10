import consumers from "../../functions/lib/public-release-installed-consumers.js";
import protocol from "../../functions/lib/public-release-pair.js";
import admission from "../../functions/lib/public-release-admission.js";
import { functionsInventoryIdentity } from "../../scripts/lib/cms-component-receipt.mjs";
import { assertInstalledPublicReleaseConsumersInTransaction } from "../../site/scripts/public-release-installed-consumer-owner";
export const sourceSha = "b".repeat(40), configurationFingerprint = "d".repeat(64), inputFingerprint = "e".repeat(64);
export function installedConsumerFixture(environment: 'development' | 'production' = 'development') {
  const projectId = environment === 'development' ? 'njpbs-site-dev' : 'njpbs-site';
  const names = ["cmsGetPublicPage", "cmsSaveContent", "cmsTransitionContent", "onScheduledPublish"];
  const inventory = names.map(name => ({ name: `projects/${projectId}/locations/us-central1/functions/${name}`,
    state: "ACTIVE", environment: "GEN_2", updateTime: "2026-10-29T00:00:00Z",
    buildConfig: { entryPoint: name, runtime: "nodejs22", source: { storageSource: { bucket: "fixture-source", object: `${name}/archive.tar.gz`, generation: "7" } },
      sourceProvenance: { resolvedStorageSource: null } },
    serviceConfig: { service: name.toLowerCase(), uri: `https://${name.toLowerCase()}.run.app`, revision: `${name.toLowerCase()}-00001-abc`,
      allTrafficOnLatestRevision: true, environmentVariables: {}, secretEnvironmentVariables: [] } }));
  const identities = functionsInventoryIdentity(inventory);
  const files = consumers.INSTALLED_CONSUMER_FILES.map(path => ({ path, sha256: "c".repeat(64) }));
  const source = { files, inputFingerprint, functionGraph: { version: 2, globalFingerprint: "f".repeat(64),
    exports: Object.fromEntries(names.map(name => [name, { fingerprint: "9".repeat(64), preview: false }])) } };
  const root = { schemaVersion: 1, mediaLifecycleReady: true, state: "idle", activeGeneration: 1,
    activeCommitSha: "a".repeat(40), activeDeploymentId: "old-public", lastReservedGeneration: 1,
    newestEligibleGeneration: 1, newestEligibleBuildBatchId: "old-public" };
  const contract = { schemaVersion: 2, families: ["posts"], features: [] }, contractDigest = protocol.publicReleaseDigest(contract);
  const data = new Map<string, any>([
    ["system/publicDeployment", root], [`${admission.CONTRACTS}/${contractDigest}`, contract],
    ["cmsDeploymentReceipts/functions", { schemaVersion: 1, component: "functions", state: "complete", mutation: {
      sourceSha, inputFingerprint, functionGraph: structuredClone(source.functionGraph), configurationFingerprint, providerIdentities: identities } }],
    ["cmsReaderCompatibilityReceipts/functions", { schemaVersion: 2, component: "functions", state: "complete", lastComplete: {
      schemaVersion: 2, component: "functions", sourceSha, inputFingerprint, configurationFingerprint, providerIdentities: identities,
      supported: { previewRequest: [1], postChrome: [1], settings: [1], capabilities: [1], adminSession: [1] }, verifiedAt: "2026-10-29T00:00:00.000Z" } }],
  ]);
  const doc = (path: string) => ({ path });
  const getAll = async (...refs: { path: string }[]) => refs.map(ref => ({ ref, exists: data.has(ref.path), data: () => structuredClone(data.get(ref.path)) }));
  const firestore = { projectId, doc, getAll } as any, transaction = { getAll } as any;
  let now = 1_800_000_000_000;
  const provider = { readInventory: async () => structuredClone(inventory), readProbe: async (_inventory: any, nonce: string) => ({
    schemaVersion: 2 as const, kind: "public-release-installed-consumers" as const, nonce,
    revision: inventory[0].serviceConfig.revision, files, sourceDigest: protocol.publicReleaseDigest(files),
    flags: { PUBLIC_RELEASE_READERS_ENABLED: true, PUBLIC_RELEASE_COMPOSED_READERS_ENABLED: true } }) };
  const options = { firestore, environment, sourceSha, contractDigest, provider,
    readSource: async () => source, clock: () => now };
  return { inventory, files, source, root, contractDigest, data, firestore, transaction, provider, options,
    advance: (ms: number) => { now += ms; },
    assert: (proof: any, overrides = {}) => assertInstalledPublicReleaseConsumersInTransaction({ firestore, transaction, proof,
      environment, contractDigest, before: root, ...overrides }) };
}
