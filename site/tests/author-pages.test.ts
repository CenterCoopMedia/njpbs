import { describe, expect, it } from "vitest";
import { authorPageContent, compareEditorialRecency } from "../src/lib/author-pages";
import type { CmsPostBuildData } from "../src/lib/cms-posts-loader";

// The ratified author-page rules, one test each.

const AUTHOR_A = "au_" + "a".repeat(32);
const AUTHOR_B = "au_" + "b".repeat(32);

function post(
  postId: string,
  authorIds: string[],
  sortInstant: number | null,
  overrides: Partial<CmsPostBuildData> = {},
): CmsPostBuildData {
  return {
    postId,
    slug: postId,
    previousSlugs: [],
    locale: "en",
    path: `/posts/${postId}/`,
    title: `Story ${postId}`,
    summary: `Summary ${postId}`,
    excerpt: "",
    categories: [],
    tags: [],
    credits: [],
    authorIds,
    displayDate: "2026-08-20",
    sortInstant,
    updateShown: false,
    updatedAt: null,
    updatedDate: null,
    heroImage: null,
    heroImageAlt: "",
    heroImageDecorative: false,
    blocks: [],
    assets: {},
    noindex: false,
    sourceVersion: 1,
    firstPublishedAt: "2026-08-20T14:00:00.000Z",
    publishedAt: "2026-08-20T14:00:00.000Z",
    ...overrides,
  };
}

const author = (overrides: Partial<{ pinnedPostId: string | null; hiddenPostIds: string[] }> = {}) => ({
  authorId: AUTHOR_A,
  pinnedPostId: null,
  hiddenPostIds: [] as string[],
  ...overrides,
});

describe("grouping", () => {
  it("excludes noindex Posts from every credited author's archive, including stale pins", () => {
    const posts = [
      post("unlisted", [AUTHOR_A, AUTHOR_B], 300, { noindex: true }),
      post("normal", [AUTHOR_A, AUTHOR_B], 200),
    ];
    for (const authorId of [AUTHOR_A, AUTHOR_B]) {
      const content = authorPageContent({ ...author({ pinnedPostId: "unlisted" }), authorId }, posts);
      expect(content.listings.map((item) => item.postId)).toEqual(["normal"]);
      expect(content.listings[0].pinned).toBe(false);
      expect(authorPageContent({ ...author(), authorId }, [posts[0]]).listings).toEqual([]);
    }
  });

  it("lists only the posts this author is credited on, by stable id", () => {
    const content = authorPageContent(author(), [
      post("mine", [AUTHOR_A], 300),
      post("theirs", [AUTHOR_B], 200),
    ]);
    expect(content.listings.map((item) => item.postId)).toEqual(["mine"]);
  });

  it("lists a coauthored post on both authors' pages", () => {
    const shared = post("shared", [AUTHOR_A, AUTHOR_B], 100);
    expect(authorPageContent(author(), [shared]).listings).toHaveLength(1);
    expect(
      authorPageContent({ ...author(), authorId: AUTHOR_B }, [shared]).listings,
    ).toHaveLength(1);
  });
});

describe("ordering", () => {
  it("sorts newest first by the trusted editorial instant", () => {
    const content = authorPageContent(author(), [
      post("older", [AUTHOR_A], 100),
      post("newest", [AUTHOR_A], 300),
      post("middle", [AUTHOR_A], 200),
    ]);
    expect(content.listings.map((item) => item.postId)).toEqual([
      "newest",
      "middle",
      "older",
    ]);
  });

  it("sorts a post with no resolvable instant last, not first", () => {
    const content = authorPageContent(author(), [
      post("undated", [AUTHOR_A], null),
      post("dated", [AUTHOR_A], 100),
    ]);
    expect(content.listings.map((item) => item.postId)).toEqual([
      "dated",
      "undated",
    ]);
  });

  it("breaks a tie on the post id so the emitted page is byte-stable", () => {
    expect(
      compareEditorialRecency(
        { postId: "b", sortInstant: 100 },
        { postId: "a", sortInstant: 100 },
      ),
    ).toBeGreaterThan(0);
  });
});

describe("the pin", () => {
  it("puts the pinned post first and marks it", () => {
    const content = authorPageContent(author({ pinnedPostId: "older" }), [
      post("older", [AUTHOR_A], 100),
      post("newest", [AUTHOR_A], 300),
    ]);
    expect(content.listings.map((item) => item.postId)).toEqual([
      "older",
      "newest",
    ]);
    expect(content.listings[0].pinned).toBe(true);
    expect(content.listings[1].pinned).toBe(false);
  });

  it("ignores a pin naming a post this author is not credited on", () => {
    const content = authorPageContent(author({ pinnedPostId: "theirs" }), [
      post("mine", [AUTHOR_A], 100),
      post("theirs", [AUTHOR_B], 300),
    ]);
    expect(content.listings.map((item) => item.postId)).toEqual(["mine"]);
    expect(content.listings[0].pinned).toBe(false);
  });

  it("ignores a stale pin naming a post that is no longer published", () => {
    const content = authorPageContent(author({ pinnedPostId: "withdrawn" }), [
      post("mine", [AUTHOR_A], 100),
    ]);
    expect(content.listings).toHaveLength(1);
    expect(content.listings[0].pinned).toBe(false);
  });
});

describe("hiding", () => {
  it("removes the post from this author's page", () => {
    const content = authorPageContent(author({ hiddenPostIds: ["hidden"] }), [
      post("hidden", [AUTHOR_A], 300),
      post("shown", [AUTHOR_A], 100),
    ]);
    expect(content.listings.map((item) => item.postId)).toEqual(["shown"]);
  });

  it("leaves the same post on a coauthor's page", () => {
    const shared = post("shared", [AUTHOR_A, AUTHOR_B], 100);
    expect(
      authorPageContent(author({ hiddenPostIds: ["shared"] }), [shared]).listings,
    ).toEqual([]);
    expect(
      authorPageContent({ ...author(), authorId: AUTHOR_B }, [shared]).listings,
    ).toHaveLength(1);
  });

  it("leaves an author who hid everything looking like one who published nothing", () => {
    // Deliberate: the page must not report the curation choice back to readers,
    // so both states produce the same empty list and the same page.
    const hidEverything = authorPageContent(author({ hiddenPostIds: ["only"] }), [
      post("only", [AUTHOR_A], 100),
    ]);
    const publishedNothing = authorPageContent(author(), []);
    expect(hidEverything).toEqual(publishedNothing);
    expect(hidEverything.listings).toEqual([]);
  });
});

describe("the card", () => {
  it("carries the headline, summary, date and thumbnail into one link", () => {
    const content = authorPageContent(author(), [
      post("one", [AUTHOR_A], 100, {
        heroImage: {
          assetId: "asset",
          url: "https://media.njpbs.org/cms-media/a.jpg",
          mimeType: "image/jpeg",
          width: 1600,
          height: 900,
        },
        heroImageAlt: "Council members at a table",
      }),
    ]);
    expect(content.listings[0]).toMatchObject({
      path: "/posts/one/",
      title: "Story one",
      summary: "Summary one",
      displayDate: "2026-08-20",
      thumbnail: {
        url: "https://media.njpbs.org/cms-media/a.jpg",
        width: 1600,
        height: 900,
        alt: "Council members at a table",
      },
    });
  });

  it("falls back to the excerpt, and to nothing rather than inventing a summary", () => {
    const content = authorPageContent(author(), [
      post("one", [AUTHOR_A], 200, { summary: "", excerpt: "An excerpt." }),
      post("two", [AUTHOR_A], 100, { summary: "", excerpt: "" }),
    ]);
    expect(content.listings[0].summary).toBe("An excerpt.");
    expect(content.listings[1].summary).toBe("");
  });

  it("silences a decorative lead image on the card", () => {
    const content = authorPageContent(author(), [
      post("one", [AUTHOR_A], 100, {
        heroImage: {
          assetId: "asset",
          url: "https://media.njpbs.org/cms-media/a.jpg",
          mimeType: "image/jpeg",
          width: 1600,
          height: 900,
        },
        heroImageAlt: "Ignored",
        heroImageDecorative: true,
      }),
    ]);
    expect(content.listings[0].thumbnail?.alt).toBe("");
  });
});
