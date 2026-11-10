import robotsParser from 'robots-parser';

export const origin = 'https://njpbs.org';
export const userAgent = 'NJPBS-QA/1.0';
export const bounds = Object.freeze({
  urls: 100, redirects: 5, responseBytes: 1024 * 1024,
  totalBytes: 4 * 1024 * 1024, deadlineMs: 10_000, requests: 12,
  sitemapDocuments: 6, requestBytes: 4096,
});

export class CrawlError extends Error {
  constructor(code, status = 502) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function targetUrl(value, base) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) throw new CrawlError('invalid_url', 400);
  let url;
  try { url = new URL(value, base); } catch { throw new CrawlError('invalid_url', 400); }
  if (url.origin !== origin || url.username || url.password || url.search) {
    throw new CrawlError('url_not_allowed', 400);
  }
  // Reject encoded separators and double encoding rather than guessing server decoding.
  if (/%(?:2f|5c|25)/i.test(url.pathname)) throw new CrawlError('path_not_allowed', 400);
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { throw new CrawlError('invalid_url', 400); }
  if (path.includes('//') || path.includes('\\') || /[\u0000-\u0020\u007f]/.test(path)
      || path.split('/').some(part => part.startsWith('_'))
      || /^\/(?:wiki|architecture|design-system|admin|api|cms)(?:\/|$)/i.test(path)) {
    throw new CrawlError('path_not_allowed', 400);
  }
  url.hash = '';
  return url.href;
}

export function robotsPolicy(text) {
  if (!/^\s*user-agent\s*:/im.test(text) || /<\s*(?:!doctype|html)/i.test(text)) {
    throw new CrawlError('invalid_robots');
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 1) throw new CrawlError('invalid_robots');
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent' && !/^[a-zA-Z0-9_*.-]+$/.test(value)) throw new CrawlError('invalid_robots');
    if (['allow', 'disallow'].includes(key) && value && !value.startsWith('/')) throw new CrawlError('invalid_robots');
  }
  const parser = robotsParser(`${origin}/robots.txt`, text);
  const sitemaps = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*sitemap\s*:\s*(\S+)\s*(?:#.*)?$/i.exec(line);
    if (match) sitemaps.push(targetUrl(match[1]));
  }
  if (sitemaps.length > bounds.sitemapDocuments) throw new CrawlError('sitemap_limit');
  return {
    sitemaps: [...new Set(sitemaps)],
    allows(url) { return parser.isAllowed(url, userAgent) === true; },
  };
}

export function withinDeadline(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(new CrawlError('deadline_exceeded', 504));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function readBounded(response, budget, maxBytes = bounds.responseBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await withinDeadline(reader.read(), budget.signal);
      if (result.done) break;
      bytes += result.value.byteLength;
      budget.bytes += result.value.byteLength;
      if (bytes > maxBytes || budget.bytes > bounds.totalBytes) throw new CrawlError('byte_limit', 413);
      chunks.push(result.value);
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(output); }
  catch { throw new CrawlError('invalid_encoding'); }
}

export async function fetchDocument(value, kind, budget, policy) {
  let url = targetUrl(value);
  while (true) {
    budget.signal.throwIfAborted();
    if (policy && !policy.allows(url)) throw new CrawlError('robots_disallowed', 403);
    if (++budget.requests > bounds.requests) throw new CrawlError('request_limit');
    const response = await withinDeadline(fetch(url, {
      method: 'GET', redirect: 'manual', signal: budget.signal,
      headers: { 'User-Agent': userAgent, Accept: kind === 'html' ? 'text/html' : kind === 'xml' ? 'application/xml, text/xml' : 'text/plain' },
    }), budget.signal);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      void response.body?.cancel().catch(() => {});
      if (++budget.redirects > bounds.redirects) throw new CrawlError('redirect_limit');
      const location = response.headers.get('location');
      if (!location) throw new CrawlError('invalid_redirect');
      url = targetUrl(location, url);
      continue;
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new CrawlError('upstream_status');
    }
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const allowedTypes = { html: ['text/html'], xml: ['application/xml', 'text/xml'], robots: ['text/plain'] };
    if (!allowedTypes[kind].includes(type)) {
      void response.body?.cancel().catch(() => {});
      throw new CrawlError('content_type_not_allowed');
    }
    return { url, status: response.status, text: await readBounded(response, budget), headers: response.headers };
  }
}
