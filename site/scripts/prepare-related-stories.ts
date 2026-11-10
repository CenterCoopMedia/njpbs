// Prepare a reviewed catalog from dated RSS receipts. This script does not fetch,
// publish, approve vocabulary, or infer subjects from headlines.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { SHELF_TOPICS, type ShelfSnapshot, type ShelfThumbnail, type StoryShelfItem } from "../../packages/content-core/src/dynamic-shelves";
import { RELATED_STORY_INDEX } from "../../packages/content-core/src/shelf-catalog";
import { spotlightCopyImageUrl } from "../../packages/content-core/src/spotlight-image.mjs";

const MAX_SOURCES = 10;
const MAX_CARDS_PER_SOURCE = 100;
const MAX_STORIES = 250;
const HOST = "www.njspotlightnews.org";
const UPLOAD_PREFIX = "/wp-content/uploads/";
const normalized = (value: string) => value.trim().toLowerCase().replace(/&/g, "and").replace(/\s+/g, " ");
const topicMap = new Map(SHELF_TOPICS.map((topic) => [normalized(topic.label), topic.id]));
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const timestamp = (value: unknown) => typeof value === "string" ? Date.parse(value) : NaN;

function publisherUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.host === HOST && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

interface SourceImage {
  url: string;
  width: number;
  height: number;
}

function publisherImage(value: unknown): SourceImage | null {
  if (!isRecord(value)) return null;
  const url = publisherUrl(value.url);
  if (!url || !url.pathname.startsWith(UPLOAD_PREFIX) ||
      !Number.isSafeInteger(value.width) || Number(value.width) <= 0 ||
      !Number.isSafeInteger(value.height) || Number(value.height) <= 0) {
    return null;
  }
  return { url: String(value.url), width: Number(value.width), height: Number(value.height) };
}

function reviewedThumbnail(value: unknown): ShelfThumbnail | null {
  if (!isRecord(value) || typeof value.url !== "string" ||
      !spotlightCopyImageUrl(value.url) || typeof value.alt !== "string") {
    return null;
  }
  return { url: value.url, alt: value.alt };
}

function canonicalArticleHref(value: unknown): string | null {
  const url = publisherUrl(value);
  if (!url || !/^\/\d{4}\/\d{2}\/[^/]+\/$/.test(url.pathname)) return null;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function prepareRelatedStories(
  inputs: unknown[],
  previous: { items: readonly { id: string; href: string; thumbnail?: unknown }[] } = RELATED_STORY_INDEX,
) {
  if (inputs.length === 0 || inputs.length > MAX_SOURCES) {
    throw new Error(`Provide between 1 and ${MAX_SOURCES} dated source snapshots.`);
  }
  const items = new Map<string, StoryShelfItem>();
  const oldIds = new Map(previous.items.map((item) => [item.href, item.id]));
  // Even a departing story still owns its id: reusing it would redirect saved pins.
  const idOwners = new Map(previous.items.map((item) => [item.id, item.href]));
  const oldThumbnails = new Map(previous.items.flatMap((item) => {
    const href = canonicalArticleHref(item.href);
    const thumbnail = reviewedThumbnail(item.thumbnail);
    return href && thumbnail ? [[href, thumbnail] as const] : [];
  }));
  const unmapped = new Set<string>();
  const skipped = { invalidStory: 0, noApprovedTopic: 0 };
  let duplicatesMerged = 0;
  const sources: { url: string; checkedAt: string; cards: { href: unknown; title: unknown; publishedAt: unknown; sourceCategories: string[]; sourceImage?: SourceImage }[] }[] = [];

  for (const input of inputs) {
    if (!isRecord(input) || input.source !== "nj-spotlight-news-rss" ||
        !Number.isFinite(timestamp(input.checkedAt)) || !isRecord(input.request) ||
        !publisherUrl(input.request.url) || !Array.isArray(input.cards) ||
        input.cards.length > MAX_CARDS_PER_SOURCE) {
      throw new Error("Each source must be a dated NJ Spotlight News RSS snapshot with at most 100 cards.");
    }
    const checkedAt = new Date(timestamp(input.checkedAt)).toISOString();
    const source = { url: String(input.request.url), checkedAt, cards: [] as typeof sources[number]["cards"] };
    sources.push(source);
    for (const card of input.cards) {
      if (!isRecord(card) || !Array.isArray(card.sourceCategories) ||
          !card.sourceCategories.every((category) => typeof category === "string")) {
        throw new Error("Missing raw sourceCategories; refresh with sync:spotlight-news. Homepage topic labels are not source evidence.");
      }
      const categories = card.sourceCategories as string[];
      const sourceImage = publisherImage(card.sourceImage);
      source.cards.push({ href: card.href, title: card.title, publishedAt: card.publishedAt, sourceCategories: categories,
        ...(sourceImage ? { sourceImage } : {}) });
      const url = publisherUrl(card.href);
      const published = timestamp(card.publishedAt);
      // Related stories are article URLs, not nightly episodes or player pages.
      if (card.source !== "nj-spotlight-news-rss" || !url ||
          !/^\/\d{4}\/\d{2}\/[^/]+\/$/.test(url.pathname) ||
          typeof card.title !== "string" || !card.title.trim() ||
          !Number.isFinite(published) || published > timestamp(checkedAt)) {
        skipped.invalidStory += 1;
        continue;
      }
      const topics = new Set<string>();
      for (const category of categories) {
        const topic = topicMap.get(normalized(category));
        if (topic) topics.add(topic);
        else if (category.trim()) unmapped.add(category.trim());
      }
      if (topics.size === 0) {
        skipped.noApprovedTopic += 1;
        continue;
      }
      url.search = "";
      url.hash = "";
      const href = url.toString();
      const existing = items.get(href);
      if (existing) {
        existing.topics = [...new Set([...existing.topics, ...topics])];
        duplicatesMerged += 1;
        continue;
      }
      // URL-derived IDs cannot reconnect a retired pin to a reused article slug,
      // even after the original URL has left several successive catalogs.
      const id = oldIds.get(href) ?? `njspotlight-${createHash("sha256").update(href).digest("hex")}`;
      if (idOwners.has(id) && idOwners.get(id) !== href) throw new Error(`Story id collision: ${id}. Resolve it before replacing the catalog.`);
      idOwners.set(id, href);
      const thumbnail = oldThumbnails.get(href);
      items.set(href, {
        id, source: "njpbs_related_index", title: card.title, href,
        topics: [...topics], publishedAt: new Date(published).toISOString(),
        sourceLabel: "NJ Spotlight News",
        ...(thumbnail ? { thumbnail } : {}),
      });
      if (items.size > MAX_STORIES) throw new Error("A reviewed related-story index is capped at 250 stories. Narrow the input set.");
    }
  }
  if (items.size === 0) throw new Error("No eligible related stories; the current catalog must remain intact.");
  const snapshot: ShelfSnapshot<StoryShelfItem> = {
    // The oldest receipt keeps a mixed-age import from presenting itself as fresh.
    checkedAt: sources.map((source) => source.checkedAt).sort()[0],
    provenance: "NJ Spotlight News RSS snapshots: " + sources.map((source) => `${source.url} (checked ${source.checkedAt})`).join("; ") +
      ". Topics match the publisher's source categories/tags exactly; no headline inference. Input order supplies curated order; this data is pending editorial review until its PR is approved.",
    items: [...items.values()],
  };
  return {
    snapshot,
    report: {
      storyCount: items.size,
      topicCounts: Object.fromEntries(SHELF_TOPICS.map((topic) => [topic.id, snapshot.items.filter((item) => item.topics.includes(topic.id)).length])),
      removedIds: previous.items.filter((item) => !items.has(item.href)).map((item) => item.id),
      duplicatesMerged, skipped, unmappedCategories: [...unmapped].sort(),
    },
    sources,
  };
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    input: { type: "string", multiple: true }, output: { type: "string" },
  } });
  if (!values.output) throw new Error("An explicit --output candidate JSON path is required.");
  const files = values.input ?? [];
  if (files.length === 0 || files.length > MAX_SOURCES) throw new Error(`Provide between 1 and ${MAX_SOURCES} --input snapshots.`);
  const inputs = await Promise.all(files.map(async (file) => JSON.parse(await readFile(file, "utf8"))));
  const result = prepareRelatedStories(inputs);
  const output = path.resolve(values.output);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(`${output}.review.json`, JSON.stringify({ report: result.report, sources: result.sources }, null, 2) + "\n");
  await writeFile(output, JSON.stringify(result.snapshot, null, 2) + "\n");
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(({ report }) => console.log(JSON.stringify(report, null, 2))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
