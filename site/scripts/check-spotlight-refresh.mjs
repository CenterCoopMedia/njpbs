import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSpotlightConfig,
  fetchSpotlightFeed,
  parseSpotlightFeed,
} from "./sync-spotlight-news.mjs";

const PUBLIC_ORIGIN = "https://njpbs.org";
const PUBLIC_TIMEOUT_MS = 20_000;

async function readPublicJson(route, fetchImpl) {
  const url = new URL(route, PUBLIC_ORIGIN);
  url.searchParams.set("_njpbs_refresh", randomUUID());
  const response = await fetchImpl(url, {
    headers: { "Cache-Control": "no-cache" },
  });
  if (!response.ok) throw new Error(`Public ${route} returned HTTP ${response.status}`);
  return response.json();
}

export function shouldRefreshSpotlight(cards, live, receipt) {
  if (!Array.isArray(cards) || cards.length === 0 ||
      !Array.isArray(live?.spotlight?.cards) || live.spotlight.cards.length === 0 ||
      !Number.isSafeInteger(receipt?.generation) ||
      live.publication?.generation !== receipt.generation ||
      live.publication?.buildBatchId !== receipt.buildBatchId) {
    throw new Error("The feed or live shelf receipt is invalid");
  }

  const datedCards = cards.map((card) => ({
    href: card.href,
    time: Date.parse(card.publishedAt ?? ""),
  }));
  if (datedCards.some((card) => !card.href || !Number.isFinite(card.time))) {
    throw new Error("The Spotlight feed has an invalid item time");
  }

  const liveLinks = new Set(live.spotlight.cards.map((card) => card.href));
  const newestFeedTime = Math.max(...datedCards.map((card) => card.time));
  const newestLiveTime = Math.max(
    ...datedCards.filter((card) => liveLinks.has(card.href)).map((card) => card.time),
  );
  return newestFeedTime > newestLiveTime;
}

export async function checkSpotlightRefresh(fetchImpl = fetch) {
  const config = buildSpotlightConfig();
  const timedFetch = (timeoutMs) => (url, options) => fetchImpl(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const [feed, live, receipt] = await Promise.all([
    fetchSpotlightFeed(config, fetchImpl),
    readPublicJson("/_home-sources.json", timedFetch(PUBLIC_TIMEOUT_MS)),
    readPublicJson("/_publication.json?cms-context=code", timedFetch(PUBLIC_TIMEOUT_MS)),
  ]);
  return shouldRefreshSpotlight(parseSpotlightFeed(feed, config.limit), live, receipt);
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  checkSpotlightRefresh()
    .then((refresh) => process.stdout.write(`${refresh ? "newer" : "current"}\n`))
    .catch((error) => {
      const reason = error?.message === "The feed or live shelf receipt is invalid"
        ? "public receipt mismatch"
        : error?.message === "The Spotlight feed has an invalid item time"
          ? "invalid feed item time"
          : "source unavailable";
      process.stderr.write(`${reason}\n`);
      process.exitCode = 1;
    });
}
