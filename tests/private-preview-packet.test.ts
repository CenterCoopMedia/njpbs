import { expect, it } from "vitest";
import { bindPrivatePreviewPackets, privatePreviewPacketReadback } from "../scripts/lib/private-preview-packet.mjs";
import { installPrivatePreviewPair, inspectPrivatePreviewPair } from "../scripts/lib/install-private-preview-pair.mjs";
import { createPrivatePreviewPairProvider, previewProviderDigest as digest } from "../scripts/lib/private-preview-pair-provider.mjs";
import { previewProviderFixture, versionId, namespaceId, applicationId, workerId, deploymentId } from "./helpers/private-preview-provider-fixture.js";
import { pair } from "./helpers/cms-preview-pairs.js";
import { releasePair, pairReference } from "./helpers/private-public-release-pair.js";
const noCredential = () => { throw new Error("must stay offline"); };
async function fixture(role: string, source: string, operationId = `preview-${role}-install`, healthId = operationId) {
  const f = await previewProviderFixture({ pair: pair(role, source) });
  const request = { operationId: healthId, expectedRuntimeDigest: "a".repeat(64), expectedCandidatePointerDigest: null,
    bootstrapPublicPair: pairReference(releasePair()), candidate: { sourceSha: f.descriptor.rendererSha, trustedWorkflowSha: "e".repeat(40),
      runId: role === "old" ? "99" : "100", runAttempt: 1, inputFingerprint: f.prepared.bundleDigest, configurationFingerprint: f.prepared.configurationDigest } };
  const packet = { sourceSha: "e".repeat(40), resourceOperationId: operationId, request };
  const { plan, planDigest } = await installPrivatePreviewPair({ prepared: f.prepared, request: { ...request, operationId }, readToken: noCredential, readSecret: noCredential, firestore: undefined, signal: undefined });
  if (!plan || !planDigest) throw new Error("dry-run plan required");
  // HTTP is the only provider seam; inspection uses the real readback parser.
  f.state.identity = f.state.version = f.state.deployed = f.state.container = f.state.schedules = true;
  f.state.tags = [`private-preview:${planDigest}`];
  const ids: [string, string, string, string, string] = role === "old" ? [versionId, namespaceId, applicationId, workerId, deploymentId]
    : ["12345678-1234-4234-8234-123456789abc", "1".repeat(32), "2".repeat(32), "3".repeat(32), "87654321-4321-4321-8321-cba987654321"];
  const originals = [versionId, namespaceId, applicationId, workerId, deploymentId];
  const fetchImpl: typeof fetch = async (url, init) => {
    let originalUrl = String(url);
    ids.forEach((id, i) => { originalUrl = originalUrl.replaceAll(id, originals[i]); });
    const response = await f.request(originalUrl, init);
    let bytes = await response.text(); originals.forEach((id, i) => { bytes = bytes.replaceAll(id, ids[i]); });
    return new Response(bytes, { status: response.status, headers: response.headers });
  };
  const provider = createPrivatePreviewPairProvider({ prepared: f.prepared, operationDigest: planDigest, readToken: () => "synthetic", readSecret: noCredential, fetchImpl });
  const observed = await inspectPrivatePreviewPair({ provider, prepared: f.prepared, versionId: ids[0] });
  const resource = { schemaVersion: 1, plan, planDigest, pair: observed.pair, installedTargetDigest: observed.installedTargetDigest,
    providerEvidence: observed.evidence, completedAt: "2026-10-29T10:00:00.000Z" };
  const qualification = { schemaVersion: 1, resourceOperationId: operationId, request, requestDigest: digest({ resourceOperationId: operationId, request }),
    pair: observed.pair, installedTargetDigest: observed.installedTargetDigest,
    health: { ready: true, pairId: observed.pair.pairId, rendererSha: observed.pair.rendererSha, serializerId: observed.pair.serializerId, workerVersion: observed.pair.workerVersion },
    completedAt: "2026-10-29T10:01:00.000Z" };
  const loaded = { packet, packetDigest: (role === "old" ? "a" : "b").repeat(64), prepared: f.prepared, plan, planDigest };
  return { loaded, resource, qualification, readback: privatePreviewPacketReadback(loaded, resource, qualification) };
}
async function both() {
  const old = await fixture("old", "a"), next = await fixture("new", "b", "preview-new-install", "preview-new-fresh-proof");
  const manifest = { schemaVersion: 1, oldRendererSha: "a".repeat(40), newRendererSha: "b".repeat(40),
    OLD: { packetPath: "/packet/old.json", packetDigest: old.loaded.packetDigest }, NEW: { packetPath: "/packet/new.json", packetDigest: next.loaded.packetDigest } };
  return { old, next, manifest };
}
it("preserves original provider/health receipts, digests and times in role order, including a fresh separately named health proof", async () => {
  const { old, next, manifest } = await both();
  const result = bindPrivatePreviewPackets(manifest, old.loaded, next.loaded, { OLD: old.readback, NEW: next.readback });
  expect(result.productionAuthority).toBe(false);
  if (!("receipts" in result)) throw new Error("complete binding required");
  expect(result.receipts.OLD.resource).toEqual(old.resource); expect(result.receipts.NEW.qualification).toEqual(next.qualification);
  expect(result.receipts.NEW.resourcePath).toBe("cmsPreviewPrivateInstalls/preview-new-install");
  expect(result.receipts.NEW.healthPath).toBe("cmsPreviewPrivateHealth/preview-new-fresh-proof");
  expect(result.receipts.NEW.healthDigest).toBe(digest(next.qualification));
  expect(result.receiptDigest).toBe(digest({ bindingDigest: result.bindingDigest, receipts: result.receipts }));
  expect(bindPrivatePreviewPackets(manifest, old.loaded, next.loaded, { OLD: old.readback, NEW: next.readback })).toEqual(result);
});
it("allows missing receipts only in the installer's diagnostic readback, never a complete binding", async () => {
  const { old, next, manifest } = await both();
  expect(privatePreviewPacketReadback(old.loaded, null, null)).toMatchObject({ resource: null, qualification: null, resourceDigest: null, healthDigest: null });
  expect(() => bindPrivatePreviewPackets(manifest, old.loaded, next.loaded, { OLD: privatePreviewPacketReadback(old.loaded, old.resource, null), NEW: next.readback })).toThrow();
  expect(() => privatePreviewPacketReadback(old.loaded, null, old.qualification)).toThrow();
});
it.each(["resource", "health", "pair", "image", "version", "namespace", "privacy", "request", "extra", "timestamp"])("refuses changed %s before receipt output", async field => {
  const f = await fixture("old", "a"), r = structuredClone(f.resource), h = structuredClone(f.qualification);
  if (field === "resource") r.plan.operationId = "preview-replacement";
  if (field === "health") h.resourceOperationId = "preview-replacement";
  if (field === "pair") h.pair.rendererSha = "f".repeat(40);
  if (field === "image") r.providerEvidence.container.imageDigest = `sha256:${"f".repeat(64)}`;
  if (field === "version") r.providerEvidence.version.versionId = "00000000-0000-4000-8000-000000000000";
  if (field === "namespace") r.providerEvidence.namespace.namespaceId = "0".repeat(32);
  if (field === "privacy") r.providerEvidence.privacy.subdomain.enabled = true;
  if (field === "request") h.request.candidate.runId = "111";
  if (field === "extra") (r as any).secret = "synthetic-private-value";
  if (field === "timestamp") h.completedAt = "2026-02-31T00:00:00.000Z";
  expect(() => privatePreviewPacketReadback(f.loaded, r, h)).toThrow("Private preview packet refused");
});
it("refuses swapped receipts, altered receipt digests and cross-role operation collisions", async () => {
  const { old, next, manifest } = await both();
  expect(() => bindPrivatePreviewPackets(manifest, old.loaded, next.loaded, { OLD: next.readback, NEW: old.readback })).toThrow();
  expect(() => bindPrivatePreviewPackets(manifest, old.loaded, next.loaded, { OLD: { ...old.readback, resourceDigest: "f".repeat(64) }, NEW: next.readback })).toThrow();
  const collision = await fixture("new", "b", old.loaded.packet.request.operationId);
  expect(() => bindPrivatePreviewPackets(manifest, old.loaded, collision.loaded)).toThrow();
});
it("rejects different environments, bootstrap public pair, source and runtime authority", async () => {
  const { old, next, manifest } = await both();
  for (const changed of [
    { ...next.loaded, prepared: { ...next.loaded.prepared, environment: "development" } },
    { ...next.loaded, packet: { ...next.loaded.packet, sourceSha: "f".repeat(40) } },
    { ...next.loaded, packet: { ...next.loaded.packet, request: { ...next.loaded.packet.request, expectedRuntimeDigest: "f".repeat(64) } } },
    { ...next.loaded, packet: { ...next.loaded.packet, request: { ...next.loaded.packet.request, bootstrapPublicPair: pairReference(releasePair("other")) } } },
  ]) expect(() => bindPrivatePreviewPackets(manifest, old.loaded, changed)).toThrow();
});
