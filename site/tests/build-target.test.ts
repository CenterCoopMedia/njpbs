import { describe, it, expect } from "vitest";
import {
  cmsRoutedContentEnabled,
  isPublicOnlyBuild,
  publicRootRoutesEnabled,
  internalSurfaceRoutesEnabled,
  sharePageEnabled,
  dataHubPageEnabled,
} from "../src/lib/build-target";

// PUBLIC_ONLY selects the coming-soon rollback. A full build leaves it unset and
// emits the root public pages. These tests guard that switch.
describe("isPublicOnlyBuild", () => {
  it("is true for a truthy PUBLIC_ONLY flag", () => {
    expect(isPublicOnlyBuild({ PUBLIC_ONLY: "1" })).toBe(true);
    expect(isPublicOnlyBuild({ PUBLIC_ONLY: "true" })).toBe(true);
    expect(isPublicOnlyBuild({ PUBLIC_ONLY: "YES" })).toBe(true);
  });

  it("is false when unset or explicitly disabled", () => {
    expect(isPublicOnlyBuild({})).toBe(false);
    expect(isPublicOnlyBuild({ PUBLIC_ONLY: "" })).toBe(false);
    expect(isPublicOnlyBuild({ PUBLIC_ONLY: "0" })).toBe(false);
    expect(isPublicOnlyBuild({ PUBLIC_ONLY: "false" })).toBe(false);
  });
});

describe("publicRootRoutesEnabled", () => {
  it("disables root public routes in a public-only build", () => {
    expect(publicRootRoutesEnabled({ PUBLIC_ONLY: "1" })).toBe(false);
  });

  it("enables root public routes in a full build", () => {
    expect(publicRootRoutesEnabled({})).toBe(true);
  });
});

describe("cmsRoutedContentEnabled", () => {
  it("allows Post and author routes in ordinary full builds", () => {
    expect(cmsRoutedContentEnabled({})).toBe(true);
  });

  it("refuses a public-artifact deploy without the validated v3 bundle", () => {
    expect(
      cmsRoutedContentEnabled({ PUBLIC_BUILD_BATCH_ID: "build-2026-08-22" }),
    ).toBe(false);
  });

  it("allows routed content from the exact v3 bundle", () => {
    expect(cmsRoutedContentEnabled({
      PUBLIC_BUILD_BATCH_ID: "build-2026-08-22",
      PUBLIC_ARTIFACT_BUNDLE_PATH: "/tmp/bundle.json",
      PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION: "3",
    })).toBe(true);
  });

  it("keeps every unsupported Worker lane closed", () => {
    expect(cmsRoutedContentEnabled({
      WORKERS_CI: "1",
      WORKERS_CI_BRANCH: "production",
      PUBLIC_BUILD_BATCH_ID: "build-2026-08-22",
      PUBLIC_ARTIFACT_BUNDLE_PATH: "/tmp/bundle.json",
      PUBLIC_ARTIFACT_BUNDLE_SCHEMA_VERSION: "3",
    })).toBe(false);
    expect(cmsRoutedContentEnabled({
      WORKERS_CI: "1",
      WORKERS_CI_BRANCH: "preview",
    })).toBe(false);
  });

  it("retains the public-only rollback override", () => {
    expect(cmsRoutedContentEnabled({ PUBLIC_ONLY: "1" })).toBe(false);
  });
});

describe("internalSurfaceRoutesEnabled", () => {
  it("disables maintainer routes unless internal surfaces are enabled", () => {
    expect(internalSurfaceRoutesEnabled({})).toBe(false);
  });

  it("enables maintainer routes when internal surfaces are enabled", () => {
    expect(internalSurfaceRoutesEnabled({ INTERNAL_SURFACES: "1" })).toBe(true);
  });

  it("keeps public-only as the override for maintainer routes", () => {
    expect(
      internalSurfaceRoutesEnabled({
        INTERNAL_SURFACES: "1",
        PUBLIC_ONLY: "1",
      }),
    ).toBe(false);
  });
});

describe("sharePageEnabled", () => {
  it("stays off until the launch switch is set", () => {
    expect(sharePageEnabled({})).toBe(false);
    expect(sharePageEnabled({ PUBLIC_SHARE_PAGE: "0" })).toBe(false);
    expect(sharePageEnabled({ PUBLIC_SHARE_PAGE: "1" })).toBe(true);
  });

  it("stays off in the coming-soon rollback", () => {
    expect(sharePageEnabled({ PUBLIC_SHARE_PAGE: "1", PUBLIC_ONLY: "1" })).toBe(false);
  });
});

describe("dataHubPageEnabled", () => {
  it.each([undefined, "", "0", "false", "off", "preview"])("keeps the prototype off for %s", (flag) => {
    expect(dataHubPageEnabled({ DATA_HUB_PUBLIC: flag })).toBe(false);
  });

  it.each(["1", "true", "YES", " on "])("accepts explicit opt-in %s", (flag) => {
    expect(dataHubPageEnabled({ DATA_HUB_PUBLIC: flag })).toBe(true);
    expect(dataHubPageEnabled({ DATA_HUB_PUBLIC: flag, PUBLIC_ONLY: "1" })).toBe(false);
  });

  it("does not publish the prototype with other surface flags", () => {
    expect(dataHubPageEnabled({ INTERNAL_SURFACES: "1", PUBLIC_SHARE_PAGE: "1" })).toBe(false);
  });
});
