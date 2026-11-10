import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeSourcesForPagePublication, readPreparedHomeSources, readRetainedHomeSources, type RetainedHomeSource } from "../src/lib/no-build-home-sources";
import { createHomeSourceSnapshot } from "../src/lib/home-sources";
import { readHomeEditorialSourceReceipt, resolveHomeShelf } from "../../packages/content-core/src/home-source-catalog";
import type { ContentShelfBlock } from "../../packages/content-core/src/content-model";
import media from "../src/data/launch-media-manager.json";
import spotlight from "./fixtures/home-sources/spotlight-feed.json";
import posts from "./fixtures/home-sources/station-posts.json";
import fixture from "./fixtures/home-v2-selections.json";
import { refreshPublishedPageHomeSources } from "../src/lib/published-page-render";
import { projectJoinedRecords } from "../src/lib/published-post-shadow";
import newsletterCopy from "./fixtures/home-sources/newsletter-public-copy.json";

const sources = { ...createHomeSourceSnapshot(media, spotlight, fixture.editorial.receipt),
  editorial: readHomeEditorialSourceReceipt(fixture.editorial) };
const bytes = Buffer.from(JSON.stringify(sources));
const source: RetainedHomeSource = { file: { path: "/_home-sources.json",
  key: `post-background-v1/home/retained-claim/${"c".repeat(64)}`, digest: createHash("sha256").update(bytes).digest("hex"),
  size: bytes.length, contentType: "application/json; charset=utf-8" }, publication: sources.publication!, catalogDigest: sources.editorial.receipt.digest };
const publication = { buildBatchId: "Home-page-refresh", generation: 22, commitSha: "a".repeat(40) };
const externalCard = { description: "Frozen program", href: "https://watch.njpbs.org/show/frozen/", title: "Refreshed program" };
const externalNews = { category: "News", href: "https://www.njspotlightnews.org/frozen/", image: "/frozen.jpg", title: "Refreshed story" };
const externalPayloads = {
  "launch-media-manager.json": { checkedAt: "2026-10-12T14:00:00.000Z", cards: [externalCard] },
  "spotlight-news.json": { checkedAt: "2026-10-12T14:00:00.000Z", cards: [externalNews] },
  "schedule.json": { generatedAt: "2026-10-12T14:00:00.000Z", days: [] },
};
const externalBytes = Object.fromEntries(Object.entries(externalPayloads).map(([name, value]) => [name, Buffer.from(JSON.stringify(value))]));
const externalInputs = { schemaVersion: 1 as const, operationId: "PROVIDERrefreshop001",
  runtime: { owner: "cloudflare" as const, release: "b".repeat(40) }, checkedAt: Date.parse("2026-10-12T14:01:00.000Z"),
  contentDigest: createHash("sha256").update(JSON.stringify({
    "launch-media-manager.json": { cards: [externalCard] }, "spotlight-news.json": { cards: [externalNews] }, "schedule.json": { days: [] },
  })).digest("hex"), files: Object.fromEntries(Object.entries(externalBytes).map(([name, bytes]) => [name, {
    key: `post-background-v1/external-inputs/PROVIDERrefreshop001/${name}`,
    digest: createHash("sha256").update(bytes).digest("hex"), size: bytes.length,
  }])) };
const readExternal = async (key: string) => externalBytes[key.split("/").at(-1)!];
let directory: string;
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), "home-provider-snapshot-")); await writeFile(join(directory, "snapshot.json"), bytes); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
const read = async () => readFile(join(directory, "snapshot.json"));

describe("Home Page provider inputs", () => {
  it("projects the sealed prepared inputs with frozen observation times and separate rendering identity", async () => {
    const result = await readPreparedHomeSources({ inputs: externalInputs, read: readExternal, publication });
    expect(result.pbs.featured[0].title).toBe("Refreshed program");
    expect(result.spotlight.cards[0].title).toBe("Refreshed story");
    expect(result.pbs.checkedAt).toBe(externalPayloads["launch-media-manager.json"].checkedAt);
    expect(result.spotlight.checkedAt).toBe(externalPayloads["spotlight-news.json"].checkedAt);
    expect(result.publication).toEqual(publication);
    expect(result.editorial!.receipt).toMatchObject(publication);
    const stationPosts = result.editorial!.catalog.sources["home-posts"];
    if (stationPosts.status !== "ready") throw new Error("Prepared Station Post snapshot is not ready");
    expect(stationPosts.cards).toEqual([]);
    expect(externalInputs.runtime.release).toBe("b".repeat(40));
  });
  it("adds unselected approved Newsletter choices after prepared provider reads while preserving their sealed bytes", async () => {
    const prepared = await readPreparedHomeSources({ inputs: externalInputs, read: readExternal, publication });
    expect(prepared.editorial!.catalog.services).toBeUndefined();
    const cards = projectJoinedRecords([{ id: "first-choice", type: "newsletter", status: "draft", version: 3,
      title: "PRIVATE working", approvedLibraryVersion: { type: "newsletter", status: "approved", version: 2,
        title: newsletterCopy.title, signupUrl: newsletterCopy.signupUrl } }], new Map(), new Date(externalInputs.checkedAt)).recordCards;
    const current = await refreshPublishedPageHomeSources(prepared, [], undefined, publication.commitSha,
      new Date(externalInputs.checkedAt), publication, [], cards);
    const pool = current.editorial!.catalog.services!.newsletters;
    expect(pool.status).toBe("ready");
    if (pool.status !== "ready") throw new Error("Expected current approved roster");
    expect(pool.records).toHaveLength(1);
    expect(pool.records[0]).toMatchObject({ id: "first-choice", sourceVersion: 2 });
    expect(current.pbs).toEqual(prepared.pbs);
    expect(current.spotlight).toEqual(prepared.spotlight);
    expect(JSON.stringify(current)).not.toContain("PRIVATE");
  });

  it("refuses substituted keys, changed blobs and combined content identities in prepared inputs", async () => {
    const changedKey = structuredClone(externalInputs);
    changedKey.files["schedule.json"].key = "unowned/schedule.json";
    await expect(readPreparedHomeSources({ inputs: changedKey, read: readExternal, publication })).rejects.toThrow();
    await expect(readPreparedHomeSources({ inputs: { ...externalInputs, contentDigest: "f".repeat(64) },
      read: readExternal, publication })).rejects.toThrow();
    for (const name of Object.keys(externalBytes)) {
      await expect(readPreparedHomeSources({ inputs: externalInputs, publication,
        read: async key => key.endsWith(`/${name}`) ? Buffer.from("changed") : readExternal(key) })).rejects.toThrow();
    }
  });

  it("reads a full frozen snapshot with its exact byte, publication and catalog identities", async () => {
    expect(await readRetainedHomeSources({ source, read })).toEqual(sources);
  });

  it("refuses changed bytes, source generations and catalog identities", async () => {
    for (const changed of [
      { ...source, file: { ...source.file, digest: "f".repeat(64) } },
      { ...source, publication: { ...source.publication, generation: 23 } },
      { ...source, catalogDigest: "f".repeat(64) },
    ]) await expect(readRetainedHomeSources({ source: changed, read })).rejects.toThrow();
    await expect(readRetainedHomeSources({ source: { ...source, file: { ...source.file, key: "unowned/file" } }, read })).rejects.toThrow();
  });

  it("uses the saved selection order with current headlines and bylines, while keeping all provider pools", () => {
    const current = [{ ...posts[0], title: "Corrected headline", sourceVersion: 41,
      credits: [{ kind: "custom", name: "Current author" }] }];
    const result = homeSourcesForPagePublication({ sources, posts: current as never, publication,
      cutoffAt: "2026-10-11T19:30:00.000Z", home: fixture.home });
    const selected = resolveHomeShelf(fixture.home.blocks[7] as ContentShelfBlock, result.editorial!.catalog);
    expect(selected.cards.map(card => [card.title, card.byline, card.sourceVersion])).toEqual([["Corrected headline", "Current author", 41]]);
    for (const section of ["home-featured", "home-more", "home-spotlight"] as const) {
      expect(result.editorial!.catalog.sources[section]).toEqual(sources.editorial.catalog.sources[section]);
    }
    expect(result.pbs).toEqual(sources.pbs);
    expect(result.spotlight).toEqual(sources.spotlight);
    expect(fixture.home.version).toBe(7);
  });

  it("omits withdrawn cards without modifying saved IDs or selecting a replacement", () => {
    const result = homeSourcesForPagePublication({ sources, posts: [], publication,
      cutoffAt: "2026-10-11T19:30:00.000Z", home: fixture.home });
    const shelf = fixture.home.blocks[7] as ContentShelfBlock;
    const selected = resolveHomeShelf(shelf, result.editorial!.catalog);
    expect(selected.cards).toEqual([]);
    expect(selected.missingIds).toEqual(shelf.data.selectedIds);
    expect(selected.emptyReason).toBe("selection_unavailable");
  });
});
