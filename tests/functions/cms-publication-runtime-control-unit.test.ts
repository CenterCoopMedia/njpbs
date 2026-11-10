import { createRequire } from "node:module";
import { expect, it } from "vitest";
const { parseCmsPublicationRuntimeControl, assertCmsPublicationClaim, assertCmsPublicationCloudAdmission,
  assertCmsPublicationAdmission } = createRequire(import.meta.url)("../../functions/lib/cms-publication-runtime-control.js");
const primary = { schemaVersion: 1, phase: "ready", commitSha: "a".repeat(40), serializerId: "node-compute-primary" };
const cloud = { phase: "ready", commitSha: "b".repeat(40), serializerId: "cloudflare-publisher" };
it("keeps schema-one legacy admission and split cloud identities independently fenced", () => {
  expect(parseCmsPublicationRuntimeControl(primary)).toEqual(primary);
  expect(assertCmsPublicationAdmission(primary)).toEqual(primary);
  expect(assertCmsPublicationClaim(primary, primary)).toEqual(primary);
  expect(() => assertCmsPublicationCloudAdmission(primary, { commitSha: primary.commitSha })).toThrow();

  const split = parseCmsPublicationRuntimeControl({ ...primary, cloud });
  expect(assertCmsPublicationClaim(split, primary)).toEqual(split);
  expect(() => assertCmsPublicationClaim(split, cloud)).toThrow();
  expect(assertCmsPublicationCloudAdmission(split, { commitSha: cloud.commitSha })).toEqual(cloud);
  expect(() => assertCmsPublicationCloudAdmission(split, { commitSha: primary.commitSha })).toThrow();
  expect(() => assertCmsPublicationCloudAdmission({ ...split, cloud: { ...cloud, phase: "starting" } }, { commitSha: cloud.commitSha })).toThrow();
  expect(assertCmsPublicationClaim({ ...split, cloud: { ...cloud, phase: "paused" } }, primary)).toBeDefined();
});
