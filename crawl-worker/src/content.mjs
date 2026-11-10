import { parse } from 'node-html-parser';
import { NodeHtmlMarkdown } from 'node-html-markdown';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { bounds, CrawlError, fetchDocument, targetUrl, userAgent } from './policy.mjs';

export function pageResult(page, policy) {
  const document = parse(page.text);
  const directives = [page.headers.get('x-robots-tag') || ''];
  for (const meta of document.querySelectorAll('meta[name]')) {
    if (['robots', 'njpbs-qa'].includes(meta.getAttribute('name')?.toLowerCase())) directives.push(meta.getAttribute('content') || '');
  }
  const robots = directives.join(', ').toLowerCase().split(/[\s,]+/).filter(Boolean);
  const nofollow = robots.includes('nofollow') || robots.includes('none');
  const links = new Map();
  const exclusions = new Map();
  let truncated = false;
  for (const anchor of document.querySelectorAll('a[href]')) {
    let url;
    try { url = targetUrl(anchor.getAttribute('href'), page.url); }
    catch {
      // Only a reason and count are returned; excluded URLs can contain private query data.
      const reason = 'url_not_allowed';
      exclusions.set(reason, (exclusions.get(reason) || 0) + 1);
      continue;
    }
    const linkNofollow = nofollow || /\bnofollow\b/i.test(anchor.getAttribute('rel') || '');
    const old = links.get(url);
    if (old) old.nofollow ||= linkNofollow;
    else if (links.size < bounds.urls) links.set(url, { url, nofollow: linkNofollow, robotsAllowed: policy.allows(url) });
    else truncated = true;
  }
  let canonical = null;
  const rawCanonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href');
  if (rawCanonical) {
    try { canonical = targetUrl(rawCanonical, page.url); } catch { /* Do not echo rejected canonical URLs. */ }
  }
  const main = document.querySelector('main') || document.querySelector('article') || document.querySelector('body');
  main?.querySelectorAll('script, style, template, noscript, iframe, form, nav, footer').forEach(node => node.remove());
  const markdown = main ? NodeHtmlMarkdown.translate(main.innerHTML) : '';
  if (!markdown.trim()) throw new CrawlError('missing_page_content');
  return {
    url: page.url, canonical, status: page.status, markdown,
    robots: { userAgent, noindex: robots.includes('noindex') || robots.includes('none'), nofollow },
    links: [...links.values()].sort((a, b) => a.url.localeCompare(b.url)),
    exclusions: [...exclusions].map(([reason, count]) => ({ reason, count })), truncated,
  };
}

function sitemapEntries(text) {
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(text) || XMLValidator.validate(text) !== true) throw new CrawlError('invalid_sitemap');
  const parsed = new XMLParser({ ignoreAttributes: true, parseTagValue: false, processEntities: false, removeNSPrefix: true }).parse(text);
  const index = parsed.sitemapindex;
  const entries = index ? index.sitemap : parsed.urlset?.url;
  if ((!Object.hasOwn(parsed, 'sitemapindex') && !Object.hasOwn(parsed, 'urlset')) || (Object.hasOwn(parsed, 'sitemapindex') && Object.hasOwn(parsed, 'urlset'))) throw new CrawlError('invalid_sitemap');
  if (entries === undefined) return { index: Boolean(index), urls: [] };
  const rows = Array.isArray(entries) ? entries : [entries];
  return { index: Boolean(index), urls: rows.map(row => {
    if (typeof row?.loc !== 'string') throw new CrawlError('invalid_sitemap');
    return targetUrl(row.loc.replaceAll('&amp;', '&'));
  }) };
}

export async function sitemapInventory(policy, budget) {
  if (!policy.sitemaps.length) throw new CrawlError('missing_sitemap');
  const queue = policy.sitemaps.map(url => ({ url, depth: 0 }));
  const visited = new Set();
  const urls = new Set();
  const exclusions = [];
  let truncated = false;
  for (let i = 0; i < queue.length; i++) {
    const { url, depth } = queue[i];
    if (visited.has(url)) continue;
    if (visited.size >= bounds.sitemapDocuments) { truncated = true; break; }
    visited.add(url);
    const page = await fetchDocument(url, 'xml', budget, policy);
    if (page.url !== url && visited.has(page.url)) throw new CrawlError('sitemap_cycle');
    visited.add(page.url);
    const parsed = sitemapEntries(page.text);
    if (parsed.index && depth >= 1) throw new CrawlError('sitemap_depth_limit');
    for (const entry of parsed.urls) {
      if (!policy.allows(entry)) {
        exclusions.push({ reason: 'robots_disallowed' });
        if (exclusions.length >= bounds.urls) { truncated = true; break; }
        continue;
      }
      if (parsed.index) {
        if (entry === url || entry === page.url) throw new CrawlError('sitemap_cycle');
        if (queue.some(item => item.url === entry)) continue;
        if (queue.length >= bounds.sitemapDocuments) { truncated = true; break; }
        queue.push({ url: entry, depth: depth + 1 });
      } else if (urls.size < bounds.urls) urls.add(entry);
      else { truncated = true; break; }
    }
  }
  return { urls: [...urls].sort(), exclusions, truncated };
}

export function urlTree(urls) {
  const root = { segment: '/', urls: [], children: [] };
  for (const url of urls) {
    let node = root;
    for (const segment of new URL(url).pathname.split('/').filter(Boolean)) {
      let child = node.children.find(item => item.segment === segment);
      if (!child) { child = { segment, urls: [], children: [] }; node.children.push(child); }
      node = child;
    }
    node.urls.push(url);
  }
  return root;
}
