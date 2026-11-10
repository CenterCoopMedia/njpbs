"use strict";

const MEDIA_MANAGER_ORIGIN = "https://media.services.pbs.org";
const DEFAULT_TIMEOUT_MS = 8000;
const TIERS = ["public", "all_members", "station_members"];
const WINDOWS = new Set([...TIERS, "unavailable"]);
const ASSET_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function nonblank(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function projectWindow(window) {
  if (window === null) return null;
  if (!isRecord(window) || (!Object.hasOwn(window, "start") && !Object.hasOwn(window, "end"))) {
    throw new Error("Invalid availability window");
  }
  const result = {};
  for (const bound of ["start", "end"]) {
    if (!Object.hasOwn(window, bound)) continue;
    if (window[bound] !== null && typeof window[bound] !== "string") {
      throw new Error("Invalid availability bound");
    }
    result[bound] = window[bound];
  }
  return result;
}

function projectVideos(videos) {
  if (videos === null) return null;
  if (!Array.isArray(videos)) return undefined;
  return videos.flatMap((video) => {
    if (!isRecord(video)) return [];
    const { profile, url } = video;
    if ([profile, url].some((value) => value != null && typeof value !== "string")) {
      return [];
    }
    return [{
      ...(profile !== undefined ? { profile } : {}),
      ...(url !== undefined ? { url } : {}),
    }];
  });
}

/** Keep only the wire fields consumed by assetToGateInput; never return a body. */
function projectAsset(resource, assetId) {
  if (!isRecord(resource) || resource.type !== "asset"
      || typeof resource.id !== "string" || resource.id.toLowerCase() !== assetId) return null;
  const attributes = resource.attributes;
  if (!isRecord(attributes)
      || !WINDOWS.has(attributes.availability_window)
      || !WINDOWS.has(attributes.playable_window)) return null;
  // PBS also documents an empty list when an asset has no videos yet.
  const wireVideos = Array.isArray(attributes.videos) && attributes.videos.length === 0
    ? {} : attributes.videos;
  if (!isRecord(attributes.availabilities) || !isRecord(wireVideos)) return null;
  const availabilities = {};
  const videos = {};
  for (const tier of TIERS) {
    if (Object.hasOwn(attributes.availabilities, tier)) availabilities[tier] = projectWindow(attributes.availabilities[tier]);
    // PBS's per-viewer decision authorizes only this bucket's URLs.
    if (tier === attributes.playable_window && Object.hasOwn(wireVideos, tier)) {
      const renditions = projectVideos(wireVideos[tier]);
      if (renditions !== undefined) videos[tier] = renditions;
    }
  }
  return {
    type: "asset", id: assetId,
    attributes: {
      availability_window: attributes.availability_window,
      playable_window: attributes.playable_window,
      availabilities, videos,
    },
  };
}

function classifyHttpStatus(status) {
  if (status === 200) return "ok";
  if (status === 404) return "not-found";
  if (status === 401 || status === 403) return "forbidden";
  if (status === 429) return "rate-limited";
  return "error";
}

async function readAsset({ url, assetId, authorization, fetchImpl, signal }) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Authorization: authorization, Accept: "application/vnd.api+json" },
    redirect: "error",
    cache: "no-store",
    signal,
  });
  const status = classifyHttpStatus(response.status);
  if (status !== "ok") return { status };
  const body = await response.json();
  if (!isRecord(body) || Object.hasOwn(body, "errors") || !Object.hasOwn(body, "data")) {
    return { status: "error" };
  }
  if (body.data === null) return { status: "not-found" };
  const resources = Array.isArray(body.data) ? body.data : [body.data];
  if (resources.length === 0) return { status: "not-found" };
  if (resources.length !== 1) return { status: "error" };
  const asset = projectAsset(resources[0], assetId);
  return asset ? { status: "ok", asset } : { status: "error" };
}

/**
 * Unexported server transport (#1262). Only assetId comes from a request.
 * The second argument MUST be server-owned: stationCid is the configured PBS
 * station CID; verifiedEntitlement is the result of that station's MVault lookup,
 * never a request/session claim. Missing or denied entitlement omits membership.
 * No credentials, unrelated metadata or exception text are returned or logged.
 */
async function fetchAssetAvailability(request = {}, serverContext = {}) {
  if (!isRecord(request)) return { status: "error" };
  if (!isRecord(serverContext)) return { status: "not-configured" };
  let { assetId } = request;
  const {
    stationCid,
    verifiedEntitlement,
    apiKey,
    apiSecret,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = serverContext;
  if (!nonblank(stationCid) || !nonblank(apiKey) || !nonblank(apiSecret) || apiKey.includes(":")) {
    return { status: "not-configured" };
  }
  if (typeof assetId !== "string" || !ASSET_ID.test(assetId)) return { status: "error" };
  assetId = assetId.toLowerCase();
  let timer;
  const controller = new AbortController();
  try {
    const url = new URL(`/api/v1/assets/${encodeURIComponent(assetId)}/`, MEDIA_MANAGER_ORIGIN);
    url.searchParams.set("localized_station", stationCid);
    if (verifiedEntitlement?.entitled === true && ["active", "grace"].includes(verifiedEntitlement.state)) {
      url.searchParams.set("membership", stationCid);
    }
    const authorization = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`, "utf8").toString("base64")}`;
    const budget = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(timeoutMs, DEFAULT_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => {
        resolve({ status: "timeout" });
        controller.abort();
      }, budget);
    });
    // Include body reads, even for an injected fetch that ignores AbortSignal.
    return await Promise.race([
      readAsset({ url, assetId, authorization, fetchImpl, signal: controller.signal }),
      deadline,
    ]);
  } catch {
    return { status: "error" };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

module.exports = { fetchAssetAvailability };
