// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { readPoliticsPreviewAsset } from "../src/lib/politics-guide-preview-build";
import { containsPoliticsGuidePreview, politicsGuidePreviewEnabled, politicsGuidePreviewHtml, politicsGuidePreviewRoutes, POLITICS_PREVIEW_ASSETS } from "../src/lib/politics-guide-preview";

describe("private politics guide build boundary", () => {
  it.each(["nj-politics.json", "nj-election-2026.json"] as const)("builds the CI preview from the committed synthetic %s", async asset => {
    const result = await readPoliticsPreviewAsset(asset, { INTERNAL_SURFACES: "1", CI: "true", POLITICS_PREVIEW_FIXTURE_MODE: "1" });
    const fixture = await readFile(new URL(`../../admin/tests/fixtures/resources/${asset}`, import.meta.url), "utf8");
    expect(JSON.parse(result)).toEqual(JSON.parse(fixture));
  });
  it.each([undefined, "", "false"])("refuses fixture selection outside CI: %s", async CI => {
    await expect(readPoliticsPreviewAsset("nj-politics.json", { INTERNAL_SURFACES: "1", CI, POLITICS_PREVIEW_FIXTURE_MODE: "1" })).rejects.toThrow("require CI=true");
  });
  it.each([
    {}, { INTERNAL_SURFACES: "1", PUBLIC_ONLY: "1" }, { INTERNAL_SURFACES: "1", WORKERS_CI: "1" },
    { INTERNAL_SURFACES: "1", CMS_PREVIEW_INPUT_PATH: "/tmp/draft.json" },
    { INTERNAL_SURFACES: "1", PUBLIC_BUILD_BATCH_ID: "publication-123" },
  ])("fixture mode preserves the build exclusion: %j", async env => {
    await expect(readPoliticsPreviewAsset("nj-politics.json", { ...env, CI: "true", POLITICS_PREVIEW_FIXTURE_MODE: "1" })).rejects.toThrow("disabled");
  });
  it.each([{}, { INTERNAL_SURFACES: "" }, { INTERNAL_SURFACES: "false" }])("requires the existing internal opt-in: %j", env => {
    expect(politicsGuidePreviewEnabled(env)).toBe(false);
    expect(politicsGuidePreviewRoutes(env)).toEqual([]);
  });
  it.each(["1", "true", " YES ", "on"])("enables only internal route injection: %s", flag => {
    expect(politicsGuidePreviewRoutes({ INTERNAL_SURFACES: flag })).toHaveLength(2);
  });
  it.each([
    { PUBLIC_ONLY: "1" }, { WORKERS_CI: "1" }, { WORKERS_CI: "true" },
    { PUBLIC_BUILD_BATCH_ID: "publication-123" }, { PUBLIC_ARTIFACT_BUNDLE_PATH: "/tmp/public.json" },
    { CMS_PREVIEW_INPUT_PATH: "/tmp/draft.json" }, { CMS_PREVIEW_INPUT_SHA256: "digest" },
  ])("public/frozen settings override opt-in: %j", env => {
    expect(politicsGuidePreviewRoutes({ INTERNAL_SURFACES: "1", ...env })).toEqual([]);
  });
  it("excludes an already resolved frozen preview and limits emitted assets", () => {
    expect(politicsGuidePreviewRoutes({ INTERNAL_SURFACES: "1" }, true)).toEqual([]);
    expect(POLITICS_PREVIEW_ASSETS).toEqual(["guide.js", "guide.css", "nj-politics.json", "nj-election-2026.json"]);
  });
  it("marks the reader noindex, excludes Pagefind and avoids inline datasets", () => {
    const html = politicsGuidePreviewHtml();
    expect(html).toContain('name="robots" content="noindex');
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    expect(html).toContain("data-pagefind-ignore");
    expect(html).toContain("Staff preview · Read only");
    expect(html).not.toContain("sourceWorkbook");
  });
  it("detects renamed presentation and research assets", () => {
    for (const marker of ["nj-politics-dev-preview", ".politics-preview-shell{display:flex}", "person-shirley-emehelu", "candidate-000000000000000000", "nj-politics-study-workbook-audited.xlsx", "person-example-official", "candidate-one"]) expect(containsPoliticsGuidePreview(marker)).toBe(true);
    expect(containsPoliticsGuidePreview("An ordinary NJ PBS report about the election.")).toBe(false);
  });
  it("rejects HTML and asset endpoint calls before loading a private payload", async () => {
    vi.stubEnv("INTERNAL_SURFACES", "");
    const html = await import("../src/pages/_politics-guide-preview");
    const asset = await import("../src/pages/_politics-guide-preview-asset");
    expect((await html.GET({} as never)).status).toBe(404);
    expect(await asset.getStaticPaths({} as never)).toEqual([]);
    expect((await asset.GET({ params: { asset: "nj-politics.json" } } as never)).status).toBe(404);
    vi.stubEnv("INTERNAL_SURFACES", "1");
    expect((await asset.GET({ params: { asset: "../../admin/.env" } } as never)).status).toBe(404);
    vi.unstubAllEnvs();
  });
});
