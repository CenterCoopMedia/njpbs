import {
  GUIDE_VIDEO_TYPES,
  guideVideoAsset,
  type GuideVideoExtension,
} from "../../src/lib/guide-video-assets";

interface GuideAccessService {
  validateAccess(token: string, ip: string): Promise<number>;
}

interface GuideAssetService {
  fetch(request: Request): Promise<Response>;
}

interface GuideVideoObject {
  size: number;
  httpEtag: string;
  body?: BodyInit | null;
  range?: { offset?: number; length?: number; suffix?: number };
}

interface GuideVideoBucket {
  head(key: string): Promise<GuideVideoObject | null>;
  get(
    key: string,
    options?: { range?: { offset?: number; length?: number; suffix?: number } },
  ): Promise<GuideVideoObject | null>;
}

interface GuideContentEnv {
  ASSETS: GuideAssetService;
  STAFF_ACCESS: GuideAccessService;
  GUIDE_VIDEOS?: GuideVideoBucket;
}

interface GuideContentContext {
  request: Request;
  env: GuideContentEnv;
}

const TOKEN = /^[A-Za-z0-9._-]{1,3500}$/;
const GUIDE_RELEASE = /^[a-f0-9]{16}$/;
const ALLOWED_PATH = /^\/guide-content\/(?:admin-status\.json|manifest\.json|search\.json|resources\/(?:nj-politics|nj-election-2026|public-bios)\.json|pages\/[a-z0-9]+(?:-[a-z0-9]+)*\.md|images\/[A-Za-z0-9][A-Za-z0-9._-]*\.webp)$/;

function privateResponse(
  body: BodyInit | null,
  status: number,
  sourceHeaders: HeadersInit = {},
): Response {
  const headers = new Headers(sourceHeaders);
  headers.delete("set-cookie");
  headers.set("cache-control", "private, no-store");
  headers.set("cdn-cache-control", "no-store");
  headers.set("cloudflare-cdn-cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  if (status === 429) headers.set("retry-after", "1");
  return new Response(body, { status, headers });
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice(7);
  return TOKEN.test(token) ? token : null;
}

function assetRequest(request: Request): Request {
  const headers = new Headers();
  for (const name of ["accept", "range", "if-range", "if-none-match", "if-modified-since"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Request(request.url, {
    method: request.method,
    headers,
    redirect: "manual",
  });
}

type VideoRange = { offset: number; length?: number } | { suffix: number };

function requestedRange(header: string | null): VideoRange | "absent" | "invalid" {
  if (!header) return "absent";
  const value = header.trim();
  if (!value.startsWith("bytes=")) return "absent";
  if (value.includes(",")) return "invalid";
  const match = /^(\d*)-(\d*)$/.exec(value.slice("bytes=".length));
  if (!match || (match[1] === "" && match[2] === "")) return "invalid";
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    return { suffix };
  }
  const start = Number(match[1]);
  if (!Number.isSafeInteger(start) || start < 0) return "invalid";
  if (match[2] === "") return { offset: start };
  const end = Number(match[2]);
  if (!Number.isSafeInteger(end) || end < start) return "invalid";
  return { offset: start, length: end - start + 1 };
}

function satisfiedRange(
  object: GuideVideoObject,
): { offset: number; length: number } | "absent" | "invalid" {
  if (!object.range) return "absent";
  const offset = object.range.offset ?? (
    object.range.suffix !== undefined ? Math.max(0, object.size - object.range.suffix) : 0
  );
  const length = object.range.length ?? (
    object.range.suffix !== undefined ? Math.min(object.range.suffix, object.size) : object.size - offset
  );
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length <= 0 || offset >= object.size) {
    return "invalid";
  }
  return { offset, length };
}

function videoHeaders(
  object: GuideVideoObject,
  extension: GuideVideoExtension,
  range: { offset: number; length: number } | "absent",
): HeadersInit {
  const headers: Record<string, string> = {
    "accept-ranges": "bytes",
    "content-length": String(range === "absent" ? object.size : range.length),
    "content-type": GUIDE_VIDEO_TYPES[extension],
    etag: object.httpEtag,
  };
  if (range !== "absent") {
    headers["content-range"] = `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`;
  }
  return headers;
}

function unsatisfiableRange(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "InvalidRange" || /not satisfiable \(10039\)/.test(error.message);
}

function rangeError(size: number, extension: GuideVideoExtension): Response {
  return privateResponse("Range not satisfiable", 416, {
    "accept-ranges": "bytes",
    "content-range": `bytes */${size}`,
    "content-type": GUIDE_VIDEO_TYPES[extension],
  });
}

async function guideRelease(bucket: GuideVideoBucket): Promise<string | null> {
  const pointer = await bucket.get("videos/current");
  if (!pointer?.body) return null;
  const release = (typeof pointer.body === "string"
    ? pointer.body
    : await new Response(pointer.body).text()).trim();
  return GUIDE_RELEASE.test(release) ? release : null;
}

function versionedGuideKey(release: string, id: string, extension: GuideVideoExtension): string {
  return `videos/r/${release}/${id}.${extension}`;
}

async function currentVideo(
  bucket: GuideVideoBucket,
  key: string,
  extension: GuideVideoExtension,
): Promise<Response> {
  const full = await bucket.get(key);
  if (!full) return privateResponse("Not found", 404);
  if (!full.body) return privateResponse("Guide access unavailable", 503);
  return privateResponse(full.body, 200, videoHeaders(full, extension, "absent"));
}

async function recoverUnsatisfiableRange(
  bucket: GuideVideoBucket,
  key: string,
  extension: GuideVideoExtension,
  ifRange: string | null,
): Promise<Response> {
  const described = await bucket.head(key);
  if (!described) return privateResponse("Not found", 404);
  if (ifRange && ifRange !== described.httpEtag) return currentVideo(bucket, key, extension);
  return rangeError(described.size, extension);
}

async function serveVideo(
  request: Request,
  env: GuideContentEnv,
  asset: { id: string; extension: GuideVideoExtension },
): Promise<Response> {
  const bucket = env.GUIDE_VIDEOS;
  if (!bucket) return privateResponse("Guide access unavailable", 503);
  const release = await guideRelease(bucket);
  if (!release) return privateResponse("Not found", 404);
  const key = versionedGuideKey(release, asset.id, asset.extension);
  // Range only applies to GET. HEAD describes the entire representation.
  if (request.method === "HEAD") {
    const described = await bucket.head(key);
    if (!described) return privateResponse(null, 404);
    return privateResponse(null, 200, videoHeaders(described, asset.extension, "absent"));
  }
  const ifRange = request.headers.get("if-range");
  if (ifRange) {
    const described = await bucket.head(key);
    if (!described) return privateResponse("Not found", 404);
    if (ifRange !== described.httpEtag) {
      const full = await bucket.get(key);
      if (!full) return privateResponse("Not found", 404);
      if (!full.body) return privateResponse("Guide access unavailable", 503);
      return privateResponse(full.body, 200, videoHeaders(full, asset.extension, "absent"));
    }
  }
  const requested = requestedRange(request.headers.get("range"));
  if (requested === "invalid") {
    const described = await bucket.head(key);
    if (!described) return privateResponse("Not found", 404);
    return rangeError(described.size, asset.extension);
  }
  let object: GuideVideoObject | null;
  try {
    object = await bucket.get(key, requested === "absent" ? undefined : { range: requested });
  } catch (error) {
    if (!unsatisfiableRange(error) || requested === "absent") throw error;
    return recoverUnsatisfiableRange(bucket, key, asset.extension, ifRange);
  }
  if (!object) {
    if (requested === "absent") return privateResponse("Not found", 404);
    return recoverUnsatisfiableRange(bucket, key, asset.extension, ifRange);
  }
  const current = requested !== "absent" && ifRange && ifRange !== object.httpEtag
    ? await bucket.get(key)
    : object;
  if (!current?.body) return privateResponse("Guide access unavailable", 503);
  const range = current === object ? satisfiedRange(current) : "absent";
  if (range === "invalid") return rangeError(current.size, asset.extension);
  const status = range === "absent" ? 200 : 206;
  return privateResponse(current.body, status, videoHeaders(current, asset.extension, range));
}

export async function onRequest(context: GuideContentContext): Promise<Response> {
  const { request, env } = context;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return privateResponse("Method not allowed", 405, { allow: "GET, HEAD" });
  }

  try {
    const token = bearerToken(request);
    if (!token) return privateResponse("Unauthorized", 401);

    const access = await env.STAFF_ACCESS.validateAccess(
      token,
      request.headers.get("cf-connecting-ip")?.trim() || "missing",
    );
    if (access !== 204) return privateResponse("Guide access unavailable", access);

    const pathname = new URL(request.url).pathname;
    const video = guideVideoAsset(pathname);
    if (video) return await serveVideo(request, env, video);
    if (!ALLOWED_PATH.test(pathname)) return privateResponse("Not found", 404);

    const upstream = await env.ASSETS.fetch(assetRequest(request));
    return privateResponse(
      request.method === "HEAD" ? null : upstream.body,
      upstream.status,
      upstream.headers,
    );
  } catch {
    return privateResponse("Guide access unavailable", 503);
  }
}


