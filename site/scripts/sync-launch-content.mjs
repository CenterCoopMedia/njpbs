import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { homeNewscastForSync } from "./sync-home-newscast.mjs";

const DEFAULT_BASE_URL = "https://media.services.pbs.org/api/v1/";
const DEFAULT_OUTPUT_PATH = "src/data/launch-media-manager.json";
const DEFAULT_WATCH_BASE_URL = "https://watch.njpbs.org";

// NJ Spotlight News stays an external-only destination, so drop it wherever it
// appears in a title, not only as a prefix (e.g. "The Change Project by NJ
// Spotlight News"). The test filter targets QA stub records, which end in
// "TEST" (e.g. "NJTV News TEST"); a trailing-only match keeps real programs that
// merely contain the word, like "America's Test Kitchen".
const EXCLUDED_TITLE_PATTERNS = [/\bnjtv\b/i, /\btest$/i, /nj spotlight news/i];
const PLACEHOLDER_DESCRIPTION_PATTERNS = [
  /^tba\.?$/i,
  /^to be announced\.?$/i,
  /^coming soon\.?$/i,
];

export function buildSyncConfig(env = process.env) {
  const key = optionalEnv(env.MEDIA_MANAGER_API_KEY);
  const secret = optionalEnv(env.MEDIA_MANAGER_API_SECRET);
  // Both absent is the intended manual-fallback build; both present authenticates.
  // Exactly one present is a misconfiguration, not a fallback — fail loud so a
  // half-set secret never silently ships the fallback as if it were intended.
  if (Boolean(key) !== Boolean(secret)) {
    throw new Error(
      "Media Manager sync needs both MEDIA_MANAGER_API_KEY and MEDIA_MANAGER_API_SECRET, or neither.",
    );
  }
  const audience = optionalEnv(env.MEDIA_MANAGER_AUDIENCE) ?? "WNJT";
  const pageSize = optionalEnv(env.MEDIA_MANAGER_PAGE_SIZE) ?? "100";
  const baseUrl = optionalEnv(env.MEDIA_MANAGER_BASE_URL) ?? DEFAULT_BASE_URL;
  const outputPath = optionalEnv(env.LAUNCH_CONTENT_OUTPUT) ?? DEFAULT_OUTPUT_PATH;
  const url = new URL("shows/", ensureTrailingSlash(baseUrl));
  url.searchParams.set("audience-scope", "local");
  url.searchParams.set("audience", audience);
  url.searchParams.set("page-size", pageSize);

  return {
    audience,
    authorization: key && secret ? buildBasicAuthHeader(key, secret) : null,
    hasCredentials: Boolean(key && secret),
    outputPath,
    pageSize,
    url,
  };
}

export function buildBasicAuthHeader(key, secret) {
  return `Basic ${Buffer.from(`${key}:${secret}`, "utf8").toString("base64")}`;
}

export async function fetchMediaManagerShows(config, fetchImpl = fetch) {
  if (!config.authorization) {
    return { data: [] };
  }

  const response = await fetchImpl(config.url, {
    headers: {
      Accept: "application/json",
      Authorization: config.authorization,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(
      `Media Manager sync failed with HTTP ${response.status}: ${text.slice(0, 300)}`,
    );
    error.status = response.status;
    throw error;
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (cause) {
    // A 200 with an unparseable body (HTML error page, truncated response) is a
    // contract failure, not a transient outage. Tag it with the response status
    // so fetchShowsWithFallback rethrows it instead of masking a real bug as the
    // manual fallback.
    const error = new Error(
      `Media Manager sync returned an unparseable body (HTTP ${response.status}): ${cause.message}`,
    );
    error.status = response.status;
    throw error;
  }
  // We authenticated and got a 200, so a missing/non-array `data` is an upstream
  // contract change, not an empty catalog. Fail loud (tagged with the 200 status
  // so it rethrows) rather than letting normalizeShowsToCards coerce it to [] and
  // silently ship the manual cards. An empty `data: []` is valid and falls through.
  if (!Array.isArray(payload?.data)) {
    const error = new Error(
      `Media Manager sync returned an unexpected shape (HTTP ${response.status}): "data" is not an array`,
    );
    error.status = response.status;
    throw error;
  }
  return payload;
}

export function normalizeShowsToCards(payload) {
  const records = Array.isArray(payload?.data) ? payload.data : [];
  return records.flatMap((record) => {
    const attributes = record?.attributes ?? {};
    const title = firstString(attributes.title, attributes.name);
    const slug = firstString(attributes.slug);
    if (!title || !slug) return [];

    return [
      {
        source: "media-manager",
        id: firstString(record.id) ?? slug,
        title,
        description:
          firstString(
            attributes.description_short,
            attributes.short_description,
            attributes.description,
            attributes.description_long,
          ) ?? "Available through PBS video.",
        href: `${DEFAULT_WATCH_BASE_URL}/show/${slug}/`,
        image: pickImage(attributes),
      },
    ];
  });
}

export function selectLaunchCards(cards, limit = 24) {
  return cards
    .filter(isUsableLaunchCard)
    .slice(0, limit);
}

function isUsableLaunchCard(card) {
  return (
    typeof card?.title === "string" &&
    EXCLUDED_TITLE_PATTERNS.every((pattern) => !pattern.test(card.title)) &&
    typeof card?.description === "string" &&
    card.description.trim().length > 12 &&
    PLACEHOLDER_DESCRIPTION_PATTERNS.every((pattern) => !pattern.test(card.description.trim())) &&
    typeof card?.href === "string" &&
    card.href.startsWith(DEFAULT_WATCH_BASE_URL) &&
    typeof card?.image === "string" &&
    /^https:\/\//i.test(card.image)
  );
}

// A bounded in-run retry ladder absorbs transient fetch failures before
// selecting fallback cards.
const TRANSIENT_RETRY_DELAYS_MS = [2000, 4000];

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchShowsWithFallback(
  config,
  fetchImpl = fetch,
  sleepImpl = defaultSleep,
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return { payload: await fetchMediaManagerShows(config, fetchImpl), outage: false };
    } catch (error) {
      // A 4xx is an auth or contract failure (bad/expired key, wrong audience
      // scope), not a transient outage. Let it fail the deploy so a broken sync
      // is loud, never silently masked as a fallback. Only a network error (no
      // HTTP status) or a 5xx server outage retries and then falls back, so a
      // blip can't block the deploy. A half-set credential already threw
      // earlier, in buildSyncConfig.
      const status = typeof error.status === "number" ? error.status : undefined;
      if (status !== undefined && status < 500) {
        throw error;
      }
      if (attempt < TRANSIENT_RETRY_DELAYS_MS.length) {
        const wait = TRANSIENT_RETRY_DELAYS_MS[attempt];
        console.warn(
          `Media Manager sync attempt ${attempt + 1} failed (${error.message}); retrying in ${wait / 1000}s.`,
        );
        await sleepImpl(wait);
        continue;
      }
      console.warn(
        `Launch content sync hit a persistent Media Manager outage (${error.message}); falling back to the committed or manual launch cards so the deploy proceeds.`,
      );
      return { payload: { data: [] }, outage: true };
    }
  }
}

// During an outage the repository-committed launch-content file is the most
// recent persisted Media Manager snapshot available to the build. Build-time
// syncs do not commit refreshed snapshots, so it can predate the last
// successful deploy; keeping it still beats overwriting usable cards with an
// empty list. Only a committed media-manager payload whose cards still pass
// today's selection filter qualifies. A manual-fallback file, an empty file,
// or unreadable JSON returns null so the caller writes the manual fallback.
export async function readCommittedLaunchContent(config, readImpl = readFile) {
  try {
    const committed = JSON.parse(
      await readImpl(path.resolve(config.outputPath), "utf8"),
    );
    if (committed?.source !== "media-manager") return null;
    const cards = selectLaunchCards(
      Array.isArray(committed.cards) ? committed.cards : [],
    );
    if (cards.length === 0) return null;
    return { ...committed, cards };
  } catch {
    return null;
  }
}

export async function writeLaunchContent(config, payload, outage = false, newscast) {
  const output = {
    // An outage write never carries Media Manager data, so labeling it
    // "media-manager" would let the next outage run mistake an empty synthetic
    // payload for a last-known-good sync. Only a real credentialed fetch earns
    // the media-manager source tag.
    source: config.hasCredentials && !outage ? "media-manager" : "manual-fallback",
    checkedAt: new Date().toISOString(),
    request: {
      audience: config.audience,
      url: config.url.toString(),
    },
    cards: selectLaunchCards(normalizeShowsToCards(payload)),
    ...(newscast ? { newscast } : {}),
  };
  await writeLaunchContentFile(config, output);
  return output;
}

async function writeLaunchContentFile(config, output) {
  const outputPath = path.resolve(config.outputPath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
}

export async function main(env = process.env, fetchImpl = fetch, sleepImpl = defaultSleep) {
  const config = buildSyncConfig(env);
  if (env.REQUIRE_FRESH_CONTENT === "1" && !config.hasCredentials) {
    throw new Error("scheduled refresh requires Media Manager credentials");
  }
  const { payload, outage } = await fetchShowsWithFallback(config, fetchImpl, sleepImpl);
  if (outage && env.REQUIRE_FRESH_CONTENT === "1") {
    throw new Error("scheduled refresh requires fresh Media Manager data");
  }
  if (env.REQUIRE_FRESH_CONTENT === "1" && selectLaunchCards(normalizeShowsToCards(payload)).length === 0) {
    throw new Error("scheduled refresh requires usable Media Manager data");
  }
  const newscast = await homeNewscastForSync(config, fetchImpl);
  if (outage) {
    const committed = await readCommittedLaunchContent(config);
    if (committed) {
      // Write the re-filtered list back rather than leaving the file untouched:
      // the build reads the file raw, so a committed card that today's selection
      // rules exclude must not survive on disk just because the keep path ran.
      await writeLaunchContentFile(config, { ...committed, newscast });
      const noun = committed.cards.length === 1 ? "card" : "cards";
      console.log(
        `Launch content sync kept ${committed.cards.length} committed ${noun} (checked ${committed.checkedAt}) through the Media Manager outage`,
      );
      return;
    }
  }
  const output = await writeLaunchContent(config, payload, outage, newscast);
  console.log(
    `Launch content sync wrote ${output.cards.length} cards from ${output.source}`,
  );
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function optionalEnv(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function pickImage(attributes) {
  const direct = firstString(
    attributes.image,
    attributes.poster_image,
    attributes.mezzanine_image,
    attributes.thumbnail,
  );
  const images = Array.isArray(attributes.images) ? attributes.images : [];
  const fromList = images
    .map((image) =>
      firstString(image?.image, image?.url, image?.profile_url, image?.source_url),
    )
    .find(Boolean);

  // Only publish https image URLs into the public homepage. A non-https URL breaks
  // as mixed content on the HTTPS site, and an off-scheme value (data:, http:) has
  // no place in an <img src> rendered for visitors. Drop anything else so
  // CinematicHomePage falls back to the local placeholder art. Keep the
  // direct-then-list preference.
  for (const candidate of [direct, fromList]) {
    if (typeof candidate === "string" && /^https:\/\//i.test(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
