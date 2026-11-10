import { expect, it } from "vitest";
import pairs from "../../functions/lib/public-release-pair.js";
import legacy from "../../functions/lib/public-deployment.js";
import runtimeControl from "../../functions/lib/cms-publication-runtime-control.js";
import owner from "../../functions/lib/publication-runtime-owner.js";
import { releasePair, releaseSelector, pairReference } from "../helpers/public-release-pair.js";

it("parses isolated immutable pair identities without changing legacy pointer semantics", () => {
  const input = releasePair();
  const pair = pairs.parsePublicReleasePair(JSON.parse(JSON.stringify(input)));
  expect(pair).toEqual(input);
  expect(Object.isFrozen(pair.publisher)).toBe(true);
  input.publisher.application = "reused-slot";
  expect(pair.publisher.application).toBe("njpbs-publisher-a");
  expect(pairs.publicReleasePairReference(pair)).toEqual(pairReference());
  const old = legacy.initialPublicDeploymentPointer();
  expect(pairs.parseVersionedPublicDeployment(old)).toBe(old);
  expect(legacy.PUBLIC_DEPLOYMENT_SCHEMA_VERSION).toBe(1);
});

it("refuses unknown or missing fields at every pair identity boundary", () => {
  const pair = releasePair();
  for (const path of [[], ["publisher"], ["publicWorker"]]) {
    const sample = path.reduce((value, key) => value[key], pair);
    for (const key of Object.keys(sample)) {
      const broken = structuredClone(pair);
      delete path.reduce((value, part) => value[part], broken)[key];
      expect(() => pairs.parsePublicReleasePair(broken)).toThrow();
    }
    const broken = structuredClone(pair);
    path.reduce((value, key) => value[key], broken).unreviewedCapability = true;
    expect(() => pairs.parsePublicReleasePair(broken)).toThrow();
  }
});

it.each([
  { schemaVersion: 1 }, { schemaVersion: 3 }, { commitSha: "a".repeat(39) },
  { pairId: "slot-without-incarnation" }, { environment: "staging" }, { readerReceiptDigest: null },
  { publisher: { ...releasePair().publisher, imageDigest: [releasePair().publisher.imageDigest] } },
  { publicWorker: { ...releasePair().publicWorker, incarnation: "reused" } },
])("refuses unsealed or conflicting pair metadata %j", patch => {
  expect(() => pairs.parsePublicReleasePair({ ...releasePair(), ...patch })).toThrow();
});

it("strictly parses schema two while old writers and runtime readers still refuse it", () => {
  const selector = releaseSelector();
  expect(pairs.parseVersionedPublicDeployment(selector)).toEqual(selector);
  expect(Object.isFrozen(pairs.parsePublicReleaseSelector(selector).contentHead)).toBe(true);
  expect(() => legacy.assertPublicDeploymentPointer(selector)).toThrow();
  expect(() => legacy.assertMediaLifecycleDeploymentFence(selector)).toThrow();
  const control = { schemaVersion: 2, phase: "ready", commitSha: selector.activeCommitSha,
    serializerId: "cloudflare-publisher", pairId: selector.selectedPair.pairId };
  expect(() => runtimeControl.parseCmsPublicationRuntimeControl(control)).toThrow();
  expect(() => runtimeControl.assertCmsPublicationCloudAdmission(control, { commitSha: control.commitSha })).toThrow();
  expect(() => owner.publicationRuntime({ owner: "cloudflare", release: control.commitSha, pairId: control.pairId })).toThrow();
});

it("refuses all missing/unknown selector fields and mismatched projections", () => {
  const selector = releaseSelector();
  for (const key of Object.keys(selector)) {
    const broken = structuredClone(selector);
    delete broken[key];
    expect(() => pairs.parsePublicReleaseSelector(broken)).toThrow();
  }
  const patches = [
    { runtime: {} }, { state: "deploying" }, { mediaLifecycleReady: false }, { epoch: 0 },
    { epoch: Number.MAX_SAFE_INTEGER + 1 }, { activeCommitSha: "b".repeat(40) },
    { lastReservedGeneration: 8 }, { newestEligibleGeneration: 8 }, { recoveryPair: selector.selectedPair },
    { selectedPair: { ...selector.selectedPair, extra: true } },
    { contentHead: { ...selector.contentHead, pairId: selector.recoveryPair.pairId } },
    { contentHead: { ...selector.contentHead, unreviewed: true } },
    { contentHead: { ...selector.contentHead, contextSequence: -1 } },
    { proofDigest: "unproven" },
  ];
  for (const patch of patches) expect(() => pairs.parsePublicReleaseSelector({ ...selector, ...patch })).toThrow();
});
