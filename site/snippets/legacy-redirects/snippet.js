/**
 * Cloudflare edge entrypoint for the legacy-URL 410/301 map (#260, ADR 0010 M7).
 *
 * Runs the pure classifier in src/lib/legacy-redirects.ts against each inbound path and:
 *   - 410 Gone   for a retired legacy path (with a short page that links home,
 *                so a person who followed an old link is not left on a blank 410),
 *   - 301        for a hand-picked move,
 *   - pass-through (origin fetch) for everything else.
 *
 * The classifier is the tested source of truth (site/tests/legacy-redirects.test.ts,
 * under the repo's Vitest gate). This file is only the edge wrapper. It is written in
 * module form so it runs as-is as a Cloudflare Worker on a route; a Cloudflare Snippet
 * is a single file, so bundle it first (see README) before upload. esbuild resolves and
 * compiles the .ts import into the bundle. The repository artifact targets a Snippet.
 * Issue #879 is complete, so only the reviewed production upload and rule activation
 * remain external to this repository change.
 */
import { classify } from "../../src/lib/legacy-redirects";

// Security-header baseline for edge-generated responses. A synthetic 410 or 301 returns
// from this wrapper before Workers Assets serves a file, so Cloudflare never applies the
// wildcard rules in site/public/_headers to it. Without this, every classified legacy URL
// would lose the site's HSTS, nosniff, framing, referrer, permissions, and report-only CSP
// headers. Source of truth is site/public/_headers (docs/security-headers-policy.md, #253);
// keep this mirror of the /* block in sync with it until a shared generator lands.
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000",
  "x-frame-options": "SAMEORIGIN",
  "permissions-policy":
    'geolocation=(self "https://player.pbs.org"), encrypted-media=(self "https://player.pbs.org" "https://www.youtube-nocookie.com" "https://www.youtube.com" "https://player.vimeo.com" "https://www.facebook.com"), camera=(), microphone=(), payment=(), usb=()',
  "content-security-policy-report-only":
    "default-src 'self'; script-src 'self' https://jaws-prod.cdn.pbs.org; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://image.pbs.org https://media.njpbs.org; font-src 'self' https://media.njpbs.org; frame-src https://player.pbs.org https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com https://www.tiktok.com https://www.instagram.com https://www.facebook.com; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'",
};

const GONE_BODY = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Page no longer available - NJ PBS</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 34rem; margin: 12vh auto; padding: 0 1.25rem; line-height: 1.5; color: #1a1a1a; }
  a { color: #0b5cad; }
</style>
</head>
<body>
<h1>This page is no longer available</h1>
<p>You followed a link to a page from the previous njpbs.org site. That page has
been retired and there is no replacement for it.</p>
<p><a href="/">Go to the NJ PBS home page</a> to find what you are looking for.</p>
</body>
</html>
`;

export default {
  /**
   * @param {Request} request
   * @param {{ ASSETS?: { fetch: (request: Request) => Promise<Response> } }} [env]
   * @returns {Promise<Response>}
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    const decision = classify(url.pathname);

    if (decision === null) {
      // Not a legacy path: hand off unchanged. As a Worker in front of the
      // njpbs-production Workers Assets project, a plain fetch(request) does not reach
      // the bundled assets and can recurse into this same route, so serve through the
      // ASSETS binding when it is present. A Cloudflare Snippet (or a binding-less
      // Worker) has no env.ASSETS and falls back to a normal origin fetch.
      return env && env.ASSETS ? env.ASSETS.fetch(request) : fetch(request);
    }

    if (decision.action === "redirect") {
      // Resolve relative destinations against the current origin. Response.redirect sets
      // only Location, so build the response by hand to carry the security baseline too.
      const dest = new URL(decision.location, url);
      // Preserve the request's query string when the mapped destination has none: a 301 must keep
      // attribution and other caller params (e.g. /about/financials?utm_source=x -> /give
      // keeps ?utm_source=x). A destination that sets its own query wins.
      if (!dest.search && url.search) dest.search = url.search;
      const location = dest.toString();
      return new Response(null, {
        status: 301,
        headers: { ...SECURITY_HEADERS, location },
      });
    }

    // action === "gone"
    return new Response(GONE_BODY, {
      status: 410,
      headers: {
        ...SECURITY_HEADERS,
        "content-type": "text/html; charset=utf-8",
        // A retired path will not come back; let caches and crawlers keep the 410.
        "cache-control": "public, max-age=86400",
      },
    });
  },
};
