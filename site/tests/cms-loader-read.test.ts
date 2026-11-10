import { describe, expect, it, vi } from "vitest";
import {
  readCmsContentFromDatabase,
  type CmsPageDoc,
  type CmsPublicAsset,
} from "../src/lib/cms-loader";

const NOW = new Date("2026-07-15T12:00:00.000Z");

function snapshot<T extends object>(
  id: string,
  value: T | undefined,
) {
  return {
    id,
    exists: value !== undefined,
    data: () =>
      (value === undefined ? {} : { ...value }) as Record<string, unknown>,
  };
}

function databaseFixture({
  pages,
  assets,
}: {
  pages: Record<string, CmsPageDoc>;
  assets: Record<string, CmsPublicAsset>;
}) {
  const reads = {
    pageCollection: vi.fn(),
    pageDocuments: vi.fn(),
    assetCollection: vi.fn(),
    assetDocuments: vi.fn(),
  };
  const database = {
    collection(name: string) {
      if (name === "cmsPages") {
        return {
          async get() {
            reads.pageCollection();
            return {
              docs: Object.entries(pages).map(([id, page]) =>
                snapshot(id, page),
              ),
            };
          },
          doc(id: string) {
            return {
              async get() {
                reads.pageDocuments(id);
                return snapshot(id, pages[id]);
              },
            };
          },
        };
      }
      if (name === "media_assets_public") {
        return {
          async get() {
            reads.assetCollection();
            return {
              docs: Object.entries(assets).map(([id, asset]) =>
                snapshot(id, asset),
              ),
            };
          },
          doc(id: string) {
            return {
              async get() {
                reads.assetDocuments(id);
                return snapshot(id, assets[id]);
              },
            };
          },
        };
      }
      throw new Error(`Unexpected collection ${name}`);
    },
  };
  return { database, reads };
}

function page(
  id: string,
  assetId: string,
  overrides: Partial<CmsPageDoc> = {},
): CmsPageDoc {
  const blocks = [
    {
      id: `image-${id}`,
      type: "image",
      order: 0,
      visible: true,
      data: { assetId, alt: `${id} image` },
    },
  ];
  return {
    id,
    title: id,
    template: "genericPage",
    status: "published",
    publishAt: "2026-07-15T11:00:00.000Z",
    blocks,
    version: 2,
    published: {
      blocks,
      metadata: { title: id },
      publishedAt: "2026-07-15T11:00:00.000Z",
      publishedBy: "editor-1",
      sourceVersion: 2,
    },
    ...overrides,
  };
}

function asset(id: string): CmsPublicAsset {
  return {
    id,
    url: `https://media.njpbs.org/cms-media/${id}.webp`,
    mimeType: "image/webp",
    width: 1600,
    height: 900,
  };
}

describe("CMS loader Firestore reads", () => {
  it("reads only the selected draft document and its referenced assets", async () => {
    const { database, reads } = databaseFixture({
      pages: {
        contact: page("contact", "contact-image", {
          status: "draft",
          social: { imageAssetId: "contact-social" },
        }),
        faq: page("faq", "faq-image"),
      },
      assets: {
        "contact-image": asset("contact-image"),
        "contact-social": asset("contact-social"),
        "faq-image": asset("faq-image"),
      },
    });

    const result = await readCmsContentFromDatabase(
      database,
      { mode: "draft", pageId: "contact" },
      NOW,
    );

    expect(result.pages.map(({ id }) => id)).toEqual(["contact"]);
    expect(result.assets.map(({ id }) => id).sort()).toEqual([
      "contact-image",
      "contact-social",
    ]);
    expect(reads.pageCollection).not.toHaveBeenCalled();
    expect(reads.pageDocuments).toHaveBeenCalledExactlyOnceWith("contact");
    expect(reads.assetCollection).not.toHaveBeenCalled();
    expect(reads.assetDocuments.mock.calls.flat().sort()).toEqual([
      "contact-image",
      "contact-social",
    ]);
  });

  it("reads assets only for pages admitted at the shared build instant", async () => {
    const { database, reads } = databaseFixture({
      pages: {
        contact: page("contact", "current-image"),
        faq: page("faq", "future-image", {
          publishAt: "2026-07-16T12:00:00.000Z",
        }),
      },
      assets: {
        "current-image": asset("current-image"),
        "future-image": asset("future-image"),
      },
    });

    const result = await readCmsContentFromDatabase(
      database,
      { mode: "published" },
      NOW,
    );

    expect(result.pages.map(({ id }) => id).sort()).toEqual(["contact", "faq"]);
    expect(result.assets.map(({ id }) => id)).toEqual(["current-image"]);
    expect(reads.pageCollection).toHaveBeenCalledOnce();
    expect(reads.pageDocuments).not.toHaveBeenCalled();
    expect(reads.assetCollection).not.toHaveBeenCalled();
    expect(reads.assetDocuments).toHaveBeenCalledExactlyOnceWith(
      "current-image",
    );
  });

  it("keeps the Firestore document path authoritative over stored id data", async () => {
    const { database, reads } = databaseFixture({
      pages: {
        rogue: page("home", "rogue-image"),
      },
      assets: {
        "rogue-image": asset("rogue-image"),
      },
    });

    const result = await readCmsContentFromDatabase(
      database,
      { mode: "published" },
      NOW,
    );

    expect(result.pages.map(({ id }) => id)).toEqual(["rogue"]);
    expect(result.assets).toEqual([]);
    expect(reads.assetDocuments).not.toHaveBeenCalled();
  });
});
