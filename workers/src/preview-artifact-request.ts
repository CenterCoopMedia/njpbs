const QUEUE_ID = /^[A-Za-z0-9]{20}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9._~-]+$/;

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
});

export interface PreviewObjectRequest {
  queueId: string;
  persistent: boolean;
  key: string;
  contentType: string;
}

function contentTypeFor(pathname: string): string | null {
  const filename = pathname.split("/").at(-1) ?? "";
  const dot = filename.lastIndexOf(".");
  if (dot < 1) return null;
  return CONTENT_TYPES[filename.slice(dot).toLowerCase()] ?? null;
}

export function previewObjectRequest(pathname: string): PreviewObjectRequest | null {
  if (pathname.includes("%") || pathname.includes("\\")) return null;
  const match = pathname.match(/^\/(p|s)\/([A-Za-z0-9]{20})\/(.*)$/);
  if (!match) return null;
  const queueId = match[2];
  if (!QUEUE_ID.test(queueId)) return null;

  const requestedPath = match[3];
  const segments = requestedPath.split("/");
  const hasTrailingSlash = segments.at(-1) === "";
  const pathSegments = hasTrailingSlash ? segments.slice(0, -1) : segments;
  if (pathSegments.some((segment) => !SAFE_SEGMENT.test(segment))) return null;

  const relativePath = hasTrailingSlash
    ? [...pathSegments, "index.html"].join("/")
    : pathSegments.join("/");
  const contentType = contentTypeFor(relativePath);
  if (!contentType) return null;
  return {
    queueId,
    persistent: match[1] === "s",
    key: `${match[1] === "s" ? "saved" : "v1"}/${queueId}/${relativePath}`,
    contentType,
  };
}

