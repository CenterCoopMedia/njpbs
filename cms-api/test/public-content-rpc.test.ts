import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, env as workerEnv } from "cloudflare:test";

import {
  fetchPublicPageProjection,
  PublicContentEntrypoint,
  type CmsApiEnv,
} from "../src/index";
import { LIVE } from "./fixtures/published-page";
import post from "../../site/tests/fixtures/shadow-posts/post.json";

afterEach(() => vi.unstubAllGlobals());

// The isolated Route D executor supplies the exact native emulator replies
// after real C1/C0 writes. Ordinary unit runs use the existing wire fixtures at
// the same third-party Functions-fetch boundary; no repository owner is mocked.
const supplied = (workerEnv as unknown as { CMS_ROUTE_D_REPLIES?: string }).CMS_ROUTE_D_REPLIES;
const routeDReplies = supplied ? JSON.parse(supplied) : {
  postChrome: [{ value: { kind: "post", receipt: { rendererSha: "a".repeat(40), admissionRevision: 1 }, published: post } }],
  capabilities: [{ value: { kind: "page", receipt: { rendererSha: "a".repeat(40) }, published: LIVE } }],
};

it.each(["postChrome", "capabilities"])("Route D source-bound native %s RPC preserves the reply", async feature => {
  expect(routeDReplies[feature].length).toBeGreaterThan(0);
  for (const row of routeDReplies[feature]) {
    const value = row.value;
    const rendererSha = (value.receipt ?? value.contextReceipt).rendererSha;
    const path = feature === "postChrome" ? `/posts/${value.receipt.slug ?? "shadow-fixture"}/` : value.receipt?.path ?? value.renderContext?.path ?? "/contact/";
    const wire = JSON.stringify(value);
    const network = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://us-central1-njpbs-site.cloudfunctions.net/cmsGetPublicPage");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("x-njpbs-cms-edge")).toBe("synthetic-edge");
      expect(JSON.parse(String(init?.body))).toMatchObject({ path, rendererSha, method: "GET",
        mode: feature === "postChrome" ? "no-build-post-v1" : "no-build-page-v1" });
      return new Response(wire, { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", network);
    const { PREVIEW_RENDERER: _previewRenderer, ...publicBindings } = workerEnv;
    const rpcEnv: CmsApiEnv = { ...env(), ...publicBindings, CMS_EDGE_ORIGIN_SECRET: "synthetic-edge",
      CMS_DEPLOYMENT_ENVIRONMENT: "production", FIREBASE_PROJECT_ID: "njpbs-site", FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site.cloudfunctions.net" };
    const rpc = new PublicContentEntrypoint(createExecutionContext(), rpcEnv);
    const result = feature === "postChrome" ? await rpc.getNoBuildPost(path, rendererSha) : await rpc.getNoBuildPage(path, rendererSha);
    expect(JSON.stringify(result)).toBe(wire);
    expect(network).toHaveBeenCalledOnce();
  }
});

function env(): CmsApiEnv {
  return {
    ALLOW_LOCAL_ORIGINS: "false",
    CMS_EDGE_ORIGIN_SECRET: "edge-secret-for-tests",
    FIREBASE_PROJECT_ID: "njpbs-site",
    FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site.cloudfunctions.net",
    RATE_LIMITERS: {} as unknown as CmsApiEnv["RATE_LIMITERS"],
  };
}

describe("private public-content RPC core", () => {
  it.each([true, false])("preserves childDirected=%s through the private API projection", async childDirected => {
    const result = await fetchPublicPageProjection(env(), "contact", {
      fetchOrigin: vi.fn<typeof fetch>(async () => Response.json({ ...LIVE, page: { ...LIVE.page, childDirected } })),
    });
    expect(result.state === "live" && result.page.childDirected).toBe(childDirected);
  });
  it.each(["true", "false", 1, null])("rejects malformed child-directed projection metadata: %s", async childDirected => {
    await expect(fetchPublicPageProjection(env(), "contact", {
      fetchOrigin: vi.fn<typeof fetch>(async () => Response.json({ ...LIVE, page: { ...LIVE.page, childDirected } })),
    })).rejects.toThrow("Invalid projection");
  });
  const notice = {
    id: "notices", type: "document_list", order: 0, visible: true,
    data: { documents: [{
      itemId: "notice-one", assetId: "pdf-one", title: "Board notice",
      publisher: "njpba", addedAt: "2026-10-07T12:00:00.000Z",
    }] },
  };
  const pdf = { url: "https://media.njpbs.org/cms-media/notice.pdf", mimeType: "application/pdf" };
  const image = { url: "https://media.njpbs.org/cms-media/photo.jpg", mimeType: "image/jpeg", width: 640, height: 480 };
  const readPage = (page: Record<string, unknown>) => fetchPublicPageProjection(env(), "contact", {
    fetchOrigin: vi.fn<typeof fetch>(async () => Response.json({
      ...LIVE, page: { ...LIVE.page, ...page },
    })),
  });

  it("keeps known Page themes and omits malformed historical values", async () => {
    for (const pageTheme of ["default", "nj-decides"] as const) {
      const result = await readPage({ pageTheme });
      expect(result).toMatchObject({ page: { pageTheme } });
    }
    for (const pageTheme of ["retired-campaign-theme", false, null]) {
      const result = await readPage({ pageTheme });
      expect(result.state).toBe("live");
      if (result.state !== "live") throw new Error("Expected live projection");
      expect(result.page).not.toHaveProperty("pageTheme");
    }
  });

  it("selects bounded current image credit and excludes library description or storage fields", async () => {
    const blocks = [{ id: "photo", type: "image", order: 0, visible: true, data: { assetId: "photo-one", alt: "Context" } }];
    const result = await readPage({ blocks, assets: { "photo-one": { ...image, credit: "Current photographer", description: "Private description", storageKey: "Private object" } } });
    expect(result).toMatchObject({ page: { assets: { "photo-one": { ...image, credit: "Current photographer" } } } });
    expect(JSON.stringify(result)).not.toMatch(/Private description|storageKey/);
    for (const credit of [42, {}, "x".repeat(301)]) {
      await expect(readPage({ blocks, assets: { "photo-one": { ...image, credit } } })).rejects.toThrow(/invalid projection/i);
    }
  });

  it.each([
    ["https://media.njpbs.org/cms-media/photo.jpg", false, true],
    ["https://njpbs.org/brand/logo.png", false, true],
    ["https://dev-media.example.org/cms-media/photo.jpg", false, false],
    ["https://dev-public.example.org/brand/logo.png", false, false],
    ["https://media.njpbs.org/cms-media/photo.jpg", true, true],
    ["https://njpbs.org/brand/logo.png", true, true],
    ["https://dev-media.example.org/cms-media/photo.jpg", true, true],
    ["https://dev-public.example.org/brand/logo.png", true, true],
    ["https://example.test/cms-media/photo.jpg", true, false],
    ["https://dev-media.example.org/private/photo.jpg", true, false],
    ["https://dev-media.example.org/cms-media/photo.jpg?token=private", true, false],
  ])("enforces environment asset hosts at the RPC boundary: %s dev=%s", async (url, dev, admitted) => {
    const result = fetchPublicPageProjection({ ...env(),
      CMS_DEPLOYMENT_ENVIRONMENT: dev ? "development" : "production",
      ADMIN_ORIGIN: dev ? "https://dev-admin.example.org" : "https://admin.njpbs.org",
      FIREBASE_PROJECT_ID: dev ? "njpbs-site-dev" : "njpbs-site",
      FUNCTIONS_ORIGIN: dev ? "https://us-central1-njpbs-site-dev.cloudfunctions.net" : env().FUNCTIONS_ORIGIN,
    }, "contact", {
      fetchOrigin: async () => Response.json({ ...LIVE, page: { ...LIVE.page,
        blocks: [{ id: "photo", type: "image", order: 0, visible: true,
          data: { assetId: "photo-one", alt: "Fixture" } }],
        assets: { "photo-one": { ...image, url } },
      } }),
    });
    if (admitted) expect(await result).toMatchObject({ page: { assets: { "photo-one": { url } } } });
    else await expect(result).rejects.toThrow(/invalid projection/i);
  });

  it.each(["media.njpbs.org", "dev-media.example.org"])("admits dev PDFs from %s", async (host) => {
    const url = `https://${host}/cms-media/notice.pdf`;
    const result = await fetchPublicPageProjection({ ...env(), CMS_DEPLOYMENT_ENVIRONMENT: "development", FIREBASE_PROJECT_ID: "njpbs-site-dev",
      ADMIN_ORIGIN: "https://dev-admin.example.org",
      FUNCTIONS_ORIGIN: "https://us-central1-njpbs-site-dev.cloudfunctions.net" }, "contact", {
      fetchOrigin: async () => Response.json({ ...LIVE, page: { ...LIVE.page,
        blocks: [notice], assets: { "pdf-one": { ...pdf, url } },
      } }),
    });
    expect(result).toMatchObject({ page: { assets: { "pdf-one": { url } } } });
  });

  it("preserves dimensionless PDF notices and dimensioned images through the actual RPC decoder", async () => {
    const blocks = [notice, {
      id: "photo", type: "image", order: 1, visible: true,
      data: { assetId: "photo-one", alt: "A photo" },
    }];
    const result = await readPage({ blocks, assets: {
      "pdf-one": { ...pdf, privateNote: "omit", width: 1, height: 1 },
      "photo-one": image,
    } });
    expect(result.state).toBe("live");
    if (result.state !== "live") throw new Error("Expected live projection");
    expect(result.page.blocks).toEqual(blocks);
    expect(result.page.assets).toEqual({ "pdf-one": pdf, "photo-one": image });
    const dimensionless = await readPage({ blocks: [notice], assets: { "pdf-one": pdf } });
    expect(dimensionless.state === "live" && dimensionless.page.assets["pdf-one"]).toEqual(pdf);
  });

  it.each([
    "https://njpbs.org/brand/notice.pdf",
    "https://example.com/cms-media/notice.pdf",
    "https://media.njpbs.org/private/notice.pdf",
    "https://media.njpbs.org/cms-media/",
    "http://media.njpbs.org/cms-media/notice.pdf",
    "https://media.njpbs.org:444/cms-media/notice.pdf",
    "https://user@media.njpbs.org/cms-media/notice.pdf",
    "https://media.njpbs.org/cms-media/notice.pdf?token=private",
    "https://media.njpbs.org/cms-media/notice.pdf#fragment",
  ])("rejects a PDF outside the approved public-media URL contract: %s", async (url) => {
    await expect(readPage({ blocks: [notice], assets: { "pdf-one": { ...pdf, url } } }))
      .rejects.toThrow(/invalid projection/i);
  });

  it.each([undefined, image, { ...pdf, mimeType: "text/html" }])(
    "rejects missing or non-PDF notice assets: %j", async (asset) => {
      await expect(readPage({ blocks: [notice], assets: asset ? { "pdf-one": asset } : {} }))
        .rejects.toThrow(/invalid projection/i);
    },
  );

  it.each([
    { heroBackgroundImage: "pdf-one" },
    { social: { imageAssetId: "pdf-one" } },
    { homeHero: { items: [{ imageAssetId: "pdf-one" }] } },
    { blocks: [notice, { id: "photo", type: "image", order: 1, visible: true,
      data: { assetId: "pdf-one", alt: "A photo" } }] },
    { blocks: [notice, { id: "gallery", type: "image_gallery", order: 1, visible: true,
      data: { images: [{ assetId: "pdf-one", alt: "A photo" }] } }] },
    { blocks: [notice, { id: "cards", type: "card_grid", order: 1, visible: true,
      data: { cards: [{ title: "Card", imageAssetId: "pdf-one" }] } }] },
    { blocks: [notice, { id: "shelf", type: "promotion_playlist", order: 1, visible: true,
      data: { title: "Programs", placement: "before_featured", cards: [{
        itemId: "program", title: "Program", summary: "Summary",
        imageAssetId: "pdf-one", alt: "A photo", href: "/watch/",
      }] } }] },
    { blocks: [] },
  ])("rejects PDFs reused in image slots or unreferenced by notices: %j", async (overrides) => {
    await expect(readPage({ blocks: [notice], assets: { "pdf-one": pdf }, ...overrides }))
      .rejects.toThrow(/invalid projection/i);
  });

  it.each([
    { ...image, width: undefined }, { ...image, height: 0 },
    { ...image, width: 1.5 }, { ...image, mimeType: "image/svg+xml" },
  ])("retains image MIME and positive integer dimension checks: %j", async (asset) => {
    await expect(readPage({ assets: { "photo-one": asset } })).rejects.toThrow(/invalid projection/i);
  });

  it("retains the page-template restriction on PDF notice blocks", async () => {
    await expect(fetchPublicPageProjection(env(), "watch", {
      fetchOrigin: vi.fn<typeof fetch>(async () => Response.json({
        ...LIVE, page: { ...LIVE.page, pageId: "watch", path: "/watch/",
          family: "service", template: "programLanding",
          blocks: [notice], assets: { "pdf-one": pdf } },
      })),
    })).rejects.toThrow(/invalid projection/i);
  });

  it("preserves row columns and child membership across the private projection", async () => {
    const blocks = [
      { id: "row", type: "row", order: 0, visible: true, data: { columns: [6, 6] } },
      { id: "hidden", type: "divider", order: 1, visible: false, layout: { rowId: "row", column: 0 }, data: {} },
      { id: "child", type: "divider", order: 2, visible: true, layout: { rowId: "row", column: 1 }, data: {} },
    ];
    const fetchOrigin = vi.fn<typeof fetch>(async () => Response.json({ ...LIVE, page: { ...LIVE.page, blocks } }));
    const result = await fetchPublicPageProjection(env(), "contact", { fetchOrigin });
    expect(result.state).toBe("live");
    if (result.state !== "live") throw new Error("Expected live projection");
    expect(result.page.blocks).toEqual([blocks[0], { ...blocks[2], order: 1 }]);
    blocks[0].visible = false;
    const hidden = await fetchPublicPageProjection(env(), "contact", { fetchOrigin });
    expect(hidden.state === "live" && hidden.page.blocks).toEqual([]);
  });

  it("preserves optional custom shelf layout controls across the private projection", async () => {
    const shelf = (id: string, order: number, layout: Record<string, unknown> = {}) => ({
      id,
      type: "promotion_playlist" as const,
      order,
      visible: true,
      data: {
        title: `Shelf ${id}`,
        placement: "before_featured" as const,
        ...layout,
        cards: [{
          itemId: `card-${id}`,
          title: `Program ${id}`,
          summary: "Program summary.",
          imageAssetId: `asset-${id}`,
          alt: "Program image",
          href: "/watch/",
        }],
      },
    });
    const blocks = [
      shelf("configured", 0, { presentation: "grid", columns: 4 }),
      shelf("legacy", 1),
    ];
    const fetchOrigin = vi.fn<typeof fetch>(async () =>
      Response.json({ ...LIVE, page: { ...LIVE.page, blocks } }),
    );

    const result = await fetchPublicPageProjection(env(), "contact", { fetchOrigin });

    expect(result.state).toBe("live");
    if (result.state !== "live") throw new Error("Expected live projection");
    expect(result.page.blocks).toEqual(blocks);
    expect(result.page.blocks[1]?.data).not.toHaveProperty("presentation");
    expect(result.page.blocks[1]?.data).not.toHaveProperty("columns");
  });

  it("preserves optional content shelf layout across the private projection", async () => {
    const shelf = (id: string, order: number, layout: Record<string, unknown> = {}) => ({
      id,
      type: "content_shelf" as const,
      order,
      visible: true,
      data: {
        title: `Shelf ${id}`,
        source: "pbs_featured" as const,
        itemLimit: 6 as const,
        moreLabel: "See all",
        moreHref: "/watch/",
        ...layout,
      },
    });
    const blocks = [shelf("configured", 0, { presentation: "grid", columns: 3 }), shelf("legacy", 1)];
    const home = { ...LIVE.page, pageId: "home", path: "/", family: "home", template: "home", blocks };
    const fetchOrigin = vi.fn<typeof fetch>(async () => Response.json({ ...LIVE, page: home }));

    const result = await fetchPublicPageProjection(env(), "home", { fetchOrigin });

    expect(result.state).toBe("live");
    if (result.state !== "live") throw new Error("Expected live projection");
    expect(result.page.blocks).toEqual(blocks);
    expect(result.page.blocks[1]?.data).not.toHaveProperty("presentation");
    expect(result.page.blocks[1]?.data).not.toHaveProperty("columns");
  });

  it("keeps AP map settings through the private RPC projection", async () => {
    const embed = { id: "archive-map", type: "embed" as const, order: 0, visible: true, data: {
      url: "https://interactives.apelections.org/election-results/customers/layouts/organization-layouts/published/111593/29191.html",
      heading: "Archived Senate primary results", caption: "June 2, 2026. Archive example.",
      mapSize: "large" as const, mobileHeight: 700, mapWidth: "wide" as const,
    } };
    const result = await readPage({ blocks: [embed] });
    if (result.state !== "live") throw new Error("Expected live projection");
    expect(result.page.blocks).toEqual([embed]);
  });

  it.each([
    { pageId: "watch", path: "/watch/", family: "service", template: "programLanding" },
    { pageId: "contact", path: "/contact/", family: "article", template: "genericPage" },
  ] as const)("keeps the reviewed county comparison through the $template RPC projection", async metadata => {
    const comparison = { id: "county-history", type: "county_comparison" as const, order: 0, visible: true, data: {
      datasetVersion: "nj-federal-counties-2020-2024-v1", heading: "County election history",
      intro: "Compare official federal results.", source: "New Jersey Division of Elections",
    } };
    const result = await fetchPublicPageProjection(env(), metadata.pageId, {
      fetchOrigin: vi.fn<typeof fetch>(async () => Response.json({ ...LIVE,
        page: { ...LIVE.page, ...metadata, blocks: [comparison] },
      })),
    });
    if (result.state !== "live") throw new Error("Expected live projection");
    expect(result.page.blocks).toEqual([comparison]);
  });

  it("refuses county comparison in the Home RPC projection", async () => {
    await expect(fetchPublicPageProjection(env(), "home", {
      fetchOrigin: vi.fn<typeof fetch>(async () => Response.json({ ...LIVE, page: {
        ...LIVE.page, pageId: "home", path: "/", family: "home", template: "home",
        blocks: [{ id: "county-history", type: "county_comparison", order: 0, visible: true,
          data: { datasetVersion: "nj-federal-counties-2020-2024-v1", heading: "", intro: "", source: "" } }],
      } })),
    })).rejects.toThrow("Invalid projection");
  });

  it("preserves optional player dimensions across the private projection", async () => {
    const embed = {
      id: "video-1",
      type: "embed" as const,
      order: 0,
      visible: true,
      data: {
        url: "https://youtu.be/od8NMua_mEw",
        caption: "Interview",
        width: 640,
        height: 360,
      },
    };
    const fetchOrigin = vi.fn<typeof fetch>(async () =>
      Response.json({
        ...LIVE,
        page: {
          ...LIVE.page,
          pageId: "watch",
          path: "/watch/",
          family: "service",
          template: "programLanding",
          blocks: [embed],
        },
      }),
    );

    const result = await fetchPublicPageProjection(env(), "watch", { fetchOrigin });

    expect(result.state).toBe("live");
    if (result.state !== "live") throw new Error("Expected live projection");
    expect(result.page.blocks).toEqual([embed]);
  });

  it("forwards through the edge-secret boundary and returns a closed exact live version", async () => {
    const headline = {
      id: "headline-1",
      type: "headline" as const,
      order: 1,
      visible: true,
      data: { text: "Published headline", level: 2 },
    };
    const fetchOrigin = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          ...LIVE,
          page: {
            ...LIVE.page,
            blocks: [
              {
                ...headline,
                internalNote: "must not cross the RPC boundary",
                data: {
                  ...headline.data,
                  internalNote: "must not cross the RPC boundary",
                },
              },
            ],
          },
        },
        { headers: { "content-type": "application/json" } },
      ),
    );

    await expect(
      fetchPublicPageProjection(env(), "contact", { fetchOrigin }),
    ).resolves.toEqual({
      ...LIVE,
      page: { ...LIVE.page, blocks: [headline] },
    });

    const [url, init] = fetchOrigin.mock.calls[0]!;
    expect(url).toBe(
      "https://us-central1-njpbs-site.cloudfunctions.net/cmsGetPublicPage",
    );
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("x-njpbs-cms-edge")).toBe(
      "edge-secret-for-tests",
    );
    expect(JSON.parse(String(init?.body))).toEqual({ pageId: "contact" });
  });

  it("preserves a renamed Contact path through the private API projection", async () => {
    const fetchOrigin = vi.fn<typeof fetch>(async () =>
      Response.json({
        ...LIVE,
        page: { ...LIVE.page, path: "/contact-us/" },
      }),
    );

    const result = await fetchPublicPageProjection(env(), "contact", {
      fetchOrigin,
    });

    expect(result.state === "live" && result.page.path).toBe("/contact-us/");
  });

  it.each([
    { apiVersion: 1, state: "unmanaged", pageId: "contact" },
    { apiVersion: 1, state: "withdrawn", pageId: "contact" },
  ] as const)("accepts the private $state union arm", async (projection) => {
    const fetchOrigin = vi.fn<typeof fetch>(async () => Response.json(projection));
    await expect(
      fetchPublicPageProjection(env(), "contact", { fetchOrigin }),
    ).resolves.toEqual(projection);
  });

  it("fails closed on an unknown request, malformed response, or unavailable function", async () => {
    await expect(
      fetchPublicPageProjection(env(), "not-a-page", { fetchOrigin: vi.fn() }),
    ).rejects.toThrow(/refused/i);
    await expect(
      fetchPublicPageProjection(env(), "contact", {
        fetchOrigin: vi.fn<typeof fetch>(async () =>
          Response.json({ ...LIVE, page: { ...LIVE.page, sourceVersion: "7" } }),
        ),
      }),
    ).rejects.toThrow(/invalid projection/i);
    await expect(
      fetchPublicPageProjection(env(), "contact", {
        fetchOrigin: vi.fn<typeof fetch>(async () =>
          Response.json({ ...LIVE, page: { ...LIVE.page, homeHeroTitle: 42 } }),
        ),
      }),
    ).rejects.toThrow(/invalid projection/i);
    await expect(
      fetchPublicPageProjection(env(), "contact", {
        fetchOrigin: vi.fn<typeof fetch>(async () =>
          new Response("unavailable", { status: 503 }),
        ),
      }),
    ).rejects.toThrow(/unavailable/i);
  });

  it("does not expose the RPC through the public HTTP endpoint allowlist", async () => {
    const source = await import("../src/config");
    expect(source.endpointPolicy("/cmsGetPublicPage")).toBeNull();
    expect(source.endpointPolicy("/getPublicPageProjection")).toBeNull();
    // Inherited Object members are not endpoints.
    for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty"]) expect(source.endpointPolicy(`/${name}`)).toBeNull();
  });
});
