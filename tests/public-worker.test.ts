import { describe, expect, it, vi } from "vitest";

import headersFile from "../site/public/_headers?raw";
import previewWorkerSource from "../workers/src/preview-worker.ts?raw";
import legacyHeadersSource from "../site/snippets/legacy-redirects/snippet.js?raw";
import adminFrameSource from "../admin/src/components/HomePreviewFrame.tsx?raw";
import {
  SECURITY_HEADER_BASELINE,
  servePublicRequest,
} from "../workers/src/public-worker";
import type { NoBuildPageReply, PublicPageProjection } from "../cms-api/src/index";
import { pendingAuthorResponse } from "../workers/src/public-author-pending";

const EXPECTED_SECURITY_HEADERS = {
  "content-security-policy-report-only":
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'sha256-eXKMS8gR/WCZpNe9ah+6h86pPn7rAz4PSKuJbosPg+s=' https://jaws-prod.cdn.pbs.org https://public.flourish.studio https://challenges.cloudflare.com https://www.googletagmanager.com https://chimpstatic.com https://cdn.wisepops.com https://app.getwisp.co https://wisepops.net https://cdn.wisepops.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://public.flourish.studio https://image.pbs.org https://media.njpbs.org https://*.google-analytics.com https://www.googletagmanager.com https://cdn.wisepops.com https://tracking.wisepops.com https://dx4nr741tfc02.cloudfront.net https://wisp-production-storage.s3.amazonaws.com https://cdn.wisepops.net https://assets.wisepops.net; media-src 'self' https://media.njpbs.org; font-src 'self' https://media.njpbs.org; frame-src https://flo.uri.sh https://datawrapper.dwcdn.net https://interactives.apelections.org https://player.pbs.org https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com https://www.tiktok.com https://www.instagram.com https://www.facebook.com https://challenges.cloudflare.com https://notifications.wisepops.com https://wisepops.net; worker-src 'self'; connect-src 'self' https://huggingface.co https://us.aws.cdn.hf.co https://challenges.cloudflare.com https://report.njpbs.org https://intake.njpbs.org https://uploads.example.org https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com https://activity.wisepops.com https://tracking.wisepops.com https://app.getwisp.co https://wisepops.net; frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'",
  "permissions-policy":
    'geolocation=(self "https://player.pbs.org"), encrypted-media=(self "https://player.pbs.org" "https://www.youtube-nocookie.com" "https://www.youtube.com" "https://player.vimeo.com" "https://www.facebook.com"), camera=(), microphone=(), payment=(), usb=()',
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
} as const;

describe("pending author page", () => {
  const rendererSha = "a".repeat(40);
  const shell = '<!doctype html><html><head><title>Page not found</title><meta name="robots" content="noindex"><link rel="canonical" href="https://njpbs.org/404/"><script type="application/ld+json">{"name":"Old 404"}</script></head><body><header class="site-head">NJ PBS navigation</header><main id="main" data-pagefind-body><h1>Page not found</h1></main><footer class="site-foot">NJ PBS footer</footer></body></html>';
  const staff = (slugs = ["new-reporter"]): NoBuildPageReply => ({ kind: "context-page",
    contextReceipt: { rendererSha, contextRevision: 1, contextDigest: "b".repeat(64), codeGeneration: 1, path: "/staff/", source: "site" },
    renderContext: { pageId: "staff", authors: slugs.map(slug => ({ slug })) } });
  const missing = () => new Response(shell, { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });

  it.each(["GET", "HEAD"])("shows the normal shell with retryable publication status for a roster slug (%s)", async method => {
    const readStaff = vi.fn(async () => staff());
    const fetchAsset = vi.fn(async (request: Request) => {
      expect(new URL(request.url).pathname).toBe("/404/");
      expect(request.method).toBe("GET");
      return missing();
    });
    const result = await pendingAuthorResponse(new Request("https://njpbs.org/authors/new-reporter/", { method }),
      method === "HEAD" ? new Response(null, { status: 404 }) : missing(), { rendererSha, readStaff, fetchAsset });
    expect(result.status).toBe(503);
    expect(result.headers.get("retry-after")).toBe("120");
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("x-robots-tag")).toContain("noindex");
    expect(readStaff).toHaveBeenCalledExactlyOnceWith("/staff/");
    const html = await result.text();
    if (method === "HEAD") { expect(html).toBe(""); expect(fetchAsset).toHaveBeenCalledOnce(); }
    else {
      expect(fetchAsset).not.toHaveBeenCalled();
      expect(html).toContain("This profile is being published.");
      expect(html).toContain("Check back in a few minutes.");
      expect(html).toContain('class="site-head"');
      expect(html).toContain('class="site-foot"');
      expect(html).toContain('href="https://njpbs.org/authors/new-reporter/"');
      expect(html).not.toContain("Page not found");
      expect(html).not.toContain("application/ld+json");
    }
  });

  it("uses the deployed 404 shell when the background author miss has no HTML", async () => {
    const fetchAsset = vi.fn(async (_request: Request) => missing());
    const result = await pendingAuthorResponse(new Request("https://njpbs.org/authors/new-reporter/"),
      new Response(null, { status: 404 }), { rendererSha, readStaff: async () => staff(), fetchAsset });
    expect(result.status).toBe(503);
    expect(new URL(fetchAsset.mock.calls[0][0].url).pathname).toBe("/404/");
    expect(await result.text()).toContain("NJ PBS navigation");
  });

  it("preserves the normal 404 for an unknown slug absent from the roster", async () => {
    const original = missing();
    expect(await pendingAuthorResponse(new Request("https://njpbs.org/authors/new-reporter/"), original,
      { rendererSha, readStaff: async () => staff([]), fetchAsset: async () => { throw new Error("No shell read"); } })).toBe(original);
    expect(await original.text()).toContain("Page not found");
  });

  it("returns to the normal 404 when a profile is withdrawn from the current roster", async () => {
    let slugs = ["new-reporter"];
    const deps = { rendererSha, readStaff: async () => staff(slugs), fetchAsset: async () => missing() };
    const request = new Request("https://njpbs.org/authors/new-reporter/");
    expect((await pendingAuthorResponse(request, missing(), deps)).status).toBe(503);
    slugs = [];
    const original = missing();
    expect(await pendingAuthorResponse(request, original, deps)).toBe(original);
    expect(original.status).toBe(404);
  });

  it.each(["built profile", "edited bio or photo", "Staff roster"])("adds no reads or response changes for %s", async label => {
    const readStaff = vi.fn(async () => { throw new Error("No Staff read on a 200"); });
    const original = new Response("Already published page", { status: 200 });
    const path = label === "Staff roster" ? "/staff/" : "/authors/new-reporter/";
    expect(await pendingAuthorResponse(new Request(`https://njpbs.org${path}`), original,
      { rendererSha, readStaff, fetchAsset: async () => { throw new Error("No Assets read"); } })).toBe(original);
    expect(readStaff).not.toHaveBeenCalled();
    expect(await original.text()).toBe("Already published page");
  });

  it("uses the current Staff projection after a Page alias", async () => {
    const readStaff = vi.fn(async (path: string): Promise<NoBuildPageReply> => path === "/staff/"
      ? { kind: "redirect", location: "/our-people/" } : staff());
    const result = await pendingAuthorResponse(new Request("https://njpbs.org/authors/new-reporter/"), missing(),
      { rendererSha, readStaff, fetchAsset: async () => missing() });
    expect(result.status).toBe(503);
    expect(readStaff.mock.calls.map(call => call[0])).toEqual(["/staff/", "/our-people/"]);
  });

  it("recognizes a profile in an owned published Staff Page", async () => {
    const reply: NoBuildPageReply = { kind: "page", receipt: {
      schemaVersion: 1, pageId: "staff", operationId: "A".repeat(20), rendererSha,
      sourceVersion: 1, snapshotDigest: "b".repeat(64), path: "/staff/", ownedPaths: ["/staff/"],
      generation: 1, codeGeneration: 1, visible: true, contextDigest: "c".repeat(64), admissionRevision: 1,
    }, published: { authors: [{ slug: "new-reporter" }] } };
    const result = await pendingAuthorResponse(new Request("https://njpbs.org/authors/new-reporter/"), missing(),
      { rendererSha, readStaff: async () => reply, fetchAsset: async () => missing() });
    expect(result.status).toBe(503);
  });

  it.each(["unavailable", "pass", "wrong renderer", "wrong page"])("keeps the 404 when Staff authority is %s", async mode => {
    const readStaff = async (): Promise<NoBuildPageReply> => {
      if (mode === "unavailable") throw new Error("Staff unavailable");
      if (mode === "pass") return { kind: "pass" };
      const reply = staff();
      if (mode === "wrong renderer") reply.contextReceipt!.rendererSha = "c".repeat(40);
      if (mode === "wrong page") reply.renderContext = { pageId: "contact", authors: [{ slug: "new-reporter" }] };
      return reply;
    };
    const original = missing();
    expect(await pendingAuthorResponse(new Request("https://njpbs.org/authors/new-reporter/"), original,
      { rendererSha, readStaff, fetchAsset: async () => missing() })).toBe(original);
  });
});

function parsedAssetSecurityHeaders(): Record<string, string> {
  return Object.fromEntries(
    Array.from(
      headersFile.slice(headersFile.indexOf("\n/*\n")).matchAll(/^\s{2}([A-Za-z][A-Za-z0-9-]*):\s*(.+)$/gm),
      (match) => [match[1].toLowerCase(), match[2]],
    ),
  );
}

function expectSecurityHeaders(response: Response): void {
  expect(
    Object.fromEntries(
      Object.keys(EXPECTED_SECURITY_HEADERS).map((name) => [
        name,
        response.headers.get(name),
      ]),
    ),
  ).toEqual(EXPECTED_SECURITY_HEADERS);
}

function expectContactReceiptHeaders(response: Response): void {
  expect(response.headers.get("access-control-allow-origin")).toBe(
    "https://admin.njpbs.org",
  );
  expect(response.headers.get("access-control-expose-headers")).toBe(
    "x-njpbs-content-source, x-njpbs-source-version",
  );
  expect(response.headers.get("vary")).toMatch(/(?:^|,\s*)Origin(?:,|$)/);
}

function expectContactBoundaryHeaders(response: Response): void {
  expectSecurityHeaders(response);
  expectContactReceiptHeaders(response);
}

const STATIC_CONTACT = `<!doctype html><html><head>
  <title>Static Contact — NJ PBS</title>
  <link rel="stylesheet" href="/_astro/contact.css">
  <script src="/_astro/contact.js"></script>
  <meta name="description" content="Static description">
  <meta name="robots" content="noindex, nofollow">
  <meta property="og:title" content="Static Contact — NJ PBS">
  <meta property="og:description" content="Static description">
  <meta property="og:image" content="https://njpbs.org/static-social.webp">
  <meta name="twitter:title" content="Static Contact — NJ PBS">
  <meta name="twitter:description" content="Static description">
  <meta name="twitter:image" content="https://njpbs.org/static-social.webp">
</head><body><img src="/brand/contact.jpg" srcset="/_astro/contact-small.webp 640w, /_astro/contact-large.webp 1280w"><article data-cms-runtime-page="contact">
  <h1 data-cms-runtime-title="contact">Static Contact</h1>
  <span data-cms-runtime-description="contact">Static description</span>
  <div data-cms-runtime-body="contact"><p>Static body</p></div>
</article></body></html>`;

const STALE_CMS_CONTACT = `<!doctype html><html><head>
  <title>Withdrawn CMS title — NJ PBS</title>
  <meta name="description" content="Withdrawn CMS description">
  <meta property="og:title" content="Withdrawn CMS title — NJ PBS">
  <meta property="og:description" content="Withdrawn CMS description">
  <meta property="og:image" content="https://njpbs.org/brand/withdrawn.webp">
  <meta name="twitter:title" content="Withdrawn CMS title — NJ PBS">
  <meta name="twitter:description" content="Withdrawn CMS description">
  <meta name="twitter:image" content="https://njpbs.org/brand/withdrawn.webp">
  <script type="application/ld+json">{"name":"Withdrawn CMS title"}</script>
</head><body><article data-cms-runtime-page="contact">
  <h1 data-cms-runtime-title="contact">Withdrawn CMS title</h1>
  <span data-cms-runtime-description="contact">Withdrawn CMS description</span>
  <div data-cms-runtime-body="contact"><p>Withdrawn CMS private detail</p></div>
</article></body></html>`;

function asset(body = STATIC_CONTACT) {
  return new Response(body, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

const LIVE_PAGE: Extract<PublicPageProjection, { state: "live" }>["page"] = {
  pageId: "contact",
  path: "/contact/",
  family: "article",
  template: "genericPage",
  title: "Contact <New Jersey>",
  description: "Published contact description",
  noindex: false,
  seo: { title: "Contact search", description: "Search description" },
  social: {
    title: "Contact social",
    description: "Social description",
    imageAssetId: "contact-social",
  },
  blocks: [
    {
      id: "headline-1",
      type: "headline",
      order: 1,
      visible: true,
      data: { text: "Help <script>alert(1)</script>", level: 2 },
    },
    {
      id: "embed-1",
      type: "embed",
      order: 2,
      visible: true,
      data: { url: "https://www.pbs.org/", caption: "PBS contact help" },
    },
  ],
  assets: {
    "contact-social": {
      url: "https://njpbs.org/brand/contact-social.webp",
      mimeType: "image/webp",
      width: 1200,
      height: 630,
    },
  },
  contentMode: "published",
  sourceVersion: 7,
  publishedAt: "2026-08-25T12:00:00.000Z",
};

const LIVE = {
  apiVersion: 1,
  state: "live",
  page: LIVE_PAGE,
} satisfies PublicPageProjection;

const WITHDRAWN = {
  apiVersion: 1,
  state: "withdrawn",
  pageId: "contact",
} satisfies PublicPageProjection;

async function expectCommittedFallback(response: Response): Promise<void> {
  const html = await response.text();
  expect(html).toContain("Contact NJ PBS");
  expect(html).toContain("Email NJ PBS");
  expect(html).toContain("Call 800-882-6622");
  expect(html).not.toContain("Withdrawn CMS");
  expect(html).not.toContain("Withdrawn CMS private detail");
  expect(html).not.toContain('type="application/ld+json"');
  expect(html.match(/name="robots"/g)).toHaveLength(1);
  expect(response.headers.get("cache-control")).toBe("no-cache");
  expect(response.headers.get("x-njpbs-content-source")).toBe(
    "committed-fallback",
  );
  expect(response.headers.has("x-njpbs-source-version")).toBe(false);
  expectContactBoundaryHeaders(response);
}

describe("public Contact runtime projection", () => {
  it.each([true, false])("rechecks childDirected=%s against an older eligible Contact shell", async childDirected => {
    const analytics = '<script id="mcjs">mailchimp-tracking</script><script id="wisepopsjs">wisepops-loader</script><script id="analytics-consent-default">ga-consent</script><aside data-analytics-consent data-activecampaign-enabled>Privacy choice</aside>';
    const response = await servePublicRequest(new Request("https://njpbs.org/contact/"), {
      fetchAsset: async () => asset(STATIC_CONTACT.replace("</head>", `${analytics}</head>`)),
      getPublishedPage: async () => ({ ...LIVE, page: { ...LIVE_PAGE, childDirected } }),
    });
    const html = await response.text();
    for (const marker of ["mailchimp-tracking", "wisepops-loader", "ga-consent", "data-analytics-consent", "data-activecampaign-enabled"]) {
      expect(html.includes(marker)).toBe(!childDirected);
    }
    expectContactBoundaryHeaders(response);
  });
  it("removes vendor eligibility from an older shell when Contact becomes noindex", async () => {
    const response = await servePublicRequest(new Request("https://njpbs.org/contact/"), {
      fetchAsset: async () => asset(STATIC_CONTACT.replace("</head>", '<script id="mcjs">mailchimp-tracking</script><script id="wisepopsjs">wisepops-loader</script><aside data-analytics-consent data-activecampaign-enabled>Privacy choice</aside></head>')),
      getPublishedPage: async () => ({ ...LIVE, page: { ...LIVE_PAGE, noindex: true } }),
    });
    const html = await response.text();
    expect(html).toContain("data-analytics-consent");
    expect(html).not.toContain("data-activecampaign-enabled");
    expect(html).not.toContain("mailchimp-tracking");
    expect(html).not.toContain("wisepops-loader");
  });
  it.each([
    ["https://youtu.be/od8NMua_mEw", "www.youtube-nocookie.com"],
    ["https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv/live", "www.youtube.com"],
    ["https://vimeo.com/76979871", "player.vimeo.com"],
    ["https://www.tiktok.com/@scout2015/video/6718335390845095173", "www.tiktok.com"],
    ["https://www.tiktok.com/player/v1/6718335390845095173", "www.tiktok.com"],
    ["https://www.instagram.com/reel/CxYz_123Ab-/", "www.instagram.com"],
    ["https://www.facebook.com/watch/?v=10153231379946729", "www.facebook.com"],
    ["https://www.facebook.com/reel/2038437459890192/", "www.facebook.com"],
    ["https://player.pbs.org/partnerplayer/3000000000/", "player.pbs.org"],
  ])("omits analytics when published content contains a %s player", async (url, host) => {
    const analytics = '<script id="mcjs">mailchimp-tracking</script><script id="wisepopsjs">wisepops-loader</script><script id="analytics-consent-default">ga-consent</script><div data-analytics-consent>Analytics choice</div>';
    const response = await servePublicRequest(new Request("https://njpbs.org/contact/"), {
      fetchAsset: async () => asset(STATIC_CONTACT.replace("</head>", `${analytics}</head>`)),
      getPublishedPage: async () => ({ ...LIVE, page: { ...LIVE_PAGE, blocks: [
        { id: "video", type: "embed", order: 0, visible: true, data: { url } },
      ] } }),
    });
    const html = await response.text();
    expect(html).toContain(`src="https://${host}/`);
    expect(html).not.toContain("mailchimp-tracking");
    expect(html).not.toContain("wisepops-loader");
    expect(html).not.toContain("ga-consent");
    expect(html).not.toContain("data-analytics-consent");
    expectContactBoundaryHeaders(response);
  });

  it("allows every player frame in the public, private preview, legacy and admin policies", () => {
    const hosts = ["player.pbs.org", "www.youtube-nocookie.com", "www.youtube.com", "player.vimeo.com", "www.tiktok.com", "www.instagram.com", "www.facebook.com"];
    for (const source of [headersFile, EXPECTED_SECURITY_HEADERS["content-security-policy-report-only"], previewWorkerSource, legacyHeadersSource, adminFrameSource]) {
      const frames = /frame-src ([^;]+)/.exec(source)?.[1].split(/\s+/);
      for (const host of hosts) expect(frames).toContain(`https://${host}`);
    }
    for (const host of ["player.pbs.org", "www.youtube-nocookie.com", "www.youtube.com", "player.vimeo.com", "www.facebook.com"]) {
      expect(EXPECTED_SECURITY_HEADERS["permissions-policy"]).toContain(`"https://${host}"`);
      expect(legacyHeadersSource).toContain(`"https://${host}"`);
    }
  });

  it("coalesces concurrent projection lookups and caches them across query strings", async () => {
    const entries = new Map<string, Response>();
    const projectionCache = {
      match: vi.fn(async (request: Request) => entries.get(request.url)?.clone()),
      put: vi.fn(async (request: Request, response: Response) => {
        entries.set(request.url, response.clone());
      }),
    };
    let resolveProjection!: (projection: PublicPageProjection) => void;
    const getPublishedPage = vi.fn(
      () => new Promise<PublicPageProjection>((resolve) => {
        resolveProjection = resolve;
      }),
    );
    const dependencies = {
      fetchAsset: vi.fn(async () => asset()),
      getPublishedPage,
      projectionCache,
      now: () => 1_000,
    };

    const firstRequests = Array.from({ length: 20 }, (_, index) =>
      servePublicRequest(
        new Request(`https://njpbs.org/contact/?nonce=${index}`),
        dependencies,
      ));
    await vi.waitFor(() => expect(getPublishedPage).toHaveBeenCalledTimes(1));
    resolveProjection(LIVE);
    await Promise.all(firstRequests);

    const cached = await servePublicRequest(
      new Request("https://njpbs.org/contact/?another-nonce=21"),
      { ...dependencies, now: () => 30_000 },
    );

    expect(getPublishedPage).toHaveBeenCalledTimes(1);
    expect(projectionCache.put).toHaveBeenCalledTimes(1);
    expect(projectionCache.put.mock.calls[0]?.[0].url).toBe(
      "https://cms-runtime-cache.invalid/v1/contact",
    );
    expect(cached.headers.get("x-njpbs-source-version")).toBe("7");
  });

  it("keeps a timed-out lookup coalesced until the backend operation settles", async () => {
    const projectionCache = {
      match: vi.fn(async () => undefined),
      put: vi.fn(async () => undefined),
    };
    let resolveProjection!: (projection: PublicPageProjection) => void;
    const getPublishedPage = vi.fn(
      () => new Promise<PublicPageProjection>((resolve) => {
        resolveProjection = resolve;
      }),
    );
    const dependencies = {
      fetchAsset: vi.fn(async () => asset()),
      getPublishedPage,
      projectionCache,
      lookupTimeoutMs: 5,
    };

    await servePublicRequest(
      new Request("https://njpbs.org/contact/?first=1"),
      dependencies,
    );
    const second = servePublicRequest(
      new Request("https://njpbs.org/contact/?second=1"),
      { ...dependencies, lookupTimeoutMs: 100 },
    );
    expect(getPublishedPage).toHaveBeenCalledTimes(1);
    resolveProjection(LIVE);

    expect((await second).headers.get("x-njpbs-source-version")).toBe("7");
    expect(getPublishedPage).toHaveBeenCalledTimes(1);
  });

  it("uses a bounded stale projection when refresh fails", async () => {
    const entries = new Map<string, Response>();
    const projectionCache = {
      match: vi.fn(async (request: Request) => entries.get(request.url)?.clone()),
      put: vi.fn(async (request: Request, response: Response) => {
        entries.set(request.url, response.clone());
      }),
    };
    const getPublishedPage = vi.fn(async () => LIVE);
    const dependencies = {
      fetchAsset: vi.fn(async () => asset()),
      getPublishedPage,
      projectionCache,
      now: () => 1_000,
    };
    await servePublicRequest(
      new Request("https://njpbs.org/contact/?warm=1"),
      dependencies,
    );
    getPublishedPage.mockRejectedValueOnce(new Error("unavailable"));

    const stale = await servePublicRequest(
      new Request("https://njpbs.org/contact/?refresh=1"),
      { ...dependencies, now: () => 62_000 },
    );

    expect(getPublishedPage).toHaveBeenCalledTimes(2);
    expect(stale.headers.get("x-njpbs-source-version")).toBe("7");

    const backedOff = await servePublicRequest(
      new Request("https://njpbs.org/contact/?backoff=1"),
      { ...dependencies, now: () => 70_000 },
    );
    expect(getPublishedPage).toHaveBeenCalledTimes(2);
    expect(backedOff.headers.get("x-njpbs-source-version")).toBe("7");

    getPublishedPage.mockRejectedValueOnce(new Error("still unavailable"));
    const expired = await servePublicRequest(
      new Request("https://njpbs.org/contact/?expired=1"),
      { ...dependencies, now: () => 302_000 },
    );

    expect(getPublishedPage).toHaveBeenCalledTimes(3);
    expect(expired.headers.get("x-njpbs-content-source")).toBe(
      "committed-fallback",
    );
  });

  it("uses the CMS projection when the edge cache is unavailable", async () => {
    const getPublishedPage = vi.fn(async () => LIVE);
    const response = await servePublicRequest(
      new Request("https://njpbs.org/contact/"),
      {
        fetchAsset: vi.fn(async () => asset()),
        getPublishedPage,
        projectionCache: {
          match: vi.fn(async () => {
            throw new Error("cache unavailable");
          }),
          put: vi.fn(async () => undefined),
        },
      },
    );

    expect(getPublishedPage).toHaveBeenCalledTimes(1);
    expect(response.headers.get("x-njpbs-source-version")).toBe("7");
  });

  it("renders the published hero background and removes it after withdrawal", async () => {
    const slot = '<div class="cms-hero-background" data-cms-runtime-hero="contact" aria-hidden="true"></div>';
    const source = STATIC_CONTACT.replace('<h1 data-cms-runtime-title', `${slot}<h1 data-cms-runtime-title`);
    const response = await servePublicRequest(new Request("https://njpbs.org/contact/"), {
      fetchAsset: async () => asset(source),
      getPublishedPage: async () => ({ ...LIVE, page: { ...LIVE_PAGE,
        heroBackgroundImage: "contact-social", heroBackgroundPosition: "top" } }),
    });
    const html = await response.text();
    expect(html).toContain('class="cms-hero-background__image"');
    expect(html).toContain('object-position: top;');
    expect(html).toContain('alt=""');
    const withdrawn = await servePublicRequest(new Request("https://njpbs.org/contact/"), {
      fetchAsset: async () => asset(html), getPublishedPage: async () => WITHDRAWN,
    });
    expect(await withdrawn.text()).not.toContain('class="cms-hero-background__image"');
  });

  it("preserves the built redirect when Contact has a new public URL", async () => {
    const redirect = '<html><head><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0;url=/contact-us/"></head><body>Page moved</body></html>';
    const response = await servePublicRequest(new Request("https://njpbs.org/contact/"), {
      fetchAsset: async () => asset(redirect),
      getPublishedPage: async () => ({ ...LIVE, page: { ...LIVE_PAGE, path: "/contact-us/" } }),
    });
    expect(await response.text()).toBe(redirect);
    expect(response.headers.has("x-njpbs-source-version")).toBe(false);
    expectSecurityHeaders(response);
  });

  it("renders row children in their columns through the existing Contact boundary", async () => {
    const page = {
      ...LIVE_PAGE,
      blocks: [
        { id: "row", type: "row" as const, order: 0, visible: true, data: { columns: [4, 8] } },
        ...LIVE_PAGE.blocks.map((block, index) => ({ ...block, order: index + 1, layout: { rowId: "row", column: index } })),
      ],
    };
    const response = await servePublicRequest(new Request("https://njpbs.org/contact/"), {
      fetchAsset: async () => new Response(STATIC_CONTACT, { headers: { "content-type": "text/html" } }),
      getPublishedPage: async () => ({ ...LIVE, page }),
    });
    expectContactBoundaryHeaders(response);
    expect(response.headers.get("x-njpbs-source-version")).toBe("7");
    const html = await response.text();
    expect(html.match(/class="cms-row__column"/g)).toHaveLength(2);
    expect(html.match(/data-block-id=/g)).toHaveLength(3);
    expect(html).toContain("--cms-columns: minmax(0, 4fr) minmax(0, 8fr)");
    expect(html).toContain("Help &lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("never plays a video on the runtime Contact page, whose shell can load analytics (#2751)", async () => {
    const page = {
      ...LIVE_PAGE,
      blocks: [
        ...LIVE_PAGE.blocks,
        {
          id: "clip",
          type: "video" as const,
          order: LIVE_PAGE.blocks.length,
          visible: true,
          data: {
            sourceId: "video-library" as const,
            assetId: "asset-1",
            title: "Clip",
            public: {
              url: `https://media.njpbs.org/cms-media/video/asset-1/${"a".repeat(64)}.mp4`,
              posterUrl: `https://media.njpbs.org/cms-media/video/asset-1/${"b".repeat(64)}.jpg`,
              width: 1920,
              height: 1080,
              mimeType: "video/mp4" as const,
            },
          },
        },
      ],
    };
    const response = await servePublicRequest(new Request("https://njpbs.org/contact/"), {
      fetchAsset: async () => new Response(STATIC_CONTACT, { headers: { "content-type": "text/html" } }),
      getPublishedPage: async () => ({ ...LIVE, page }),
    });
    const html = await response.text();
    expect(html).not.toMatch(/<video/);
    expect(html).not.toContain("cms-video");
    expect(html.match(/data-block-id=/g)).toHaveLength(LIVE_PAGE.blocks.length);
  });

  it("keeps the Worker and static asset security baselines in exact parity", () => {
    expect(SECURITY_HEADER_BASELINE).toEqual(EXPECTED_SECURITY_HEADERS);
    expect(parsedAssetSecurityHeaders()).toEqual(EXPECTED_SECURITY_HEADERS);
  });

  it("keeps public HTML and response headers identical with a forged staff hint (#3145)", async () => {
    const deps = { fetchAsset: async () => asset(), getPublishedPage: async () => LIVE };
    const reader = await servePublicRequest(new Request("https://njpbs.org/contact/"), deps);
    const hinted = await servePublicRequest(new Request("https://njpbs.org/contact/", {
      headers: { Cookie: "bw_staff=1; bw_staff_dev=1" },
    }), deps);
    expect(await hinted.text()).toBe(await reader.text());
    expect([...hinted.headers]).toEqual([...reader.headers]);
  });

  it("serves the active immutable publication receipt at the root probe", async () => {
    const getPublishedPage = vi.fn(async () => LIVE);
    const fetchAsset = vi.fn(async () => new Response(
      '{"schemaVersion":1,"buildBatchId":"build-one"}\n',
      {
        headers: {
          "content-type": "application/json; charset=utf-8",
          etag: '"publication"',
          "last-modified": "Thu, 27 Aug 2026 20:00:00 GMT",
        },
      },
    ));
    const response = await servePublicRequest(
      new Request(
        "https://njpbs.org/_publication.json?candidate=build-one",
        {
          headers: {
            "if-none-match": '"publication"',
            "if-modified-since": "Thu, 27 Aug 2026 20:00:00 GMT",
          },
        },
      ),
      { fetchAsset, getPublishedPage },
    );

    expect(await response.text()).toBe(
      '{"schemaVersion":1,"buildBatchId":"build-one"}\n',
    );
    expect(fetchAsset).toHaveBeenCalledTimes(1);
    const assetRequest = fetchAsset.mock.calls[0]?.[0];
    expect(new URL(assetRequest.url).pathname).toBe("/_publication.json");
    expect(new URL(assetRequest.url).search).toBe("");
    expect(assetRequest.headers.get("if-none-match")).toBeNull();
    expect(assetRequest.headers.get("if-modified-since")).toBeNull();
    expect(getPublishedPage).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-njpbs-publication-origin"))
      .toBe("njpbs-production");
    expect(response.headers.has("etag")).toBe(false);
    expect(response.headers.has("last-modified")).toBe(false);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://admin.njpbs.org");
    expectSecurityHeaders(response);
  });

  it("does not expose the publication probe through another method", async () => {
    const request = new Request(
      "https://njpbs.org/_publication.json",
      { method: "POST" },
    );
    const fetchAsset = vi.fn(async () => new Response("Method not allowed", {
      status: 405,
    }));
    const getPublishedPage = vi.fn(async () => LIVE);

    const response = await servePublicRequest(request, {
      fetchAsset,
      getPublishedPage,
    });

    expect(response.status).toBe(405);
    expect(fetchAsset).toHaveBeenCalledWith(request);
    expect(getPublishedPage).not.toHaveBeenCalled();
    expectSecurityHeaders(response);
  });

  it("injects one escaped live projection and its exact source headers", async () => {
    const getPublishedPage = vi.fn(async () => LIVE);
    const fetchAsset = vi.fn(async (_request: Request) =>
      new Response(STATIC_CONTACT, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          etag: '"static-contact"',
          "last-modified": "Tue, 25 Aug 2026 12:00:00 GMT",
        },
      }));
    const response = await servePublicRequest(
      new Request("https://njpbs.org/contact/?cms-receipt=receipt-0", {
        headers: {
          origin: "https://admin.njpbs.org",
          "if-none-match": '"static-contact"',
          "if-modified-since": "Tue, 25 Aug 2026 12:00:00 GMT",
          range: "bytes=0-20",
          "if-range": '"static-contact"',
        },
      }),
      { fetchAsset, getPublishedPage },
    );
    const html = await response.text();

    expect(getPublishedPage).toHaveBeenCalledWith("contact");
    expect(html).toContain("Contact &lt;New Jersey&gt;");
    expect(html).toContain("Help &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain(
      '<div class="embed"><a href="https://www.pbs.org/">PBS contact help</a></div>',
    );
    expect(html).not.toContain("Static body");
    expect(html).toContain(
      '<div class="cms-page__blocks cms-page__blocks--within-frame">',
    );
    expect(html).toContain("<title>Contact search — NJ PBS</title>");
    expect(html).toContain('content="Search description"');
    expect(html).toContain(
      'property="og:image" content="https://njpbs.org/brand/contact-social.webp"',
    );
    expect(html).toContain(
      'name="twitter:image" content="https://njpbs.org/brand/contact-social.webp"',
    );
    expect(html).toContain('href="/contact/_astro/contact.css"');
    expect(html).toContain('src="/contact/_astro/contact.js"');
    expect(html).toContain(
      'srcset="/contact/_astro/contact-small.webp 640w, /contact/_astro/contact-large.webp 1280w"',
    );
    expect(html).toContain('src="/brand/contact.jpg"');
    expect(html).not.toContain('name="robots"');
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("x-njpbs-content-source")).toBe("cms-runtime");
    expect(response.headers.get("x-njpbs-source-version")).toBe("7");
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://admin.njpbs.org",
    );
    expect(response.headers.get("access-control-expose-headers")).toBe(
      "x-njpbs-content-source, x-njpbs-source-version",
    );
    expect(response.headers.get("vary")).toContain("Origin");
    expect(response.headers.has("access-control-allow-credentials")).toBe(false);
    expectContactBoundaryHeaders(response);
    expect([
      fetchAsset.mock.calls[0]?.[0].headers.get("if-none-match"),
      fetchAsset.mock.calls[0]?.[0].headers.get("if-modified-since"),
      fetchAsset.mock.calls[0]?.[0].headers.get("range"),
      fetchAsset.mock.calls[0]?.[0].headers.get("if-range"),
      response.headers.get("etag"),
      response.headers.get("last-modified"),
    ]).toEqual([null, null, null, null, null, null]);
  });

  it("renders three consecutive link cards through the shared directory contract", async () => {
    const projection = {
      ...LIVE,
      page: {
        ...LIVE.page,
        blocks: [
          {
            id: "headline-before-cards",
            type: "headline",
            order: 0,
            visible: true,
            data: { text: "Coverage", level: 2 },
          },
          {
            id: "card-one",
            type: "link_card",
            order: 1,
            visible: true,
            data: {
              title: "First <story>",
              url: "https://example.com/first",
              source: "Outlet <one>",
              date: "2026-09-17",
              summary: "Summary & details",
            },
          },
          {
            id: "card-two",
            type: "link_card",
            order: 2,
            visible: true,
            data: {
              title: "Second story",
              url: "https://example.com/second",
              source: "Outlet two",
              date: "2026-09-16",
            },
          },
          {
            id: "card-three",
            type: "link_card",
            order: 3,
            visible: true,
            data: {
              title: "Third story",
              url: "javascript:alert(1)",
              source: "Outlet three",
              date: "2025-09-23",
            },
          },
        ],
      },
    } satisfies PublicPageProjection;
    const response = await servePublicRequest(
      new Request("https://njpbs.org/contact/"),
      {
        fetchAsset: vi.fn(async () => asset()),
        getPublishedPage: vi.fn(async () => projection),
      },
    );
    const html = await response.text();

    expect(html.match(/class="link-card-directory coverage-list"/g)).toHaveLength(1);
    expect(html.match(/ data-coverage-entry /g)).toHaveLength(3);
    expect(html).toContain('data-coverage-noun="articles"');
    expect(html).toContain('data-coverage-year="2026"');
    expect(html).toContain('data-coverage-year="2025"');
    expect(html).toContain("<h3>2026</h3>");
    expect(html).toContain('<h4 class="link-card__title">First &lt;story&gt;</h4>');
    expect(html).toContain("First &lt;story&gt;");
    expect(html).toContain("Outlet &lt;one&gt;");
    expect(html).toContain("Summary &amp; details");
    expect(html).not.toContain("javascript:alert(1)");
    expect(html).toContain('<div class="link-card__link"><span class="link-card__source">Outlet three</span>');
    expect(html).not.toContain("cms-block--link_card");
  });

  it("adds one canonical robots tag and restores the default social image", async () => {
    const projection = {
      ...LIVE,
      page: {
        ...LIVE.page,
        noindex: true,
        social: {
          title: "Contact social",
          description: "Social description",
        },
      },
    } satisfies PublicPageProjection;
    const staticWithoutRobots = STATIC_CONTACT.replace(
      '  <meta name="robots" content="noindex, nofollow">\n',
      "",
    );
    const response = await servePublicRequest(
      new Request("https://njpbs.org/contact/"),
      {
        fetchAsset: vi.fn(async () => asset(staticWithoutRobots)),
        getPublishedPage: vi.fn(async () => projection),
      },
    );
    const html = await response.text();

    expect(html.match(/name="robots"/g)).toHaveLength(1);
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain(
      'property="og:image" content="https://njpbs.org/og-default.png"',
    );
    expect(html).toContain(
      'name="twitter:image" content="https://njpbs.org/og-default.png"',
    );
    expectContactBoundaryHeaders(response);
  });

  it.each(["unpublish", "archive"])(
    "replaces a stale CMS asset with the committed fallback after %s",
    async () => {
      const response = await servePublicRequest(
        new Request("https://njpbs.org/contact/"),
        {
          fetchAsset: vi.fn(async () => asset(STALE_CMS_CONTACT)),
          getPublishedPage: vi.fn(async () => WITHDRAWN),
        },
      );

      await expectCommittedFallback(response);
    },
  );

  it("replaces a stale CMS asset with the committed fallback on lookup failure", async () => {
    const response = await servePublicRequest(
      new Request("https://njpbs.org/contact/"),
      {
        fetchAsset: vi.fn(async () => asset(STALE_CMS_CONTACT)),
        getPublishedPage: vi.fn(async () => {
          throw new Error("unavailable");
        }),
      },
    );

    await expectCommittedFallback(response);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://admin.njpbs.org",
    );
    expect(response.headers.get("access-control-expose-headers")).toContain(
      "x-njpbs-source-version",
    );
    expectContactBoundaryHeaders(response);
  });

  it("replaces a stale CMS asset with the committed fallback on lookup timeout", async () => {
    const response = await servePublicRequest(
      new Request("https://njpbs.org/contact/"),
      {
        fetchAsset: vi.fn(async () => asset(STALE_CMS_CONTACT)),
        getPublishedPage: vi.fn(
          () => new Promise<PublicPageProjection>(() => undefined),
        ),
        lookupTimeoutMs: 5,
      },
    );

    await expectCommittedFallback(response);
  });

  it("preserves the Contact boundary on a non-HTML asset response", async () => {
    const getPublishedPage = vi.fn(async () => LIVE);
    const response = await servePublicRequest(
      new Request("https://njpbs.org/contact/"),
      {
        fetchAsset: vi.fn(async () =>
          new Response("plain Contact", {
            headers: { "content-type": "text/plain; charset=utf-8" },
          })),
        getPublishedPage,
      },
    );

    expect(await response.text()).toBe("plain Contact");
    expect(getPublishedPage).not.toHaveBeenCalled();
    expectContactBoundaryHeaders(response);
  });

  it("preserves the Contact boundary on an asset redirect", async () => {
    const getPublishedPage = vi.fn(async () => LIVE);
    const response = await servePublicRequest(
      new Request("https://njpbs.org/contact"),
      {
        fetchAsset: vi.fn(async () =>
          new Response(null, {
            status: 307,
            headers: { location: "https://njpbs.org/contact/" },
          })),
        getPublishedPage,
      },
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://njpbs.org/contact/");
    expect(getPublishedPage).not.toHaveBeenCalled();
    expectContactBoundaryHeaders(response);
  });

  it("preserves the security boundary on a nested Contact 404", async () => {
    const getPublishedPage = vi.fn(async () => LIVE);
    const response = await servePublicRequest(
      new Request("https://njpbs.org/contact/missing"),
      {
        fetchAsset: vi.fn(async () =>
          new Response("Not found", {
            status: 404,
            headers: { "content-type": "text/html; charset=utf-8" },
          })),
        getPublishedPage,
      },
    );

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
    expect(getPublishedPage).not.toHaveBeenCalled();
    expectSecurityHeaders(response);
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
    expect(response.headers.has("access-control-expose-headers")).toBe(false);
  });

  it("serves rewritten Contact Astro assets from the same bound artifact", async () => {
    const fetchAsset = vi.fn(async () => new Response("contact styles", {
      headers: { "content-type": "text/css; charset=utf-8" },
    }));
    const getPublishedPage = vi.fn(async () => LIVE);
    const response = await servePublicRequest(
      new Request(
        "https://njpbs.org/contact/_astro/build-target.hash.css?v=one",
      ),
      { fetchAsset, getPublishedPage },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("contact styles");
    expect(fetchAsset).toHaveBeenCalledTimes(1);
    expect(fetchAsset.mock.calls[0]?.[0].url).toBe(
      "https://njpbs.org/_astro/build-target.hash.css?v=one",
    );
    expect(getPublishedPage).not.toHaveBeenCalled();
    expectSecurityHeaders(response);
  });

  it("preserves the Contact boundary on a non-GET request", async () => {
    const fetchAsset = vi.fn(async () =>
      new Response("Method not allowed", {
        status: 405,
        headers: { allow: "GET, HEAD" },
      }));
    const getPublishedPage = vi.fn(async () => LIVE);
    const request = new Request("https://njpbs.org/contact/", {
      method: "POST",
    });
    const response = await servePublicRequest(request, {
      fetchAsset,
      getPublishedPage,
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(fetchAsset).toHaveBeenCalledWith(request);
    expect(getPublishedPage).not.toHaveBeenCalled();
    expectContactBoundaryHeaders(response);
  });

  it("does not transform a partial static Contact response", async () => {
    const fetchAsset = vi.fn(async (_request: Request) =>
      new Response("partial static contact", {
        status: 206,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-range": "bytes 0-21/200",
        },
      }));
    const getPublishedPage = vi.fn(async () => LIVE);
    const response = await servePublicRequest(
      new Request("https://njpbs.org/contact/", {
        headers: { range: "bytes=0-21", "if-range": '"static-contact"' },
      }),
      { fetchAsset, getPublishedPage },
    );

    expect(response.status).toBe(206);
    expect(await response.text()).toBe("partial static contact");
    expect(fetchAsset.mock.calls[0]?.[0].headers.get("range")).toBeNull();
    expect(fetchAsset.mock.calls[0]?.[0].headers.get("if-range")).toBeNull();
    expect(getPublishedPage).not.toHaveBeenCalled();
    expectContactBoundaryHeaders(response);
  });

  it("passes every non-Contact route directly to static assets", async () => {
    const getPublishedPage = vi.fn(async () => LIVE);
    const response = await servePublicRequest(
      new Request("https://njpbs.org/about/"),
      {
        fetchAsset: vi.fn(async () => new Response("static about")),
        getPublishedPage,
      },
    );

    expect(await response.text()).toBe("static about");
    expect(getPublishedPage).not.toHaveBeenCalled();
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
  });
});

it.each(["/_pair-compiled/server/entry.mjs", "/_pair-compiled", "/%5fpair-compiled/server.js", "/%255fpair-compiled/server.js", "/other/%5fpair-compiled/server.js", "/%5fpair-compiled/bad%"])(
  "keeps private compiled code unreachable at %s", async path => {
    const fetchAsset = vi.fn(async () => new Response("private modules"));
    const post = vi.fn(async () => new Response("private modules"));
    const response = await servePublicRequest(new Request(`https://njpbs.org${path}`), { fetchAsset, noBuildPosts: { fetch: post } });
    expect(response.status).toBe(404);
    expect(fetchAsset).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

it.each(["/docs/100%25%20report.pdf", "/foo%", "/docs/%E0%A4%A"])("preserves ordinary asset routing and security headers at %s", async path => {
  const fetchAsset = vi.fn(async () => new Response("ordinary asset", { headers: { "x-content-type-options": "nosniff" } }));
  const request = new Request(`https://njpbs.org${path}`);
  const response = await servePublicRequest(request, { fetchAsset });
  expect(fetchAsset).toHaveBeenCalledOnce();
  expect(fetchAsset).toHaveBeenCalledWith(request);
  expect(await response.text()).toBe("ordinary asset");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
});
