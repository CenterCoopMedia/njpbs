#!/usr/bin/env -S node --experimental-strip-types
// Publishes a seeded dev project through Boardwalk, so it holds what a normal
// publish leaves behind: Post, Page and record owners, publication rows, history,
// media usage and settings receipts. Settings are created, saved and published
// only through these calls; the import never writes them. Run it after
// `seed-dev-published.mjs verify`; rerun with the same journal to resume.
// Development only: run it from a checkout rendered by render-development-config.mjs.
// The Boardwalk sign-in is on fd 3, the Access headers JSON on fd 4.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ACTOR, canonical, validateManifest } from './seed-dev-published.mjs';

const ADMIN = 'https://dev-admin.example.org';
const API = 'https://dev-api.example.org';
const SETTINGS_TRANSPORT = 'public-context-no-build-v1';
// The transport each publish must report: the owner that writes its owner row.
const CONTENT_TRANSPORT = { page: 'page-no-build-v1', post: 'post-no-build-v1',
  program: 'public-context-no-build-v1', event: 'public-context-no-build-v1' };
// Chrome is published last, so that its context holds every other setting.
const LAST_SETTING = 'public-site-chrome';
// These change what Node or Playwright print or load, and could expose the sign-in.
const REFUSED_ENVIRONMENT = ['DEBUG', 'PWDEBUG', 'NODE_OPTIONS'];
const PACE_MS = 4_000;
const RATE_WAIT_MS = 65_000;
const RECEIPT_WAIT_MS = 30 * 60_000;

const say = value => console.log(JSON.stringify({ at: new Date().toISOString(), ...value }));
const authored = message => Object.assign(new Error(message.slice(0, 200)), { authored: true });
const refused = (step, reply) => authored(`${step} refused: ${reply.status} ${reply.body?.error ?? ''}`);

/** The signed-in token of a request to the dev API, and of no other request. */
export function apiToken(request) {
  const header = request.headers().authorization;
  return header?.startsWith('Bearer ') && new URL(request.url()).origin === API ? header : undefined;
}

export function refuseUnsafeEnvironment(env = process.env) {
  // config-input: DEBUG, NODE_OPTIONS, PWDEBUG
  const set = REFUSED_ENVIRONMENT.filter(name => env[name] !== undefined && env[name] !== '');
  if (set.length) throw authored(`Unset ${set.join(', ')} before signing in`);
}

// Every routed Page, Post, Program and Event in the manifest, in a stable order.
export function contentTargets(manifest) {
  return manifest.records.flatMap(record => {
    const kind = record.collection === 'cmsPages' ? 'page' : record.collection === 'cmsPosts' ? record.projection.metadata?.type : null;
    return Object.hasOwn(CONTENT_TRANSPORT, kind ?? '') ? [{ collection: record.collection, id: record.id, kind }] : [];
  });
}
export function settingsTargets(manifest) {
  const rows = manifest.records.filter(record => record.collection === 'cmsSettings');
  return [...rows.filter(row => row.id !== LAST_SETTING), ...rows.filter(row => row.id === LAST_SETTING)]
    .map(row => ({ id: row.id, values: row.projection.values }));
}

// The journal names each row this script moved to a draft, with the draft version
// the edit returned. Only those drafts are resumed; any other draft is someone's work.
export function readJournal(lines) {
  const drafts = new Map(); const pending = new Set();
  for (const line of lines.split('\n').filter(Boolean)) {
    const entry = JSON.parse(line);
    const key = `${entry.collection}/${entry.id}`;
    if (entry.step === 'edit-intent') pending.add(key);
    if (entry.step === 'edit-done') { pending.delete(key); drafts.set(key, entry.version); }
    if (entry.step === 'published') drafts.delete(key);
  }
  return { drafts, pending };
}

// A seed-written row carries the seed actor as its publisher. A normal publish
// replaces it with the staff account, so a published row needs nothing more.
export function publicationStep(document, key, journal) {
  if (document.status === 'published') return document.published?.publishedBy === ACTOR ? 'edit' : 'current';
  if (document.status === 'draft' && journal.drafts.get(key) === document.version) return 'publish';
  if (journal.pending.has(key)) return 'unconfirmed';
  return 'not-seeded';
}

export async function publishContent({ targets, call, journal, record = () => {} }) {
  const result = { published: 0, current: 0, failed: [] };
  for (const { collection, id, kind } of targets) {
    const key = `${collection}/${id}`;
    const read = await call('cmsGetContent', { collection, id });
    const document = read.body?.document;
    if (read.status !== 200 || !document) { result.failed.push({ collection, id, step: 'read', status: read.status }); continue; }
    const step = publicationStep(document, key, journal);
    if (step === 'current') { result.current++; continue; }
    // A draft the journal does not name, or an edit whose reply was lost, is left
    // for an operator: publishing it could release another person's work.
    if (step === 'not-seeded' || step === 'unconfirmed') { result.failed.push({ collection, id, step, status: document.status }); continue; }
    let version = document.version;
    if (step === 'edit') {
      record({ step: 'edit-intent', collection, id, baseVersion: version });
      const edit = await call('cmsTransitionContent', { collection, id, action: 'edit', baseVersion: version });
      if (edit.status !== 200 || !Number.isSafeInteger(edit.body?.version)) { result.failed.push({ collection, id, step: 'edit', status: edit.status, error: edit.body?.error }); continue; }
      version = edit.body.version;
      record({ step: 'edit-done', collection, id, version });
      journal.pending.delete(key); journal.drafts.set(key, version);
    }
    // Publishing a published row is refused, so the row is first moved to a draft.
    const published = await call('cmsSaveContent', { collection, id, baseVersion: version, publish: true, document: {} });
    if (published.status === 200 && published.body?.publication?.transport === CONTENT_TRANSPORT[kind]) {
      record({ step: 'published', collection, id });
      journal.drafts.delete(key);
      result.published++;
    } else result.failed.push({ collection, id, step: 'publish', status: published.status, error: published.body?.error, transport: published.body?.publication?.transport });
  }
  return result;
}

const settled = publication => publication?.status === 'success' && !publication.missingConsumers?.length;
export async function publishSettings({ targets, call, wait, report = () => {}, now = Date.now }) {
  for (const { id, values } of targets) {
    const read = await call('cmsGetSettings', { id });
    if (read.status !== 200) throw refused(id, read);
    let current = read.body.found === false ? null : read.body.settings;
    let publication = read.body.publication;
    if (!current || canonical(current.values) !== canonical(values)) {
      const saved = await call('cmsSaveSettings', current ? { id, baseVersion: current.version, values } : { id, createOnly: true, values });
      if (saved.status !== 200) throw refused(id, saved);
      // Publish this saved version only. A later draft belongs to another editor.
      current = saved.body.settings;
      if (canonical(current?.values) !== canonical(values) || !Number.isSafeInteger(current.version)) throw authored(`${id} save returned other values`);
      publication = null;
    }
    if (!current.published || canonical(current.published.values) !== canonical(values) || !settled(publication)) {
      const published = await call('cmsPublishSettings', { id, baseVersion: current.version, publicationTransport: SETTINGS_TRANSPORT });
      if (published.status !== 200) throw refused(id, published);
      // The endpoint can answer with an earlier accepted publication of the same version.
      if (published.body?.settings && canonical(published.body.settings.published?.values) !== canonical(values)) throw authored(`${id} publish returned other values`);
    }
    report({ setting: id, published: true });
  }
  // A settled receipt covers only its own context and everything before it, so the
  // receipt of the newest context is the one to await. An unchanged setting keeps
  // the receipt of an earlier run.
  let newest = null;
  for (const { id } of targets) {
    const revision = (await call('cmsGetSettings', { id })).body?.publication?.contextRevision ?? 0;
    if (!newest || revision >= newest.revision) newest = { id, revision };
  }
  if (!newest) return null;
  const { id } = newest;
  for (const end = now() + RECEIPT_WAIT_MS; ; await wait(10_000)) {
    const publication = (await call('cmsGetSettings', { id })).body?.publication;
    if (settled(publication)) return publication;
    if (publication?.status === 'failed' || now() > end) throw authored(`${id} receipt: ${publication?.status} missing ${publication?.missingConsumers?.join()}`);
  }
}

// Each record has its own publication, which no settings receipt covers. A rerun
// waits for the records an earlier run published as well.
export async function awaitContent({ targets, call, wait, now = Date.now }) {
  let pending = targets;
  for (let end; pending.length; await wait(10_000)) {
    const next = [];
    for (const target of pending) {
      const { collection, id } = target;
      const read = await call('cmsGetContent', { collection, id, publicationOnly: true });
      const publication = read.body?.publication;
      if (read.status !== 200 || !publication) throw refused(`${collection}/${id}`, read);
      // A record also reads as failed while it is only late; its receipt names the outcome.
      const status = publication.recordPublication?.status ?? publication.queueStatus;
      if (['failed', 'cancelled', 'public_unconfirmed'].includes(status)) throw authored(`${collection}/${id} publication: ${status}`);
      if (publication.publicUpdatePending !== false) next.push(target);
    }
    end ??= now() + RECEIPT_WAIT_MS;
    if (next.length && now() > end) throw authored(`${next.length} publications did not settle: ${next[0].collection}/${next[0].id}`);
    pending = next;
  }
}

async function main() {
  refuseUnsafeEnvironment();
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { journal: { type: 'string' } } });
  if (positionals.length !== 1 || !values.journal) throw authored('Usage: publish-dev-seed.mjs <seed manifest> --journal <file>');
  const manifest = validateManifest(JSON.parse(readFileSync(positionals[0], 'utf8')));
  const journalPath = resolve(values.journal);
  const journal = readJournal(existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : '');
  const record = entry => appendFileSync(journalPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
  const { chromium } = await import('@playwright/test');
  const { launchCmsBrowser, parseBrowserCredential, submitCmsSignIn } = await import('./cms-debug-browser.mjs');
  const credential = parseBrowserCredential(readFileSync(3, 'utf8'));
  const access = JSON.parse(readFileSync(4, 'utf8'));
  if (Object.keys(access).sort().join() !== 'CF-Access-Client-Id,CF-Access-Client-Secret') throw authored('Access headers are required');
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
      token = apiToken(request) ?? token;
    });
    await page.goto(`${ADMIN}/`, { waitUntil: 'domcontentloaded' });
    if (new URL(page.url()).origin !== ADMIN) throw authored('The dev Boardwalk did not open');
    await submitCmsSignIn(page, async () => credential, () => page.getByRole('button', { name: /^Account menu for / }).waitFor({ state: 'visible' }));
    credential.password = '';
    for (let i = 0; !token && i < 60; i++) await page.waitForTimeout(500);
    if (!token) throw authored('Boardwalk made no signed-in request');
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
    const content = await publishContent({ targets: contentTargets(manifest), call, journal, record });
    say({ content });
    if (content.failed.length) throw authored(`${content.failed.length} records were not published`);
    const wait = ms => page.waitForTimeout(ms);
    say({ receipt: await publishSettings({ targets: settingsTargets(manifest), call, wait, report: say }) });
    await awaitContent({ targets: contentTargets(manifest), call, wait });
    say({ contentSettled: true });
  } finally { await browser.close().catch(() => {}); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.authored ? error.message : 'Dev seed publication failed: credential, browser or transport error.'); process.exitCode = 1; });
}
