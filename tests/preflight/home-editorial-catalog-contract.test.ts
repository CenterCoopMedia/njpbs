import { afterEach, describe, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { resolveConfig } from "vite";
import adminConfig from "../../admin/vite.config";
import { runInNewContext } from "node:vm";
import { TextEncoder } from "node:util";
import { readHomeEditorialCatalog, homeCatalogJson } from "../../packages/content-core/src/home-source-catalog.ts";
import fixture from "../../site/tests/fixtures/home-v2-selections.json";

afterEach(() => vi.unstubAllEnvs());

describe("Home catalog browser and storage contract", () => {
  it.each(["development", "production"])("uses only the approved media origins in the %s Admin build", async environment => {
    vi.stubEnv("VITE_CMS_DEPLOYMENT_ENVIRONMENT", environment);
    vi.stubEnv("CMS_MEDIA_ORIGIN", "https://untrusted.example.test");
    const config = await resolveConfig({
      ...adminConfig({ command: "build", mode: "production" }),
      root: "admin", configFile: false,
    }, "build");
    const bundle = await build({ entryPoints: ["packages/content-core/src/home-source-catalog.ts"],
      bundle: true, platform: "browser", format: "iife", globalName: "HomeCatalog", write: false,
      define: config.define as Record<string, string> });
    const read = (catalog: unknown) => runInNewContext(`${bundle.outputFiles[0].text}\nHomeCatalog.readHomeEditorialCatalog(JSON.parse(input))`,
      { URL, TextEncoder, input: JSON.stringify(catalog) });
    for (const origin of ["https://media.njpbs.org", "https://dev-media.example.org", "https://untrusted.example.test",
      "https://dev-media.example.org.example.test"]) {
      const catalog = structuredClone(fixture.editorial.catalog);
      catalog.sources["home-posts"].cards[0].image = { url: `${origin}/cms-media/image/fixture.webp`, alt: "Fixture" };
      if (origin === "https://media.njpbs.org" || environment === "development" && origin === "https://dev-media.example.org") {
        expect(read(catalog).sources["home-posts"].cards[0].image.url).toBe(`${origin}/cms-media/image/fixture.webp`);
      } else expect(() => read(catalog)).toThrow(/cards are invalid/);
    }
  });

  it("rejects multibyte catalogs above the byte budget even when their character count fits", () => {
    const catalog = structuredClone(fixture.editorial.catalog);
    catalog.sources["home-posts"].cards = Array.from({ length: 90 }, (_, index) => ({
      id: `post-${index}`, source: "station_posts", title: "Published story", href: `/posts/story-${index}/`, summary: "界".repeat(4000),
    }));
    const encoded = homeCatalogJson(catalog);
    expect(encoded.length).toBeLessThan(400_000);
    expect(Buffer.byteLength(encoded, "utf8")).toBeGreaterThan(1_048_576);
    expect(() => readHomeEditorialCatalog(catalog)).toThrow(/too large/);
    catalog.sources["home-posts"].cards.forEach(card => { card.summary = "a".repeat(4000); });
    expect(Buffer.byteLength(homeCatalogJson(catalog), "utf8")).toBeLessThan(400_000);
    expect(readHomeEditorialCatalog(catalog)).toEqual(catalog);
  });
});
