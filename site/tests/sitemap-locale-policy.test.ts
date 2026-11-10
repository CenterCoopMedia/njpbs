// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sitemap: vi.fn((options: unknown) => ({
    name: "captured-sitemap-options",
    options,
  })),
  pageDeclaresNoindex: vi.fn(() => false),
}));

vi.mock("@astrojs/sitemap", () => ({ default: mocks.sitemap }));
vi.mock("../src/lib/sitemap-noindex.ts", () => ({
  pageDeclaresNoindex: mocks.pageDeclaresNoindex,
}));

type SitemapOptions = {
  filter?: (page: string) => boolean;
  i18n?: unknown;
  serialize?: unknown;
};

const configLoad = import("../astro.config.mjs");

async function sitemapOptions(): Promise<SitemapOptions> {
  await configLoad;
  expect(mocks.sitemap).toHaveBeenCalledOnce();
  return mocks.sitemap.mock.calls[0]?.[0] as SitemapOptions;
}

describe("sitemap locale policy", () => {
  it("leaves language alternates to each page head", async () => {
    const options = await sitemapOptions();

    expect(options).not.toHaveProperty("i18n");
    // Adding a serializer needs an output check that proves it emits no alternates.
    expect(options).not.toHaveProperty("serialize");
  });

  it("keeps localized public pages under the existing route filter", async () => {
    const filter = (await sitemapOptions()).filter;
    expect(filter).toBeTypeOf("function");

    expect(filter?.("https://njpbs.org/about/")).toBe(true);
    expect(filter?.("https://njpbs.org/es/about/")).toBe(true);
    expect(filter?.("https://njpbs.org/es/wiki/example/")).toBe(false);
    expect(filter?.("https://njpbs.org/es/design-system/")).toBe(false);
    expect(filter?.("https://njpbs.org/admin/docs/")).toBe(false);
  });

  it("uses emitted noindex metadata for the donate route", async () => {
    const filter = (await sitemapOptions()).filter;
    const donate = "https://njpbs.org/donate/";

    mocks.pageDeclaresNoindex.mockReturnValueOnce(false);
    expect(filter?.(donate)).toBe(true);
    mocks.pageDeclaresNoindex.mockReturnValueOnce(true);
    expect(filter?.(donate)).toBe(false);
  });
});
