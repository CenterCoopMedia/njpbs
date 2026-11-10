// Static HTML extraction and URL normalization adapted from workers-firecrawl
// f53a0dc01502401bf790ccb382d41014b8713afb. See ../LICENSE.upstream.
import { timingSafeEqual } from 'node:crypto';
import { bounds, CrawlError, fetchDocument, origin, readBounded, robotsPolicy, targetUrl, withinDeadline } from './policy.mjs';
import { pageResult, sitemapInventory, urlTree } from './content.mjs';

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

async function authorized(request, token) {
  if (typeof token !== 'string' || token.length < 32) return false;
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ') || header.length > 4096) return false;
  const encode = new TextEncoder();
  const [expected, actual] = await Promise.all([
    crypto.subtle.digest('SHA-256', encode.encode(token)),
    crypto.subtle.digest('SHA-256', encode.encode(header.slice(7))),
  ]);
  // Compare fixed-size digests with the Workers runtime timing-safe primitive.
  return timingSafeEqual(expected, actual);
}

async function crawl(request, env, path, budget) {
  let admitted;
  try { admitted = await withinDeadline(env.CRAWL_LIMITER.limit({ key: 'own-site-credential-v1' }), budget.signal); }
  catch { throw new CrawlError('limiter_unavailable', 503); }
  if (admitted?.success !== true) throw new CrawlError('rate_limited', 429);
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new CrawlError('invalid_request', 400);
  const body = await readBounded(request, budget, bounds.requestBytes);
  let input;
  try { input = JSON.parse(body); } catch { throw new CrawlError('invalid_request', 400); }
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'url')) throw new CrawlError('invalid_request', 400);
  const url = targetUrl(input.url);
  const robots = await fetchDocument(`${origin}/robots.txt`, 'robots', budget);
  const policy = robotsPolicy(robots.text);
  const page = pageResult(await fetchDocument(url, 'html', budget, policy), policy);
  if (path === '/scrape') return { ...page, complete: !page.truncated };
  const inventory = await sitemapInventory(policy, budget);
  const truncated = page.truncated || inventory.truncated;
  return {
    page, inventory: inventory.urls, urlTree: urlTree(inventory.urls),
    treeMeaning: 'URL path grouping; not a verified site hierarchy',
    observedEdges: page.links.map(link => ({ from: page.url, to: link.url, nofollow: link.nofollow })),
    exclusions: inventory.exclusions, truncated, complete: !truncated,
  };
}

export default {
  async fetch(request, env) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), bounds.deadlineMs);
    const budget = { signal: controller.signal, bytes: 0, requests: 0, redirects: 0 };
    let status = 500;
    let urlCount = 0;
    try {
      if (env.CRAWL_ENABLED !== 'true' || !env.CRAWL_LIMITER || typeof env.CRAWL_TOKEN !== 'string' || env.CRAWL_TOKEN.length < 32) {
        status = 503;
        return json({ error: 'crawl_disabled' }, status);
      }
      const path = new URL(request.url).pathname;
      if (!['/scrape', '/map'].includes(path)) { status = 404; return json({ error: 'not_found' }, status); }
      if (request.method !== 'POST') { status = 405; return json({ error: 'method_not_allowed' }, status); }
      if (!await withinDeadline(authorized(request, env.CRAWL_TOKEN), budget.signal)) {
        status = 401;
        return json({ error: 'unauthorized' }, status);
      }
      const result = await withinDeadline(crawl(request, env, path, budget), budget.signal);
      urlCount = result.inventory?.length ?? result.links.length;
      status = 200;
      return json(result);
    } catch (error) {
      const failure = controller.signal.aborted ? new CrawlError('deadline_exceeded', 504)
        : error instanceof CrawlError ? error : new CrawlError('crawl_failed');
      status = failure.status;
      return json({ error: failure.code, complete: false }, status);
    } finally {
      clearTimeout(timer);
      controller.abort();
      console.log(JSON.stringify({ event: 'own_site_crawl', status, durationMs: Date.now() - started, bytes: budget.bytes, urlCount }));
    }
  },
};
