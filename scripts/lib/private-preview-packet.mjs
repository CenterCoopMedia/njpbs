import { assertDevelopmentSource } from "../render-development-config.mjs";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { preparePrivatePreviewPair, previewProviderDigest } from "./private-preview-pair-provider.mjs";
import { installPrivatePreviewPair } from "./install-private-preview-pair.mjs";
import preview from "../../functions/lib/cms-preview-pair.js";

const HEX = /^[a-f0-9]{64}$/, SHA = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const RESOURCE = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
const fail = () => { throw new Error("Private preview packet refused"); };
const same = (a, b) => { if (previewProviderDigest(a) !== previewProviderDigest(b)) fail(); };
export function exactPreviewFields(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) fail();
}
export function readPreviewJson(filename, max = 64 * 1024) {
  const bytes = readFileSync(filename); if (!bytes.length || bytes.length > max) fail();
  return { value: JSON.parse(bytes.toString("utf8")), digest: createHash("sha256").update(bytes).digest("hex") };
}
/** Shared with the existing installer: validate exact bytes and clean source
 * before credentials. No SDK, token stream or provider is used by this loader. */
export async function loadPrivatePreviewPacket(filename, root, mode) {
  const { value: packet, digest: packetDigest } = readPreviewJson(filename);
  exactPreviewFields(packet, ["schemaVersion", "sourceSha", "pair", "config", "image", "multipartPath", "multipartDigest", "request", "resourceOperationId"]);
  if (packet.schemaVersion !== 1 || !SHA.test(packet.sourceSha) || !HEX.test(packet.multipartDigest) ||
      typeof packet.multipartPath !== "string" || !path.isAbsolute(packet.multipartPath) || packet.config?.main !== path.join(root, "preview-renderer/worker.ts") ||
      !/^preview-[a-z0-9][a-z0-9-]{0,31}$/.test(packet.resourceOperationId)) fail();
  if (["apply", "plan"].includes(mode) && packet.resourceOperationId !== packet.request?.operationId) fail();
  const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (git(["rev-parse", "HEAD"]) !== packet.sourceSha || !assertDevelopmentSource(root)) fail();
  const bytes = readFileSync(packet.multipartPath);
  if (bytes.length > 32 * 1024 * 1024 || createHash("sha256").update(bytes).digest("hex") !== packet.multipartDigest) fail();
  const prepared = await preparePrivatePreviewPair({ pair: packet.pair, config: packet.config, image: packet.image, multipart: new Uint8Array(bytes) });
  // Validate the exact qualification request through its real owner. The
  // resource plan always retains the original resource operation identity.
  const input = { prepared, readToken: fail, readSecret: fail, dryRun: true };
  await installPrivatePreviewPair({ ...input, request: packet.request });
  const { plan, planDigest } = await installPrivatePreviewPair({ ...input, request: { ...packet.request, operationId: packet.resourceOperationId } });
  return { packet, packetDigest, prepared, plan, planDigest };
}
const timestamp = value => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail();
};
/** Allowlisted original receipts, never raw SDK data. Unexpected fields refuse
 * rather than risking credential/provider text in output. No timestamps change. */
export function privatePreviewPacketReadback(loaded, resource, qualification) {
  const { packet, prepared, plan, planDigest } = loaded;
  if (resource !== null) {
    exactPreviewFields(resource, ["schemaVersion", "plan", "planDigest", "pair", "installedTargetDigest", "providerEvidence", "completedAt"]);
    if (resource.schemaVersion !== 1) fail();
    same(resource.plan, plan); same(resource.planDigest, planDigest);
    const pair = preview.parsePair(resource.pair);
    if (!UUID.test(pair.workerVersion)) fail();
    same(pair, { ...prepared.pair, workerVersion: pair.workerVersion });
    const e = resource.providerEvidence;
    exactPreviewFields(e, ["worker", "version", "deployment", "namespace", "privacy", "schedules", "container"]);
    const workerId = e.worker?.workerId, namespaceId = e.namespace?.namespaceId, applicationId = e.container?.applicationId, deploymentId = e.deployment?.deploymentId;
    if (![workerId, namespaceId, applicationId].every(v => typeof v === "string" && RESOURCE.test(v)) || !UUID.test(deploymentId)) fail();
    same(e.worker, { workerId, name: pair.workerName, private: true, operationDigest: planDigest });
    same(e.version, { versionId: pair.workerVersion, namespaceId: null, bundleDigest: prepared.bundleDigest, configurationDigest: prepared.configurationDigest });
    same(e.deployment, { deploymentId, versionId: pair.workerVersion });
    same(e.namespace, { namespaceId, versionId: pair.workerVersion });
    same(e.container, { applicationId, namespaceId, imageDigest: pair.imageDigest, configurationDigest: prepared.configurationDigest });
    same(e.schedules, { crons: ["* * * * *"] });
    exactPreviewFields(e.privacy, ["private", "zoneIds", "domainCount", "routeCount", "subdomain"]);
    if (e.privacy.private !== true || !Array.isArray(e.privacy.zoneIds) || e.privacy.zoneIds.length > 1000 ||
        e.privacy.zoneIds.some(v => typeof v !== "string" || !/^[a-f0-9]{32}$/.test(v)) ||
        new Set(e.privacy.zoneIds).size !== e.privacy.zoneIds.length ||
        ![e.privacy.domainCount, e.privacy.routeCount].every(v => Number.isSafeInteger(v) && v >= 0)) fail();
    same(e.privacy.subdomain, { enabled: false, previews_enabled: false });
    same(resource.installedTargetDigest, previewProviderDigest({ pair, worker: e.worker, version: e.version, deployment: e.deployment,
      namespace: e.namespace, ingress: { private: true, subdomain: e.privacy.subdomain, routes: [], domains: [] }, schedules: e.schedules, container: e.container }));
    timestamp(resource.completedAt);
  }
  if (qualification !== null) {
    if (!resource) fail();
    exactPreviewFields(qualification, ["schemaVersion", "resourceOperationId", "request", "requestDigest", "pair", "installedTargetDigest", "health", "completedAt"]);
    if (qualification.schemaVersion !== 1 || qualification.resourceOperationId !== packet.resourceOperationId) fail();
    same(qualification.request, packet.request);
    same(qualification.requestDigest, previewProviderDigest({ resourceOperationId: packet.resourceOperationId, request: packet.request }));
    same(qualification.pair, resource.pair); same(qualification.installedTargetDigest, resource.installedTargetDigest);
    const pair = resource.pair;
    same(qualification.health, { ready: true, pairId: pair.pairId, rendererSha: pair.rendererSha, serializerId: pair.serializerId, workerVersion: pair.workerVersion });
    timestamp(qualification.completedAt);
  }
  return { schemaVersion: 1, resourcePath: `cmsPreviewPrivateInstalls/${packet.resourceOperationId}`,
    healthPath: `cmsPreviewPrivateHealth/${packet.request.operationId}`,
    resourceDigest: resource === null ? null : previewProviderDigest(resource),
    healthDigest: qualification === null ? null : previewProviderDigest(qualification), resource, qualification };
}
/** Offline binding only: archived receipts are not a current provider preflight,
 * replay proof, selector decision or production authorization. */
export function bindPrivatePreviewPackets(manifest, old, next, readbacks) {
  exactPreviewFields(manifest, ["schemaVersion", "oldRendererSha", "newRendererSha", "OLD", "NEW"]);
  if (manifest.schemaVersion !== 1 || !SHA.test(manifest.oldRendererSha) || !SHA.test(manifest.newRendererSha)) fail();
  for (const [role, loaded, source] of [["OLD", old, manifest.oldRendererSha], ["NEW", next, manifest.newRendererSha]]) {
    exactPreviewFields(manifest[role], ["packetPath", "packetDigest"]);
    if (typeof manifest[role].packetPath !== "string" || !path.isAbsolute(manifest[role].packetPath) || !HEX.test(manifest[role].packetDigest)) fail();
    same(manifest[role].packetDigest, loaded.packetDigest); same(loaded.prepared.pair.rendererSha, source);
  }
  same(old.packet.sourceSha, next.packet.sourceSha); same(old.prepared.environment, next.prepared.environment);
  same(old.packet.request.expectedRuntimeDigest, next.packet.request.expectedRuntimeDigest);
  same(old.packet.request.bootstrapPublicPair, next.packet.request.bootstrapPublicPair);
  for (const key of ["pairId", "serializerId", "workerName", "applicationName"]) if (old.prepared.pair[key] === next.prepared.pair[key]) fail();
  // Resource and proof operations share a global private-preflight namespace.
  const a = [old.packet.resourceOperationId, old.packet.request.operationId], b = [next.packet.resourceOperationId, next.packet.request.operationId];
  if (a.some(id => b.includes(id)) || `renderer-${old.packet.request.candidate.runId}-${old.packet.request.candidate.runAttempt}` ===
      `renderer-${next.packet.request.candidate.runId}-${next.packet.request.candidate.runAttempt}`) fail();
  const entry = loaded => ({ packetDigest: loaded.packetDigest, resourceOperationId: loaded.packet.resourceOperationId,
    healthOperationId: loaded.packet.request.operationId, plan: loaded.plan, planDigest: loaded.planDigest, request: loaded.packet.request });
  const binding = { sourceSha: old.packet.sourceSha, environment: old.prepared.environment,
    oldRendererSha: manifest.oldRendererSha, newRendererSha: manifest.newRendererSha, OLD: entry(old), NEW: entry(next) };
  const result = { schemaVersion: 1, productionAuthority: false, binding, bindingDigest: previewProviderDigest(binding) };
  if (readbacks !== undefined) {
    exactPreviewFields(readbacks, ["OLD", "NEW"]);
    const readback = (loaded, value) => {
      if (!value?.resource || !value.qualification) fail();
      const receipt = privatePreviewPacketReadback(loaded, value.resource, value.qualification);
      same(value, receipt); return receipt;
    };
    const receipts = { OLD: readback(old, readbacks.OLD), NEW: readback(next, readbacks.NEW) };
    const x = receipts.OLD.resource, y = receipts.NEW.resource;
    if (x.pair.workerVersion === y.pair.workerVersion || ["workerId", "namespaceId", "applicationId"].some((key, i) =>
      x.providerEvidence[["worker", "namespace", "container"][i]][key] === y.providerEvidence[["worker", "namespace", "container"][i]][key])) fail();
    return { ...result, receipts, receiptDigest: previewProviderDigest({ bindingDigest: result.bindingDigest, receipts }) };
  }
  return result;
}
