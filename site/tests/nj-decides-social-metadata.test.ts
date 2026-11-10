// @vitest-environment node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { NJ_DECIDES_SOCIAL_IMAGES as images } from "../src/lib/nj-decides-social-images";
import { leadFixturePoster } from "./fixtures/post-lead-media";

beforeAll(() => {
  execFileSync(process.execPath, ["node_modules/astro/bin/astro.mjs", "build", "--config", "astro.nj-decides-social.config.mjs"], {
    env: { PATH: process.env.PATH, NODE_ENV: "production", ASTRO_TELEMETRY_DISABLED: "1", TZ: "America/New_York" },
    stdio: "pipe",
  });
}, 30_000);

function metadata(route: string) {
  const html = readFileSync(`.astro/nj-decides-social/dist/${route}/index.html`, "utf8");
  const meta: Record<string, string> = {};
  function visit(node: DefaultTreeAdapterMap["node"]) {
    if ("attrs" in node) {
      const attrs = Object.fromEntries(node.attrs.map(attr => [attr.name, attr.value]));
      if (node.tagName === "meta") meta[attrs.property ?? attrs.name] = attrs.content;
      if (node.tagName === "link" && attrs.rel === "canonical") meta.canonical = attrs.href;
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
  }
  visit(parse(html));
  return { html, meta };
}

describe("real Page and Post social metadata", () => {
  it.each([["page/hub", "hub"], ["page/results", "results"], ["post/election", "post"],
    ["data-hub", "results"], ["staff", "results"]] as const)(
    "renders matching accessible kit metadata on %s", (route, variant) => {
      const { meta } = metadata(route);
      expect(meta["og:image"]).toBe(`https://njpbs.org${images[variant].url}`);
      expect(meta["twitter:image"]).toBe(meta["og:image"]);
      expect(meta["og:image:alt"]).toBe(images[variant].alt);
      expect(meta["twitter:image:alt"]).toBe(images[variant].alt);
      expect(meta["og:image:width"]).toBe("1200");
      expect(meta["og:image:height"]).toBe("630");
    });
  it.each([["page/override", "https://media.njpbs.org/editor.png"], ["post/override", leadFixturePoster],
    ["post/ordinary", leadFixturePoster], ["post/missing", "https://njpbs.org/og-default.png"],
    ["page/ordinary", "https://njpbs.org/og-default.png"]])("preserves existing image selection on %s", (route, url) => {
    expect(metadata(route).meta["og:image"]).toBe(url);
  });
  it("preserves search/social copy, canonical URLs and indexing", () => {
    const { meta } = metadata("page/hub");
    expect(meta.description).toBe("Search description");
    expect(meta["og:title"]).toBe("Social title");
    expect(meta["og:description"]).toBe("Social description");
    expect(meta.canonical).toBe("https://njpbs.org/nj-decides/");
    expect(meta.robots).toBeUndefined();
  });
  it("keeps NewsArticle tied to the Post hero and retired slugs noindex", () => {
    const { html } = metadata("post/election");
    const article = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs)]
      .map(match => JSON.parse(match[1])).find(value => value["@type"] === "NewsArticle");
    expect(article.image).toContain(leadFixturePoster);
    const retired = metadata("post/retired");
    expect(retired.meta.robots).toContain("noindex");
    expect(retired.html).not.toContain('"@type":"NewsArticle"');
  });
});
