import { cloudflareR2Endpoint } from "./cloudflare-account.mjs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spotlightCopyImageUrl, spotlightImageUrl } from "../../packages/content-core/src/spotlight-image.mjs";

const require = createRequire(import.meta.url);
const ORIGIN = "https://media.njpbs.org";
const MAX_BYTES = 2 * 1024 * 1024;
const BUDGET_MS = 30_000;
const TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
const hash = value => createHash("sha256").update(value).digest("hex");

export function spotlightCopyIndexKey(sourceUrl) {
  if (!spotlightImageUrl(sourceUrl)) throw new Error("Invalid Spotlight source image");
  return `cms-media/spotlight/.sources/${hash(sourceUrl)}.json`;
}

export function spotlightCardSizeUrl(source) {
  if (!source || !spotlightImageUrl(source.url) || !/-\d+x\d+\.[a-z]+$/i.test(source.url) ||
      !Number.isSafeInteger(source.width) || !Number.isSafeInteger(source.height) || source.width < 1 || source.height < 1) return undefined;
  // Preferred target for the widest Home hero (1344px) and 390px phones at 2x.
  // The bounded copy pass may choose a smaller intermediate under #4719.
  if (source.width === 1536) return source.url;
  const height = source.width === 300 && source.height === 169 ? 864 : Math.round(1536 * source.height / source.width);
  return spotlightImageUrl(source.url.replace(/-\d+x\d+(?=\.[a-z]+$)/i, `-1536x${height}`));
}

function spotlightCardSizeUrls(source) {
  const preferred = spotlightCardSizeUrl(source);
  if (!preferred) return [];
  // Standard WordPress intermediates, descending; never fetch the original.
  const height = Number(/-(\d+)x(\d+)\.[a-z]+$/i.exec(preferred)[2]);
  return [1536, 1024, 768, 300].map(width => preferred.replace(/-\d+x\d+(?=\.[a-z]+$)/i,
    `-${width}x${Math.round(width * height / 1536)}`));
}

class SpotlightImageSizeError extends Error {}

function admittedCopy(value, sourceUrl) {
  if (!value || value.schemaVersion !== 1 || value.sourceUrl !== sourceUrl || !TYPES[value.mimeType] ||
      !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MAX_BYTES ||
      !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) || value.width < 1 || value.height < 1 ||
      value.width * value.height > 12_000_000 || !/^[a-f0-9]{64}$/.test(value.sha256) ||
      value.key !== `cms-media/spotlight/${hash(sourceUrl)}/${value.sha256}.${TYPES[value.mimeType]}` ||
      !spotlightImageUrl(value.fetchedUrl) || value.fetchedUrl.replace(/-\d+x\d+(?=\.[a-z]+$)/i, "") !==
        sourceUrl.replace(/-\d+x\d+(?=\.[a-z]+$)/i, "")) return undefined;
  return spotlightCopyImageUrl(`${ORIGIN}/${value.key}`) ? value : undefined;
}

async function boundedBody(response, maximum) {
  if (Number(response.headers.get("content-length")) > maximum) {
    await response.body?.cancel();
    throw new SpotlightImageSizeError("Spotlight image exceeds its byte limit");
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Spotlight image response unavailable");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new SpotlightImageSizeError("Spotlight image exceeds its byte limit");
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally { await reader.cancel(); reader.releaseLock(); }
}

/** Reuse the CMS's immutable public uploader. The caller owns credentials and
 * opts into writes; absent configuration always means topic-art fallback. */
export function createSpotlightImageStorage(config, signal) {
  if (!config?.accessKeyId || !config?.secretAccessKey) return undefined;
  if (config.endpoint !== cloudflareR2Endpoint() || config.bucket !== "njpbs") throw new Error("Invalid Spotlight media storage target");
  const { S3Client } = require("@aws-sdk/client-s3");
  const { R2MediaStorage, r2ClientConfig } = require("../../functions/lib/r2-media.js");
  const client = new S3Client({ ...r2ClientConfig(config), maxAttempts: 1,
    requestHandler: { connectionTimeout: 3000, requestTimeout: 8000 } });
  const storage = new R2MediaStorage({ bucket: config.bucket,
    client: { send: command => client.send(command, { abortSignal: signal }) } });
  return { headIfExists: key => storage.headIfExists(key), get: key => storage.get(key),
    putFinal: value => storage.putFinal(value), close: () => client.destroy() };
}

/** One sequential pass, bounded size alternatives for new URLs, no request retry.
 * Cached receipts are on NJ PBS; an existing copy never contacts Spotlight. */
export async function copySpotlightImages(cards, fetchImpl = fetch, storageFactory) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BUDGET_MS);
  let storage;
  let unavailable = 0;
  try {
    try { storage = storageFactory?.(controller.signal); }
    catch { console.warn("Spotlight image cache: configured storage unavailable; using public copies or topic art."); }
    const copies = new Map();
    const selected = [];
    for (const card of cards) {
      const sourceUrl = spotlightImageUrl(card.sourceImage?.url);
      if (!sourceUrl || controller.signal.aborted) { selected.push(card); continue; }
      if (copies.has(sourceUrl)) {
        const copy = copies.get(sourceUrl);
        selected.push(copy ? { ...card, image: `${ORIGIN}/${copy.key}`, imageCopy: copy } : card);
        continue;
      }
      let copy;
      let missingIndex = false;
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]);
        const indexKey = spotlightCopyIndexKey(sourceUrl);
        if (storage) {
          const head = await storage.headIfExists(indexKey);
          missingIndex = head === null;
          if (head && head.contentLength <= 4096) copy = admittedCopy(JSON.parse((await storage.get(indexKey)).toString("utf8")), sourceUrl);
        } else {
          const response = await fetchImpl(`${ORIGIN}/${indexKey}`, { redirect: "error", signal,
            headers: { Accept: "application/json", "User-Agent": "NJ PBS Spotlight image cache/1.0" } });
          if (response.ok) copy = admittedCopy(JSON.parse((await boundedBody(response, 4096)).toString("utf8")), sourceUrl);
          else await response.body?.cancel();
        }
        if (copy) {
          // A missing/deleted copy is unavailable; its immutable pointer does not
          // justify another origin download on every refresh.
          const head = storage ? await storage.headIfExists(copy.key) : await fetchImpl(`${ORIGIN}/${copy.key}`, { method: "HEAD", redirect: "error", signal });
          const present = storage ? head?.contentLength === copy.bytes && head.contentType === copy.mimeType && head.metadata?.contenthash === copy.sha256
            : head?.ok && Number(head.headers.get("content-length")) === copy.bytes && head.headers.get("content-type")?.split(";")[0] === copy.mimeType;
          if (!present) copy = undefined;
        } else if (storage && missingIndex && !controller.signal.aborted) {
          let fetchedUrl, mimeType, body;
          for (const candidate of spotlightCardSizeUrls(card.sourceImage)) {
            controller.signal.throwIfAborted();
            const response = await fetchImpl(candidate, { redirect: "error", signal,
              headers: { Accept: "image/jpeg,image/png,image/webp,image/gif", "User-Agent": "NJ PBS Spotlight image cache/1.0" } });
            if (response.status === 404) { await response.body?.cancel(); continue; }
            mimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
            if (!TYPES[mimeType]) { await response.body?.cancel(); throw new Error("Unsupported Spotlight image type"); }
            try { body = await boundedBody(response, MAX_BYTES); }
            catch (error) { if (error instanceof SpotlightImageSizeError) continue; throw error; }
            fetchedUrl = candidate;
            break;
          }
          if (!body || !fetchedUrl) throw new Error("No bounded Spotlight image size available");
          const sharp = require("sharp");
          const metadata = await sharp(body, { animated: false, failOn: "error", limitInputPixels: 12_000_000 }).metadata();
          if ((metadata.format === "jpeg" ? "image/jpeg" : `image/${metadata.format}`) !== mimeType || !metadata.width || !metadata.height) throw new Error("Invalid Spotlight raster image");
          // Header metadata alone can admit a truncated file. Decode the first
          // frame before publishing, with bounded pixels and a tiny output.
          await sharp(body, { animated: false, failOn: "error", limitInputPixels: 12_000_000 }).resize(1, 1).raw().toBuffer();
          const sha256 = hash(body);
          const key = `cms-media/spotlight/${hash(sourceUrl)}/${sha256}.${TYPES[mimeType]}`;
          controller.signal.throwIfAborted();
          await storage.putFinal({ key, body, mimeType, metadata: { sourcehash: hash(sourceUrl), contenthash: sha256 } });
          const head = await storage.headIfExists(key);
          if (head?.contentLength !== body.length || head.contentType !== mimeType || head.metadata?.contenthash !== sha256) throw new Error("Spotlight media copy verification failed");
          copy = { schemaVersion: 1, sourceUrl, fetchedUrl, key, sha256, bytes: body.length, mimeType, width: metadata.width, height: metadata.height };
          controller.signal.throwIfAborted();
          await storage.putFinal({ key: indexKey, body: Buffer.from(JSON.stringify(copy)), mimeType: "application/json", metadata: { sourcehash: hash(sourceUrl) } });
          // Concurrent syncs may have recorded an earlier content hash. Follow
          // that immutable receipt rather than publishing an unindexed copy.
          copy = admittedCopy(JSON.parse((await storage.get(indexKey)).toString("utf8")), sourceUrl);
          if (copy && copy.key !== key) {
            const winner = await storage.headIfExists(copy.key);
            if (winner?.contentLength !== copy.bytes || winner.contentType !== copy.mimeType || winner.metadata?.contenthash !== copy.sha256) copy = undefined;
          }
        }
      } catch { copy = undefined; }
      if (storage && !copy) unavailable++;
      copies.set(sourceUrl, copy);
      selected.push(copy ? { ...card, image: `${ORIGIN}/${copy.key}`, imageCopy: copy } : card);
    }
    return selected;
  } finally {
    if (unavailable) console.warn(`Spotlight image cache: ${unavailable} unavailable source(s); used topic art.`);
    clearTimeout(timer); controller.abort(); storage?.close?.();
  }
}
