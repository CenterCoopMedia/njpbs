// @vitest-environment node
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { renderNameAtlasReader } from "../src/lib/name-atlas-reader";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const snapshot = read("../src/internal/name-atlas/reader.html");
const bridge = read("../src/internal/name-atlas/bridge.js");
const rendered = renderNameAtlasReader(snapshot, bridge);

describe("approved atlas snapshot and hosting adapters", () => {
  it("pins the approved reader with media-hosted font references", () => {
    expect(createHash("sha256").update(snapshot).digest("hex"))
      .toBe("a6f22ddef7db34254a7c5a61610b83efec07db73ef00c12bd3a298072fb5ac5a");
  });
  it("preserves the research payload, font references and all styles while adding hosting context", () => {
    const payload = (text: string) => text.match(/const encoded='([^']*)';/)?.[1];
    expect(payload(snapshot)?.length).toBeGreaterThan(1_000_000);
    expect(payload(rendered)).toBe(payload(snapshot));
    const styles = (text: string) => [...text.matchAll(/<style[^>]*>[\s\S]*?<\/style>/g)].map((match) => match[0]);
    expect(styles(rendered)).toEqual(styles(snapshot));
    expect(rendered).toContain('data-name-atlas-reader data-pagefind-ignore="all"');
    expect(rendered).toContain('name="robots" content="noindex, nofollow, noarchive"');
    expect(rendered.indexOf(bridge)).toBeLessThan(rendered.indexOf("const encoded="));
  });
  it("keeps the approved encoded research bytes and valid inline scripts", () => {
    const encoded = snapshot.match(/const encoded='([^']*)';/)?.[1];
    expect(createHash("sha256").update(encoded!).digest("hex")).toBe("cd13deae1fe78ee27dc9f395e12c2f583df03f0c5a3bbbadce2af0338504301d");
    for (const script of snapshot.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
      expect(() => new Script(script[1])).not.toThrow();
    }
  });
  it("copies the containing page URL without query strings, also from standalone mode", () => {
    expect(rendered).toContain("const url=new URL('/atlas/',window.location.origin);url.hash=routeHash(code);");
    expect(rendered).not.toContain("const url=new URL(window.location.href);url.hash=routeHash(code);");
    expect(rendered).toContain("navigator.clipboard.writeText");
    expect(rendered).toContain("atlas-share-fallback");
  });
  it("requires adapter review when a replacement snapshot changes the copy hook", () => {
    expect(() => renderNameAtlasReader(snapshot.replace("url.hash=routeHash(code);", ""), bridge)).toThrow("review its hosting adapters");
  });
  it("announces new tabs for both fixed map credits and dynamically rendered references", () => {
    const anchors = rendered.match(/<a\b[^>]*\btarget=["']_blank["'][^>]*>[\s\S]*?<\/a>/g) ?? [];
    expect(anchors).toHaveLength(3);
    for (const anchor of anchors) expect(anchor).toContain('(opens in new tab)');
    expect(rendered).toContain("a.append(el('span',' (opens in new tab)','sr-only'));return a;");
  });
  it("injects both routes only after the frozen-preview exclusion and omits the sitemap", () => {
    const config = read("../astro.config.mjs");
    expect(config).toMatch(/if \(previewInput\) return;\s+if \(nameAtlasRoutesEnabled\(process.env, Boolean\(previewInput\)\)\) \{[\s\S]*?pattern: "\/atlas\/"[\s\S]*?pattern: "\/atlas\/reader\/index.html"/);
    expect(config).toContain('!page.includes("/atlas/")');
  });
  it("reuses the site shell with analytics and search participation disabled", () => {
    const page = read("../src/pages/_name-atlas.astro");
    expect(page).toContain('<PublicSiteLayout');
    expect(page).toContain("preview={true}");
    expect(page).toContain("noindex={true}");
    expect(page).toContain("searchable={false}");
    expect(page).toContain('title="Interactive atlas of New Jersey municipality name histories"');
    expect(page).toContain("Open atlas on its own");
  });
});
