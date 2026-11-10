// @vitest-environment node
import { describe, expect, it } from "vitest";
import { nameAtlasRoutesEnabled, containsNameAtlasContent, NAME_ATLAS_PAYLOAD_FINGERPRINT } from "../src/lib/name-atlas-preview";

describe("private name atlas build boundary", () => {
  it.each([{}, { INTERNAL_SURFACES: "" }, { INTERNAL_SURFACES: "false" }])(
    "omits the reader unless internal surfaces are explicitly enabled: %j", (env) => {
      expect(nameAtlasRoutesEnabled(env)).toBe(false);
    },
  );
  it.each(["1", "true", " YES ", "on"])("accepts the existing internal opt-in %s", (flag) => {
    expect(nameAtlasRoutesEnabled({ INTERNAL_SURFACES: flag })).toBe(true);
  });
  it.each([
    { PUBLIC_ONLY: "1" }, { PUBLIC_ONLY: "true" }, { WORKERS_CI: "1" },
    { WORKERS_CI: "true" }, { PUBLIC_BUILD_BATCH_ID: "publication-123" },
    { PUBLIC_ARTIFACT_BUNDLE_PATH: "/tmp/public.json" },
    { CMS_PREVIEW_INPUT_PATH: "/tmp/draft.json" }, { CMS_PREVIEW_INPUT_SHA256: "digest" },
  ])("public and frozen-artifact settings override internal opt-in: %j", (env) => {
    expect(nameAtlasRoutesEnabled({ INTERNAL_SURFACES: "1", ...env })).toBe(false);
  });
  it("excludes an already-resolved frozen preview", () => {
    expect(nameAtlasRoutesEnabled({ INTERNAL_SURFACES: "1" }, true)).toBe(false);
  });
  it("finds both the raw reader and renamed/bundled copies", () => {
    for (const value of [
      '<main id="nj-name-atlas">', "New Jersey — An Atlas of Names", "atlas-municipalities",
      'const id = "atlas-share-fallback";', NAME_ATLAS_PAYLOAD_FINGERPRINT,
    ]) expect(containsNameAtlasContent(value)).toBe(true);
    expect(containsNameAtlasContent("An ordinary NJ PBS post about a town")).toBe(false);
  });
});
