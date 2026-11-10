import { adaptLatestHomeNewscast, HOME_NEWSCAST_ASSETS_URL } from "../../packages/content-core/src/home-newscast-source.ts";
import { createHomeNewscastPacket } from "../../packages/content-core/src/home-newscast-published.ts";

const maxPageBytes = 4 * 1024 * 1024;
const maxTotalBytes = 16 * 1024 * 1024;
// Optional pagination gets one minute of the Pages job's 15-minute budget,
// leaving the rest for the other sources, build and artifact upload.
const maxPaginationMs = 60_000;

function approvedPage(value, seen) {
  if (typeof value !== "string" || /[\\\u0000-\u0020\u007f]/.test(value)) throw new Error("Invalid newscast pagination.");
  const url = new URL(value), expected = new URL(HOME_NEWSCAST_ASSETS_URL);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password || url.hash ||
      seen.has(url.href) || seen.size >= 100) throw new Error("Invalid newscast pagination.");
  for (const [key, value] of expected.searchParams) {
    if (url.searchParams.getAll(key).length !== 1 || url.searchParams.get(key) !== value) throw new Error("Invalid newscast provider filter.");
  }
  for (const [key, value] of url.searchParams) {
    if (expected.searchParams.has(key)) continue;
    if (!["page", "page-size"].includes(key) || url.searchParams.getAll(key).length !== 1 ||
        !/^[1-9]\d*$/.test(value) || Number(value) > (key === "page-size" ? 1000 : 100_000)) throw new Error("Invalid newscast pagination.");
  }
  return url.href;
}

async function boundedJson(response) {
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maxPageBytes)) throw new Error("Newscast response exceeds its bound.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Newscast response is incomplete.");
  const parts = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxPageBytes) throw new Error("Newscast response exceeds its bound.");
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return { payload: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), size };
}

/** Normal complete PBS sync only; the fast Home publisher never calls this. */
export async function fetchHomeNewscast(config, fetchImpl = fetch, now = () => new Date().toISOString()) {
  if (!config.authorization) return createHomeNewscastPacket(adaptLatestHomeNewscast({ status: "error" }, now()));
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException("Newscast pagination deadline exceeded.", "TimeoutError")), maxPaginationMs);
  try {
    const data = [], seen = new Set();
    let next = HOME_NEWSCAST_ASSETS_URL, totalBytes = 0;
    while (next !== null) {
      deadline.signal.throwIfAborted();
      const url = approvedPage(next, seen); seen.add(url);
      const response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.any([deadline.signal, AbortSignal.timeout(20_000)]),
        headers: { Accept: "application/json", Authorization: config.authorization } });
      if (!response.ok || response.redirected) throw new Error("Newscast provider unavailable.");
      const { payload, size } = await boundedJson(response); totalBytes += size;
      deadline.signal.throwIfAborted();
      if (totalBytes > maxTotalBytes || !Array.isArray(payload?.data) || payload.data.length > 1000 ||
          data.length + payload.data.length > 10_000 || !payload.links ||
          !(payload.links.next === null || typeof payload.links.next === "string")) throw new Error("Newscast response is incomplete.");
      data.push(...payload.data); next = payload.links.next;
    }
    const checkedAt = now();
    const packet = createHomeNewscastPacket(adaptLatestHomeNewscast({ status: "ready", source: "pbs_media_manager",
      requestUrl: HOME_NEWSCAST_ASSETS_URL, checkedAt, complete: true, response: { data, links: { next: null } } }, checkedAt));
    // A new observation must support the in-place playback contract. Never
    // invent an embed or silently choose an older episode when its code is absent.
    if (packet.episode && !packet.episode.playerSrc) throw new Error("Newscast player unavailable.");
    return packet;
  } catch {
    // Upstream errors can carry response/request data. Export only this safe
    // error; neither credentials nor response bodies enter logs or artifacts.
    throw new Error("The complete approved newscast provider snapshot is unavailable.");
  } finally {
    clearTimeout(timer);
  }
}

export async function homeNewscastForSync(config, fetchImpl = fetch, now = () => new Date().toISOString()) {
  try { return await fetchHomeNewscast(config, fetchImpl, now); }
  catch {
    // This optional source owns its failure state. It must not stop the normal
    // PBS shelves, schedule refresh or publication of a Home without Newscast.
    console.warn("PBS newscast refresh failed; publishing a source_error packet.");
    return createHomeNewscastPacket(adaptLatestHomeNewscast({ status: "error" }, now()));
  }
}
