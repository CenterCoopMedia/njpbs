import { describe, expect, it } from "vitest";
import {
  assertPostRouteUniqueness,
  postAssetIds,
  projectCmsPost,
  resolveImage,
  publicCredits,
  type CmsPostDoc,
} from "../src/lib/cms-posts-loader";

// The public Post projection. Mirrors tests/cms-page-projection.test.ts in
// shape, because the two loaders answer the same question about different
// content: what may this build put on njpbs.org, and what must it refuse.

const NOW = new Date("2026-08-21T18:00:00.000Z");

function snapshotMetadata(overrides: Record<string, unknown> = {}) {
  return {
    type: "post",
    title: "Trenton budget hearing draws a crowd",
    slug: "trenton-budget-hearing",
    previousSlugs: [],
    locale: "en",
    categories: ["Station news"],
    tags: ["budget"],
    summary: "Residents filled the room for a two-hour session.",
    // Derived from the first-publish receipt, which is the ordinary case.
    editorialDateSource: "firstPublish",
    firstPublishedAt: "2026-08-20T14:00:00.000Z",
    credits: [
      { kind: "registered", authorId: "au_" + "1".repeat(32), displayName: "Ada Reporter", slug: "ada-reporter" },
    ],
    ...overrides,
  };
}

function post(overrides: Partial<CmsPostDoc> = {}, metadata: Record<string, unknown> = {}): CmsPostDoc {
  return {
    id: "post-one",
    status: "published",
    publishAt: "2026-08-20T14:00:00.000Z",
    published: {
      blocks: [],
      metadata: snapshotMetadata(metadata),
      publishedAt: "2026-08-20T14:00:00.000Z",
      publishedBy: "uid-editor",
      sourceVersion: 4,
    },
    ...overrides,
  };
}

describe("admission", () => {
  it("projects an admitted published post at /posts/{slug}/", () => {
    const projected = projectCmsPost(post(), { now: NOW });
    expect(projected).not.toBeNull();
    expect(projected?.path).toBe("/posts/trenton-budget-hearing/");
    expect(projected?.sourceVersion).toBe(4);
    expect(projected?.displayDate).toBe("2026-08-20");
    expect(projected?.firstPublishedAt).toBe("2026-08-20T14:00:00.000Z");
    expect(projected?.categories).toEqual(["Station news"]);
    expect(projected?.tags).toEqual(["budget"]);
  });

  it("refuses to emit a draft, a soft-deleted post, or a future scheduled one", () => {
    expect(projectCmsPost(post({ status: "draft" }), { now: NOW })).toBeNull();
    expect(projectCmsPost(post({ deleted: true }), { now: NOW })).toBeNull();
    expect(
      projectCmsPost(
        post({ status: "scheduled", publishAt: "2027-01-01T00:00:00.000Z" }),
        { now: NOW },
      ),
    ).toBeNull();
  });

  it("ignores the other record kinds that share the cmsPosts collection", () => {
    expect(
      projectCmsPost(post({}, { type: "program" }), { now: NOW }),
    ).toBeNull();
  });

  it("never reads the working document over the published snapshot", () => {
    const projected = projectCmsPost(
      post({ title: "A draft retitle nobody approved", slug: "draft-slug" }),
      { now: NOW },
    );
    expect(projected?.title).toBe("Trenton budget hearing draws a crowd");
    expect(projected?.slug).toBe("trenton-budget-hearing");
  });

  it("marks a pre-contract post with no first-publication receipt", () => {
    const projected = projectCmsPost(
      post({}, {
        firstPublishedAt: undefined,
        editorialDateSource: "editorial",
        date: "2026-08-20",
      }),
      { now: NOW },
    );
    expect(projected?.firstPublishedAt).toBeNull();
  });

  it("keeps the publication receipt's uids out of the public projection", () => {
    const projected = projectCmsPost(
      post({}, { firstPublishedBy: "uid-editor", meaningfulUpdatedBy: "uid-other" }),
      { now: NOW },
    );
    expect(JSON.stringify(projected)).not.toContain("uid-editor");
    expect(JSON.stringify(projected)).not.toContain("uid-other");
  });
});

describe("fail-closed refusals", () => {
  it("admits incomplete blocks only for an explicit private preview", () => {
    const blocks = [{
      id: "table",
      type: "data_table",
      order: 0,
      visible: true,
      data: { title: "", csv: "", source: "", sourceHref: "" },
    }];
    const snapshot = post().published as Record<string, unknown>;
    const candidate = post({ published: { ...snapshot, blocks } });

    expect(() => projectCmsPost(candidate, { now: NOW })).toThrow(
      /invalid data for data_table/,
    );
    expect(projectCmsPost(candidate, { now: NOW, complete: false })?.blocks)
      .toEqual(blocks);
  });

  it("refuses an admitted post with no route-safe slug", () => {
    expect(() =>
      projectCmsPost(post({}, { slug: "Trenton Budget" }), { now: NOW }),
    ).toThrow(/route-safe published slug/);
    // The public reader accepts every shape the server writer can mint, but
    // still rejects a shape that writer never produces.
    expect(() =>
      projectCmsPost(post({}, { slug: "two--hyphens" }), { now: NOW }),
    ).toThrow(/route-safe published slug/);
  });

  it("refuses an admitted post with no resolvable publication date", () => {
    expect(() =>
      projectCmsPost(
        post({}, { firstPublishedAt: undefined, date: undefined }),
        { now: NOW },
      ),
    ).toThrow(/publication date/);
  });

  it("defaults an absent legacy categories list and refuses malformed taxonomy", () => {
    expect(
      projectCmsPost(post({}, { categories: undefined }), { now: NOW })?.categories,
    ).toEqual([]);
    expect(() =>
      projectCmsPost(post({}, { categories: ["Station news", 42] }), { now: NOW }),
    ).toThrow(/categories must be an array of strings/);
    expect(() =>
      projectCmsPost(post({}, { tags: "budget" }), { now: NOW }),
    ).toThrow(/tags must be an array of strings/);
  });

  it("omits a missing lead image while the asset resolver stays strict (#3582)", () => {
    expect(projectCmsPost(post({}, { heroImage: "asset-one" }), { now: NOW })?.heroImage).toBeNull();
    expect(() => resolveImage("asset-one", new Map())).toThrow(/missing media asset asset-one/);
  });

  it("omits an off-origin lead image while the asset resolver stays strict (#3582)", () => {
    const assets = new Map([
      [
        "asset-one",
        {
          url: "https://cdn.example.com/photo.jpg",
          mimeType: "image/jpeg",
          width: 1600,
          height: 900,
        },
      ],
    ]);
    expect(projectCmsPost(post({}, { heroImage: "asset-one" }), { now: NOW, assets })?.heroImage).toBeNull();
    expect(() => resolveImage("asset-one", assets)).toThrow(/approved origin/);
  });

  it("omits an unsized lead image while the asset resolver stays strict (#3582)", () => {
    const assets = new Map([
      [
        "asset-one",
        {
          url: "https://media.njpbs.org/cms-media/photo.jpg",
          mimeType: "image/jpeg",
          width: 0,
          height: 900,
        },
      ],
    ]);
    expect(projectCmsPost(post({}, { heroImage: "asset-one" }), { now: NOW, assets })?.heroImage).toBeNull();
    expect(() => resolveImage("asset-one", assets)).toThrow(/positive dimensions/);
  });
});

describe("dates and the byline", () => {
  it("shows an update only when the newsroom turned the control on", () => {
    const withUpdate = projectCmsPost(
      post(
        {},
        {
          meaningfulUpdatedAt: "2026-08-21T13:00:00.000Z",
          showUpdatedDate: true,
        },
      ),
      { now: NOW },
    );
    expect(withUpdate?.updateShown).toBe(true);
    expect(withUpdate?.updatedDate).toBe("2026-08-21");

    const silent = projectCmsPost(
      post({}, { meaningfulUpdatedAt: "2026-08-21T13:00:00.000Z" }),
      { now: NOW },
    );
    expect(silent?.updateShown).toBe(false);
    expect(silent?.updatedAt).toBeNull();
  });

  it("carries the authorId of every registered credit for the author-page join", () => {
    const projected = projectCmsPost(post(), { now: NOW });
    expect(projected?.authorIds).toEqual(["au_" + "1".repeat(32)]);
  });

  it("links a registered credit only when a public slug was frozen with it", () => {
    expect(
      publicCredits([
        { kind: "registered", authorId: "au_a", displayName: "Public Person", slug: "public-person" },
        { kind: "registered", authorId: "au_b", displayName: "Private Person" },
        { kind: "custom", name: "NJ PBS staff" },
      ]),
    ).toEqual([
      { name: "Public Person", authorId: "au_a", slug: "public-person" },
      { name: "Private Person", authorId: "au_b" },
      { name: "NJ PBS staff" },
    ]);
  });

  it("drops a registered credit that has no readable frozen name", () => {
    expect(
      publicCredits([{ kind: "registered", authorId: "au_c" }]),
    ).toEqual([]);
  });

  it("reads a pre-credits snapshot's single author as one custom credit", () => {
    const projected = projectCmsPost(
      post({}, { credits: undefined, author: "Wire service" }),
      { now: NOW },
    );
    expect(projected?.credits).toEqual([{ name: "Wire service" }]);
    expect(projected?.authorIds).toEqual([]);
  });
});

describe("retired slugs", () => {
  it("keeps every route-safe previous slug as a redirect source", () => {
    const projected = projectCmsPost(
      post({}, { previousSlugs: ["old-budget-story", "older-budget-story"] }),
      { now: NOW },
    );
    expect(projected?.previousSlugs).toEqual([
      "old-budget-story",
      "older-budget-story",
    ]);
  });

  it("drops a previous slug equal to the live one rather than redirecting a page to itself", () => {
    const projected = projectCmsPost(
      post({}, { previousSlugs: ["trenton-budget-hearing"] }),
      { now: NOW },
    );
    expect(projected?.previousSlugs).toEqual([]);
  });

  it("drops an unroutable retired slug without refusing the live page", () => {
    const projected = projectCmsPost(
      post({}, { previousSlugs: ["Not A Route", "fine-old-slug"] }),
      { now: NOW },
    );
    expect(projected?.previousSlugs).toEqual(["fine-old-slug"]);
  });
});

describe("route uniqueness", () => {
  const base = {
    postId: "one",
    path: "/posts/a/",
    previousSlugs: [] as string[],
  };

  it("accepts a conflict-free set", () => {
    expect(() =>
      assertPostRouteUniqueness([
        { ...base } as never,
        { ...base, postId: "two", path: "/posts/b/" } as never,
      ]),
    ).not.toThrow();
  });

  it("refuses two posts claiming one live route", () => {
    expect(() =>
      assertPostRouteUniqueness([
        { ...base } as never,
        { ...base, postId: "two" } as never,
      ]),
    ).toThrow(/routes collide/);
  });

  it("refuses a new post taking a slug another post still redirects from", () => {
    expect(() =>
      assertPostRouteUniqueness([
        { ...base, postId: "two", path: "/posts/b/", previousSlugs: ["a"] } as never,
        { ...base } as never,
      ]),
    ).toThrow(/routes collide/);
  });
});

describe("asset collection", () => {
  it("collects optional bio portraits and requires the published asset projection", () => {
    const block = {
      id: "bio-one", type: "bio_card", order: 0, visible: true,
      data: {
        profileId: "sample-person", kind: "person", name: "Sample Person",
        role: "Mayor", area: "Example town", summary: "Leads the municipal government.",
        sourceUrl: "https://example.org/mayor", sourceLabel: "Official biography",
        asOf: "2026-10-03", image: { assetId: "bio-portrait", alt: "Sample Person" },
      },
    };
    expect(postAssetIds({}, [block] as never)).toEqual(["bio-portrait"]);
    const snapshot = post().published as Record<string, unknown>;
    const candidate = post({ published: { ...snapshot, blocks: [block] } });
    expect(() => projectCmsPost(candidate, { now: NOW, assets: new Map() }))
      .toThrow(/missing media asset bio-portrait/);
    const projected = projectCmsPost(candidate, { now: NOW, assets: new Map([["bio-portrait", {
      url: "https://media.njpbs.org/cms-media/bio.webp", mimeType: "image/webp",
      width: 640, height: 800,
    }]]) });
    expect(projected?.assets["bio-portrait"]).toMatchObject({ width: 640, height: 800 });
    const { image: _image, ...withoutPhoto } = block.data;
    expect(postAssetIds({}, [{ ...block, data: withoutPhoto }] as never)).toEqual([]);
  });

  it("collects the lead image, the social card, and every block image", () => {
    const blocks = [
      {
        id: "b1",
        type: "image",
        order: 0,
        visible: true,
        data: { assetId: "in-body", alt: "" },
      },
      {
        id: "shelf",
        type: "promotion_playlist",
        order: 1,
        visible: true,
        data: { title: "Programs", placement: "before_featured", cards: [{
          itemId: "program-one",
          title: "Program one",
          summary: "Program summary.",
          imageAssetId: "in-shelf",
          alt: "Program still",
          href: "/programs/program-one/",
        }] },
      },
    ] as never;
    expect(
      postAssetIds(
        { heroImage: "hero", social: { imageAssetId: "card" } },
        blocks,
      ),
    ).toEqual(["card", "hero", "in-body", "in-shelf"]);
  });

  it("keeps nonempty unresolved promotion images fail-closed", () => {
    const snapshot = post().published as Record<string, unknown>;
    const blocks = [{
      id: "shelf",
      type: "promotion_playlist",
      order: 0,
      visible: true,
      data: { title: "Programs", placement: "before_featured", cards: [{
        itemId: "program-one",
        title: "Program one",
        summary: "Program summary.",
        imageAssetId: "missing-shelf-image",
        alt: "Program still",
        href: "/programs/program-one/",
      }] },
    }];

    const candidate = post({ published: { ...snapshot, blocks } });
    expect(() => projectCmsPost(
      candidate,
      { now: NOW, assets: new Map() },
    )).toThrow(/missing media asset missing-shelf-image/);
    expect(projectCmsPost(candidate, { now: NOW, assets: new Map([["missing-shelf-image", {
      url: "https://media.njpbs.org/cms-media/shelf.webp",
      mimeType: "image/webp",
      width: 640,
      height: 360,
    }]]) })?.assets["missing-shelf-image"]).toMatchObject({
      assetId: "missing-shelf-image",
      width: 640,
      height: 360,
    });
  });

  it("leaves an id containing a slash unread rather than building a Firestore path from it", () => {
    expect(postAssetIds({ heroImage: "a/b" }, [])).toEqual([]);
  });
});
