// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEFAULT_NJ_DECIDES_SETTINGS, NJ_DECIDES_SETTINGS_ID } from "../../packages/content-core/src/cms-settings";
import { resolveNjDecidesBrand } from "../../packages/content-core/src/nj-decides-brand";
import { renderNjDecidesBand } from "../../packages/content-core/src/nj-decides-render";
import { isNjDecidesBuildData, projectNjDecidesSettings } from "../src/lib/nj-decides-settings";
import { projectChrome } from "../src/lib/published-post-shadow";
import { NJ_DECIDES_LOGO } from "../../packages/content-core/src/nj-decides";

const values = { ...DEFAULT_NJ_DECIDES_SETTINGS };
const published = { schemaVersion: 1, values, sourceVersion: 3, publishedAt: "2026-10-26T17:00:00.000Z" };
const document = { id: NJ_DECIDES_SETTINGS_ID, schemaVersion: 1, version: 5,
  values: { ...values, backgroundColor: "#ffffff" }, published };

describe("NJ Decides published branding", () => {
  it("uses only the frozen published values and carries them through shared chrome", () => {
    const projection = projectNjDecidesSettings(document);
    expect(projection.status).toBe("published");
    if (projection.status !== "published") throw new Error("Missing test projection");
    expect(projection.data.backgroundColor).toBe("#e9eaee");
    expect(isNjDecidesBuildData(projection.data)).toBe(true);
    expect(projectChrome({ settings: [document], navigationPages: [] }).settings).toEqual([projection.data]);
  });
  it("retains an addressable invalid version for a safe default receipt", () => {
    expect(projectNjDecidesSettings({ ...document, published: { ...published,
      values: { ...values, textColor: values.backgroundColor } } })).toEqual({ status: "invalid", sourceVersion: 3 });
    expect(resolveNjDecidesBrand({ ...values, textColor: values.backgroundColor }).values).toEqual(values);
  });
  it("selects the supplied reversed identity on a valid dark surface", () => {
    expect(resolveNjDecidesBrand({ ...values, backgroundColor: "#011375", textColor: "#ffffff", linkColor: "#ffffff" }).logo.url)
      .toBe(NJ_DECIDES_LOGO.reversedSrc);
  });
  it("resolves selected Media images and falls back safely for unsafe URLs", () => {
    const branding = { ...values, logoAssetId: "logo-example", logoAlt: "Example election coverage", backgroundAssetId: "background-example" };
    const image = { url: "/brand/example.jpg", mimeType: "image/jpeg", width: 800, height: 300 };
    const resolved = resolveNjDecidesBrand(branding, { "logo-example": image, "background-example": image });
    expect(resolved.logo.alt).toBe("Example election coverage");
    expect(resolved.background?.url).toBe(image.url);
    expect(resolveNjDecidesBrand(branding, { "logo-example": { ...image, url: "/\\unreviewed.example/image" } }).logo.url)
      .toBe(NJ_DECIDES_LOGO.src);
  });
});

describe("NJ Decides shared band", () => {
  it("escapes staff copy and labels, strips unsafe links and caps actions at two", () => {
    const html = renderNjDecidesBand({ copy: '<img src=x onerror="alert(1)">', links: [
      { label: "Unsafe", href: "javascript:alert(1)" }, { label: "<Watch>", href: "/live/" }, { label: "Third", href: "/watch/" },
    ] });
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;Watch&gt;");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain(">Third<");
  });
  it("renders a complete identity with no fabricated copy or empty copy whitespace", () => {
    const html = renderNjDecidesBand();
    expect(html).toContain('alt="NJ Decides 2026"');
    expect(html).toContain('class="nj-decides-band__copy"></div>');
    expect(html).not.toContain("New Jersey chooses");
  });
});
