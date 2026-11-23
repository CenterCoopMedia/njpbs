const ARCHIVE_PATH = /^\/(?:\d{4}\/(?:0[1-9]|1[0-2])\/|stories\/\d{2,4}\/\d{2}\/\d{2}\/|video\/|blog-post\/)(?:[A-Za-z0-9_-]|%[0-9a-fA-F]{2})+\/?$/;

export const SPOTLIGHT_ARCHIVE_REDIRECT_ASSETS = "/_spotlight-archive-redirects/";

export function spotlightArchiveRedirectShard(path: string): string {
  // Shard by the full path to keep request reads small as the archive grows.
  let hash = 0;
  for (const char of path) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) & 255;
  return hash.toString(16).padStart(2, "0");
}

/** Normalize the slash and URL encoding of an exact legacy story path. */
export function spotlightArchivePath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 512 || !ARCHIVE_PATH.test(value)) return null;
  const path = value.endsWith("/") ? value : `${value}/`;
  try {
    // Re-encode only the leaf. Reject escapes for separators, dot segments,
    // controls and other ASCII outside the ordinary WordPress slug alphabet.
    const start = path.lastIndexOf("/", path.length - 2) + 1;
    const leaf = decodeURIComponent(path.slice(start, -1));
    if (!leaf || /[^A-Za-z0-9_\u0080-\uFFFF-]/.test(leaf)) return null;
    const normalized = `${path.slice(0, start)}${encodeURIComponent(leaf)}/`;
    return normalized.length <= 512 ? normalized : null;
  } catch {
    return null;
  }
}

export function isSpotlightArchivePaths(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && new Set(value).size === value.length &&
    value.every(path => typeof path === "string" && spotlightArchivePath(path) === path);
}
