import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copySpotlightImages } from "./spotlight-image-cache.mjs";
import { spotlightTopicImage, spotlightImageUrl } from "../../packages/content-core/src/spotlight-image.mjs";
import { spotlightDisplayByline } from "../../packages/content-core/src/spotlight-byline.mjs";

const DEFAULT_FEED_URL = "https://www.njspotlightnews.org/feed/";
const DEFAULT_OUTPUT_PATH = "src/data/spotlight-news.json";
// Bound the feed response time.
const FEED_TIMEOUT_MS = 60_000;
const MAX_FEED_BYTES = 2 * 1024 * 1024;
const DEFAULT_TOPIC = {
  label: "More Issues",
  slug: "more-issues",
};
const TOPICS = [
  {
    label: "NJ Decides 2026",
    slug: "nj-decides",
    match: ["nj decides 2026"],
  },
  {
    label: "Under the Dome",
    slug: "under-the-dome",
    match: ["under the dome"],
  },
  {
    label: "Budget",
    slug: "budget",
    match: ["budget", "stay nj", "property tax", "fiscal year", "appropriations"],
  },
  {
    label: "Business",
    slug: "business",
    match: ["business", "data centers", "ai", "artificial intelligence", "hedge funds"],
  },
  {
    label: "Education",
    slug: "education",
    match: ["education", "schools", "scholarships", "k-12", "public schools", "private schools"],
  },
  {
    label: "Energy & Environment",
    slug: "energy-environment",
    match: ["energy & environment", "environment", "polluters", "water", "hurricanes"],
  },
  {
    label: "Healthcare",
    slug: "healthcare",
    match: ["healthcare", "health care", "public health", "988", "behavioral crisis"],
  },
  {
    label: "Immigration",
    slug: "immigration",
    match: ["immigration", "ice", "delaney hall", "geo group", "deport"],
  },
  {
    label: "Politics",
    slug: "politics",
    match: ["politics", "rep.", "sen.", "congress", "trump", "sherrill", "kim"],
  },
  {
    label: "Law & Public Safety",
    slug: "law-public-safety",
    match: ["law & public safety", "police", "charged", "crash", "prison", "judge"],
  },
  {
    label: "Social Issues",
    slug: "social-issues",
    match: ["social issues", "homeless", "homelessness", "snap", "food pantries", "loneliness"],
  },
  {
    label: "Opinion",
    slug: "opinion",
    match: ["opinion", "op-ed"],
  },
  {
    label: "Watch",
    slug: "watch",
    match: ["full episodes", "video", "watch", "podcast", "roundtables"],
  },
  {
    label: "More Issues",
    slug: "more-issues",
    match: ["more issues", "from our partners", "sponsored content", "housing", "planning", "transportation"],
  },
];

export function buildSpotlightConfig(env = process.env) {
  return {
    feedUrl: optionalEnv(env.SPOTLIGHT_NEWS_FEED_URL) ?? DEFAULT_FEED_URL,
    outputPath: optionalEnv(env.SPOTLIGHT_NEWS_OUTPUT) ?? DEFAULT_OUTPUT_PATH,
    limit: Number.parseInt(optionalEnv(env.SPOTLIGHT_NEWS_LIMIT) ?? "8", 10),
  };
}

export async function fetchSpotlightFeed(config, fetchImpl = fetch) {
  const requestUrl = new URL(config.feedUrl);
  requestUrl.searchParams.append("_njpbs_refresh", randomUUID());
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error("NJ Spotlight News feed exceeded its deadline"));
  }, FEED_TIMEOUT_MS);
  let reader;
  try {
    const response = await fetchImpl(requestUrl.toString(), {
      signal: controller.signal,
      redirect: "error",
      headers: {
        Accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        "User-Agent": "njpbs.org launch feed sync",
      },
    });
    if (!response.ok) {
      const error = new Error(`NJ Spotlight News feed failed with HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    if (Number(response.headers.get("content-length")) > MAX_FEED_BYTES) {
      throw new Error("NJ Spotlight News feed exceeded its byte limit");
    }
    if (!response.body) return "";
    reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Count decoded bytes too: A compressed or chunked response may be larger.
      bytes += value.byteLength;
      if (bytes > MAX_FEED_BYTES) {
        throw new Error("NJ Spotlight News feed exceeded its byte limit");
      }
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks, bytes));
  } finally {
    clearTimeout(timeout);
    // Abort unread bodies on HTTP errors or limits, without waiting for the peer.
    controller.abort();
    reader?.releaseLock();
  }
}

export function parseSpotlightFeed(xml, limit = 8) {
  const itemMatches = Array.from(xml.matchAll(/<item\b[\s\S]*?<\/item>/gi));
  return itemMatches
    .map((match) => parseSpotlightItem(match[0]))
    .filter((card) => card !== undefined)
    .slice(0, limit);
}

export async function writeSpotlightNews(
  config,
  xml,
  cards = parseSpotlightFeed(xml, config.limit),
) {
  const output = {
    source: "nj-spotlight-news-rss",
    checkedAt: new Date().toISOString(),
    request: {
      url: config.feedUrl,
    },
    cards,
  };
  const outputPath = path.resolve(config.outputPath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  return output;
}

export async function main(env = process.env, fetchImpl = fetch, options = {}) {
  const config = buildSpotlightConfig(env);
  let xml;
  try {
    xml = await fetchSpotlightFeed(config, fetchImpl);
  } catch (error) {
    console.warn(
      `NJ Spotlight News sync skipped; using committed data (${error.message})`,
    );
    if (env.REQUIRE_FRESH_CONTENT === "1") {
      throw new Error("scheduled refresh requires fresh Spotlight data");
    }
    return { cards: [], reusedCommittedData: true };
  }
  // CLI/GitHub refreshes are cache-only. Only the cloud operator injects its
  // optional credential-bound storage factory.
  const cards = await copySpotlightImages(parseSpotlightFeed(xml, config.limit), fetchImpl, options.storageFactory);
  if (env.REQUIRE_FRESH_CONTENT === "1" && cards.length === 0) {
    throw new Error("scheduled refresh requires usable Spotlight data");
  }
  const output = await writeSpotlightNews(config, xml, cards);
  console.log(`NJ Spotlight News sync wrote ${output.cards.length} cards`);
  return output;
}

function parseSpotlightItem(itemXml) {
  const title = decodeXml(readTag(itemXml, "title"));
  const href = decodeXml(readTag(itemXml, "link"));
  const publishedAt = readTag(itemXml, "pubDate");
  // dc:creator and author can be posting accounts in older or cached feeds.
  const byline = spotlightDisplayByline(decodeXml(readTag(itemXml, "njspotlight:byline")));
  const categories = readTags(itemXml, "category").map(decodeXml).filter(Boolean);
  const sourceImage = readSourceImage(itemXml);
  const topic = pickTopic({ title, href, categories });

  if (!title || !href || !href.startsWith("https://www.njspotlightnews.org/")) {
    return undefined;
  }

  return {
    source: "nj-spotlight-news-rss",
    title,
    href,
    // The homepage topic below is a heuristic. Keep the publisher's actual
    // categories separate for related-story imports.
    sourceCategories: categories,
    ...(byline ? { byline, bylineSource: "coauthors-plus" } : {}),
    category: topic.label,
    topic: topic.label,
    topicSlug: topic.slug,
    publishedAt: publishedAt || undefined,
    dateLabel: formatDateLabel(publishedAt),
    image: spotlightTopicImage(topic.slug, publishedAt, href),
    fallbackImage: spotlightTopicImage(topic.slug, publishedAt, href),
    ...(sourceImage ? { sourceImage } : {}),
  };
}

function readSourceImage(xml) {
  const pattern = /<media:content\b([^>]*)\/?\s*>/gi;
  for (const match of xml.matchAll(pattern)) {
    const attributes = readAttributes(match[1]);
    if (attributes.get("medium")?.trim().toLowerCase() !== "image") continue;
    const url = spotlightImageUrl(decodeXml(attributes.get("url") ?? ""));
    const width = positiveInteger(attributes.get("width"));
    const height = positiveInteger(attributes.get("height"));
    if (url && width && height) return { url, width, height };
  }
  return undefined;
}

function readAttributes(value = "") {
  const attributes = new Map();
  const pattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of value.matchAll(pattern)) {
    attributes.set(match[1].toLowerCase(), match[2] ?? match[3] ?? "");
  }
  return attributes;
}


function positiveInteger(value) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

function readTag(xml, tagName) {
  const pattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = xml.match(pattern);
  return match ? stripCdata(match[1]).trim() : undefined;
}

function readTags(xml, tagName) {
  const pattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "gi");
  return Array.from(xml.matchAll(pattern), (match) => stripCdata(match[1]).trim());
}

function stripCdata(value = "") {
  return value.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function pickTopic({ title = "", href = "", categories = [] }) {
  const haystack = `${title} ${href} ${categories.join(" ")}`.toLowerCase();
  return TOPICS.find((topic) => topic.match.some((term) => termMatches(haystack, term))) ?? DEFAULT_TOPIC;
}

function termMatches(haystack, term) {
  const value = term.toLowerCase().trim();
  if (!value) return false;
  const before = /^[a-z0-9]/.test(value) ? "(^|[^a-z0-9])" : "";
  const after = /[a-z0-9]$/.test(value) ? "([^a-z0-9]|$)" : "";
  return new RegExp(`${before}${escapeRegExp(value)}${after}`).test(haystack);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatDateLabel(value) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function decodeXml(value = "") {
  return value
    .replace(/&#038;/g, "&")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#039;/g, "'")
    .replace(/&#8217;/g, "\u2019")
    .replace(/&#8216;/g, "\u2018")
    .replace(/&#8220;/g, "\u201c")
    .replace(/&#8221;/g, "\u201d")
    .replace(/&#8212;/g, "\u2014")
    .replace(/&#8211;/g, "\u2013");
}

function optionalEnv(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
