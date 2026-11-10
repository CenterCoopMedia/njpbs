// @vitest-environment node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main, parseSpotlightFeed } from "../scripts/sync-spotlight-news.mjs";
import { copySpotlightImages, spotlightCopyIndexKey, spotlightCardSizeUrl } from "../scripts/spotlight-image-cache.mjs";
import { spotlightImageUrl, spotlightCopyImageUrl, spotlightStoryImage } from "../../packages/content-core/src/spotlight-image.mjs";
import { createHomeSourceSnapshot } from "../src/lib/home-sources";
import { readHomeSourceSnapshot } from "../../packages/content-core/src/home-published-sources";
import { adaptHomeSpotlight } from "../../packages/content-core/src/home-spotlight-source";
import { readHomeEditorialSourceReceipt } from "../../packages/content-core/src/home-source-catalog";
import { readHomeHeroCatalog } from "../../packages/content-core/src/home-hero";
import { readRetainedHomeSources } from "../src/lib/no-build-home-sources";
import { createHash } from "node:crypto";
import { RELATED_STORY_INDEX } from "../../packages/content-core/src/shelf-catalog";
import { createRequire } from "node:module";
import byteSizes from "./fixtures/spotlight-image-byte-sizes.json";
import selections from "./fixtures/home-v2-selections.json";

const require = createRequire(import.meta.url);
const serverCatalog = require("../../functions/lib/home-source-catalog.js");
const serverHero = require("../../functions/lib/home-hero.js");
const retained = require("../../functions/lib/home-retained-sources.js");
afterEach(() => vi.restoreAllMocks());

const xml = await readFile(new URL("./fixtures/spotlight-feed-2026-10-14.xml", import.meta.url), "utf8");
const body = await readFile(new URL("./fixtures/spotlight-tap-1536x864.jpg", import.meta.url));
const feedImage = "https://www.njspotlightnews.org/wp-content/uploads/sites/123/2025/01/drinking-water-tap-cup-300x169.jpg";
const fetchedImage = feedImage.replace("300x169", "1536x864");
// The source URL is recorded from the Oct. 14 feed; response bytes are a
// deterministic synthetic JPEG with the requested 1536 by 864 dimensions.
const sourceHash = "9b1c2159b9c72c49b853e64db88591f64c82192ad41f7f8547ac1d6a2530f147";
const contentHash = "1e7a233c7edff58b7c67a8f8905b33f5c3479eb5f830484b6af6787da109d517";
const key = `cms-media/spotlight/${sourceHash}/${contentHash}.jpg`;
const cardImage = `https://media.njpbs.org/${key}`;
const cards = parseSpotlightFeed(xml);
const first = cards[0]!;

function memoryStorage() {
  const objects = new Map<string, { body: Buffer; mimeType: string; metadata: Record<string, string> }>();
  return { objects,
    headIfExists: vi.fn(async (objectKey: string) => {
      const value = objects.get(objectKey);
      return value ? { contentLength: value.body.length, contentType: value.mimeType, metadata: value.metadata } : null;
    }),
    get: vi.fn(async (objectKey: string) => objects.get(objectKey)!.body),
    putFinal: vi.fn(async (value: { key: string; body: Buffer; mimeType: string; metadata: Record<string, string> }) => {
      if (!objects.has(value.key)) objects.set(value.key, value);
      return { created: true };
    }), close: vi.fn(),
  };
}

describe("Spotlight story images without hotlinks", () => {
  it("completes a cache-only build refresh with the real feed when every public receipt is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "spotlight-cache-only-"));
    try {
      const requests: string[] = [];
      const result = await main({ SPOTLIGHT_NEWS_OUTPUT: join(directory, "feed.json"), REQUIRE_FRESH_CONTENT: "1" }, async url => {
        requests.push(String(url));
        return new URL(String(url)).pathname === "/feed/" ? new Response(xml) : new Response(null, { status: 404 });
      });
      expect(result.cards).toHaveLength(8);
      expect(result.cards.every(card => card !== undefined && card.image === card.fallbackImage)).toBe(true);
      expect(requests).toHaveLength(9);
      expect(requests.every(url => new URL(url).origin === "https://www.njspotlightnews.org" && new URL(url).pathname === "/feed/" ||
        url.startsWith("https://media.njpbs.org/cms-media/spotlight/.sources/"))).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it.each([cardImage, first.fallbackImage, "https://example.org/image.jpg", undefined])("keeps reviewed photos when overlapping feed copies are unavailable: %s", image => {
    const reviewed = RELATED_STORY_INDEX.items[0];
    const snapshot = createHomeSourceSnapshot({}, { cards: [{ ...first, href: reviewed.href, image }] });
    const story = snapshot.heroCatalog?.find(card => card.id === reviewed.id);
    expect(story?.image?.url).toBe(image === cardImage ? cardImage : "https://media.njpbs.org/cms-media/spotlight/1d8a624c901423a554da02a1710a446eda699d3475888239d5c8cf3d8f2f8251/43b02cd0d7d4d20e02efa7ee6f117bfd9d7d29183d4b01afb824a58850d972fa.jpg");
  });
  it("retains approved historical hero thumbnails through the deployed Functions source bundle", async () => {
    const snapshot = { ...createHomeSourceSnapshot({}, { cards: [first] }, selections.editorial.receipt),
      editorial: readHomeEditorialSourceReceipt(selections.editorial) };
    const bytes = Buffer.from(JSON.stringify(snapshot));
    const source = { file: { path: "/_home-sources.json", key: `post-background-v1/home/retained-claim/${"c".repeat(64)}`,
      digest: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, contentType: "application/json; charset=utf-8" },
      publication: snapshot.publication!, catalogDigest: selections.editorial.receipt.digest };
    const read = async () => bytes;
    const expected = await readRetainedHomeSources({ source, read });
    expect(expected.spotlight.cards).toEqual(snapshot.spotlight.cards);
    expect(expected.heroCatalog?.find(card => card.image?.url === "https://media.njpbs.org/cms-media/spotlight/77abda1058885842264827a77c093955df56f04ca2685be102786866dd1642e5/d700ed67f6689e1410fad8d8c8ba9e0547bb517cef91679e4fe157c6672e40a8.jpg")).toBeDefined();
    expect(await retained.readRetainedHomeSources({ source, read })).toEqual(expected);
  });

  it("reports configured failures without logging provider errors or credentials", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await copySpotlightImages([first], async () => new Response(null, { status: 404 }), () => { throw new Error("SENSITIVE fixture error"); });
    expect(warn.mock.calls).toEqual([["Spotlight image cache: configured storage unavailable; using public copies or topic art."]]);
    warn.mockClear();
    await copySpotlightImages([first, first], async () => new Response(null, { status: 503 }), () => memoryStorage());
    expect(warn.mock.calls).toEqual([["Spotlight image cache: 1 unavailable source(s); used topic art."]]);
    warn.mockClear();
    await copySpotlightImages([first], async () => new Response(null, { status: 404 }));
    expect(warn).not.toHaveBeenCalled(); // An intentionally absent binding is quiet.
  });
  it.each([undefined, "", feedImage.replace("https:", "http:"), feedImage.replace("www.njspotlightnews.org", "example.org"),
    feedImage.replace("/wp-content/uploads/", "/images/"), feedImage + "?key=value"])("rejects unsafe source uploads: %s", url => {
    expect(spotlightImageUrl(url)).toBeUndefined();
    if (url) {
      const parsed = parseSpotlightFeed(xml.replaceAll(feedImage, url));
      const story = parsed[0];
      if (!story) throw new Error("Expected the first RSS story after rejecting its image");
      expect(story.sourceImage).toBeUndefined();
      expect(story.image).toBe(first.fallbackImage);
    }
  });
  it("never chooses an original or an unbounded feed size", () => {
    expect(spotlightCardSizeUrl(first.sourceImage)).toBe(fetchedImage);
    expect(spotlightCardSizeUrl({ ...first.sourceImage, url: feedImage.replace("-300x169", "") })).toBeUndefined();
    expect(spotlightCardSizeUrl({ ...first.sourceImage, width: undefined })).toBeUndefined();
    expect(spotlightCardSizeUrl({ url: fetchedImage, width: 1536, height: 864 })).toBe(fetchedImage);
  });

  it("preserves copies in Functions and rejects altered sealed V2 catalogs instead of silently recertifying them", () => {
    const receipt = structuredClone(selections.editorial);
    const image = { url: cardImage, alt: "", fallbackUrl: "/brand/spotlight/immigration-02.jpg" };
    receipt.catalog.sources["home-spotlight"].cards[0].image = image;
    expect(serverCatalog.readHomeEditorialSourceReceipt(receipt)).toEqual(readHomeEditorialSourceReceipt(receipt));
    // Feed/legacy adapters fall back before sealing; immutable receipts must
    // reject an altered catalog so its publication identity cannot be reused.
    for (const url of ["https://example.org/image.jpg", "/brand/unapproved.jpg"]) {
      receipt.catalog.sources["home-spotlight"].cards[0].image = { ...image, url };
      for (const reader of [readHomeEditorialSourceReceipt, serverCatalog.readHomeEditorialSourceReceipt]) {
        expect(() => reader(receipt)).toThrow("Home source catalog cards are invalid.");
      }
    }
  });

  it.each([cardImage, feedImage, "https://example.org/image.jpg", "http://media.njpbs.org/image.jpg", undefined])("keeps Functions hero image validation in parity: %s", url => {
    const catalog = [{ id: "story", title: first.title, summary: "", href: first.href, source: "spotlight",
      categories: [], tags: [], image: { url, alt: "", fallbackUrl: first.fallbackImage } }];
    const expected = readHomeHeroCatalog(catalog);
    expect(serverHero.readHomeHeroCatalog(catalog)).toEqual(expected);
    expect(expected[0].image?.url).toBe(url === cardImage ? cardImage : first.fallbackImage);
  });
  it("records the actual feed image and destination, using topic art until copied", () => {
    expect(first).toMatchObject({ title: "‘Forever chemicals’ found in surface water statewide, report holds",
      href: "https://www.njspotlightnews.org/2026/10/forever-chemicals-found-in-surface-water-statewide-report-holds/",
      sourceImage: { url: feedImage, width: 300, height: 169 }, image: "/brand/spotlight/energy-environment-02.jpg" });
    expect(cards).toHaveLength(8);
    expect(cards.every(card => card && spotlightImageUrl(card.sourceImage?.url))).toBe(true);
    expect(spotlightStoryImage({ ...first, image: feedImage }).url).toBe(first.fallbackImage);
    expect(spotlightImageUrl(feedImage)).toBe(feedImage);
    expect(spotlightCopyImageUrl(cardImage)).toBe(cardImage);
  });

  it.each([undefined, "", feedImage, cardImage.replace("https:", "http:"), cardImage.replace("media.njpbs.org", "example.org"),
    cardImage.replace("media.njpbs.org", "media.njpbs.org.evil.test"), cardImage.replace("/cms-media/spotlight/", "/other/"),
    cardImage.replace("https://", "https://user:password@"), cardImage + "?token=value", cardImage + "#image", cardImage + "\n",
    cardImage.replace("https://", "https:\\\\"), cardImage.replace(".jpg", ".html"), "/brand/unapproved.jpg"])("falls back at producer and saved reader: %s", image => {
    expect(spotlightCopyImageUrl(image)).toBeUndefined();
    const story = { ...first, image };
    expect(spotlightStoryImage(story).url).toBe(first.fallbackImage);
    const snapshot = createHomeSourceSnapshot({}, { cards: [story] });
    expect(snapshot.spotlight.cards[0].image).toBe(first.fallbackImage);
    snapshot.publication = { buildBatchId: "spotimg-local", generation: 1, commitSha: "a".repeat(40) };
    snapshot.spotlight.cards[0].image = image as string;
    expect(readHomeSourceSnapshot(snapshot, { schemaVersion: 1, ...snapshot.publication }).spotlight.cards[0].image).toBe(first.fallbackImage);
    expect(adaptHomeSpotlight({ status: "ready", source: "nj-spotlight-news-rss", checkedAt: "2026-10-14T17:00:00Z", cards: [story] },
      { cutoffAt: "2026-10-14T17:00:00Z" }).cards[0].image?.url).toBe(first.fallbackImage);
  });

  it("copies the synthetic crop once and reuses its content-addressed NJ PBS copy", async () => {
    expect(createHash("sha256").update(body).digest("hex")).toBe(contentHash);
    const storage = memoryStorage();
    const fetchImpl = vi.fn<typeof fetch>(async (url, options) => {
      expect(String(url)).toBe(fetchedImage);
      expect(options).toMatchObject({ redirect: "error", headers: { "User-Agent": "NJ PBS Spotlight image cache/1.0" } });
      return new Response(body, { headers: { "content-type": "image/jpeg" } });
    });
    const [copied] = await copySpotlightImages([first, first], fetchImpl, () => storage);
    expect(copied).toMatchObject({ image: cardImage, imageCopy: { sourceUrl: feedImage, fetchedUrl: fetchedImage,
      key, sha256: contentHash, bytes: 8558, mimeType: "image/jpeg", width: 1536, height: 864 } });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(storage.putFinal).toHaveBeenCalledTimes(2);
    fetchImpl.mockClear(); storage.putFinal.mockClear();
    expect((await copySpotlightImages([first], fetchImpl, () => storage))[0].image).toBe(cardImage);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(storage.putFinal).not.toHaveBeenCalled();
  }, 40_000); // Includes the copy pass's 30s budget and a second cached pass; native startup is cold.

  // Byte counts recorded in #4719 on Nov. 3. A decodable PNG is padded to
  // those exact counts at the network boundary; sharp and receipt verification
  // stay real. Pixel content is immaterial to the byte-cap regression.
  it.each(byteSizes)("copies the 1024px image for $story", async fixture => {
    const sharp = require("sharp");
    const png = await sharp(body).resize(1024, 576).png().toBuffer();
    const smaller = Buffer.concat([png, Buffer.alloc(fixture.smallerBytes - png.length)]);
    for (const contentLength of [true, false]) {
      const storage = memoryStorage();
      const requests: string[] = [];
      const card = { ...first, sourceImage: { url: fixture.url, width: 300, height: 169 } };
      const preferred = fixture.url.replace("300x169", "1536x864");
      const selected = fixture.url.replace("300x169", "1024x576");
      const copied = await copySpotlightImages([card, card], async url => {
        requests.push(String(url));
        const bytes = String(url) === preferred ? Buffer.alloc(fixture.preferredBytes) : smaller;
        return new Response(bytes, { headers: { "content-type": "image/png",
          ...(contentLength ? { "content-length": String(bytes.length) } : {}) } });
      }, () => storage);
      expect(requests).toEqual([preferred, selected]);
      expect(copied[0]).toMatchObject({ imageCopy: { fetchedUrl: selected, bytes: fixture.smallerBytes,
        mimeType: "image/png", width: 1024, height: 576 } });
      expect(copied[1].image).toBe(copied[0].image);
      expect(copied[0].image).toMatch(/^https:\/\/media.njpbs.org\/cms-media\/spotlight\//);
      const receipt = JSON.parse(storage.objects.get(spotlightCopyIndexKey(fixture.url))!.body.toString());
      expect(receipt.fetchedUrl).toBe(selected);
      expect(storage.objects.get(receipt.key)!.body).toEqual(smaller);
      expect((await copySpotlightImages([card], async () => { throw new Error("must reuse copy"); }, () => storage))[0].image)
        .toBe(copied[0].image);
    }
  });

  it("tries smaller intermediates when a larger size is absent, without fetching an original", async () => {
    const requests: string[] = [];
    const [result] = await copySpotlightImages([first], async url => {
      requests.push(String(url));
      return requests.length < 3 ? new Response(null, { status: 404 })
        : new Response(body, { headers: { "content-type": "image/jpeg" } });
    }, () => memoryStorage());
    expect(requests).toEqual([fetchedImage, feedImage.replace("300x169", "1024x576"), feedImage.replace("300x169", "768x432")]);
    expect(result.imageCopy.fetchedUrl).toBe(requests[2]);
  });

  it("retains the requested 300px real-image fallback when larger sizes are missing", async () => {
    const thumbnail = await require("sharp")(body).resize(300, 169).jpeg().toBuffer();
    const storage = memoryStorage();
    const requests: string[] = [];
    const [result] = await copySpotlightImages([first], async url => {
      requests.push(String(url));
      return String(url) === feedImage
        ? new Response(thumbnail, { headers: { "content-type": "image/jpeg" } })
        : new Response(null, { status: 404 });
    }, () => storage);
    expect(requests).toEqual([fetchedImage, feedImage.replace("300x169", "1024x576"), feedImage.replace("300x169", "768x432"), feedImage]);
    expect(result.imageCopy).toMatchObject({ fetchedUrl: feedImage, width: 300, height: 169, bytes: thumbnail.length });
    expect(result.image).toMatch(/^https:\/\/media.njpbs.org\/cms-media\/spotlight\//);
    expect(result.image).not.toBe(first.fallbackImage);
    const receipt = JSON.parse(storage.objects.get(spotlightCopyIndexKey(feedImage))!.body.toString());
    expect(receipt.width).toBe(300);
    expect(storage.objects.get(receipt.key)!.body).toEqual(thumbnail);
    expect((await copySpotlightImages([first], async () => { throw new Error("must reuse immutable fallback"); }, () => storage))[0].image)
      .toBe(result.image);
  });

  it("reuses public copies without a binding and never contacts Spotlight", async () => {
    const storage = memoryStorage();
    await copySpotlightImages([first], async () => new Response(body, { headers: { "content-type": "image/jpeg" } }), () => storage);
    const index = storage.objects.get(spotlightCopyIndexKey(feedImage))!.body;
    const requests: string[] = [];
    const result = await copySpotlightImages([first], async (url, options) => {
      requests.push(String(url));
      return options?.method === "HEAD" ? new Response(null, { headers: { "content-type": "image/jpeg", "content-length": String(body.length) } })
        : new Response(index.toString("utf8"), { headers: { "content-type": "application/json" } });
    });
    expect(result[0].image).toBe(cardImage);
    expect(requests.every(url => url.startsWith("https://media.njpbs.org/"))).toBe(true);
    const deleted = await copySpotlightImages([first], async (_url, options) => options?.method === "HEAD"
      ? new Response(null, { status: 404 }) : new Response(index.toString("utf8"), { headers: { "content-type": "application/json" } }));
    expect(deleted[0].image).toBe(first.fallbackImage);
  });

  it.each(["missing-binding", "origin-down", "wrong-type", "oversized", "corrupt-body", "truncated-body", "write-failed"])("uses topic art on %s after bounded size selection", async failure => {
    const storage = memoryStorage();
    if (failure === "write-failed") storage.putFinal.mockRejectedValue(new Error("storage unavailable"));
    const fetchImpl = vi.fn<typeof fetch>(async () => failure === "origin-down" || failure === "missing-binding"
      ? new Response(null, { status: 503 }) : new Response(failure === "corrupt-body" ? Buffer.from("invalid raster") : failure === "truncated-body" ? body.subarray(0, body.length / 2) : body, { headers: {
        "content-type": failure === "wrong-type" ? "text/html" : "image/jpeg",
        ...(failure === "oversized" ? { "content-length": String(2 * 1024 * 1024 + 1) } : {}),
      } }));
    expect((await copySpotlightImages([first, first], fetchImpl, failure === "missing-binding" ? undefined : () => storage))[0].image).toBe(first.fallbackImage);
    expect(fetchImpl).toHaveBeenCalledTimes(failure === "oversized" ? 4 : 1);
    expect(storage.objects.size).toBe(0);
    if (failure === "missing-binding") expect(String(fetchImpl.mock.calls[0][0])).toMatch(/^https:\/\/media\.njpbs\.org\//);
  });

  it("does not download again for deleted copies or invalid existing receipts", async () => {
    const storage = memoryStorage();
    await copySpotlightImages([first], async () => new Response(body, { headers: { "content-type": "image/jpeg" } }), () => storage);
    const fetchImpl = vi.fn<typeof fetch>();
    storage.objects.delete(key);
    expect((await copySpotlightImages([first], fetchImpl, () => storage))[0].image).toBe(first.fallbackImage);
    storage.objects.set(spotlightCopyIndexKey(feedImage), { body: Buffer.from("{}"), mimeType: "application/json", metadata: {} });
    expect((await copySpotlightImages([first], fetchImpl, () => storage))[0].image).toBe(first.fallbackImage);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("ends the sequential pass at the overall thirty-second budget", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const storage = memoryStorage();
      const fetchImpl = vi.fn<typeof fetch>(async (_url, options) => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("deadline")), { once: true });
      }));
      const result = copySpotlightImages(cards, fetchImpl, () => storage);
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await result)[0].image).toBe(first.fallbackImage);
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(storage.close).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});
