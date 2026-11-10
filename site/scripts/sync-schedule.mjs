import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PBS_KIDS_NOLA_ROOTS,
  TVSS_TIME_ZONE,
  shapeTvssScheduleDay,
  unwrapTvssJsonp,
} from "../src/lib/schedule-feed.ts";
import { applyScheduleCorrections, uncorrectedScheduleDates } from "../src/lib/schedule-corrections.ts";

const DEFAULT_OUTPUT_PATH = "src/data/schedule.json";
const DEFAULT_REFERER = "https://njpbs.org/";
const DEFAULT_BASE_URL =
  "https://jaws.pbs.org/tvss/station/WNJT/providers-feed/day/";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_REQUEST_CONCURRENCY = 4;
const MAX_REQUEST_CONCURRENCY = 8;
const DAYS_TO_BAKE = 14;

/** A TVSS request, response, JSONP, or payload-shape failure. */
export class UpstreamError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "UpstreamError";
  }
}

export function buildScheduleConfig(env = process.env) {
  return {
    outputPath: optionalEnv(env.SCHEDULE_OUTPUT) ?? DEFAULT_OUTPUT_PATH,
    referer: DEFAULT_REFERER,
    baseUrl: optionalEnv(env.SCHEDULE_FEED_BASE_URL) ?? DEFAULT_BASE_URL,
    requestTimeoutMs: positiveIntegerEnv(
      env.SCHEDULE_REQUEST_TIMEOUT_MS,
      "SCHEDULE_REQUEST_TIMEOUT_MS",
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
    requestConcurrency: boundedPositiveIntegerEnv(
      env.SCHEDULE_REQUEST_CONCURRENCY,
      "SCHEDULE_REQUEST_CONCURRENCY",
      DEFAULT_REQUEST_CONCURRENCY,
      MAX_REQUEST_CONCURRENCY,
    ),
  };
}

export function buildTvssUrl(date, kind, baseUrl = DEFAULT_BASE_URL) {
  const compactDate = date.replaceAll("-", "");
  if (!/^\d{8}$/.test(compactDate)) {
    throw new Error(`Invalid TVSS request date: ${date}`);
  }
  const url = new URL(`${compactDate}/`, ensureTrailingSlash(baseUrl));
  url.searchParams.set("callback", "cb");
  url.searchParams.set("provider", "Broadcast");
  url.searchParams.set("kids", "");
  url.searchParams.set("kidsflag", kind === "kids" ? "true" : "false");
  return url;
}

export function getEtBroadcastDates(now, count = DAYS_TO_BAKE) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("Schedule sync needs a valid current instant.");
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("Schedule sync day count must be a positive integer.");
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TVSS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(now)
    .reduce((result, part) => {
      if (part.type !== "literal") result[part.type] = part.value;
      return result;
    }, {});
  const firstDay = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
  );
  return Array.from({ length: count }, (_, index) =>
    new Date(firstDay + index * 86_400_000).toISOString().slice(0, 10),
  );
}

export async function fetchTvssDay(config, date, kind, fetchImpl = fetch) {
  const url = buildTvssUrl(date, kind, config.baseUrl);
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(),
    config.requestTimeoutMs,
  );
  console.log(`Schedule sync request ${kind} ${date}`);
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/javascript",
        Referer: config.referer,
      },
      signal: controller.signal,
    });
    console.log(`Schedule sync response ${kind} ${date} HTTP ${response.status}`);
    if (!response.ok) {
      throw new UpstreamError(
        `TVSS ${kind} ${date} failed with HTTP ${response.status}`,
      );
    }
    const text = await readScheduleResponseText(response);
    return shapeTvssScheduleDay(unwrapTvssJsonp(text), { date, kind });
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    if (controller.signal.aborted) {
      throw new UpstreamError(
        `TVSS ${kind} ${date} timed out after ${config.requestTimeoutMs}ms.`,
        { cause: error },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new UpstreamError(
      `TVSS ${kind} ${date} request or payload failed: ${message}`,
      { cause: error },
    );
  } finally {
    clearTimeout(deadline);
    // Stop unread bodies on HTTP errors or size limits without waiting for EOF.
    controller.abort();
  }
}

/** Bound both the TVSS day and public refresh receipts before parsing. */
export async function readScheduleResponseText(response) {
  const tooLarge = () => new Error("Schedule response exceeded its 2 MiB byte limit.");
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    throw tooLarge();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  try {
    const chunks = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Fetch exposes decompressed bytes; headers alone cannot bound gzip/chunks.
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw tooLarge();
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks, bytes));
  } finally {
    reader.releaseLock();
  }
}

/**
 * Resolve an ordered list through a small worker pool. The first failure stops
 * new work from being claimed, but already-started requests are allowed to
 * settle before the original error is rethrown. This keeps upstream traffic
 * bounded and leaves no detached request running after fallback is selected.
 */
export async function mapWithConcurrency(items, concurrency, worker) {
  if (!Array.isArray(items)) {
    throw new Error("Concurrent schedule work requires an array.");
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Concurrent schedule work requires a positive limit.");
  }
  if (typeof worker !== "function") {
    throw new Error("Concurrent schedule work requires a worker function.");
  }
  if (items.length === 0) return [];

  const results = new Array(items.length);
  let nextIndex = 0;
  let firstError;

  async function runWorker() {
    while (firstError === undefined) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        if (firstError === undefined) firstError = error;
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      () => runWorker(),
    ),
  );
  if (firstError !== undefined) throw firstError;
  return results;
}

export async function writeScheduleData(config, output) {
  const outputPath = path.resolve(config.outputPath);
  const directory = path.dirname(outputPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(outputPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(output, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function main(
  env = process.env,
  fetchImpl = fetch,
  now = new Date(),
  writeImpl = writeScheduleData,
) {
  const config = buildScheduleConfig(env);
  const dates = getEtBroadcastDates(now);
  const feedDates = uncorrectedScheduleDates(dates);
  const today = dates[0];
  const hadPreviousBake = await hasValidBakedData(config.outputPath, today);
  let broadcast;
  let kids;

  try {
    const requests = [
      ...feedDates.map((date) => ({ date, kind: "broadcast" })),
      ...feedDates.map((date) => ({ date, kind: "kids" })),
    ];
    const days = await mapWithConcurrency(
      requests,
      config.requestConcurrency,
      ({ date, kind }) => fetchTvssDay(config, date, kind, fetchImpl),
    );
    const sourceCheckedAt = now.toISOString();
    broadcast = days.slice(0, feedDates.length).map((day) => ({ ...day, sourceCheckedAt }));
    kids = days.slice(feedDates.length).map((day) => ({ ...day, sourceCheckedAt }));
  } catch (error) {
    if (!(error instanceof UpstreamError) || !hadPreviousBake) throw error;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Schedule sync skipped; using committed data (${message})`);
    if (env.REQUIRE_FRESH_CONTENT === "1") {
      throw new Error("scheduled refresh requires fresh schedule data");
    }
    return { reusedCommittedData: true };
  }

  /** @type {import("../src/lib/schedule-feed.ts").BakedScheduleData} */
  const output = applyScheduleCorrections({
    source: "pbs-tvss",
    generatedAt: now.toISOString(),
    timeZone: TVSS_TIME_ZONE,
    request: { station: "WNJT", dates },
    days: { broadcast, kids },
  });
  await writeImpl(config, output);
  console.log(
    `Schedule sync wrote ${output.days.broadcast.length} broadcast days and ${output.days.kids.length} kids days`,
  );
  return { ...output, reusedCommittedData: false };
}

async function hasValidBakedData(outputPath, today) {
  const absolutePath = path.resolve(outputPath);
  try {
    await access(absolutePath);
    const value = JSON.parse(await readFile(absolutePath, "utf8"));
    return isValidBakedScheduleData(value, today);
  } catch {
    return false;
  }
}

function isValidBakedScheduleData(value, today) {
  if (!isRecord(value) || !["pbs-tvss", "pbs-tvss-with-njpbs-corrections"].includes(value.source)) return false;
  if (!isIsoInstant(value.generatedAt) || value.timeZone !== TVSS_TIME_ZONE) {
    return false;
  }
  if (!isRecord(value.request) || value.request.station !== "WNJT") {
    return false;
  }
  const dates = value.request.dates;
  if (
    !Array.isArray(dates) ||
    (value.source === "pbs-tvss"
      ? dates.length !== DAYS_TO_BAKE
      : dates.length !== DAYS_TO_BAKE && (dates.length < 31 || dates.length > 45)) ||
    !dates.every(isBroadcastDate) ||
    new Set(dates).size !== dates.length ||
    !dates.includes(today)
  ) {
    return false;
  }
  if (!isRecord(value.days)) return false;
  return (
    hasValidScheduleDays(value.days.broadcast, "broadcast", dates) &&
    hasValidScheduleDays(value.days.kids, "kids", dates)
  );
}

function hasValidScheduleDays(days, kind, dates) {
  return (
    Array.isArray(days) &&
    days.length === dates.length &&
    days.every(
      (day, index) =>
        isRecord(day) &&
        day.date === dates[index] &&
        day.callsign === "wnjt" &&
        day.kind === kind &&
        typeof day.feedCid === "string" &&
        day.feedCid.trim().length > 0 &&
        day.timeZone === TVSS_TIME_ZONE &&
        Array.isArray(day.entries) &&
        day.entries.length > 0 &&
        hasValidScheduleEntries(day.entries, kind, day.date),
    )
  );
}

function hasValidScheduleEntries(entries, kind, date) {
  let previousEnd = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    if (!isValidScheduleEntry(entry, kind, date)) return false;
    const start = Date.parse(entry.startsAt);
    if (start < previousEnd) return false;
    previousEnd = Date.parse(entry.endsAt);
  }
  return true;
}

function isValidScheduleEntry(entry, kind, date) {
  if (!isRecord(entry) || entry.feedKind !== kind) return false;
  if (entry.kids !== undefined && typeof entry.kids !== "boolean") return false;
  if (kind === "kids" && typeof entry.kids !== "boolean") return false;
  if (
    entry.nolaRoot !== null &&
    (typeof entry.nolaRoot !== "string" || !entry.nolaRoot.trim())
  ) {
    return false;
  }
  if (
    entry.programId !== null &&
    (typeof entry.programId !== "number" ||
      !Number.isInteger(entry.programId))
  ) {
    return false;
  }
  if (!isNullableNonBlankString(entry.programExternalId)) return false;
  if (!isNullableNonBlankString(entry.cid)) return false;
  if (typeof entry.isKids !== "boolean") return false;
  const expectedIsKids =
    entry.kids === true ||
    (typeof entry.nolaRoot === "string" &&
      PBS_KIDS_NOLA_ROOTS.has(entry.nolaRoot));
  if (entry.isKids !== expectedIsKids) return false;
  if (typeof entry.title !== "string" || !entry.title.trim()) return false;
  if (
    entry.episodeTitle !== undefined &&
    (typeof entry.episodeTitle !== "string" || !entry.episodeTitle.trim())
  ) {
    return false;
  }
  if (
    entry.episodeDescription !== undefined &&
    (typeof entry.episodeDescription !== "string" ||
      !entry.episodeDescription.trim())
  ) {
    return false;
  }
  if (
    entry.description !== undefined &&
    (typeof entry.description !== "string" || !entry.description.trim())
  ) {
    return false;
  }
  if (!isIsoInstant(entry.startsAt) || !isIsoInstant(entry.endsAt)) {
    return false;
  }
  return (
    entry.startsAt.slice(0, 10) === date &&
    Date.parse(entry.endsAt) > Date.parse(entry.startsAt)
  );
}

function isNullableNonBlankString(value) {
  return value === null || (typeof value === "string" && value.trim().length > 0);
}

function isIsoInstant(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value))
  );
}

function isBroadcastDate(value) {
  if (typeof value !== "string") return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() + 1 === Number(match[2]) &&
    date.getUTCDate() === Number(match[3])
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function optionalEnv(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveIntegerEnv(value, name, fallback) {
  if (value === undefined) return fallback;
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function boundedPositiveIntegerEnv(value, name, fallback, maximum) {
  const parsed = positiveIntegerEnv(value, name, fallback);
  if (parsed > maximum) {
    throw new Error(`${name} must not exceed ${maximum}.`);
  }
  return parsed;
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
