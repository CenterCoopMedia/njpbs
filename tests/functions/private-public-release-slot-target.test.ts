import { expect, it } from "vitest";
import { publicSlotScenario } from "../helpers/private-public-release-slot-target.mjs";
import { privatePublicReleaseSlotTarget, readPrivatePublicReleaseSlotProvider } from "../../scripts/lib/private-public-release-slot-target.mjs";
import { installPublicReleasePairReaderWithPreflight } from "../../site/scripts/install-public-release-pair-reader-with-preflight";

it("leaves the composed operator off by default before touching any boundary", async () => {
  await expect(installPublicReleasePairReaderWithPreflight({} as never)).rejects.toMatchObject({
    stage: "input", code: "reader-install-input-refused", uncertain: false,
    message: expect.stringContaining("no caller authority was requested"),
  });
});

it("refuses a different source checkout before database or credential access", async () => {
  const f = publicSlotScenario();
  await expect(installPublicReleasePairReaderWithPreflight({ ...f, firestore: null, authorized: true,
    preflightOperationId: "reader-source-mismatch" } as never)).rejects.toThrow("Private reader installation was refused");
  expect(f.calls).toEqual([]);
});

it("reads the original exact private slot through provider GETs without any installation effect", async () => {
  const f = publicSlotScenario(), target = privatePublicReleaseSlotTarget(f);
  const result = await readPrivatePublicReleaseSlotProvider({ ...f, target });
  expect(result).toMatchObject({ workerId: "1".repeat(32), versionId: f.pair.publicWorker.versionId,
    deploymentId: f.rollout.publicDeploymentId, sourceDigest: f.installPlan.slotBundleDigest, private: true });
  expect(f.calls.length).toBeGreaterThan(5);
  expect(f.calls.every(call => call.method === "GET")).toBe(true);
});

it("accepts the provider's production environment spelling for the identical service binding", async () => {
  const f = publicSlotScenario(), target = privatePublicReleaseSlotTarget(f);
  f.state.version.resources.bindings = f.state.version.resources.bindings.map(binding => binding.type === "service" ? { ...binding, environment: "production" } : binding);
  await expect(readPrivatePublicReleaseSlotProvider({ ...f, target })).resolves.toMatchObject({ private: true });
});

it.each(["source", "version", "configuration", "compatibility", "split-traffic", "deployment-tag", "worker-tag", "public-domain", "public-route", "workers-dev", "preview", "extra-version"])("refuses actual %s drift", async mode => {
  const f = publicSlotScenario(), target = privatePublicReleaseSlotTarget(f);
  if (mode === "source") f.state.source = new TextEncoder().encode("altered code");
  if (mode === "version") f.state.version.id = f.installPlan.oldPair.publicWorker.versionId;
  if (mode === "configuration") f.state.version.resources.bindings[0].text = "altered binding";
  if (mode === "compatibility") f.state.version.resources.script_runtime.compatibility_flags = [];
  if (mode === "split-traffic") f.state.deployment.versions[0].percentage = 99;
  if (mode === "deployment-tag") f.state.deployment.annotations = {};
  if (mode === "worker-tag") f.state.worker.tags = [];
  if (mode === "public-domain") f.state.domains = [{ service: f.config.name }];
  if (mode === "public-route") f.state.routes = [{ script: f.config.name }];
  if (mode === "workers-dev") f.state.subdomain.enabled = true;
  if (mode === "preview") f.state.subdomain.previews_enabled = true;
  if (mode === "extra-version") f.state.versions.push(f.state.versions[0]);
  await expect(readPrivatePublicReleaseSlotProvider({ ...f, target })).rejects.toThrow("Private public-slot target was refused");
  expect(f.calls.every(call => call.method === "GET")).toBe(true);
});

it("refuses a deployment change during byte readback", async () => {
  const f = publicSlotScenario(), target = privatePublicReleaseSlotTarget(f);
  const fetchImpl = async (...args) => {
    const response = await f.fetchImpl(...args);
    if (new URL(args[0]).pathname.endsWith("/content/v2")) f.state.deployment.id = "eeeeeeee-3333-4333-8333-333333333333";
    return response;
  };
  await expect(readPrivatePublicReleaseSlotProvider({ ...f, target, fetchImpl })).rejects.toThrow();
});

it.each(["publisher", "capability", "origin", "plan-extra", "other-pair"])("refuses %s identity substitution before network access", mode => {
  const f = publicSlotScenario();
  if (mode === "publisher") f.pair.publisher.workerVersionId = "eeeeeeee-3333-4333-8333-333333333333";
  if (mode === "capability") f.pair.capabilityDigest = "f".repeat(64);
  if (mode === "origin") f.installPlan.readerOrigins[0] = "https://other.example.test";
  if (mode === "plan-extra") Object.assign(f.installPlan, { unexpected: true });
  if (mode === "other-pair") f.pair.pairId = f.installPlan.newPair.pairId;
  expect(() => privatePublicReleaseSlotTarget(f)).toThrow();
  expect(f.calls).toEqual([]);
});

it("redacts boundary errors and refuses pre-cancel without credential access", async () => {
  const f = publicSlotScenario(), target = privatePublicReleaseSlotTarget(f);
  let reads = 0;
  const readToken = async () => { reads++; throw new Error("synthetic-sensitive-error"); };
  await expect(readPrivatePublicReleaseSlotProvider({ ...f, target, readToken, signal: AbortSignal.abort() })).rejects.toThrow("Private public-slot target was refused");
  expect(reads).toBe(0);
  try { await readPrivatePublicReleaseSlotProvider({ ...f, target, readToken }); }
  catch (error) { expect(String(error)).not.toContain("synthetic-sensitive-error"); }
});
