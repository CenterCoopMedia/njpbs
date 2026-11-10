import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TVSS_TIME_ZONE } from "../src/lib/schedule-feed.ts";
import { applyScheduleCorrections, uncorrectedScheduleDates } from "../src/lib/schedule-corrections.ts";
import {
  buildScheduleConfig,
  fetchTvssDay,
  getEtBroadcastDates,
  mapWithConcurrency,
  readScheduleResponseText,
} from "./sync-schedule.mjs";

const PUBLIC_ORIGIN = "https://njpbs.org";
const RECEIPT_ERROR = "The feed or live schedule receipt is invalid";

async function readPublicJson(route, fetchImpl) {
  const url = new URL(route, PUBLIC_ORIGIN);
  url.searchParams.set("_njpbs_refresh", randomUUID());
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetchImpl(url, {
      headers: { "Cache-Control": "no-cache" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Public ${route} returned HTTP ${response.status}`);
    return JSON.parse(await readScheduleResponseText(response));
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
}

function entryKeys(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error(RECEIPT_ERROR);
  return entries.map((entry) => {
    const start = Date.parse(entry?.startsAt ?? "");
    const end = Date.parse(entry?.endsAt ?? "");
    if (typeof entry?.title !== "string" || !Number.isFinite(start) || !Number.isFinite(end)) {
      throw new Error(RECEIPT_ERROR);
    }
    return `${entry.title.trim()}|${start}|${end}`;
  }).join("\n");
}

// The public snapshot carries only broadcast days. A date that the next build
// would bake but the live page lacks counts as a change.
export function shouldRefreshSchedule(feedDays, live, receipt) {
  if (!Array.isArray(feedDays) || feedDays.length === 0 ||
      !Array.isArray(live?.days) || live.days.length === 0 ||
      !Number.isSafeInteger(receipt?.generation) ||
      typeof receipt.buildBatchId !== "string" || !receipt.buildBatchId ||
      !/^[a-f0-9]{40}$/.test(receipt.commitSha ?? "") ||
      live.publication?.generation !== receipt.generation ||
      live.publication?.buildBatchId !== receipt.buildBatchId ||
      live.publication?.commitSha !== receipt.commitSha) {
    throw new Error(RECEIPT_ERROR);
  }
  // Build every key first, so an invalid entry fails before any comparison.
  const liveDays = new Map(live.days.map((day) => [day?.date, entryKeys(day?.entries)]));
  const feedKeys = feedDays.map((day) => [day?.date, entryKeys(day?.entries)]);
  return feedKeys.some(([date, keys]) => liveDays.get(date) !== keys);
}

export async function checkScheduleRefresh(fetchImpl = fetch, now = new Date()) {
  const config = buildScheduleConfig({});
  const dates = getEtBroadcastDates(now);
  const [feedDays, live, receipt] = await Promise.all([
    mapWithConcurrency(uncorrectedScheduleDates(dates), config.requestConcurrency,
      (date) => fetchTvssDay(config, date, "broadcast", fetchImpl)),
    readPublicJson("/_schedule-sources.json", fetchImpl),
    readPublicJson("/_publication.json?cms-context=code", fetchImpl),
  ]);
  const corrected = applyScheduleCorrections({
    source: "pbs-tvss", generatedAt: now.toISOString(), timeZone: TVSS_TIME_ZONE,
    request: { station: "WNJT", dates }, days: { broadcast: feedDays, kids: [] },
  });
  return shouldRefreshSchedule(corrected.days.broadcast, live, receipt);
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  // fetchTvssDay logs each request; the caller reads one decision line.
  console.log = () => {};
  checkScheduleRefresh()
    .then((refresh) => process.stdout.write(`${refresh ? "newer" : "current"}\n`))
    .catch((error) => {
      process.stderr.write(`${error?.message === RECEIPT_ERROR
        ? "public receipt mismatch"
        : "source unavailable"}\n`);
      process.exitCode = 1;
    });
}
