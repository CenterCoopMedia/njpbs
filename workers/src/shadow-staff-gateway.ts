import { serveStaffSite } from "./staff-site-worker";
// Import the slug rule from content-core, not site/src: this file is tested outside the site package.
import { isServerMintableSlugShape as isPublicContentSlug } from "../../packages/content-core/src/post-slugs";

/** The same CMS session gate protects shadow HTML and its client assets.
 * Only an admitted slug selects the shadow; other dev Posts retain the origin.
 */
export function serveShadowStaffPost(request: Request, config: {
  SHADOW_POSTS_ENABLED: string; SHADOW_POST_SLUGS: string;
}, dependencies: {
  validateAccess(token: string): Promise<number>;
  shadow: { fetch(request: Request, config: { SHADOW_POSTS_ENABLED: string; SHADOW_POST_SLUGS: string }): Promise<Response> };
  serveAsset(request: Request): Promise<Response>;
  serveOrigin(request: Request): Promise<Response>;
}): Promise<Response> {
  if (new URL(request.url).origin !== "https://dev-public.example.org") {
    return Promise.resolve(new Response("Not found", { status: 404 }));
  }
  return serveStaffSite(request, {
    validateAccess: dependencies.validateAccess,
    serve(cleanRequest) {
      const url = new URL(cleanRequest.url);
      if (url.pathname.startsWith("/posts/_shadow-assets/_astro/")) {
        url.pathname = url.pathname.slice("/posts/_shadow-assets".length);
        return dependencies.serveAsset(new Request(url, cleanRequest));
      }
      const slug = /^\/posts\/([^/]+)\/$/.exec(url.pathname)?.[1];
      if (config.SHADOW_POSTS_ENABLED === "true" && isPublicContentSlug(slug) &&
        config.SHADOW_POST_SLUGS.split(",").map(value => value.trim()).includes(slug)) {
        return dependencies.shadow.fetch(cleanRequest, config);
      }
      return dependencies.serveOrigin(cleanRequest);
    },
  });
}
