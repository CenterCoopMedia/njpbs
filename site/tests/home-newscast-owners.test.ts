// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import media from "../src/data/launch-media-manager.json";
import selection from "./fixtures/home-v2-selections.json";
import provider from "./fixtures/home-sources/newscast-documented-schema.json";
import copy from "./fixtures/home-sources/newsletter-public-copy.json";
import { createHomeSourceSnapshot } from "../src/lib/home-sources";
import { createHomeEditorialCatalog, rebuildHomeSourcesForPosts } from "../src/lib/home-editorial-catalog";
import { refreshPublishedPageHomeSources } from "../src/lib/published-page-render";
import { readHomeSourceSnapshot } from "../../packages/content-core/src/home-published-sources";
import { adaptLatestHomeNewscast, HOME_NEWSCAST_ASSETS_URL } from "../../packages/content-core/src/home-newscast-source";
import { createHomeNewscastPacket } from "../../packages/content-core/src/home-newscast-published";
import { boundHomeNewsletterCatalog, homeCatalogJson, readHomeEditorialCatalog } from "../../packages/content-core/src/home-source-catalog";
import { createHomeNewsletterSnapshot } from "../../packages/content-core/src/home-service-sources";
import { readPreparedHomeSources, readRetainedHomeSources } from "../src/lib/no-build-home-sources";
const cutoffAt = "2026-10-11T19:00:00.000Z";
const newsletter = (title = "Approved station Newsletter") => ({ id: "approved-newsletter", kind: "newsletter", href: null, sourceVersion: 1,
  newsletter: { card: { title, summary: copy.summary, signupUrl: copy.signupUrl } } });
const packet = () => createHomeNewscastPacket(adaptLatestHomeNewscast({ status: "ready", source: "pbs_media_manager",
  requestUrl: HOME_NEWSCAST_ASSETS_URL, checkedAt: cutoffAt, complete: true, response: provider }, cutoffAt));
function sources() {
  const snapshot = createHomeSourceSnapshot({ ...media, newscast: packet() }, {}, selection.editorial.receipt);
  return { ...snapshot, editorial: createHomeEditorialCatalog(snapshot, {}, [], cutoffAt, [], [newsletter()]) };
}
describe("automatic Newscast across public Home owners", () => {
  it("passes the complete provider packet through full-build projection, serialization and the published source reader", () => {
    const original = sources();
    const current = readHomeSourceSnapshot(JSON.parse(JSON.stringify(original)), { schemaVersion: 1, ...original.publication });
    expect(current.pbs.newscast).toEqual(packet());
    expect(current.editorial!.catalog.services!.newscast!.episode!.episodeDate).toBe("2026-10-09");
    expect(current.editorial!.catalog.services!.newscast!.cutoffAt).toBe(cutoffAt);
    expect(createHash("sha256").update(homeCatalogJson(current.editorial!.catalog)).digest("hex")).toBe(current.editorial!.receipt.digest);
    expect(JSON.stringify(current.pbs.newscast)).not.toMatch(/requestUrl|Authorization|availabilities|parent_tree/);
    expect(() => readHomeSourceSnapshot({ ...original, pbs: { ...original.pbs,
      newscast: { ...packet(), raw: provider } } }, { schemaVersion: 1, ...original.publication })).toThrow();
  });
  it("retains the same observed episode through fast Post and cloud Page/Newsletter refresh without provider calls", async () => {
    const original = sources(), next = { ...original.publication!, buildBatchId: "newscast-native-refresh", generation: original.publication!.generation + 1 };
    const later = "2026-10-12T19:00:00.000Z";
    const post = rebuildHomeSourcesForPosts(original, [], next, later);
    const page = await refreshPublishedPageHomeSources(original, [], undefined, next.commitSha, new Date(later), next,
      [], [newsletter("Approved correction")]);
    for (const current of [post, page]) {
      expect(current.pbs.newscast).toEqual(original.pbs.newscast);
      expect(current.editorial!.catalog.services!.newscast!.episode).toEqual(original.editorial.catalog.services!.newscast!.episode);
      expect(current.editorial!.catalog.services!.newscast).toMatchObject({ checkedAt: cutoffAt, cutoffAt: later });
      expect(current.editorial!.catalog.sources["home-featured"]).toEqual(original.editorial.catalog.sources["home-featured"]);
      expect(current.editorial!.catalog.sources["home-more"]).toEqual(original.editorial.catalog.sources["home-more"]);
    }
    expect(JSON.stringify(post.editorial!.catalog.services!.newsletters)).toContain("Approved station Newsletter");
    expect(JSON.stringify(page.editorial!.catalog.services!.newsletters)).toContain("Approved correction");
    const failedRoster = await refreshPublishedPageHomeSources(original, [], undefined, next.commitSha, new Date(later), next, [], undefined, true);
    expect(failedRoster.editorial!.catalog.services!.newsletters).toEqual({ status: "error" });
    expect(failedRoster.editorial!.catalog.services!.newscast!.episode).toEqual(original.editorial.catalog.services!.newscast!.episode);
  });
  it("expires the retained episode at a forward rights boundary and selects a newer episode only on a normal provider update", async () => {
    const original = sources(), expiry = "2028-07-24T03:59:59.000Z";
    const current = await refreshPublishedPageHomeSources(original, [], undefined, original.publication!.commitSha, new Date(expiry));
    expect(current.editorial!.catalog.services!.newscast).toMatchObject({ episode: null, emptyReason: "withdrawn", checkedAt: cutoffAt, cutoffAt: expiry });
    expect(current.pbs.newscast!.episode!.episodeDate).toBe("2026-10-09");
    const changed = structuredClone(provider);
    const latest = changed.data[0];
    latest.attributes.title = "NJ PBS News with Rob Nelson | October 10, 2026";
    latest.attributes.parent_tree.attributes.title = latest.attributes.title;
    latest.attributes.premiered_on = "2026-10-10";
    const observed = createHomeNewscastPacket(adaptLatestHomeNewscast({ status: "ready", source: "pbs_media_manager", requestUrl: HOME_NEWSCAST_ASSETS_URL,
      checkedAt: cutoffAt, complete: true, response: changed }, cutoffAt));
    const normal = createHomeSourceSnapshot({ ...media, newscast: observed }, {}, original.publication);
    expect(createHomeEditorialCatalog(normal, {}, [], cutoffAt).catalog.services!.newscast!.episode!.episodeDate).toBe("2026-10-10");
  });
  it("preserves the independent Newscast service when the eligible Newsletter catalog is fitted or unavailable", () => {
    const original = sources().editorial.catalog;
    const records = Array.from({ length: 200 }, (_, index) => ({ ...newsletter("x".repeat(300)), id: `newsletter-${index}`,
      newsletter: { card: { title: "x".repeat(300), summary: "s".repeat(10000), signupUrl: copy.signupUrl } } }));
    const fitted = boundHomeNewsletterCatalog({ ...original, services: { ...original.services,
      newsletters: createHomeNewsletterSnapshot(records, cutoffAt, cutoffAt) } });
    expect(fitted.services!.newscast).toEqual(original.services!.newscast);
    expect(new TextEncoder().encode(homeCatalogJson(fitted)).byteLength).toBeLessThanOrEqual(400000);
    const unavailable = boundHomeNewsletterCatalog({ ...original, services: { ...original.services, newsletters: { status: "error" } } });
    expect(unavailable.services!.newscast).toEqual(original.services!.newscast);
    expect(() => readHomeEditorialCatalog({ ...original, services: { ...original.services,
      newscast: { ...original.services!.newscast, cutoffAt: "2026-10-12T00:00:00Z" } } })).toThrow();
  });
  it("reads the same frozen episode through the actual sealed prepared and retained provider owners", async () => {
    const original = sources(), observed = packet();
    const { checkedAt: _observation, ...semanticEpisode } = observed;
    const semantic = {
      "launch-media-manager.json": JSON.parse(homeCatalogJson({ cards: media.cards, newscast: semanticEpisode })),
      "spotlight-news.json": { cards: [] }, "schedule.json": { days: [] },
    };
    const contentDigest = createHash("sha256").update(JSON.stringify(semantic)).digest("hex");
    const operationId = "NEWSCASTfixture00123";
    for (const checkedAt of [cutoffAt, "2026-10-12T00:00:00.000Z"]) {
      const payloads = {
        "launch-media-manager.json": { cards: media.cards, checkedAt, newscast: { ...observed, checkedAt } },
        "spotlight-news.json": { cards: [], checkedAt }, "schedule.json": { days: [], generatedAt: checkedAt },
      };
      const blobs = Object.fromEntries(Object.entries(payloads).map(([name, value]) => [name, Buffer.from(JSON.stringify(value))]));
      const inputs = { schemaVersion: 1 as const, operationId, runtime: { owner: "cloudflare" as const, release: "b".repeat(40) },
        checkedAt: Date.parse("2026-10-12T01:00:00.000Z"), contentDigest,
        files: Object.fromEntries(Object.entries(blobs).map(([name, bytes]) => [name, { key: `post-background-v1/external-inputs/${operationId}/${name}`,
          digest: createHash("sha256").update(bytes).digest("hex"), size: bytes.length }])) };
      const prepared = await readPreparedHomeSources({ inputs, publication: original.publication!, read: async key => blobs[key.split("/").at(-1)!] });
      expect(prepared.editorial!.catalog.services!.newscast).toMatchObject({ checkedAt, cutoffAt: "2026-10-12T01:00:00.000Z" });
      expect(prepared.editorial!.catalog.services!.newscast!.episode!.episodeDate).toBe("2026-10-09");
      expect(prepared.pbs.newscast).not.toHaveProperty("cutoffAt");
    }
    const bytes = Buffer.from(JSON.stringify(original));
    const retained = await readRetainedHomeSources({ source: { file: { path: "/_home-sources.json",
      key: `post-background-v1/home/newscast-fixture/${"c".repeat(64)}`, digest: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length, contentType: "application/json; charset=utf-8" }, publication: original.publication!, catalogDigest: original.editorial.receipt.digest },
      read: async () => bytes });
    expect(retained.pbs.newscast).toEqual(original.pbs.newscast);
    expect(retained.editorial!.catalog.services!.newscast!.episode!.episodeDate).toBe("2026-10-09");
  });
});
