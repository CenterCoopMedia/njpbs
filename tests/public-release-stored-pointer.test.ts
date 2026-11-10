import { expect, it } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import protocol from "../functions/lib/public-release-pair.js";
import pointer from "../functions/lib/public-deployment-pointer.js";
import { releaseSelector } from "./helpers/private-public-release-pair.js";
it("preserves every legacy read field while keeping the schema-one writer guard closed", () => {
  const selector = releaseSelector(), updatedAt = Timestamp.fromMillis(1_800_000_000_000);
  const stored = { ...selector, updatedAt };
  expect(protocol.parseStoredPublicReleaseSelector(stored)).toEqual(selector);
  expect(protocol.parseVersionedPublicDeployment(stored)).toEqual(selector);
  const legacy = pointer.readPublicDeploymentPointer(stored);
  for (const key of ["mediaLifecycleReady", "state", "activeGeneration", "activeDeploymentId", "activeCommitSha", "lastReservedGeneration", "newestEligibleGeneration", "newestEligibleBuildBatchId"] as const) expect(legacy[key]).toEqual(selector[key]);
  expect(legacy.updatedAt).toBe(updatedAt); expect(legacy.schemaVersion).toBe(1);
  expect(() => pointer.assertPublicDeploymentPointer(stored)).toThrow();
  expect(() => protocol.parsePublicReleaseSelector(stored)).toThrow();
});
it("refuses malformed timestamps and unknown stored metadata instead of ignoring it", () => {
  for (const updatedAt of [0, "2026-10-28", { seconds: 1 }, null]) expect(() => protocol.parseStoredPublicReleaseSelector({ ...releaseSelector(), updatedAt })).toThrow();
  expect(() => protocol.parseStoredPublicReleaseSelector({ ...releaseSelector(), extra: true })).toThrow();
  expect(() => pointer.readPublicDeploymentPointer({ ...releaseSelector(), state: "deploying" })).toThrow();
});
