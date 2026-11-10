import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker from '../src/index.mjs';
import { bounds } from '../src/policy.mjs';

// Test-only credential: never installed as a Worker secret.
const token = 'fixture-only-token-for-network-boundary-tests';
const fixtures = {};
for (const name of ['contact.html', 'robots.txt', 'sitemap-index.xml', 'sitemap-0.xml']) {
  fixtures[name] = await readFile(new URL(`fixtures/${name}`, import.meta.url), 'utf8');
}
let calls;
let responses;
let limiter;
let env;
let logs;
const page = '<html><head><link rel="canonical" href="https://njpbs.org/example/"></head><body><main><h1>Example</h1><p>Public text.</p><a href="/about/#team">About</a><a href="https://www.njspotlightnews.org/">External</a></main></body></html>';
const xml = urls => `<urlset>${urls.map(url => `<url><loc>${url}</loc></url>`).join('')}</urlset>`;
const index = urls => `<sitemapindex>${urls.map(url => `<sitemap><loc>${url}</loc></sitemap>`).join('')}</sitemapindex>`;
const response = (body, type = 'text/html', status = 200, headers = {}) => new Response(body, { status, headers: { 'content-type': type, ...headers } });

beforeEach(() => {
  calls = [];
  logs = [];
  limiter = mock.fn(async () => ({ success: true }));
  env = { CRAWL_ENABLED: 'true', CRAWL_TOKEN: token, CRAWL_LIMITER: { limit: limiter } };
  responses = new Map([
    ['https://njpbs.org/robots.txt', () => response(fixtures['robots.txt'], 'text/plain')],
    ['https://njpbs.org/example/', () => response(page)],
    ['https://njpbs.org/contact/', () => response(fixtures['contact.html'])],
    ['https://njpbs.org/sitemap-index.xml', () => response(fixtures['sitemap-index.xml'], 'application/xml')],
    ['https://njpbs.org/sitemap-0.xml', () => response(fixtures['sitemap-0.xml'], 'application/xml')],
  ]);
  mock.method(console, 'log', value => logs.push(value));
  mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(url);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, undefined);
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(new URL(url).origin, 'https://njpbs.org');
    const read = responses.get(url);
    assert.ok(read, `unexpected network read: ${url}`);
    return read(options);
  });
});
afterEach(() => mock.restoreAll());

function invoke(url = 'https://njpbs.org/example/', path = '/scrape', options = {}) {
  const request = new Request(`https://crawl.test${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ url }), ...options,
  });
  return worker.fetch(request, env);
}

for (const setting of ['disabled', 'missing secret', 'short secret', 'missing limiter', 'wrong token', 'missing token']) {
  test(`${setting} fails before outbound requests`, async () => {
    let options = {};
    if (setting === 'disabled') env.CRAWL_ENABLED = 'false';
    if (setting === 'missing secret') delete env.CRAWL_TOKEN;
    if (setting === 'short secret') env.CRAWL_TOKEN = 'short';
    if (setting === 'missing limiter') delete env.CRAWL_LIMITER;
    if (setting === 'wrong token') options.headers = { authorization: 'Bearer wrong' };
    if (setting === 'missing token') options.headers = {};
    assert.ok((await invoke(undefined, undefined, options)).status >= 400);
    assert.deepEqual(calls, []);
    assert.equal(limiter.mock.callCount(), 0);
  });
}

const credentialUrl = new URL('https://njpbs.org/');
credentialUrl.username = 'fixture-user';
for (const url of ['http://njpbs.org/', 'https://www.njpbs.org/', 'https://watch.njpbs.org/', 'https://njspotlightnews.org/', 'https://njpbs.org.evil.test/', 'https://njpbs.org:444/', credentialUrl.href, 'https://njpbs.org/?q=secret', 'https://njpbs.org/wiki/', 'https://njpbs.org/architecture/', 'https://njpbs.org/design-system/', 'https://njpbs.org/_private/', 'https://njpbs.org/%61dmin/', 'https://njpbs.org/%252fadmin', 'https://njpbs.org//admin/', 'file:///etc/passwd', 'https://127.0.0.1/']) {
  test(`URL policy prevents any outbound read for ${url}`, async () => {
    assert.equal((await invoke(url)).status, 400);
    assert.deepEqual(calls, []);
  });
}

test('limiter exhaustion or failure makes no outbound request', async () => {
  limiter.mock.mockImplementation(async () => ({ success: false }));
  assert.equal((await invoke()).status, 429);
  limiter.mock.mockImplementation(async () => { throw Error('private upstream body'); });
  assert.equal((await invoke()).status, 503);
  assert.deepEqual(calls, []);
});

test('only the narrow POST JSON contract is accepted', async () => {
  for (const options of [{ body: '{}' }, { body: '{' }, { body: JSON.stringify({ url: 'https://njpbs.org/', headers: { Authorization: 'private' } }) }, { body: 'a'.repeat(4097) }]) {
    assert.ok((await invoke(undefined, undefined, options)).status >= 400);
  }
  assert.equal((await invoke(undefined, '/search')).status, 404);
  assert.equal((await invoke(undefined, undefined, { method: 'GET', body: undefined })).status, 405);
  assert.deepEqual(calls, []);
});

test('robots wildcard and named-agent policies are enforced before page and redirect requests', async () => {
  responses.set('https://njpbs.org/robots.txt', () => response('User-agent: *\nAllow: /\nUser-agent: NJPBS-QA\nDisallow: /private/\n', 'text/plain'));
  assert.equal((await invoke('https://njpbs.org/private/')).status, 403);
  responses.set('https://njpbs.org/example/', () => response(null, 'text/html', 302, { location: '/private/' }));
  assert.equal((await invoke()).status, 403);
  assert.ok(!calls.includes('https://njpbs.org/private/'));
});

for (const robots of ['<html>error</html>', 'User-agent: *\nDisallow: invalid', 'User-agent:\nAllow: /', 'User-agent: *\ninvalid']) {
  test(`invalid robots fails closed: ${robots}`, async () => {
    responses.set('https://njpbs.org/robots.txt', () => response(robots, 'text/plain'));
    assert.equal((await invoke()).status, 502);
    assert.deepEqual(calls, ['https://njpbs.org/robots.txt']);
  });
}

test('robots availability, MIME and status errors stop before the page', async () => {
  for (const reply of [() => response('Unavailable', 'text/plain', 503), () => response('User-agent: *', 'text/html')]) {
    responses.set('https://njpbs.org/robots.txt', reply);
    assert.equal((await invoke()).status, 502);
  }
  assert.ok(calls.every(url => url.endsWith('/robots.txt')));
});

for (const location of ['https://evil.test/', '//watch.njpbs.org/', '/wiki/', '/?secret=x']) {
  test(`redirect policy blocks ${location}`, async () => {
    responses.set('https://njpbs.org/example/', () => response(null, 'text/html', 302, { location }));
    assert.equal((await invoke()).status, 400);
    assert.deepEqual(calls, ['https://njpbs.org/robots.txt', 'https://njpbs.org/example/']);
  });
}

test('redirect loops stop at five hops', async () => {
  responses.set('https://njpbs.org/example/', () => response(null, 'text/html', 302, { location: '/example/' }));
  assert.equal((await invoke()).status, 502);
  assert.equal(calls.length, 7);
});

test('real static public page yields known content, canonical and nofollow edges without following them', async () => {
  const result = await (await invoke('https://njpbs.org/contact/#top')).json();
  assert.match(result.markdown, /# Contact NJ PBS/);
  assert.match(result.markdown, /viewer questions, membership questions, PBS Passport help, donation questions/);
  assert.equal(result.canonical, 'https://njpbs.org/contact/');
  assert.equal(result.robots.noindex, true);
  assert.equal(result.robots.nofollow, true);
  assert.ok(result.links.every(link => link.nofollow));
  assert.ok(result.links.some(link => link.url === 'https://njpbs.org/about/'));
  assert.deepEqual(calls, ['https://njpbs.org/robots.txt', 'https://njpbs.org/contact/']);
  assert.equal(result.complete, true);
  assert.ok(!logs.join('').includes(token));
  assert.ok(!logs.join('').includes('Contact NJ PBS'));
});

test('map uses advertised sitemap index, separates inventory from observed edges, and never fetches linked pages', async () => {
  const result = await (await invoke('https://njpbs.org/contact/', '/map')).json();
  assert.equal(result.complete, true);
  assert.ok(result.inventory.includes('https://njpbs.org/'));
  assert.ok(!result.inventory.includes('https://njpbs.org/contact/'));
  assert.equal(result.urlTree.segment, '/');
  assert.ok(result.observedEdges.every(edge => edge.from === 'https://njpbs.org/contact/' && edge.nofollow));
  assert.deepEqual(calls, ['https://njpbs.org/robots.txt', 'https://njpbs.org/contact/', 'https://njpbs.org/sitemap-index.xml', 'https://njpbs.org/sitemap-0.xml']);
});

test('sitemap URLs and redirects cannot escape the allowlist', async () => {
  responses.set('https://njpbs.org/sitemap-index.xml', () => response(index(['https://evil.test/sitemap.xml']), 'application/xml'));
  assert.equal((await invoke(undefined, '/map')).status, 400);
  responses.set('https://njpbs.org/sitemap-index.xml', () => response(null, 'application/xml', 302, { location: 'https://evil.test/map.xml' }));
  assert.equal((await invoke(undefined, '/map')).status, 400);
  assert.ok(calls.every(url => new URL(url).origin === 'https://njpbs.org'));
});

test('recursive and malformed XML is rejected without recursive fetches', async () => {
  for (const body of [index(['https://njpbs.org/sitemap-index.xml']), '<urlset><url></urlset>', '<!DOCTYPE urlset [<!ENTITY x SYSTEM "file:///etc/passwd">]><urlset/>']) {
    responses.set('https://njpbs.org/sitemap-index.xml', () => response(body, 'application/xml'));
    const result = await invoke(undefined, '/map');
    assert.equal(result.status, 502);
  }
});

test('nested sitemap indexes stop at one child level', async () => {
  responses.set('https://njpbs.org/sitemap-0.xml', () => response(index(['https://njpbs.org/next.xml']), 'application/xml'));
  assert.equal((await invoke(undefined, '/map')).status, 502);
  assert.ok(!calls.includes('https://njpbs.org/next.xml'));
});

test('inventory and observed-link limits disclose truncation', async () => {
  responses.set('https://njpbs.org/sitemap-index.xml', () => response(xml(Array.from({ length: 101 }, (_, i) => `https://njpbs.org/page-${i}/`)), 'application/xml'));
  const result = await (await invoke(undefined, '/map')).json();
  assert.equal(result.inventory.length, 100);
  assert.equal(result.truncated, true);
  assert.equal(result.complete, false);
  responses.set('https://njpbs.org/example/', () => response(`<main><h1>Links</h1>${Array.from({ length: 101 }, (_, i) => `<a href="/p-${i}/">Page</a>`).join('')}</main>`));
  const scrape = await (await invoke()).json();
  assert.equal(scrape.links.length, 100);
  assert.equal(scrape.complete, false);
});

test('streamed body larger than one MiB stops with a bounds error', async () => {
  responses.set('https://njpbs.org/example/', () => response('x'.repeat(bounds.responseBytes + 1)));
  assert.equal((await invoke()).status, 413);
});

test('wrong page MIME stops and does not return the body', async () => {
  responses.set('https://njpbs.org/example/', () => response('private error detail', 'application/json'));
  const result = await invoke();
  assert.equal(result.status, 502);
  assert.ok(!(await result.text()).includes('private error detail'));
});

test('deadline ends a hung network request without sleeping', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let started;
  const fetched = new Promise(resolve => { started = resolve; });
  responses.set('https://njpbs.org/robots.txt', () => { started(); return new Promise(() => {}); });
  const pending = invoke();
  await fetched;
  t.mock.timers.tick(10_001);
  const result = await pending;
  assert.equal(result.status, 504);
  assert.equal((await result.json()).error, 'deadline_exceeded');
  assert.deepEqual(calls, ['https://njpbs.org/robots.txt']);
});

test('aggregate response budget stops before four MiB is exceeded', async () => {
  const urls = Array.from({ length: 5 }, (_, i) => `https://njpbs.org/part-${i}.xml`);
  responses.set('https://njpbs.org/sitemap-index.xml', () => response(index(urls), 'application/xml'));
  for (const url of urls) responses.set(url, () => response(`<urlset>${' '.repeat(900_000)}</urlset>`, 'application/xml'));
  assert.equal((await invoke(undefined, '/map')).status, 413);
});

test('sitemap document budget is explicit and does not fetch overflow documents', async () => {
  responses.set('https://njpbs.org/sitemap-index.xml', () => response(index(Array.from({ length: 10 }, (_, i) => `https://njpbs.org/part-${i}.xml`)), 'application/xml'));
  for (let i = 0; i < 10; i++) responses.set(`https://njpbs.org/part-${i}.xml`, () => response(xml([`https://njpbs.org/page-${i}/`]), 'application/xml'));
  const result = await (await invoke(undefined, '/map')).json();
  assert.equal(result.complete, false);
  assert.equal(result.truncated, true);
  assert.equal(result.inventory.length, 5);
  assert.equal(calls.filter(url => /part-/.test(url)).length, 5);
});

test('slow streamed response is cancelled at the total deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let opened;
  const ready = new Promise(resolve => { opened = resolve; });
  let cancelled = false;
  responses.set('https://njpbs.org/example/', () => response(new ReadableStream({
    pull() { opened(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 })));
  const pending = invoke();
  await ready;
  t.mock.timers.tick(10_001);
  assert.equal((await pending).status, 504);
  await Promise.resolve();
  assert.equal(cancelled, true);
});

test('robots denied sitemap inventory entries are excluded', async () => {
  responses.set('https://njpbs.org/robots.txt', () => response('User-agent: *\nDisallow: /private/\nSitemap: https://njpbs.org/sitemap-index.xml', 'text/plain'));
  responses.set('https://njpbs.org/sitemap-index.xml', () => response(xml(['https://njpbs.org/private/data/', 'https://njpbs.org/about/']), 'application/xml'));
  const result = await (await invoke(undefined, '/map')).json();
  assert.deepEqual(result.inventory, ['https://njpbs.org/about/']);
  assert.deepEqual(result.exclusions, [{ reason: 'robots_disallowed' }]);
  assert.ok(!calls.includes('https://njpbs.org/private/data/'));
});

test('external advertised sitemaps fail before fetching the page', async () => {
  responses.set('https://njpbs.org/robots.txt', () => response('User-agent: *\nSitemap: https://evil.test/map.xml', 'text/plain'));
  assert.equal((await invoke(undefined, '/map')).status, 400);
  assert.deepEqual(calls, ['https://njpbs.org/robots.txt']);
});

test('duplicate sitemap index entries reuse the child without reporting a cycle', async () => {
  responses.set('https://njpbs.org/sitemap-index.xml', () => response(index(['https://njpbs.org/sitemap-0.xml', 'https://njpbs.org/sitemap-0.xml']), 'application/xml'));
  const result = await (await invoke(undefined, '/map')).json();
  assert.equal(result.complete, true);
  assert.ok(result.inventory.includes('https://njpbs.org/'));
  assert.equal(calls.filter(url => url.endsWith('/sitemap-0.xml')).length, 1);
});

test('robots may advertise both an index and its child without duplicate reads', async () => {
  responses.set('https://njpbs.org/robots.txt', () => response('User-agent: *\nAllow: /\nSitemap: https://njpbs.org/sitemap-index.xml\nSitemap: https://njpbs.org/sitemap-0.xml', 'text/plain'));
  const result = await (await invoke(undefined, '/map')).json();
  assert.equal(result.complete, true);
  assert.ok(result.inventory.includes('https://njpbs.org/'));
  assert.equal(calls.filter(url => url.endsWith('/sitemap-0.xml')).length, 1);
});
