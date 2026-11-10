import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildSpotlightConfig,
  fetchSpotlightFeed,
  main,
  parseSpotlightFeed,
} from "../scripts/sync-spotlight-news.mjs";

const rssItem = ({
  title,
  link = "https://www.njspotlightnews.org/2026/06/story/",
  pubDate = "Mon, 29 Jun 2026 10:00:00 +0000",
  category,
  mediaContent,
}: {
  title: string;
  link?: string;
  pubDate?: string;
  category?: string;
  mediaContent?: string;
}) => `
  <item>
    <title><![CDATA[${title}]]></title>
    <link>${link}</link>
    <pubDate>${pubDate}</pubDate>
    ${category ? `<category><![CDATA[${category}]]></category>` : ""}
    ${mediaContent ?? ""}
  </item>
`;

describe("fetchSpotlightFeed", () => {
  it.each([
    undefined,
    "https://www.njspotlightnews.org/feed/?category=politics&tag=news&tag=budget&search=NJ%20news&_njpbs_refresh=configured",
  ])("bypasses cached responses and preserves the configured URL: %s", async (feedUrl) => {
    const config = Object.freeze(buildSpotlightConfig({ SPOTLIGHT_NEWS_FEED_URL: feedUrl }));
    const sourceUrl = new URL(config.feedUrl);
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response("<rss/>"));

    await expect(fetchSpotlightFeed(config, fetchImpl)).resolves.toBe("<rss/>");

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [input, options] = fetchImpl.mock.calls[0]!;
    const requestUrl = new URL(String(input));
    expect(requestUrl.origin).toBe(sourceUrl.origin);
    expect(requestUrl.pathname).toBe(sourceUrl.pathname);
    const parameters = Array.from(requestUrl.searchParams.entries());
    expect(parameters.slice(0, -1)).toEqual(Array.from(sourceUrl.searchParams.entries()));
    expect(parameters.at(-1)).toEqual(["_njpbs_refresh", expect.stringMatching(/^[0-9a-f-]{36}$/)]);
    expect(options?.headers).toMatchObject({
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    });
    expect(config.feedUrl).toBe(feedUrl ?? "https://www.njspotlightnews.org/feed/");
  });

  it("uses a different cache-busting value on each request", async () => {
    const config = buildSpotlightConfig({});
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response("<rss/>"));

    await fetchSpotlightFeed(config, fetchImpl);
    await fetchSpotlightFeed(config, fetchImpl);

    const firstUrl = new URL(String(fetchImpl.mock.calls[0]![0]));
    const secondUrl = new URL(String(fetchImpl.mock.calls[1]![0]));
    expect(firstUrl.searchParams.get("_njpbs_refresh")).not.toBe(secondUrl.searchParams.get("_njpbs_refresh"));
  });
});

describe("parseSpotlightFeed", () => {
  it("preserves source categories separately from inferred homepage topics", () => {
    const xml = `<rss><channel>${rssItem({ title: "Budget debate", category: "Politics" })
      .replace("</item>", "<category><![CDATA[Energy & Environment]]></category></item>")}</channel></rss>`;
    const [card] = parseSpotlightFeed(xml);
    expect(card?.category).toBe("Budget");
    expect(card?.sourceCategories).toEqual(["Politics", "Energy & Environment"]);
    expect(parseSpotlightFeed(`<rss><channel>${rssItem({ title: "Budget debate" })}</channel></rss>`)[0]?.sourceCategories).toEqual([]);
  });

  it("records the publisher's RSS image and uses topic artwork until its copy exists", () => {
    const sourceUrl = "https://www.njspotlightnews.org/wp-content/uploads/sites/123/2026/04/budget-photo-300x169.jpeg";
    const [card] = parseSpotlightFeed(`<rss><channel>${rssItem({
      title: "Budget debate",
      category: "Budget",
      mediaContent: `<media:content height='169' url='${sourceUrl}' medium='image' width='300' />`,
    })}</channel></rss>`);

    expect(card).toMatchObject({
      image: expect.stringMatching(/^\/brand\/spotlight\/budget(?:-02)?\.jpg$/),
      fallbackImage: expect.stringMatching(/^\/brand\/spotlight\/budget(?:-02)?\.jpg$/),
      sourceImage: { url: sourceUrl, width: 300, height: 169 },
    });
  });

  it.each([
    `<media:content medium="video" url="https://www.njspotlightnews.org/wp-content/uploads/sites/123/2026/04/story.jpg" width="300" height="169" />`,
    `<media:content medium="image" url="https://images.example.test/story.jpg" width="300" height="169" />`,
    `<media:content medium="image" url="https://www.njspotlightnews.org/story.jpg" width="300" height="169" />`,
    `<media:content medium="image" url="https://www.njspotlightnews.org/wp-content/uploads/sites/123/2026/04/story.jpg" width="wide" height="169" />`,
  ])("does not admit an invalid RSS image: %s", (mediaContent) => {
    const [card] = parseSpotlightFeed(`<rss><channel>${rssItem({ title: "Budget debate", mediaContent })}</channel></rss>`);

    expect(card?.sourceImage).toBeUndefined();
    expect(card?.image).toMatch(/^\/brand\/spotlight\/budget(?:-02)?\.jpg$/);
  });

  it("does not match ai inside ordinary words", () => {
    const [card] = parseSpotlightFeed(
      `<rss><channel>${rssItem({ title: "Officials said housing plan needs another vote" })}</channel></rss>`,
    );

    if (!card) throw new Error("Expected one Spotlight card");
    expect(card.category).toBe("More Issues");
  });

  it("matches artificial intelligence when it is a topic phrase", () => {
    const [card] = parseSpotlightFeed(
      `<rss><channel>${rssItem({ title: "Artificial intelligence policy gets new hearing" })}</channel></rss>`,
    );

    if (!card) throw new Error("Expected one Spotlight card");
    expect(card.category).toBe("Business");
  });

  it("cycles alternate art by publication day without feed-order churn", () => {
    const items = Array.from({ length: 8 }, (_, index) =>
      rssItem({
        title: `Budget hearing update ${index}`,
        link: `https://www.njspotlightnews.org/2026/06/budget-story-${index}/`,
        pubDate: new Date(Date.UTC(2026, 5, index + 1)).toUTCString(),
      }));
    const feed = `<rss><channel>${items.join("")}</channel></rss>`;
    const reversedFeed = `<rss><channel>${items.toReversed().join("")}</channel></rss>`;

    const firstPass = parseSpotlightFeed(feed);
    const secondPass = parseSpotlightFeed(feed);
    const reversedPass = parseSpotlightFeed(reversedFeed);
    const firstImages = firstPass.flatMap((card) =>
      card ? [card.image] : [],
    );
    const secondImages = secondPass.flatMap((card) =>
      card ? [card.image] : [],
    );
    const reversedImagesByHref = new Map(
      reversedPass.flatMap((card) =>
        card ? [[card.href, card.image] as const] : [],
      ),
    );
    const images = new Set(firstImages);

    expect(firstImages).toHaveLength(8);
    expect(secondImages).toEqual(firstImages);
    expect(
      firstPass.flatMap((card) =>
        card ? [reversedImagesByHref.get(card.href)] : [],
      ),
    ).toEqual(firstImages);
    expect(firstImages).toEqual([
      "/brand/spotlight/budget-02.jpg",
      "/brand/spotlight/budget.jpg",
      "/brand/spotlight/budget-02.jpg",
      "/brand/spotlight/budget.jpg",
      "/brand/spotlight/budget-02.jpg",
      "/brand/spotlight/budget.jpg",
      "/brand/spotlight/budget-02.jpg",
      "/brand/spotlight/budget.jpg",
    ]);
    expect(images).toEqual(
      new Set([
        "/brand/spotlight/budget.jpg",
        "/brand/spotlight/budget-02.jpg",
      ]),
    );
  });

  it("keeps a story's artwork when its headline changes", () => {
    const link = "https://www.njspotlightnews.org/2026/09/stable-story/";
    const original = parseSpotlightFeed(
      `<rss><channel>${rssItem({
        title: "Budget plan enters final vote",
        link,
        category: "Budget",
      })}</channel></rss>`,
    );
    const updated = parseSpotlightFeed(
      `<rss><channel>${rssItem({
        title: "Updated budget plan enters final vote",
        link,
        category: "Budget",
      })}</channel></rss>`,
    );

    expect(original[0]?.image).toBe(updated[0]?.image);
  });
});

describe("main", () => {
  it("writes the configured source URL without the request's cache-busting value", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "njpbs-spotlight-"));
    const outputPath = path.join(directory, "spotlight-news.json");
    const feedUrl = "https://www.njspotlightnews.org/feed/?category=politics";
    const xml = `<rss><channel>${rssItem({ title: "Budget hearing update" })}</channel></rss>`;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(xml));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const output = await main({
        SPOTLIGHT_NEWS_FEED_URL: feedUrl,
        SPOTLIGHT_NEWS_OUTPUT: outputPath,
      }, fetchImpl);
      const saved = JSON.parse(await readFile(outputPath, "utf8"));

      expect(output).toMatchObject({ request: { url: feedUrl } });
      expect(saved.request).toEqual({ url: feedUrl });
      expect(saved.cards).toHaveLength(1);
      expect(String(fetchImpl.mock.calls[0]![0])).not.toBe(feedUrl);
    } finally {
      log.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps deploys green when the Spotlight feed request throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = async () => {
      throw new Error("ECONNRESET");
    };

    await expect(main({}, fetchImpl as unknown as typeof fetch)).resolves.toEqual({
      cards: [],
      reusedCommittedData: true,
    });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("keeps deploys green when the Spotlight feed returns a 5xx", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = (async () => ({
      ok: false,
      status: 503,
      text: async () => "upstream down",
    })) as unknown as typeof fetch;

    await expect(main({}, fetchImpl)).resolves.toEqual({
      cards: [],
      reusedCommittedData: true,
    });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("fails a scheduled refresh when the Spotlight feed is stale", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = async () => {
      throw new Error("ECONNRESET");
    };

    await expect(
      main(
        { REQUIRE_FRESH_CONTENT: "1" },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow("scheduled refresh requires fresh Spotlight data");
    warn.mockRestore();
  });

  it("fails a scheduled refresh when the Spotlight response has no cards", async () => {
    const fetchImpl = async () => new Response("<html>challenge</html>");

    await expect(
      main({ REQUIRE_FRESH_CONTENT: "1" }, fetchImpl),
    ).rejects.toThrow("scheduled refresh requires usable Spotlight data");
  });
});
