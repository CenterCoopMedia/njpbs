// Issue #2549: inspect emitted bytes, including renamed payloads and scripts.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { containsPoliticsGuidePreview, politicsGuidePreviewEnabled, POLITICS_PREVIEW_ASSETS } from "../src/lib/politics-guide-preview";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
describe("politics guide publication boundary", () => {
  it("inspects an actual built artifact", () => {
    expect(existsSync(dist)).toBe(true);
    expect(readdirSync(dist).length).toBeGreaterThan(0);
  });
  it("excludes the page, UI and datasets from every public/frozen output", () => {
    if (politicsGuidePreviewEnabled(process.env)) return;
    const files = (readdirSync(dist, { recursive: true }) as string[]).map(p => p.replaceAll("\\", "/"));
    expect(files.filter(p => /^resources\/nj-politics(?:\/|\.|$)/.test(p))).toEqual([]);
    expect(files.filter(p => /\.(?:html?|[cm]?js|css|json|map|txt|xml)$/i.test(p)).filter(p => containsPoliticsGuidePreview(readFileSync(join(dist, p), "utf8")))).toEqual([]);
  });
  it("includes only the intended private guide endpoints in an internal build", () => {
    if (!politicsGuidePreviewEnabled(process.env)) return;
    const root = join(dist, "resources/nj-politics");
    const html = readFileSync(join(root, "index.html"), "utf8");
    expect(html).toContain('name="robots" content="noindex');
    expect(html).toContain("data-pagefind-ignore");
    expect(readdirSync(join(root, "_preview")).sort()).toEqual([...POLITICS_PREVIEW_ASSETS].sort());
    expect(containsPoliticsGuidePreview(readFileSync(join(root, "_preview/nj-politics.json"), "utf8"))).toBe(true);
    expect(containsPoliticsGuidePreview(readFileSync(join(root, "_preview/nj-election-2026.json"), "utf8"))).toBe(true);
  });
});
