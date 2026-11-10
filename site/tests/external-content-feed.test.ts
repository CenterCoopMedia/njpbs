import { describe, expect, it } from "vitest";
import type { CmsPostBuildData } from "../src/lib/cms-posts-loader";
import type { CmsProgramBuildData } from "../src/lib/cms-programs-loader";
import {
  EXTERNAL_CONTENT_PAGE_SIZE,
  EXTERNAL_NEWS_FEED_ITEM_LIMIT,
  createExternalContentManifest,
  createExternalContentStaticFeed,
  renderExternalContentRss,
} from "../src/lib/external-content-feed";

const post: CmsPostBuildData = {
  postId: "post-1",
  slug: "safe-story",
  previousSlugs: [],
  locale: "en",
  path: "/posts/safe-story/",
  title: "Safe & useful <story>",
  summary: "A public summary.",
  excerpt: "",
  categories: ["Station news"],
  tags: ["News & public affairs"],
  credits: [{ name: "Pat Reporter", slug: "pat-reporter", authorId: "au_pat" }],
  authorIds: ["au_pat"],
  displayDate: "2026-09-01",
  sortInstant: Date.parse("2026-09-01T14:00:00.000Z"),
  updateShown: true,
  updatedAt: "2026-09-01T15:00:00.000Z",
  updatedDate: "2026-09-01",
  heroImage: {
    assetId: "image-1",
    url: "https://media.njpbs.org/cms-media/image-1/photo.webp",
    mimeType: "image/webp",
    width: 1200,
    height: 675,
  },
  heroImageAlt: "A reporter at work",
  heroImageDecorative: false,
  blocks: [
    {
      id: "block-1",
      type: "prose",
      order: 0,
      visible: true,
      data: {
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Body <script>alert(1)</script>" },
              ],
            },
          ],
        },
      },
    },
  ],
  assets: {},
  noindex: false,
  sourceVersion: 4,
  firstPublishedAt: "2026-09-01T14:00:00.000Z",
  publishedAt: "2026-09-01T14:00:00.000Z",
};

const program: CmsProgramBuildData = {
  programId: "program-1",
  slug: "garden-state-weekly",
  previousSlugs: [],
  locale: "en",
  path: "/programs/garden-state-weekly/",
  title: "Garden State Weekly",
  genre: "Public affairs",
  description: {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text: "A weekly New Jersey program." }],
      },
    ],
  },
  memberOnly: false,
  keyArt: null,
  keyArtAlt: "",
  keyArtDecorative: false,
  watchUrl: null,
  assets: {},
  sourceVersion: 2,
  publishedAt: "2026-08-31T14:00:00.000Z",
};

const publicAuthors = [{ authorId: "au_pat", displayName: "Pat Reporter Current", slug: "pat-reporter-current" }];

describe("external released-content feeds", () => {
  it("exports a post containing only a resolved record card", () => {
    const cardPost: CmsPostBuildData = { ...post, blocks: [{
      id: "card-1", type: "record_card", order: 0, visible: true,
      data: { recordKind: "program", recordId: "program-1" },
    }] };
    const manifest = createExternalContentManifest({
      site: "https://njpbs.org/", posts: [cardPost], programs: [], authors: [],
      recordCards: [{ kind: "program", id: "program-1", title: "Garden & State", href: "/programs/garden-state/" }],
    });
    expect(manifest.items[0]?.contentHtml).toBe(
      '<p><a href="https://njpbs.org/programs/garden-state/">Garden &amp; State</a></p>',
    );
    expect(renderExternalContentRss(manifest)).toContain("Garden &amp; State");
  });

  it("projects only explicit public fields in deterministic release order", () => {
    const privateFields = {
      ...post,
      publishedBy: "private-staff-uid",
      email: "private@example.org",
      status: "draft",
      workflow: { assignedTo: "private-staff-uid" },
    } as CmsPostBuildData;
    const manifest = createExternalContentManifest({
      site: "https://njpbs.org/",
      posts: [privateFields],
      programs: [program],
      authors: publicAuthors,
    });

    expect(manifest.items.map((item) => item.id)).toEqual([
      "urn:njpbs:content:post:post-1",
      "urn:njpbs:content:program:program-1",
    ]);
    expect(manifest.items[0]).toMatchObject({
      sourceVersion: 4,
      url: "https://njpbs.org/posts/safe-story/",
      publishedAt: "2026-09-01T14:00:00.000Z",
      modifiedAt: "2026-09-01T14:00:00.000Z",
      categories: ["Station news"],
      tags: ["News & public affairs"],
      authors: [
        {
          name: "Pat Reporter Current",
          url: "https://njpbs.org/authors/pat-reporter-current/",
        },
      ],
    });
    expect(manifest.items[0]?.contentHtml).toContain(
      "Body &lt;script&gt;alert(1)&lt;/script&gt;",
    );
    expect(JSON.stringify(manifest)).not.toContain("private-staff-uid");
    expect(JSON.stringify(manifest)).not.toContain("private@example.org");
    expect(JSON.stringify(manifest)).not.toContain('"workflow"');
  });

  it("keeps first publication separate from the current revision", () => {
    const republishedAt = "2026-09-02T16:00:00.000Z";
    const manifest = createExternalContentManifest({
      site: "https://njpbs.org/",
      posts: [{ ...post, publishedAt: republishedAt }],
      programs: [],
      authors: publicAuthors,
    });
    expect(manifest.items[0]).toMatchObject({
      publishedAt: post.firstPublishedAt,
      modifiedAt: republishedAt,
    });

    const legacyManifest = createExternalContentManifest({
      site: "https://njpbs.org/",
      posts: [{ ...post, firstPublishedAt: null, publishedAt: republishedAt }],
      programs: [],
      authors: publicAuthors,
    });
    expect(legacyManifest.items[0]).toMatchObject({
      publishedAt: republishedAt,
      modifiedAt: republishedAt,
    });
  });

  it("emits bounded linked JSON pages and a bounded recent RSS feed", () => {
    const posts = Array.from(
      { length: EXTERNAL_CONTENT_PAGE_SIZE + 1 },
      (_, index) => ({
        ...post,
        postId: `post-${index + 1}`,
        slug: `story-${index + 1}`,
        path: `/posts/story-${index + 1}/`,
        firstPublishedAt: new Date(
          Date.parse("2026-09-01T14:00:00.000Z") - index * 60_000,
        ).toISOString(),
      }),
    );
    const manifest = createExternalContentManifest({
      site: "https://njpbs.org/",
      posts,
      programs: [],
      authors: publicAuthors,
    });
    const feed = createExternalContentStaticFeed(manifest);

    expect(feed.index).toMatchObject({
      feedUrl: "https://njpbs.org/api/v1/content.json",
      pageSize: EXTERNAL_CONTENT_PAGE_SIZE,
      totalItems: EXTERNAL_CONTENT_PAGE_SIZE + 1,
      pages: [
        {
          page: 1,
          url: "https://njpbs.org/api/v1/content/1.json",
          itemCount: EXTERNAL_CONTENT_PAGE_SIZE,
        },
        {
          page: 2,
          url: "https://njpbs.org/api/v1/content/2.json",
          itemCount: 1,
        },
      ],
    });
    expect(feed.pages[0]).toMatchObject({
      previousUrl: null,
      nextUrl: "https://njpbs.org/api/v1/content/2.json",
    });
    expect(feed.pages[1]).toMatchObject({
      previousUrl: "https://njpbs.org/api/v1/content/1.json",
      nextUrl: null,
    });

    const rss = renderExternalContentRss(manifest);
    expect(rss.match(/<item>/g)).toHaveLength(EXTERNAL_NEWS_FEED_ITEM_LIMIT);
    expect(rss).not.toContain(`urn:njpbs:content:post:post-${posts.length}`);
  });

  it("keeps noindex posts out of both external formats", () => {
    const manifest = createExternalContentManifest({
      site: new URL("https://njpbs.org/"),
      posts: [{ ...post, noindex: true }],
      programs: [program],
      authors: publicAuthors,
    });
    expect(manifest.items.map((item) => item.type)).toEqual(["program"]);
    expect(renderExternalContentRss(manifest)).not.toContain("safe-story");
  });

  it("makes relative content links portable for external consumers", () => {
    const linkedPost = {
      ...post,
      blocks: [
        {
          id: "block-1",
          type: "prose",
          order: 0,
          visible: true,
          data: {
            content: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "text",
                      text: "Related story",
                      marks: [
                        {
                          type: "link",
                          attrs: { href: "../related/?a=1&b=2" },
                        },
                      ],
                    },
                    { type: "text", text: " " },
                    {
                      type: "text",
                      text: "External",
                      marks: [
                        {
                          type: "link",
                          attrs: { href: "https://example.org/story?a=1&b=2" },
                        },
                      ],
                    },
                    { type: "text", text: " " },
                    {
                      type: "text",
                      text: "Email",
                      marks: [
                        {
                          type: "link",
                          attrs: { href: "mailto:user-a367188106@example.org" },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        },
      ],
    } as CmsPostBuildData;
    const manifest = createExternalContentManifest({
      site: "https://njpbs.org/",
      posts: [linkedPost],
      programs: [],
      authors: publicAuthors,
    });
    const rss = renderExternalContentRss(manifest);

    expect(manifest.items[0]?.contentHtml).toContain(
      'href="https://njpbs.org/posts/related/?a=1&amp;b=2"',
    );
    expect(manifest.items[0]?.contentHtml).toContain(
      'href="https://example.org/story?a=1&amp;b=2"',
    );
    expect(manifest.items[0]?.contentHtml).toContain(
      'href="mailto:user-a367188106@example.org"',
    );
    expect(rss).toContain(
      'href="https://njpbs.org/posts/related/?a=1&amp;b=2"',
    );
    expect(rss).toContain(
      'href="https://example.org/story?a=1&amp;b=2"',
    );
    expect(rss).toContain('href="mailto:user-a367188106@example.org"');
  });

  it("renders escaped RSS with stable ids, HTML, and source versions", () => {
    const manifest = createExternalContentManifest({
      site: "https://njpbs.org/",
      posts: [post],
      programs: [],
      authors: publicAuthors,
    });
    const rss = renderExternalContentRss(manifest);

    expect(rss).toContain("<title>Safe &amp; useful &lt;story&gt;</title>");
    expect(rss).toContain(
      '<guid isPermaLink="false">urn:njpbs:content:post:post-1</guid>',
    );
    expect(rss).toContain("<njpbs:sourceVersion>4</njpbs:sourceVersion>");
    expect(rss).toContain(
      '<category domain="https://njpbs.org/ns/content/1/type">post</category>',
    );
    expect(rss).toContain(
      '<category domain="https://njpbs.org/ns/content/1/category">Station news</category>',
    );
    expect(rss).toContain(
      '<category domain="https://njpbs.org/ns/content/1/tag">News &amp; public affairs</category>',
    );
    expect(rss.indexOf('/1/category')).toBeLessThan(rss.indexOf('/1/tag'));
    expect(rss).toContain(
      "<![CDATA[<p>Body &lt;script&gt;alert(1)&lt;/script&gt;</p>]]>",
    );
  });

  it("refuses an unsafe site origin or invalid publication instant", () => {
    expect(() =>
      createExternalContentManifest({
        site: "http://njpbs.org/",
        posts: [post],
        programs: [],
        authors: publicAuthors,
      }),
    ).toThrow("must use HTTPS");
    expect(() =>
      createExternalContentManifest({
        site: "https://njpbs.org/",
        posts: [{ ...post, publishedAt: "not-a-date" }],
        programs: [],
        authors: publicAuthors,
      }),
    ).toThrow("invalid publication instant");
  });

  it("omits links for withdrawn authors and replaces XML-invalid text", () => {
    const manifest = createExternalContentManifest({
      site: "https://njpbs.org/",
      posts: [
        {
          ...post,
          title: "Safe\u0001 title",
          blocks: [
            {
              id: "block-1",
              type: "prose",
              order: 0,
              visible: true,
              data: {
                content: {
                  type: "doc",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "Safe\u000b body" }],
                    },
                  ],
                },
              },
            },
          ],
        },
      ],
      programs: [],
      authors: [],
    });
    const rss = renderExternalContentRss(manifest);

    expect(manifest.items[0]?.authors).toEqual([{ name: "Pat Reporter" }]);
    expect(rss).not.toMatch(/[\u0001\u000b]/);
    expect(rss).toContain("Safe� title");
    expect(rss).toContain("Safe� body");
  });
});
