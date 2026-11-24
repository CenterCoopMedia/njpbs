#!/usr/bin/env node
// Publishes a seeded dev project through Boardwalk, so it holds what a normal
// publish leaves behind: Post owners, publication rows, history, media usage and
// settings receipts. Run it after `seed-dev-published.mjs verify`; rerun to resume.
// Development only: run it from a checkout rendered by render-development-config.mjs. The Boardwalk sign-in is on fd 3, the Access headers JSON on fd 4.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { launchCmsBrowser, parseBrowserCredential, submitCmsSignIn } from './cms-debug-browser.mjs';

const ADMIN = 'https://dev-admin.example.org';
const API = 'https://dev-cms-api.example.org';
const TRANSPORT = 'public-context-no-build-v1';
// Chrome is last: its receipt proves the whole published site.
const SETTINGS = ['story-ctas', 'public-homepage-banner', 'site-navigation', 'public-site-chrome'];
const PACE_MS = 4_000;
const RATE_WAIT_MS = 65_000;
const RECEIPT_WAIT_MS = 30 * 60_000;

const say = value => console.log(JSON.stringify({ at: new Date().toISOString(), ...value }));
const refused = (step, reply) => Object.assign(new Error(`${step} refused: ${reply.status} ${reply.body?.error ?? ''}`.slice(0, 200)), { authored: true });

// A seeded row is published at its own version; a normal publish leaves the
// working version ahead of the snapshot. A draft left by an earlier run is resumed.
export function needsPublication(document) {
  return document.status === 'published' && document.version === document.published?.sourceVersion ||
    document.status === 'draft' && document.publiclyVisible === true;
}

export async function publishPosts({ ids, call }) {
  const result = { published: 0, current: 0, failed: [] };
  for (const id of ids) {
    const read = await call('cmsGetContent', { collection: 'cmsPosts', id });
    const document = read.body?.document;
    if (read.status !== 200 || !document) { result.failed.push({ id, step: 'read', status: read.status }); continue; }
    if (!needsPublication(document)) { result.current++; continue; }
    let version = document.version;
    if (document.status === 'published') {
      const edit = await call('cmsTransitionContent', { collection: 'cmsPosts', id, action: 'edit', baseVersion: version });
      if (edit.status !== 200) { result.failed.push({ id, step: 'edit', status: edit.status, error: edit.body?.error }); continue; }
      version = edit.body.version;
    }
    const published = await call('cmsSaveContent', { collection: 'cmsPosts', id, baseVersion: version, publish: true, document: {} });
    if (published.status === 200 && published.body?.publication?.transport === 'post-no-build-v1') result.published++;
    else result.failed.push({ id, step: 'publish', status: published.status, error: published.body?.error, transport: published.body?.publication?.transport });
  }
  return result;
}

export async function publishSettings({ call, wait, report = () => {} }) {
  for (const id of SETTINGS) {
    let read = await call('cmsGetSettings', { id });
    if (read.status !== 200) throw refused(id, read);
    if (read.body.found === false) {
      if (id !== 'story-ctas') throw refused(id, { status: 404 });
      const saved = await call('cmsSaveSettings', { id, createOnly: true, values: { rules: [] } });
      if (saved.status !== 200) throw refused(id, saved);
      read = await call('cmsGetSettings', { id });
    }
    if (read.body.publication?.status !== 'success' || read.body.publication.missingConsumers.length) {
      const published = await call('cmsPublishSettings', { id, baseVersion: read.body.settings.version, publicationTransport: TRANSPORT });
      if (published.status !== 200) throw refused(id, published);
    }
    report({ setting: id, published: true });
  }
  // Only the last receipt is awaited: a newer context replaces the earlier ones.
  const id = SETTINGS.at(-1);
  for (const end = Date.now() + RECEIPT_WAIT_MS; ; await wait(10_000)) {
    const publication = (await call('cmsGetSettings', { id })).body?.publication;
    if (publication?.status === 'success' && !publication.missingConsumers.length) return publication;
    if (publication?.status === 'failed' || Date.now() > end) throw Object.assign(new Error(`${id} receipt: ${publication?.status} missing ${publication?.missingConsumers?.join()}`), { authored: true });
  }
}

async function main() {
  const [manifestPath] = process.argv.slice(2);
  if (!manifestPath) throw Object.assign(new Error('Usage: publish-dev-seed.mjs <seed manifest>'), { authored: true });
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const ids = manifest.records.filter(record => record.collection === 'cmsPosts' && record.projection.metadata?.type === 'post').map(record => record.id);
  const credential = parseBrowserCredential(readFileSync(3, 'utf8'));
  const access = JSON.parse(readFileSync(4, 'utf8'));
  if (Object.keys(access).sort().join() !== 'CF-Access-Client-Id,CF-Access-Client-Secret') throw Object.assign(new Error('Access headers are required'), { authored: true });
  const browser = await launchCmsBrowser(chromium);
  try {
    const context = await browser.newContext();
    await context.route(url => url.origin === ADMIN, async route => {
      try { await route.fulfill({ response: await route.fetch({ headers: { ...route.request().headers(), ...access }, maxRedirects: 0 }) }); }
      catch { await route.abort().catch(() => {}); }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    let token = '';
    page.on('request', request => {
      const header = request.headers().authorization;
      if (header?.startsWith('Bearer ') && new URL(request.url()).origin === API) token = header;
    });
    await page.goto(`${ADMIN}/`, { waitUntil: 'domcontentloaded' });
    if (new URL(page.url()).origin !== ADMIN) throw Object.assign(new Error('The dev Boardwalk did not open'), { authored: true });
    await submitCmsSignIn(page, async () => credential, () => page.getByRole('button', { name: /^Account menu for / }).waitFor({ state: 'visible' }));
    credential.password = '';
    for (let i = 0; !token && i < 60; i++) await page.waitForTimeout(500);
    if (!token) throw Object.assign(new Error('Boardwalk made no signed-in request'), { authored: true });
    const call = async (endpoint, body) => {
      for (;;) {
        await page.waitForTimeout(PACE_MS);
        const reply = await page.evaluate(async ([url, authorization, request]) => {
          const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authorization }, body: JSON.stringify(request) });
          return { status: response.status, body: await response.json().catch(() => null) };
        }, [`${API}/${endpoint}`, token, body]);
        if (reply.status !== 429) return reply;
        await page.waitForTimeout(RATE_WAIT_MS);
      }
    };
    const posts = await publishPosts({ ids, call });
    say({ posts });
    if (posts.failed.length) throw Object.assign(new Error(`${posts.failed.length} Posts were not published`), { authored: true });
    say({ receipt: await publishSettings({ call, wait: ms => page.waitForTimeout(ms), report: say }) });
  } finally { await browser.close().catch(() => {}); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.authored ? error.message : 'Dev seed publication failed: credential, browser or transport error.'); process.exitCode = 1; });
}
