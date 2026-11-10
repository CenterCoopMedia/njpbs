import { describe, expect, it } from "vitest";
import {
  projectCmsPage,
  resolveCmsContentMode,
  type CmsPageDoc,
} from "../src/lib/cms-loader";

const NOW = new Date("2026-07-15T12:00:00.000Z");
const RENDERER_SHA = "0123456789abcdef0123456789abcdef01234567";

const divider = (id: string, order: number, visible = true) => ({
  id,
  type: "divider",
  order,
  visible,
  data: {},
});

function publishedPage(overrides: Partial<CmsPageDoc> = {}): CmsPageDoc {
  return {
    id: "contact",
    title: "Mutable draft title",
    description: "Mutable draft description",
    homeHeroTitle: "Mutable draft hero title",
    homeHeroSubtitle: "Mutable draft hero subtitle",
    template: "genericPage",
    status: "published",
    publishAt: "2026-07-15T11:00:00.000Z",
    blocks: [divider("working", 0)],
    published: {
      blocks: [
        divider("second", 2),
        divider("hidden", 1, false),
        divider("first", 0),
      ],
      metadata: {
        title: "Frozen public title",
        description: "Frozen public description",
        homeHeroTitle: "Frozen public hero title",
        homeHeroSubtitle: "Frozen public hero subtitle",
        seo: { title: "Frozen search title", noindex: true },
        social: { title: "Frozen share title" },
      },
      publishedAt: "2026-07-15T11:00:00.000Z",
      publishedBy: "editor-1",
      sourceVersion: 4,
    },
    ...overrides,
  };
}

describe("CMS content mode", () => {
  it("retains the published child-directed flag rather than the mutable draft flag", () => {
    const doc = publishedPage({ childDirected: false });
    (doc.published as { metadata: Record<string, unknown> }).metadata.childDirected = true;
    expect(projectCmsPage(doc, { mode: "published", now: NOW })?.childDirected).toBe(true);
    expect(projectCmsPage(doc, { mode: "draft", pageId: "contact", now: NOW })?.childDirected).toBe(false);
  });
  it("defaults configured builds to published snapshots", () => {
    expect(resolveCmsContentMode({})).toEqual({ mode: "published" });
    expect(resolveCmsContentMode({ CMS_CONTENT_MODE: "published" })).toEqual({
      mode: "published",
    });
  });

  it("requires one canonical page id for a draft build", () => {
    expect(() => resolveCmsContentMode({ CMS_CONTENT_MODE: "draft" })).toThrow(
      /CMS_PREVIEW_PAGE_ID/,
    );
    expect(
      resolveCmsContentMode({
        CMS_CONTENT_MODE: "draft",
        CMS_PREVIEW_PAGE_ID: "contact",
      }),
    ).toEqual({ mode: "draft", pageId: "contact" });
    expect(
      resolveCmsContentMode({
        CMS_CONTENT_MODE: "draft",
        CMS_PREVIEW_PAGE_ID: "contact",
        CMS_PREVIEW_QUEUE_ID: "queue123",
        CMS_PREVIEW_RENDERER_SHA: RENDERER_SHA,
      }),
    ).toEqual({
      mode: "draft",
      pageId: "contact",
      queueId: "queue123",
      rendererSha: RENDERER_SHA,
    });
    expect(() =>
      resolveCmsContentMode({
        CMS_CONTENT_MODE: "draft",
        CMS_PREVIEW_PAGE_ID: "not-a-page",
      }),
    ).toThrow(/Unknown preview page/);
    expect(() =>
      resolveCmsContentMode({
        CMS_CONTENT_MODE: "draft",
        CMS_PREVIEW_PAGE_ID: "contact",
        CMS_PREVIEW_QUEUE_ID: "queue/child",
        CMS_PREVIEW_RENDERER_SHA: RENDERER_SHA,
      }),
    ).toThrow(/QUEUE_ID/);
    expect(() =>
      resolveCmsContentMode({
        CMS_CONTENT_MODE: "draft",
        CMS_PREVIEW_PAGE_ID: "contact",
        CMS_PREVIEW_QUEUE_ID: "queue123",
      }),
    ).toThrow(/RENDERER_SHA/);
  });

  it("rejects an unknown mode instead of silently reading the wrong dataset", () => {
    expect(() => resolveCmsContentMode({ CMS_CONTENT_MODE: "live-ish" })).toThrow(
      /CMS_CONTENT_MODE/,
    );
    expect(() =>
      resolveCmsContentMode({
        CMS_CONTENT_MODE: "published",
        CMS_PREVIEW_QUEUE_ID: "queue123",
      }),
    ).toThrow(/only valid/);
  });
});

describe("projectCmsPage", () => {
  it("builds a public page only from its immutable snapshot", () => {
    const page = projectCmsPage(publishedPage(), {
      mode: "published",
      now: NOW,
    });

    expect(page).toMatchObject({
      pageId: "contact",
      path: "/contact/",
      family: "article",
      template: "genericPage",
      title: "Frozen public title",
      description: "Frozen public description",
      homeHeroTitle: "Frozen public hero title",
      homeHeroSubtitle: "Frozen public hero subtitle",
      noindex: true,
      contentMode: "published",
      sourceVersion: 4,
    });
    expect(page?.blocks.map((block) => block.id)).toEqual(["first", "second"]);
  });

  it("does not mix working metadata into a public snapshot", () => {
    const page = projectCmsPage(
      publishedPage({
        title: "Unpublished title edit",
        description: "Unpublished description edit",
        homeHeroTitle: "Unpublished hero title edit",
        homeHeroSubtitle: "Unpublished hero subtitle edit",
        seo: { noindex: false },
        blocks: [divider("unpublished-working-block", 0)],
      }),
      { mode: "published", now: NOW },
    );

    expect(page?.title).toBe("Frozen public title");
    expect(page?.description).toBe("Frozen public description");
    expect(page?.homeHeroTitle).toBe("Frozen public hero title");
    expect(page?.homeHeroSubtitle).toBe("Frozen public hero subtitle");
    expect(page?.noindex).toBe(true);
    expect(page?.blocks.map((block) => block.id)).toEqual(["first", "second"]);
  });

  it("keeps the immutable snapshot public while a new working revision is reviewed", () => {
    const page = projectCmsPage(
      publishedPage({
        status: "in_review",
        publiclyVisible: true,
        publishAt: "2026-08-20T12:00:00.000Z",
        title: "Unreviewed working title",
        blocks: [divider("unreviewed", 0)],
      }),
      { mode: "published", now: NOW },
    );

    expect(page).toMatchObject({
      title: "Frozen public title",
      sourceVersion: 4,
      publishedAt: "2026-07-15T11:00:00.000Z",
    });
    expect(page?.blocks.map((block) => block.id)).toEqual(["first", "second"]);
  });

  it("keeps the committed route for a block-only snapshot until republish migration", () => {
    const page = projectCmsPage(
      publishedPage({
        title: "Legacy public title",
        description: "Legacy public description",
        publishAt: undefined,
        version: 3,
        published: {
          blocks: [divider("legacy-public", 0)],
          publishedAt: "2026-07-15T11:00:00.000Z",
          publishedBy: "legacy-editor",
        },
      }),
      { mode: "published", now: NOW },
    );

    expect(page).toBeNull();
  });

  it("projects exactly one draft page from its mutable working copy", () => {
    const page = projectCmsPage(
      publishedPage({
        status: "in_review",
        title: "Review title",
        description: "Review description",
        homeHeroTitle: "Review hero title",
        homeHeroSubtitle: "Review hero subtitle",
        seo: { noindex: false },
        blocks: [
          divider("later", 4),
          divider("hidden", 2, false),
          divider("earlier", 1),
        ],
      }),
      { mode: "draft", pageId: "contact", now: NOW },
    );

    expect(page).toMatchObject({
      title: "Review title",
      description: "Review description",
      homeHeroTitle: "Review hero title",
      homeHeroSubtitle: "Review hero subtitle",
      noindex: true,
      contentMode: "draft",
    });
    expect(page?.blocks.map((block) => block.id)).toEqual(["earlier", "later"]);
    expect(
      projectCmsPage(publishedPage(), {
        mode: "draft",
        pageId: "home",
        now: NOW,
      }),
    ).toBeNull();
  });

  it("admits incomplete draft blocks while the public snapshot remains strict", () => {
    const blocks = [
      {
        id: "draft-shelf",
        type: "promotion_playlist",
        order: 0,
        visible: true,
        data: {
          title: "",
          placement: "before_featured",
          cards: [{
            itemId: "draft-card",
            title: "",
            summary: "",
            imageAssetId: "",
            alt: "",
            href: "",
          }],
        },
      },
    ];
    const draft = publishedPage({ status: "draft", blocks });

    expect(projectCmsPage(draft, {
      mode: "draft",
      pageId: "contact",
      now: NOW,
    })?.blocks).toEqual(blocks);
    expect(() => projectCmsPage(publishedPage({
      published: {
        ...publishedPage().published!,
        blocks,
      },
    }), { mode: "published", now: NOW })).toThrow(/invalid data for promotion_playlist/);
  });

  it.each([
    { status: "draft" },
    { status: "scheduled" },
    { publishAt: "2026-07-16T12:00:00.000Z" },
    { deleted: true },
  ])("excludes a public document outside the publish gate (%o)", (override) => {
    expect(
      projectCmsPage(publishedPage(override), {
        mode: "published",
        now: NOW,
      }),
    ).toBeNull();
  });

  it("ignores legacy template singleton ids that are not public routes", () => {
    expect(
      projectCmsPage(
        publishedPage({ id: "genericPage" }),
        { mode: "published", now: NOW },
      ),
    ).toBeNull();
  });

  it("fails a publish build when its admitted snapshot is absent or malformed", () => {
    expect(() =>
      projectCmsPage(publishedPage({ published: undefined }), {
        mode: "published",
        now: NOW,
      }),
    ).toThrow(/published snapshot/);
    expect(() =>
      projectCmsPage(
        publishedPage({
          published: {
            ...publishedPage().published!,
            metadata: { title: "" },
          },
        }),
        { mode: "published", now: NOW },
      ),
    ).toThrow(/title/);
    expect(() =>
      projectCmsPage(
        publishedPage({
          published: {
            blocks: [],
            metadata: { title: "Partial new snapshot" },
            publishedAt: "2026-07-15T11:00:00.000Z",
            publishedBy: "editor-1",
          },
        }),
        { mode: "published", now: NOW },
      ),
    ).toThrow(/incomplete published snapshot/);
  });

  it("fails when stored blocks do not satisfy the canonical model", () => {
    expect(() =>
      projectCmsPage(
        publishedPage({
          published: {
            ...publishedPage().published!,
            blocks: [{ ...divider("bad", 0), type: "unknown" }],
          },
        }),
        { mode: "published", now: NOW },
      ),
    ).toThrow(/blocks/);
  });

  it("resolves every referenced image through the public media projection", () => {
    const page = projectCmsPage(
      publishedPage({
        published: {
          ...publishedPage().published!,
          blocks: [
            {
              id: "image",
              type: "image",
              order: 0,
              visible: true,
              data: { assetId: "asset-1", alt: "A mural" },
            },
          ],
        },
      }),
      {
        mode: "published",
        now: NOW,
        assets: new Map([
          [
            "asset-1",
            {
              id: "asset-1",
              url: "https://media.njpbs.org/cms-media/mural.webp",
              mimeType: "image/webp",
              width: 1600,
              height: 900,
            },
          ],
        ]),
      },
    );

    expect(page?.assets).toEqual({
      "asset-1": {
        url: "https://media.njpbs.org/cms-media/mural.webp",
        mimeType: "image/webp",
        width: 1600,
        height: 900,
      },
    });
    expect(() =>
      projectCmsPage(
        publishedPage({
          published: {
            ...publishedPage().published!,
            blocks: [
              {
                id: "image",
                type: "image",
                order: 0,
                visible: true,
                data: { assetId: "missing", alt: "Missing" },
              },
            ],
          },
        }),
        { mode: "published", now: NOW, assets: new Map() },
      ),
    ).toThrow(/missing media asset missing/);
  });

  it("resolves a social-card image even when no content block uses it", () => {
    const page = projectCmsPage(
      publishedPage({
        published: {
          ...publishedPage().published!,
          blocks: [],
          metadata: {
            title: "Shared page",
            social: {
              title: "Share this page",
              description: "Social card copy",
              imageAssetId: "social-card",
            },
          },
        },
      }),
      {
        mode: "published",
        now: NOW,
        assets: new Map([
          [
            "social-card",
            {
              id: "social-card",
              url: "https://media.njpbs.org/cms-media/social-card.webp",
              mimeType: "image/webp",
              width: 1200,
              height: 630,
            },
          ],
        ]),
      },
    );

    expect(page?.assets["social-card"]).toEqual({
      url: "https://media.njpbs.org/cms-media/social-card.webp",
      mimeType: "image/webp",
      width: 1200,
      height: 630,
    });
    expect(() =>
      projectCmsPage(
        publishedPage({
          published: {
            ...publishedPage().published!,
            blocks: [],
            metadata: {
              title: "Missing share card",
              social: { imageAssetId: "missing-social-card" },
            },
          },
        }),
        { mode: "published", now: NOW },
      ),
    ).toThrow(/missing media asset missing-social-card/);
  });

  it("admits the exact current site-seed brand path", () => {
    const page = projectCmsPage(
      publishedPage({
        published: {
          ...publishedPage().published!,
          blocks: [
            {
              id: "image",
              type: "image",
              order: 0,
              visible: true,
              data: { assetId: "launch-watch", alt: "Watch NJ PBS" },
            },
          ],
        },
      }),
      {
        mode: "published",
        now: NOW,
        assets: new Map([
          [
            "launch-watch",
            {
              id: "launch-watch",
              url: "https://njpbs.org/brand/spotlight/watch.jpg",
              mimeType: "image/jpeg",
              width: 640,
              height: 360,
            },
          ],
        ]),
      },
    );

    expect(page?.assets["launch-watch"]).toEqual({
      url: "https://njpbs.org/brand/spotlight/watch.jpg",
      mimeType: "image/jpeg",
      width: 640,
      height: 360,
    });
  });

  it.each([
    {
      name: "an unrelated HTTPS origin",
      asset: {
        url: "https://example.org/cms-media/mural.webp",
        mimeType: "image/webp",
        width: 1600,
        height: 900,
      },
      error: /approved origin and path/,
    },
    {
      name: "the media origin outside its immutable object path",
      asset: {
        url: "https://media.njpbs.org/private/mural.webp",
        mimeType: "image/webp",
        width: 1600,
        height: 900,
      },
      error: /approved origin and path/,
    },
    {
      name: "the site-seed origin outside the brand path",
      asset: {
        url: "https://njpbs.org/uploads/mural.webp",
        mimeType: "image/webp",
        width: 1600,
        height: 900,
      },
      error: /approved origin and path/,
    },
    {
      name: "URL credentials",
      asset: {
        url: `https://fixture-user:fixture-password@${"media.njpbs.org"}/cms-media/mural.webp`,
        mimeType: "image/webp",
        width: 1600,
        height: 900,
      },
      error: /approved origin and path/,
    },
    {
      name: "a non-default port",
      asset: {
        url: "https://media.njpbs.org:8443/cms-media/mural.webp",
        mimeType: "image/webp",
        width: 1600,
        height: 900,
      },
      error: /approved origin and path/,
    },
    {
      name: "a mutable query string",
      asset: {
        url: "https://media.njpbs.org/cms-media/mural.webp?version=2",
        mimeType: "image/webp",
        width: 1600,
        height: 900,
      },
      error: /approved origin and path/,
    },
    {
      name: "a missing width",
      asset: {
        url: "https://media.njpbs.org/cms-media/mural.webp",
        mimeType: "image/webp",
        height: 900,
      },
      error: /positive dimensions/,
    },
    {
      name: "an unsupported image MIME",
      asset: {
        url: "https://media.njpbs.org/cms-media/mural.svg",
        mimeType: "image/svg+xml",
        width: 1600,
        height: 900,
      },
      error: /supported image/,
    },
  ])("rejects $name before Astro can fetch it", ({ asset, error }) => {
    expect(() =>
      projectCmsPage(
        publishedPage({
          published: {
            ...publishedPage().published!,
            blocks: [
              {
                id: "image",
                type: "image",
                order: 0,
                visible: true,
                data: { assetId: "asset-1", alt: "A mural" },
              },
            ],
          },
        }),
        {
          mode: "published",
          now: NOW,
          assets: new Map([
            ["asset-1", { id: "asset-1", ...asset }],
          ]),
        },
      ),
    ).toThrow(error);
  });

  it.each([
    { status: "scheduled" as const },
    { status: "draft" as const },
    { deleted: true },
  ])(
    "skips an unpublished page carrying a drifted template instead of aborting the build (%o)",
    (override) => {
      // A published build validates the stored template, but that check throws.
      // If it runs before admission, one scheduled or deleted page whose stored
      // template drifted from the registry fails the whole static build. The
      // page is not published, so admission wins and it is simply excluded.
      expect(
        projectCmsPage(publishedPage({ ...override, template: "eventPage" }), {
          mode: "published",
          now: NOW,
        }),
      ).toBeNull();
    },
  );

  it("still rejects an admitted published page whose template drifted from the registry", () => {
    expect(() =>
      projectCmsPage(publishedPage({ template: "eventPage" }), {
        mode: "published",
        now: NOW,
      }),
    ).toThrow(/editor template/);
  });

  it("still rejects a drifted template when previewing that page as a draft", () => {
    expect(() =>
      projectCmsPage(
        publishedPage({ status: "draft", template: "eventPage" }),
        { mode: "draft", pageId: "contact", now: NOW },
      ),
    ).toThrow(/editor template/);
  });
});
