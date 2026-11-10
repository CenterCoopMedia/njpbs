export { createPublicReleaseRouter } from "./public-release-router";
import { escapeHtml } from "../../packages/content-core/src/content-model";
import { SECURITY_HEADER_BASELINE } from "../../packages/content-core/src/public-security-headers";
export { SECURITY_HEADER_BASELINE } from "../../packages/content-core/src/public-security-headers";
import { hasVideoPlayer } from "../../packages/content-core/src/video-page";
import {
  generatedHeadingLevelAt,
  renderBlock,
} from "../../packages/content-core/src/content-render";
import { contentBlockHtml, renderContentGroups } from "../../packages/content-core/src/content-row-render";
import { contactPageFallback } from "../../packages/content-core/src/contact-page-fallback";
import {
  groupLinkCardDirectories,
  renderLinkCardDirectory,
} from "../../packages/content-core/src/link-card-directory-groups";
import type {
  PublicContentEntrypoint,
  PublicPageProjection,
} from "../../cms-api/src/index";

const CONTACT_PAGE_ID = "contact";
const CMS_CONTENT_SOURCE = "cms-runtime";
const FALLBACK_CONTENT_SOURCE = "committed-fallback";
const ADMIN_ORIGIN = "https://admin.njpbs.org";
const RECEIPT_RESPONSE_HEADERS =
  "x-njpbs-content-source, x-njpbs-source-version";
const DEFAULT_SOCIAL_IMAGE = "https://njpbs.org/og-default.png";
const PUBLIC_PAGE_LOOKUP_TIMEOUT_MS = 1_500;
const PUBLIC_PAGE_CACHE_LOOKUP_TIMEOUT_MS = 250;
const PUBLIC_PAGE_CACHE_FRESH_MS = 60_000;
const PUBLIC_PAGE_CACHE_STALE_MS = 5 * 60_000;
const PUBLIC_PAGE_REFRESH_BACKOFF_MS = 15_000;
const PUBLIC_PAGE_CACHE_URL = "https://cms-runtime-cache.invalid/v1/contact";
const PUBLIC_PAGE_CACHED_AT_HEADER = "x-njpbs-cached-at";
const PUBLICATION_PROBE_PATH = "/_publication.json";
const PUBLICATION_ORIGIN_HEADER = "x-njpbs-publication-origin";
const PUBLICATION_ORIGIN_VALUE = "njpbs-production";
const CONTACT_ASTRO_ASSET_PREFIX = "/contact/_astro/";
const ASTRO_ASSET_PREFIX = "/_astro/";

const STATIC_ASSET_HEADERS_TO_STRIP = [
  "if-match",
  "if-none-match",
  "if-modified-since",
  "if-unmodified-since",
  "if-range",
  "range",
] as const;

interface PublicWorkerDependencies {
  fetchAsset(request: Request): Promise<Response>;
  getPublishedPage(pageId: string): Promise<PublicPageProjection>;
  /** Optional source-only pilot. Null means the route is outside its ownership. */
  noBuildPosts?: { fetch(request: Request): Promise<Response | null> };
  lookupTimeoutMs?: number;
  projectionCache?: Pick<Cache, "match" | "put">;
  now?: () => number;
  waitUntil?(task: Promise<unknown>): void;
}

type PublicWorkerEnv = Omit<Env, "CMS_API"> & {
  CMS_API: Service<typeof PublicContentEntrypoint>;
};

type LiveContactPage = Extract<PublicPageProjection, { state: "live" }>["page"];
type ContactRenderPage = Pick<
  LiveContactPage,
  "title" | "description" | "childDirected" | "noindex" | "seo" | "social" | "blocks" | "assets" | "heroBackgroundImage" | "heroBackgroundPosition"
>;
type ContactRenderSource =
  | { kind: "cms"; sourceVersion: number }
  | { kind: "fallback" };

let projectionLookup: Promise<PublicPageProjection> | undefined;
let refreshBackoffUntil = 0;

function cachedProjectionResponse(
  projection: PublicPageProjection,
  cachedAt: number,
): Response {
  return new Response(JSON.stringify(projection), {
    headers: {
      "cache-control": `max-age=${PUBLIC_PAGE_CACHE_STALE_MS / 1_000}`,
      "content-type": "application/json",
      [PUBLIC_PAGE_CACHED_AT_HEADER]: String(cachedAt),
    },
  });
}

async function readCachedProjection(
  cache: Pick<Cache, "match">,
): Promise<{ projection: PublicPageProjection; cachedAt: number } | undefined> {
  try {
    const response = await cache.match(new Request(PUBLIC_PAGE_CACHE_URL));
    if (!response) return undefined;
    const cachedAt = Number(response.headers.get(PUBLIC_PAGE_CACHED_AT_HEADER));
    if (!Number.isFinite(cachedAt)) return undefined;
    return {
      projection: await response.json() as PublicPageProjection,
      cachedAt,
    };
  } catch {
    return undefined;
  }
}

function storeProjection(
  deps: PublicWorkerDependencies,
  cache: Pick<Cache, "put">,
  projection: PublicPageProjection,
  now: number,
): void {
  const write = cache.put(
    new Request(PUBLIC_PAGE_CACHE_URL),
    cachedProjectionResponse(projection, now),
  ).catch(() => undefined);
  if (deps.waitUntil) deps.waitUntil(write);
}

function refreshProjection(
  deps: PublicWorkerDependencies,
  cache: Pick<Cache, "put"> | undefined,
  now: number,
): Promise<PublicPageProjection> {
  if (!cache) return deps.getPublishedPage(CONTACT_PAGE_ID);
  if (projectionLookup) return projectionLookup;
  projectionLookup = deps.getPublishedPage(CONTACT_PAGE_ID).then((projection) => {
    storeProjection(deps, cache, projection, now);
    return projection;
  }).finally(() => {
    projectionLookup = undefined;
  });
  return projectionLookup;
}

async function getContactProjection(
  deps: PublicWorkerDependencies,
): Promise<PublicPageProjection> {
  const timeoutMs = deps.lookupTimeoutMs ?? PUBLIC_PAGE_LOOKUP_TIMEOUT_MS;
  const now = deps.now?.() ?? Date.now();
  let waitedForInFlight = false;
  if (projectionLookup) {
    try {
      return await withTimeout(projectionLookup, timeoutMs);
    } catch {
      waitedForInFlight = true;
    }
  }
  const cached = deps.projectionCache
    ? await withTimeout(
      readCachedProjection(deps.projectionCache),
      Math.min(timeoutMs, PUBLIC_PAGE_CACHE_LOOKUP_TIMEOUT_MS),
    ).catch(() => undefined)
    : undefined;
  if (cached && now - cached.cachedAt <= PUBLIC_PAGE_CACHE_FRESH_MS) {
    return cached.projection;
  }
  if (
    cached &&
    now - cached.cachedAt <= PUBLIC_PAGE_CACHE_STALE_MS &&
    now < refreshBackoffUntil
  ) {
    return cached.projection;
  }
  try {
    if (waitedForInFlight) {
      throw new Error("Public content lookup timed out");
    }
    return await withTimeout(
      refreshProjection(deps, deps.projectionCache, now),
      timeoutMs,
    );
  } catch (error) {
    if (cached && now - cached.cachedAt <= PUBLIC_PAGE_CACHE_STALE_MS) {
      refreshBackoffUntil = now + PUBLIC_PAGE_REFRESH_BACKOFF_MS;
      return cached.projection;
    }
    throw error;
  }
}

function isContactPage(pathname: string): boolean {
  return pathname === "/contact" || pathname === "/contact/";
}

function isContactWorkerPath(pathname: string): boolean {
  return pathname === "/contact" || pathname.startsWith("/contact/");
}

function isContactAstroAsset(pathname: string): boolean {
  return pathname.startsWith(CONTACT_ASTRO_ASSET_PREFIX);
}

function contactAstroAssetRequest(request: Request): Request {
  const url = new URL(request.url);
  url.pathname = `${ASTRO_ASSET_PREFIX}${url.pathname.slice(
    CONTACT_ASTRO_ASSET_PREFIX.length,
  )}`;
  return new Request(url, request);
}

function contactAssetPath(value: string): string {
  return value.startsWith(ASTRO_ASSET_PREFIX)
    ? `/contact${value}`
    : value;
}

function contactAssetSrcset(value: string): string {
  return value.replace(
    /(^|,\s*)\/_astro\//g,
    "$1/contact/_astro/",
  );
}

function withSecurityHeaderBaseline(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADER_BASELINE)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withContactReceiptCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", ADMIN_ORIGIN);
  headers.set("access-control-expose-headers", RECEIPT_RESPONSE_HEADERS);
  const vary = headers.get("vary");
  if (!vary?.split(",").some((value) => value.trim().toLowerCase() === "origin")) {
    headers.set("vary", vary ? `${vary}, Origin` : "Origin");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function unconditionalAssetRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  for (const header of STATIC_ASSET_HEADERS_TO_STRIP) headers.delete(header);
  return new Request(request, { headers });
}

function publicationReceiptRequest(request: Request): Request {
  const url = new URL(request.url);
  url.pathname = PUBLICATION_PROBE_PATH;
  url.search = "";
  return unconditionalAssetRequest(new Request(url, request));
}

function publicationProbeResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", ADMIN_ORIGIN);
  headers.set("cache-control", "no-store");
  headers.set(PUBLICATION_ORIGIN_HEADER, PUBLICATION_ORIGIN_VALUE);
  headers.delete("etag");
  headers.delete("last-modified");
  return withSecurityHeaderBaseline(new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  }));
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("Public content lookup timed out")),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function renderedBlocks(
  page: ContactRenderPage,
): string {
  // The runtime Contact page reuses a built shell that may load analytics, so it
  // never plays a video (VPPA, #2751). A video block on Contact renders nothing.
  const blocks = page.blocks.filter((block) => block.type !== "video");
  const groups = renderContentGroups(blocks, (block, index) => {
    const generatedHeadingLevel = generatedHeadingLevelAt(blocks, index);
    return {
      generatedHeadingLevel,
      html: renderBlock(block, {
        generatedHeadingLevel,
        resolveAsset: (assetId) => page.assets[assetId] ?? null,
      }),
    };
  });
  const body = groupLinkCardDirectories(groups).map((item) =>
    item.kind === "link-card-directory"
      ? renderLinkCardDirectory(item.groups)
      : contentBlockHtml(item.group));
  return `<div class="cms-page__blocks cms-page__blocks--within-frame">${body.join("")}</div>`;
}

function renderedHeroBackground(page: ContactRenderPage): string {
  const image = page.heroBackgroundImage ? page.assets[page.heroBackgroundImage] : undefined;
  if (!image || image.mimeType === "application/pdf") return "";
  const position = page.heroBackgroundPosition ?? "center";
  return `<img class="cms-hero-background__image" src="${escapeHtml(image.url)}" width="${image.width}" height="${image.height}" alt="" loading="eager" decoding="async" fetchpriority="high" style="object-position: ${position};"><span class="cms-hero-background__overlay"></span>`;
}

function committedContactPage(): ContactRenderPage {
  const fallback = contactPageFallback();
  return {
    title: fallback.title,
    description: fallback.description,
    noindex: fallback.noindex,
    seo: { description: fallback.seoDescription },
    blocks: fallback.blocks,
    assets: {},
  };
}

function transformedContact(
  response: Response,
  page: ContactRenderPage,
  source: ContactRenderSource,
): Response {
  const body = renderedBlocks(page);
  const videoPage = hasVideoPlayer(body);
  const documentTitle = `${page.seo?.title ?? page.title} — NJ PBS`;
  const description = page.seo?.description ?? page.description;
  const socialTitle = page.social?.title ?? documentTitle;
  const socialDescription = page.social?.description ?? description;
  const socialImage =
    (page.social?.imageAssetId
      ? page.assets[page.social.imageAssetId]?.url
      : undefined) ?? DEFAULT_SOCIAL_IMAGE;
  const rewriter = new HTMLRewriter()
    .on('#mcjs, #wisepopsjs, #analytics-consent-default, [data-analytics-consent], [data-activecampaign-enabled]', {
      element(element) {
        if (videoPage || page.childDirected === true) element.remove();
        else if (page.noindex) {
          if (["mcjs", "wisepopsjs"].includes(element.getAttribute("id") ?? "")) element.remove();
          else element.removeAttribute("data-activecampaign-enabled");
        }
      },
    })
    .on("[href]", {
      element(element) {
        const href = element.getAttribute("href");
        if (href) element.setAttribute("href", contactAssetPath(href));
      },
    })
    .on("[src]", {
      element(element) {
        const src = element.getAttribute("src");
        if (src) element.setAttribute("src", contactAssetPath(src));
      },
    })
    .on("[srcset]", {
      element(element) {
        const srcset = element.getAttribute("srcset");
        if (srcset) element.setAttribute("srcset", contactAssetSrcset(srcset));
      },
    })
    .on("head", {
      element(element) {
        if (page.noindex) {
          element.append('<meta name="robots" content="noindex, nofollow">', {
            html: true,
          });
        }
      },
    })
    .on("title", {
      element(element) {
        element.setInnerContent(documentTitle);
      },
    })
    .on('meta[name="description"]', {
      element(element) {
        element.setAttribute("content", description);
      },
    })
    .on('meta[property="og:title"]', {
      element(element) {
        element.setAttribute("content", socialTitle);
      },
    })
    .on('meta[property="og:description"]', {
      element(element) {
        element.setAttribute("content", socialDescription);
      },
    })
    .on('meta[property="og:image"]', {
      element(element) {
        element.setAttribute("content", socialImage);
      },
    })
    .on('meta[name="twitter:title"]', {
      element(element) {
        element.setAttribute("content", socialTitle);
      },
    })
    .on('meta[name="twitter:description"]', {
      element(element) {
        element.setAttribute("content", socialDescription);
      },
    })
    .on('meta[name="twitter:image"]', {
      element(element) {
        element.setAttribute("content", socialImage);
      },
    })
    .on('meta[name="robots"]', {
      element(element) {
        element.remove();
      },
    })
    .on('script[type="application/ld+json"]', {
      element(element) {
        if (page.noindex) element.remove();
      },
    })
    .on('[data-cms-runtime-hero="contact"]', {
      element(element) {
        element.setInnerContent(renderedHeroBackground(page), { html: true });
      },
    })
    .on('[data-cms-runtime-title="contact"]', {
      element(element) {
        element.setInnerContent(page.title);
      },
    })
    .on('[data-cms-runtime-description="contact"]', {
      element(element) {
        element.setInnerContent(page.description);
      },
    })
    .on('[data-cms-runtime-body="contact"]', {
      element(element) {
        element.setInnerContent(body, { html: true });
      },
    });
  const transformed = rewriter.transform(response);
  const headers = new Headers(transformed.headers);
  headers.set("cache-control", "no-cache");
  headers.set(
    "x-njpbs-content-source",
    source.kind === "cms" ? CMS_CONTENT_SOURCE : FALLBACK_CONTENT_SOURCE,
  );
  if (source.kind === "cms") {
    headers.set("x-njpbs-source-version", String(source.sourceVersion));
  } else {
    headers.delete("x-njpbs-source-version");
  }
  headers.delete("etag");
  headers.delete("last-modified");
  return new Response(transformed.body, {
    status: transformed.status,
    statusText: transformed.statusText,
    headers,
  });
}

export async function servePublicRequest(
  request: Request,
  deps: PublicWorkerDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  // Compiled pair modules are private execution inputs, including encoded paths.
  let compiledPath = url.pathname;
  // Decode valid bytes only for this ASCII-prefix check. A literal percent or
  // malformed public escape must still reach ordinary routing and its headers.
  for (let pass = 0; pass < 3; pass++) compiledPath = compiledPath.replace(/%([a-f0-9]{2})/gi,
    (_match, byte) => String.fromCharCode(Number.parseInt(byte, 16)));
  if (compiledPath.replaceAll("\\", "/").split("/").includes("_pair-compiled")) {
    return withSecurityHeaderBaseline(new Response(null, { status: 404 }));
  }
  const post = await deps.noBuildPosts?.fetch(request);
  if (post) return post;
  if (isContactAstroAsset(url.pathname)) {
    return withSecurityHeaderBaseline(
      await deps.fetchAsset(contactAstroAssetRequest(request)),
    );
  }
  if (url.pathname === PUBLICATION_PROBE_PATH) {
    const asset = await deps.fetchAsset(
      request.method === "GET" ? publicationReceiptRequest(request) : request,
    );
    return request.method === "GET"
      ? publicationProbeResponse(asset)
      : withSecurityHeaderBaseline(asset);
  }
  const isContact = isContactPage(url.pathname);
  const isContactPath = isContactWorkerPath(url.pathname);
  const canTransform = request.method === "GET" && isContact;
  const asset = await deps.fetchAsset(
    canTransform ? unconditionalAssetRequest(request) : request,
  );
  if (
    !canTransform ||
    asset.status !== 200 ||
    !asset.headers.get("content-type")?.startsWith("text/html")
  ) {
    const response = isContactPath ? withSecurityHeaderBaseline(asset) : asset;
    return isContact ? withContactReceiptCors(response) : response;
  }
  try {
    const projection = await getContactProjection(deps);
    // A renamed Contact page is served by the active static artifact, including its old URL redirect.
    if (projection.state === "live" && projection.page.path !== "/contact/") {
      return withContactReceiptCors(withSecurityHeaderBaseline(asset));
    }
    const response = projection.state === "live"
      ? transformedContact(asset, projection.page, {
          kind: "cms",
          sourceVersion: projection.page.sourceVersion,
        })
      : transformedContact(asset, committedContactPage(), { kind: "fallback" });
    return withContactReceiptCors(withSecurityHeaderBaseline(response));
  } catch {
    return withContactReceiptCors(
      withSecurityHeaderBaseline(
        transformedContact(asset, committedContactPage(), { kind: "fallback" }),
      ),
    );
  }
}

export default {
  fetch(
    request: Request,
    env: PublicWorkerEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    return servePublicRequest(request, {
      fetchAsset: (assetRequest) => env.ASSETS.fetch(assetRequest),
      getPublishedPage: (pageId) => env.CMS_API.getPublishedPage(pageId),
      projectionCache: caches.default,
      waitUntil: (task) => ctx.waitUntil(task),
    });
  },
} satisfies ExportedHandler<PublicWorkerEnv>;

