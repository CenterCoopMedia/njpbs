import { describe, expect, it, vi } from "vitest";

import publicContent from "../../functions/public-content.js";
import publicProjection from "../../functions/lib/public-content-projection.js";

const {
  createCmsGetPublicPageHandler,
  readPublicPageProjection,
} = publicContent;
const { projectPublicPageDocument } = publicProjection;

const PUBLISHED_AT = "2026-08-25T12:00:00.000Z";
const NOW = new Date("2026-08-25T12:00:01.000Z");

function publishedPage(overrides = {}) {
  return {
    status: "published",
    publishAt: PUBLISHED_AT,
    publiclyVisible: true,
    template: "genericPage",
    title: "Draft title must not leak",
    description: "Draft description must not leak",
    homeHeroTitle: "Draft hero title must not leak",
    homeHeroSubtitle: "Draft hero subtitle must not leak",
    blocks: [],
    version: 8,
    published: {
      metadata: {
        title: "Published contact title",
        description: "Published contact description",
        homeHeroTitle: "Published hero title",
        homeHeroSubtitle: "Published hero subtitle",
        seo: { title: "Published SEO title", noindex: false },
      },
      blocks: [
        {
          id: "headline-1",
          type: "headline",
          order: 1,
          visible: true,
          internalNote: "must not cross the public boundary",
          data: {
            text: "Published headline",
            level: 2,
            internalNote: "must not cross the public boundary",
          },
        },
      ],
      publishedAt: PUBLISHED_AT,
      publishedBy: "publisher-1",
      sourceVersion: 7,
    },
    ...overrides,
  };
}

function fakeFirestore(documents) {
  const reference = (path) => ({ path });
  return {
    collection(collectionId) {
      return {
        doc(documentId) {
          const path = `${collectionId}/${documentId}`;
          return {
            ...reference(path),
            async get() {
              const value = documents[path];
              return {
                id: documentId,
                exists: value !== undefined,
                data: () => value,
              };
            },
          };
        },
      };
    },
    async getAll(...references) {
      return references.map(({ path }) => {
        const value = documents[path];
        return {
          id: path.slice(path.lastIndexOf("/") + 1),
          exists: value !== undefined,
          data: () => value,
        };
      });
    },
  };
}

function makeReq(body = {}, method = "POST") {
  return { method, body };
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    headersSent: false,
    set(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      this.headersSent = true;
      return this;
    },
  };
}

describe("public page projection", () => {
  it("returns the exact immutable live version while a later draft stays private", () => {
    const result = projectPublicPageDocument({
      pageId: "contact",
      document: publishedPage({ status: "draft", publiclyVisible: true }),
      assets: new Map(),
      now: NOW,
    });

    expect(result).toMatchObject({
      apiVersion: 1,
      state: "live",
      page: {
        pageId: "contact",
        path: "/contact/",
        title: "Published contact title",
        description: "Published contact description",
        homeHeroTitle: "Published hero title",
        homeHeroSubtitle: "Published hero subtitle",
        sourceVersion: 7,
        publishedAt: PUBLISHED_AT,
      },
    });
    expect(JSON.stringify(result)).not.toContain("Draft title");
    expect(JSON.stringify(result)).not.toContain("Draft hero");
    expect(JSON.stringify(result)).not.toContain("publisher-1");
    expect(result.page.blocks).toEqual([
      {
        id: "headline-1",
        type: "headline",
        order: 1,
        visible: true,
        data: { text: "Published headline", level: 2 },
      },
    ]);
  });

  it("keeps optional embed dimensions at the public boundary", () => {
    const result = projectPublicPageDocument({
      pageId: "watch",
      document: publishedPage({
        template: "programLanding",
        published: {
          ...publishedPage().published,
          blocks: [{
            id: "video-1",
            type: "embed",
            order: 0,
            visible: true,
            data: {
              url: "https://youtu.be/od8NMua_mEw",
              caption: "Interview",
              width: 640,
              height: 360,
            },
          }],
        },
      }),
      assets: new Map(),
      now: NOW,
    });

    expect(result.page.blocks[0].data).toEqual({
      url: "https://youtu.be/od8NMua_mEw",
      caption: "Interview",
      width: 640,
      height: 360,
    });
  });

  it("keeps a published video block's stamped public copy (#2751)", () => {
    const media = {
      url: `https://media.njpbs.org/cms-media/video/asset-1/${"a".repeat(64)}.mp4`,
      posterUrl: `https://media.njpbs.org/cms-media/video/asset-1/${"b".repeat(64)}.jpg`,
      width: 1920,
      height: 1080,
      mimeType: "video/mp4",
    };
    const result = projectPublicPageDocument({
      pageId: "contact",
      document: publishedPage({
        published: {
          ...publishedPage().published,
          blocks: [{
            id: "clip-1",
            type: "video",
            order: 0,
            visible: true,
            data: { sourceId: "video-library", assetId: "asset-1", title: "Clip", caption: "Shot in Trenton", public: media },
          }],
        },
      }),
      assets: new Map(),
      now: NOW,
    });

    expect(result.page.blocks[0].data).toEqual({
      sourceId: "video-library",
      assetId: "asset-1",
      title: "Clip",
      caption: "Shot in Trenton",
      public: media,
    });
  });

  it("retains optional manual shelf controls without adding defaults", () => {
    const promotion = (id, order, data = {}) => ({
      id,
      type: "promotion_playlist",
      order,
      visible: true,
      data: {
        title: `Shelf ${id}`,
        placement: "before_featured",
        cards: [{
          itemId: `card-${id}`,
          title: `Program ${id}`,
          summary: "Program summary.",
          imageAssetId: `asset-${id}`,
          alt: "Program image",
          href: "/watch/",
        }],
        ...data,
      },
    });
    const result = projectPublicPageDocument({
      pageId: "contact",
      document: publishedPage({
        published: {
          ...publishedPage().published,
          blocks: [
            promotion("configured", 0, { presentation: "grid", columns: 4 }),
            promotion("legacy", 1),
          ],
        },
      }),
      assets: new Map([
        ["asset-configured", {
          url: "https://media.njpbs.org/cms-media/station/configured.webp",
          mimeType: "image/webp",
          width: 1200,
          height: 800,
        }],
        ["asset-legacy", {
          url: "https://media.njpbs.org/cms-media/station/legacy.webp",
          mimeType: "image/webp",
          width: 1200,
          height: 800,
        }],
      ]),
      now: NOW,
    });

    expect(result.page.blocks[0].data).toMatchObject({
      presentation: "grid",
      columns: 4,
    });
    expect(result.page.blocks[1].data).not.toHaveProperty("presentation");
    expect(result.page.blocks[1].data).not.toHaveProperty("columns");
  });

  it("projects every data table field from the immutable public snapshot", () => {
    const result = projectPublicPageDocument({
      pageId: "contact",
      document: publishedPage({
        published: {
          ...publishedPage().published,
          blocks: [{
            id: "county-population",
            type: "data_table",
            order: 0,
            visible: true,
            data: {
              title: "County population",
              csv: "County,Population\nEssex,854917",
              source: "U.S. Census Bureau",
              sourceHref: "https://www.census.gov/",
            },
          }],
        },
      }),
      assets: new Map(),
      now: NOW,
    });

    expect(result.page.blocks).toEqual([{
      id: "county-population",
      type: "data_table",
      order: 0,
      visible: true,
      data: {
        title: "County population",
        csv: "County,Population\nEssex,854917",
        source: "U.S. Census Bureau",
        sourceHref: "https://www.census.gov/",
      },
    }]);
  });

  it("distinguishes an unmanaged page from unpublished and archived pages", () => {
    expect(
      projectPublicPageDocument({
        pageId: "contact",
        document: null,
        assets: new Map(),
        now: NOW,
      }),
    ).toEqual({ apiVersion: 1, state: "unmanaged", pageId: "contact" });

    for (const document of [
      publishedPage({ status: "draft", publiclyVisible: false }),
      publishedPage({ status: "archived", publiclyVisible: false }),
    ]) {
      expect(
        projectPublicPageDocument({
          pageId: "contact",
          document,
          assets: new Map(),
          now: NOW,
        }),
      ).toEqual({ apiVersion: 1, state: "withdrawn", pageId: "contact" });
    }
  });

  it("fails closed on an unknown page or malformed immutable snapshot", () => {
    expect(() =>
      projectPublicPageDocument({
        pageId: "not-a-page",
        document: publishedPage(),
        assets: new Map(),
        now: NOW,
      }),
    ).toThrow(/unknown public page/i);
    expect(() =>
      projectPublicPageDocument({
        pageId: "contact",
        document: publishedPage({
          published: {
            ...publishedPage().published,
            sourceVersion: "7",
          },
        }),
        assets: new Map(),
        now: NOW,
      }),
    ).toThrow(/source version/i);
    expect(() =>
      projectPublicPageDocument({
        pageId: "contact",
        document: publishedPage({ published: null }),
        assets: new Map(),
        now: NOW,
      }),
    ).toThrow(/published without an immutable snapshot/i);
  });

  it("admits uploaded media only after coordinated deployment is active", async () => {
    const imageBlock = {
      id: "image-1",
      type: "image",
      order: 1,
      visible: true,
      data: { assetId: "asset-1", alt: "A lighthouse" },
    };
    const page = publishedPage({
      published: {
        ...publishedPage().published,
        blocks: [imageBlock],
      },
    });
    const projection = {
      url: "https://media.njpbs.org/cms-media/station/asset-1/image.webp",
      altText: "A lighthouse",
      mimeType: "image/webp",
      width: 1200,
      height: 800,
    };
    const privateAsset = {
      ...projection,
      id: "asset-1",
      lifecycle: "active",
      source: "site_seed",
    };

    await expect(
      readPublicPageProjection({
        firestore: fakeFirestore({
          "cmsPages/contact": page,
          "media_assets/asset-1": { ...privateAsset, source: "upload" },
          "media_assets_public/asset-1": projection,
        }),
        pageId: "contact",
        now: NOW,
      }),
    ).rejects.toThrow(/cannot enter public content/i);

    await expect(
      readPublicPageProjection({
        firestore: fakeFirestore({
          "cmsPages/contact": page,
          "media_assets/asset-1": { ...privateAsset, source: "upload" },
          "media_assets_public/asset-1": projection,
          "system/publicDeployment": {
            schemaVersion: 1,
            mediaLifecycleReady: true,
            state: "idle",
            activeGeneration: 7,
            activeDeploymentId: "deployment-7",
            activeCommitSha: "b".repeat(40),
            lastReservedGeneration: 7,
            newestEligibleGeneration: 7,
            newestEligibleBuildBatchId: "build-seven",
          },
        }),
        pageId: "contact",
        now: NOW,
      }),
    ).resolves.toMatchObject({
      state: "live",
      page: {
        assets: {
          "asset-1": {
            url: projection.url,
            mimeType: projection.mimeType,
            width: projection.width,
            height: projection.height,
          },
        },
      },
    });

    await expect(
      readPublicPageProjection({
        firestore: fakeFirestore({
          "cmsPages/contact": page,
          "media_assets/asset-1": privateAsset,
          "media_assets_public/asset-1": projection,
        }),
        pageId: "contact",
        now: NOW,
      }),
    ).resolves.toMatchObject({
      state: "live",
      page: {
        assets: {
          "asset-1": {
            url: projection.url,
            mimeType: projection.mimeType,
            width: projection.width,
            height: projection.height,
          },
        },
      },
    });
  });
});

describe("cmsGetPublicPage", () => {
  it("returns only the union and fails closed without leaking an internal error", async () => {
    const live = projectPublicPageDocument({
      pageId: "contact",
      document: publishedPage(),
      assets: new Map(),
      now: NOW,
    });
    const readProjectionFn = vi
      .fn()
      .mockResolvedValueOnce(live)
      .mockRejectedValueOnce(Object.assign(new Error("private database detail"), {
        readerCode: "reader_invalid_version", status: 409,
      }));
    const log = { error: vi.fn() };
    const handler = createCmsGetPublicPageHandler({ readProjectionFn, log });

    const success = makeRes();
    await handler(makeReq({ pageId: "contact" }), success);
    expect(success.statusCode).toBe(200);
    expect(success.body).toEqual(live);
    expect(success.headers["cache-control"]).toBe("private, no-store");

    const failed = makeRes();
    await handler(makeReq({ pageId: "contact" }), failed);
    expect(failed.statusCode).toBe(503);
    expect(failed.body).toEqual({ error: "Public content is unavailable" });
    expect(JSON.stringify(failed.body)).not.toContain("database");
    expect(JSON.parse(JSON.stringify(log.error.mock.calls[0]))).toEqual([
      "cmsGetPublicPage failed",
      { pageId: "contact", errorMessage: "private database detail", errorClass: "Error",
        errorCode: "reader_invalid_version", errorStatus: 409 },
    ]);
  });
});


describe("public PDF notice boundary", () => {
  const notice = { itemId: "notice", assetId: "notice-pdf", title: "Board meeting",
    publisher: "njpba", addedAt: PUBLISHED_AT };
  const block = { id: "notices", type: "document_list", order: 0, visible: true,
    data: { documents: [notice] } };
  const pdf = { url: "https://media.njpbs.org/cms-media/notice.pdf", mimeType: "application/pdf",
    altText: null, width: null, height: null };
  const document = (blocks = [block]) => publishedPage({
    published: { ...publishedPage().published, blocks },
  });
  const project = (blocks = [block], asset = pdf) => projectPublicPageDocument({
    pageId: "public-meetings", document: document(blocks),
    assets: new Map([[notice.assetId, asset]]), now: NOW,
  });

  it("returns the immutable PDF notice through the complete read handler", async () => {
    const firestore = fakeFirestore({
      "cmsPages/public-meetings": document(),
      "media_assets/notice-pdf": { ...pdf, source: "site_seed", lifecycle: "active" },
      "media_assets_public/notice-pdf": pdf,
    });
    const response = makeRes();
    await createCmsGetPublicPageHandler({ firestore, now: () => NOW, log: { error: vi.fn() } })(
      makeReq({ pageId: "public-meetings" }), response,
    );
    expect(response.statusCode).toBe(200);
    expect(response.body.page.blocks).toEqual([block]);
    expect(response.body.page.assets).toEqual({ "notice-pdf": { url: pdf.url, mimeType: "application/pdf" } });
    expect(JSON.stringify(response.body)).not.toContain("Draft");
    expect(JSON.stringify(response.body)).not.toContain("publisher-1");
  });

  it("preserves optional publisher omission and excludes hidden notices", () => {
    const { publisher: _publisher, ...withoutPublisher } = notice;
    expect(project([{ ...block, data: { documents: [withoutPublisher] } }]).page.blocks[0].data)
      .toEqual({ documents: [withoutPublisher] });
    const hidden = project([{ ...block, visible: false }]);
    expect(hidden.page.blocks).toEqual([]);
    expect(hidden.page.assets).toEqual({});
  });

  it("rejects missing, unsafe, and non-PDF notice assets", () => {
    for (const asset of [undefined, { ...pdf, url: "https://example.com/notice.pdf" },
      { ...pdf, url: "https://njpbs.org/brand/notice.pdf" },
      { ...pdf, mimeType: "image/png", width: 10, height: 10 }]) {
      expect(() => projectPublicPageDocument({ pageId: "public-meetings", document: document(),
        assets: new Map([[notice.assetId, asset]]), now: NOW })).toThrow();
    }
  });

  it("keeps PDF reads behind lifecycle, readiness, and private/public parity gates", async () => {
    const privateAsset = { ...pdf, source: "site_seed", lifecycle: "active" };
    const cases = [
      { privateAsset: { ...privateAsset, lifecycle: "deleted" }, publicAsset: pdf },
      { privateAsset: { ...privateAsset, source: "upload" }, publicAsset: pdf },
      { privateAsset, publicAsset: { ...pdf, url: "https://media.njpbs.org/cms-media/other.pdf" } },
      { privateAsset, publicAsset: null },
    ];
    for (const entry of cases) {
      await expect(readPublicPageProjection({ pageId: "public-meetings", now: NOW,
        firestore: fakeFirestore({
          "cmsPages/public-meetings": document(),
          "media_assets/notice-pdf": entry.privateAsset,
          ...(entry.publicAsset ? { "media_assets_public/notice-pdf": entry.publicAsset } : {}),
        }),
      })).rejects.toThrow();
    }
  });

  it("still rejects PDF assets in image slots, including shared PDF/image references", async () => {
    const image = { id: "image", type: "image", order: 1, visible: true,
      data: { assetId: notice.assetId, alt: "Meeting notice" } };
    for (const blocks of [[image], [block, image]]) {
      expect(() => project(blocks)).toThrow();
      await expect(readPublicPageProjection({ pageId: "public-meetings", now: NOW,
        firestore: fakeFirestore({
          "cmsPages/public-meetings": document(blocks),
          "media_assets/notice-pdf": { ...pdf, source: "site_seed", lifecycle: "active" },
          "media_assets_public/notice-pdf": pdf,
        }),
      })).rejects.toThrow();
    }
  });
});
