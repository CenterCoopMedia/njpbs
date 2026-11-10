import { expect, it } from "vitest";
import { assertPublicReleaseInclusionReadCapacity, PublicReleaseInclusionCapacityError } from "../../site/scripts/public-release-publication-terminal";

it("reserves all measured lineage/execution and output-page reads inside the shared 500-read boundary", () => {
  expect(() => assertPublicReleaseInclusionReadCapacity(431, 51, 100)).not.toThrow();
  expect(() => assertPublicReleaseInclusionReadCapacity(432, 51, 100)).toThrow(PublicReleaseInclusionCapacityError);
});
it("accounts for an additional immutable output page and reports the named refusal before settlement", () => {
  try { assertPublicReleaseInclusionReadCapacity(431, 51, 101); throw new Error("Expected capacity refusal"); }
  catch (error) { expect(error).toBeInstanceOf(PublicReleaseInclusionCapacityError); expect((error as PublicReleaseInclusionCapacityError).code).toBe("pair-inclusion-transaction-limit"); }
});

it("reserves the three actual development hold reads without changing production capacity", () => {
  expect(() => assertPublicReleaseInclusionReadCapacity(428, 51, 100, "development")).not.toThrow();
  expect(() => assertPublicReleaseInclusionReadCapacity(429, 51, 100, "development")).toThrow(PublicReleaseInclusionCapacityError);
  expect(() => assertPublicReleaseInclusionReadCapacity(431, 51, 100, "production")).not.toThrow();
});
