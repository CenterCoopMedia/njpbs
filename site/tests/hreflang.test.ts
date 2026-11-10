// @vitest-environment node
// Pins the hreflang behavior for issues #224 and #241: a deliberate no-op on a
// page with no translation, and a full alternate cluster on a page that has one.
// The no-cluster branch is the load-bearing one. If it ever starts emitting
// links, that is a behavior change someone must have chosen, not a side effect
// of registering a locale somewhere else in the site.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { DEFAULT_LOCALE, hreflangAlternates } from "../src/lib/hreflang";

const SITE = "https://njpbs.org";

describe("hreflang scaffolding (#224, #241)", () => {
  it("emits no alternates for a page with no translation", () => {
    expect(hreflangAlternates("/about/", SITE, [DEFAULT_LOCALE])).toEqual([]);
    expect(hreflangAlternates("/", SITE, [DEFAULT_LOCALE])).toEqual([]);
  });

  it("builds the same cluster from a localized page's own prefixed path", () => {
    // Base runs on every page, so /es/about/ calls the helper with its own URL.
    // The cluster must come out identical to the default page's — never a
    // doubled prefix like /es/es/about/.
    const fromDefault = hreflangAlternates("/about/", SITE, ["en", "es"]);
    expect(fromDefault).toEqual([
      { hreflang: "en", href: "https://njpbs.org/about/" },
      { hreflang: "es", href: "https://njpbs.org/es/about/" },
      { hreflang: "x-default", href: "https://njpbs.org/about/" },
    ]);
    expect(hreflangAlternates("/es/about/", SITE, ["en", "es"])).toEqual(
      fromDefault,
    );
    expect(hreflangAlternates("/es/", SITE, ["en", "es"])).toEqual(
      hreflangAlternates("/", SITE, ["en", "es"]),
    );
  });

  it("keeps every alternate on the njpbs.org origin", () => {
    const cluster = hreflangAlternates("/give/", SITE, ["en", "es", "pt"]);
    for (const alt of cluster) {
      expect(alt.href.startsWith("https://njpbs.org/")).toBe(true);
    }
    // Exactly one x-default, pointing at the default-locale URL.
    const xDefault = cluster.filter((a) => a.hreflang === "x-default");
    expect(xDefault).toEqual([
      { hreflang: "x-default", href: "https://njpbs.org/give/" },
    ]);
  });
  it("is wired into the shared head next to the canonical", () => {
    const base = readFileSync(
      new URL("../src/layouts/Base.astro", import.meta.url),
      "utf8",
    );
    expect(base).toContain(
      'import { DEFAULT_LOCALE, hreflangAlternates } from "../lib/hreflang"',
    );
    expect(base).toContain('rel="alternate"');
    expect(base).toContain("hreflang={alt.hreflang}");
    // Base must build the cluster from the page's own translations, never from
    // the site registry, or every page would claim a twin the moment one page
    // got translated. Matched loosely so a formatter reflow cannot break it.
    expect(base).toMatch(/translations\s*=\s*\[\]/);
    expect(base).toMatch(/\.\.\.translations\.filter\(/);
    expect(base).not.toMatch(/hreflangAlternates\([^)]*SITE_LOCALES/);
  });

  it("reaches a public page: PublicSiteLayout forwards translations to Base", () => {
    // Every public page, including the four priority:true pages #241 targets
    // first, renders through PublicSiteLayout. Without the forward, the prop is
    // unreachable and the feature is one layer short of working.
    const layout = readFileSync(
      new URL("../src/layouts/PublicSiteLayout.astro", import.meta.url),
      "utf8",
    );
    expect(layout).toMatch(/translations\?:\s*readonly string\[\]/);
    expect(layout).toMatch(/translations\s*=\s*\[\]/);
    expect(layout).toMatch(/translations=\{translations\}/);
  });

});
