import { postSlugForPath } from "../../packages/content-core/src/post-slugs";
import { SECURITY_HEADER_BASELINE } from "../../packages/content-core/src/public-security-headers";
import { SPOTLIGHT_ARCHIVE_REDIRECT_ASSETS, spotlightArchivePath, spotlightArchiveRedirectShard } from "../../packages/content-core/src/spotlight-archive-paths";

export async function serveSpotlightArchiveRedirect(request: Request, original: Response,
  fetchAsset: (request: Request) => Promise<Response>, readCanonical: (request: Request) => Promise<Response>,
): Promise<Response> {
  if (original.status !== 404 || !["GET", "HEAD"].includes(request.method)) return original;
  const url = new URL(request.url);
  const path = spotlightArchivePath(url.pathname);
  if (!path) return original;
  let location: string;
  try {
    const shardPath = `${SPOTLIGHT_ARCHIVE_REDIRECT_ASSETS}${spotlightArchiveRedirectShard(path)}.json`;
    const shard = await fetchAsset(new Request(new URL(shardPath, url.origin)));
    if (shard.status !== 200) {
      void shard.body?.cancel().catch(() => {});
      return original;
    }
    const redirects = await shard.json() as Record<string, unknown> | null;
    const target = redirects && Object.hasOwn(redirects, path) ? redirects[path] : null;
    if (typeof target !== "string" || !postSlugForPath(target)) return original;
    location = target;
  } catch {
    return original;
  }

  const headers = new Headers({ ...SECURITY_HEADER_BASELINE, "cache-control": "no-store" });
  const probe = (path: string) => readCanonical(new Request(new URL(path, url.origin), { method: "HEAD", redirect: "manual" }));
  try {
    // Confirm the canonical route is live in the same serving path a reader will use.
    let canonical = await probe(location);
    const renamed = canonical.status === 308 ? canonical.headers.get("location") : null;
    if (renamed && renamed !== location && postSlugForPath(renamed)) {
      location = renamed;
      canonical = await probe(location);
    }
    if (canonical.status >= 500) throw new Error("Archive story is unavailable");
    if (canonical.status !== 200) return original;
    if (original.body) void original.body.cancel().catch(() => {});
    headers.set("location", `${location}${url.search}`);
    return new Response(null, { status: 301, headers });
  } catch {
    if (original.body) void original.body.cancel().catch(() => {});
    return new Response(null, { status: 503, headers });
  }
}
