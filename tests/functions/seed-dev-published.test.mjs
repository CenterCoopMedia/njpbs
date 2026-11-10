import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { SOURCE, DESTINATION, ACTOR, assertPair, canonical, digest, exportPublished, validateManifest, copyMedia, importPublished, assertPublicMediaUrl } from '../../scripts/seed-dev-published.mjs';
import mediaContract from '../../functions/lib/media-contract.js';
import mediaSafety from '../../functions/lib/published-media-safety.js';
import mediaUsage from '../../functions/lib/media-usage.js';
import blocks from '../../functions/lib/content-blocks.js';
import publicProjection from '../../functions/lib/public-content-projection.js';
import deployment from '../../functions/lib/public-deployment.js';
import { DEFAULT_SITE_NAVIGATION } from '../../packages/content-core/src/cms-settings.ts';
import { createPublicArtifactInventoryReceipt } from '../../site/src/lib/public-artifact-inventory.ts';
import settings from '../../functions/lib/cms-settings-contract.js';
import settingsApi from '../../functions/settings.js';
import contentSections from '../../functions/lib/content-sections.js';
import mediaCategories from '../../functions/lib/media-categories.js';
import { backfillPageSeedMedia, PAGE_SEED_MEDIA } from '../../scripts/backfill-page-seed-media.mjs';

// The emulator boundary is mandatory. Never use ADC or a live project in tests.
if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')) throw new Error('Run with the Firestore emulator');
const sourceApp = initializeApp({ projectId: SOURCE }, 'seed-test-source');
const devApp = initializeApp({ projectId: DESTINATION }, 'seed-test-dev');
const source = getFirestore(sourceApp); const dev = getFirestore(devApp);
const sourceSha = 'a'.repeat(40);
const publication = { schemaVersion: 1, digestAlgorithm: 'sha256', buildBatchId: 'build-1', generation: 42, commitSha: sourceSha,
  artifactDigest: 'b'.repeat(64), artifactReceiptDigest: 'c'.repeat(64), mediaManifestDigest: 'd'.repeat(64) };
const when = '2026-01-01T00:00:00.000Z';
const mediaBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
const mediaUrl = 'https://media.njpbs.org/cms-media/general/image-1/image.png';
const page = () => ({ title: 'Private working draft', email: 'staff@example.test', version: 9, status: 'draft', publiclyVisible: true,
  publishAt: when, published: { metadata: { title: 'Public title', slug: 'contact', description: 'Published text', privateNotes: 'private snapshot note' },
    blocks: [{ id: 'image-block', type: 'image', order: 0, visible: true, data: { assetId: 'image-1', alt: 'Public image', decorative: false } },
      { id: 'hidden-block', type: 'headline', order: 1, visible: false, data: { text: 'Hidden draft note' } }],
    publishedAt: when, publishedBy: 'production-user', sourceVersion: 4, contentVersion: 4 },
  blocks: [{ id: 'draft', type: 'headline', data: { text: 'Do not export' } }] });
let directory;
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), 'dev-seed-test-')); });
afterAll(async () => { await Promise.all([deleteApp(sourceApp), deleteApp(devApp)]); await rm(directory, { recursive: true, force: true }); });
async function clear(db) {
  for (const collection of await db.listCollections()) await db.recursiveDelete(collection);
}
beforeEach(async () => {
  await clear(source); await clear(dev);
  for (const section of contentSections.SEEDED_CONTENT_SECTIONS) await source.doc(`sections/${section.id}`).set(section);
  for (const category of mediaCategories.SEEDED_MEDIA_CATEGORIES) await source.doc(`mediaCategories/${category.id}`).set({ ...category, active: true, version: 1 });
  await source.doc('system/publicDeployment').set({ ...deployment.initialPublicDeploymentPointer(), activeGeneration: 42,
    activeDeploymentId: 'deployment-42', activeCommitSha: sourceSha, lastReservedGeneration: 42, newestEligibleGeneration: 42,
    newestEligibleBuildBatchId: 'build-1' });
  await source.doc('system/publicDeployment/buildBatches/build-1').set({ status: 'deployed', generation: 42, commitSha: sourceSha, deploymentId: 'deployment-42' });
  await source.doc('system/publicDeployment/buildBatches/build-1/candidates/worker').set(publication);
  await source.doc('cmsPages/contact').set(page());
  await source.doc('media_assets_public/image-1').set({ url: mediaUrl, mimeType: 'image/png', width: 2, height: 2, altText: 'Public alt', privateOriginal: 's3://secret/original', email: 'media@example.test' });
});
const exportSeed = options => exportPublished({ firestore: source, sourceSha, publication,
  fetchImpl: async () => new Response(null, { headers: { 'content-type': 'image/png', 'content-length': String(mediaBytes.length) } }), ...options });
async function copied(manifest) {
  // A real PNG fixture; the fake is only the public HTTP network boundary.
  const bytes = mediaBytes;
  return copyMedia({ manifest, directory, fetchImpl: async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }) });
}

describe('isolated published-content seed', () => {
  it.each([
    ['public-homepage-banner', settings.DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS],
    ['site-navigation', DEFAULT_SITE_NAVIGATION],
    ['public-site-chrome', { newsletterEnabled: false, newsletterLabel: 'Newsletter', newsletterHref: '/contact/', newsletterOpensInNewTab: false }],
  ])('imports and refreshes %s through the real staff settings reader', async (id, values) => {
    await source.doc(`cmsSettings/${id}`).set({ version: 3,
      published: { schemaVersion: 1, values, sourceVersion: 3, publishedAt: when } });
    const manifest = await exportSeed();
    const copy = await copied(manifest);
    await importPublished({ firestore: dev, manifest, copy, apply: true });
    // Only the authentication boundary is supplied. The reader, contract,
    // authorization decision and Firestore data are the real collaborators.
    const reader = settingsApi.createCmsGetSettingsHandler({ firestore: dev,
      requirePrincipalFn: async () => ({ uid: 'seed-reader', principal: { id: 'seed-reader', grants: [{ role: 'admin' }] } }),
      log: { error() {}, warn() {} } });
    const read = async () => {
      const response = { statusCode: null, body: null, headersSent: false,
        set() { return this; }, status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; this.headersSent = true; return this; } };
      await reader({ method: 'POST', headers: { 'content-type': 'application/json' }, body: { id } }, response);
      return response;
    };
    expect(await read()).toMatchObject({ statusCode: 200, body: { id, found: true, settings: { version: 3 } } });
    const clean = (await dev.doc(`cmsSettings/${id}`).get()).data();
    // Reproduce the old writer and its provenance receipt, then exercise refresh.
    const legacy = { ...clean, id, createdAt: when, updatedAt: when, createdBy: ACTOR, updatedBy: ACTOR };
    await dev.doc(`cmsSettings/${id}`).set(legacy);
    await dev.doc(`devSeedRecords/${digest(`cmsSettings/${id}`)}`).update({ recordHash: digest(legacy),
      seedHash: digest(Object.fromEntries(Object.entries(legacy).filter(([key]) => !['createdAt', 'updatedAt'].includes(key)))) });
    expect((await read()).statusCode).toBe(409);
    await importPublished({ firestore: dev, manifest, copy, apply: true });
    expect(await read()).toMatchObject({ statusCode: 200, body: { settings: clean } });
    expect((await dev.doc(`cmsSettings/${id}`).get()).data()).toEqual(clean);
    const provenance = (await dev.doc(`devSeedRecords/${digest(`cmsSettings/${id}`)}`).get()).data();
    expect(provenance.recordHash).toBe(digest(clean));
    expect(provenance.seedHash).toBe(digest(clean));
  });

  it('carries allowlisted editor registries and admits News and media uploads after import', async () => {
    await source.doc('sections/news').update({ createdBy: 'private-user', grants: [{ uid: 'private-user', role: 'admin' }],
      email: 'private@example.test', description: 'Contact desk@example.test', extra: 'private-extension' });
    await source.doc('mediaCategories/general').update({ createdBy: 'private-user', uploadCredentials: 'private-extension' });
    await source.doc('mediaCategories/archived').set({ id: 'archived', label: 'Archived', description: '', order: 40, active: false, version: 3 });
    const manifest = await exportSeed();
    const news = manifest.records.find(record => record.collection === 'sections' && record.id === 'news');
    expect(news).toMatchObject({ sourceVersion: 1, confirmedLive: false,
      projection: { id: 'news', label: 'News', description: 'Contact [redacted]', order: 5 } });
    expect(Object.keys(news.projection).sort()).toEqual(['description', 'id', 'label', 'order']);
    for (const value of ['private-user', 'private-extension', '@example.test', 'grants', 'uploadCredentials']) expect(canonical(manifest)).not.toContain(value);
    await importPublished({ firestore: dev, manifest, apply: true });
    expect(await contentSections.unregisteredSections(dev, ['news'])).toEqual([]);
    const category = await dev.runTransaction(tx => mediaCategories.requireActiveMediaCategory(tx, dev, 'general'));
    expect(category).toMatchObject({ id: 'general', active: true, createdBy: ACTOR });
    expect((await dev.doc('mediaCategories/archived').get()).data()).toMatchObject({ active: false, version: 3 });
    await expect(dev.runTransaction(tx => mediaCategories.requireActiveMediaCategory(tx, dev, 'archived'))).rejects.toThrow('active media category');
    for (const path of ['sections/news', 'mediaCategories/general']) {
      const data = (await dev.doc(path).get()).data();
      const receipt = (await dev.doc(`devSeedRecords/${digest(path)}`).get()).data();
      expect(receipt).toMatchObject({ path, recordHash: digest(data), manifestHash: manifest.hash });
    }
  });
  it('repairs only configuration on an active dev instance and preserves its content and controls', async () => {
    const protectedRows = {
      'cmsPages/home': { title: 'Staff-edited dev Home' },
      'cmsPosts/editor-proof': { title: 'Retained draft', section: 'news' },
      'system/publicDeployment': { activeGeneration: 4 },
      'system/cmsPreviewRuntime': { phase: 'ready' },
      'system/cmsPublicationRuntime': { phase: 'ready' },
      'system/devPublishedSeed': { firstManifestHash: 'earlier-seed' },
      'system/billing': { disabled: true },
      'cmsPublishQueue/pending': { status: 'pending' },
      'cmsSettings/site-navigation': { values: { dev: 'local' } },
      'mediaCategories/dev-seed': { id: 'dev-seed', label: 'Dev seed' },
    };
    for (const [path, data] of Object.entries(protectedRows)) await dev.doc(path).set(data);
    // Configuration-only export must not depend on content/media validity or HTTP.
    await source.doc('cmsPages/contact').update({ published: { invalid: true } });
    const fetchImpl = vi.fn();
    const manifest = await exportSeed({ configurationOnly: true, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(manifest.counts).toEqual({ sections: 5, mediaCategories: 2 });
    expect(manifest.configurationOnly).toBe(true);
    expect(manifest.omissions).toEqual([]); expect(manifest.mediaUrls).toEqual([]);
    expect(validateManifest(JSON.parse(canonical(manifest))).hash).toBe(manifest.hash);
    expect(await importPublished({ firestore: dev, manifest })).toMatchObject({ applied: false, changed: 7, deleted: 0 });
    expect((await dev.collection('sections').get()).empty).toBe(true);
    expect(await importPublished({ firestore: dev, manifest, apply: true })).toMatchObject({ changed: 7, deleted: 0 });
    expect(await importPublished({ firestore: dev, manifest: await exportSeed({ configurationOnly: true }), apply: true })).toMatchObject({ changed: 0, unchanged: 7 });
    for (const [path, data] of Object.entries(protectedRows)) expect((await dev.doc(path).get()).data()).toEqual(data);
    expect(await contentSections.unregisteredSections(dev, ['news'])).toEqual([]);
  });
  it('does not initialize publication controls during a configuration-only first import', async () => {
    const manifest = await exportSeed({ configurationOnly: true });
    await importPublished({ firestore: dev, manifest, apply: true });
    expect((await dev.collection('system').get()).empty).toBe(true);
    expect((await dev.collection('cmsPosts').get()).empty).toBe(true);
    expect((await dev.collection('devSeedRecords').get()).size).toBe(7);
  });
  it.each(['untracked', 'edited', 'deleted'])('refuses a %s configuration conflict before any writes', async kind => {
    const manifest = await exportSeed({ configurationOnly: true });
    if (kind === 'untracked') await dev.doc('sections/news').set({ id: 'news', label: 'Existing dev news' });
    else {
      await importPublished({ firestore: dev, manifest, apply: true });
      if (kind === 'edited') await dev.doc('sections/news').update({ label: 'Dev staff edit' });
      else await dev.doc('sections/news').delete();
    }
    await source.doc('mediaCategories/general').update({ label: 'Changed source label', version: 2 });
    const newer = await exportSeed({ configurationOnly: true });
    await expect(importPublished({ firestore: dev, manifest: newer, apply: true })).rejects.toThrow(/Dev (edit|deletion) conflict/);
    const general = await dev.doc('mediaCategories/general').get();
    if (kind === 'untracked') expect(general.exists).toBe(false);
    else expect(general.data().label).toBe('General');
  });
  it('updates untouched registry hashes and retains configuration removed from a later source', async () => {
    await source.doc('sections/sports').set({ id: 'sports', label: 'Sports', description: '', order: 8 });
    const manifest = await exportSeed({ configurationOnly: true });
    await importPublished({ firestore: dev, manifest, apply: true });
    await source.doc('sections/news').update({ label: 'News desk' });
    await source.doc('sections/sports').delete();
    const newer = await exportSeed({ configurationOnly: true });
    expect(await importPublished({ firestore: dev, manifest: newer, apply: true })).toMatchObject({ changed: 1, unchanged: 6, deleted: 0 });
    expect((await dev.doc('sections/news').get()).data().label).toBe('News desk');
    expect((await dev.doc('sections/sports').get()).exists).toBe(true);
  });
  it.each([
    ['sections/news', { label: '' }], ['sections/news', { id: 'watch' }],
    ['mediaCategories/general', { active: 'true' }], ['mediaCategories/general', { version: 0 }],
  ])('refuses malformed source configuration at %s', async (path, patch) => {
    await source.doc(path).update(patch);
    await expect(exportSeed({ configurationOnly: true })).rejects.toThrow(/Invalid editor configuration/);
  });
  it('refuses missing prerequisites and a source collision with the local dev-seed category', async () => {
    await source.doc('sections/news').delete();
    await expect(exportSeed()).rejects.toThrow('Missing required editor configuration: sections/news');
    await source.doc('sections/news').set(contentSections.SEEDED_CONTENT_SECTIONS.find(item => item.id === 'news'));
    await source.doc('mediaCategories/dev-seed').set({ id: 'dev-seed', label: 'Source collision', description: '', order: 1, active: true, version: 1 });
    await expect(exportSeed()).rejects.toThrow('reserved dev-seed category');
  });
  it.each(['extra-field', 'false-live', 'version', 'missing-news', 'content', 'private-collection'])('refuses rehashed unsafe configuration manifests: %s', async attack => {
    const manifest = await exportSeed({ configurationOnly: true });
    const record = manifest.records.find(item => item.collection === 'sections' && item.id === 'news');
    if (attack === 'extra-field') record.projection.grants = [{ role: 'super-admin' }];
    if (attack === 'false-live') record.confirmedLive = true;
    if (attack === 'version') record.sourceVersion = 2;
    if (attack === 'missing-news') manifest.records = manifest.records.filter(item => item !== record);
    if (attack === 'content') manifest.records.push((await exportSeed()).records.find(item => item.collection === 'cmsPages'));
    if (attack === 'private-collection') record.collection = 'users';
    record.hash = digest(record.projection);
    const { hash, ...body } = manifest;
    manifest.hash = digest(body);
    expect(() => validateManifest(manifest)).toThrow();
    await expect(importPublished({ firestore: dev, manifest, apply: true })).rejects.toThrow();
    expect(await dev.listCollections()).toEqual([]);
  });
  it('runs native configuration-only export, validate, dry-run and import with no control writes', async () => {
    const receiptFile = join(directory, 'configuration-publication.json');
    await writeFile(receiptFile, JSON.stringify(publication));
    const cli = args => spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/seed-dev-published.mjs', ...args], { encoding: 'utf8', input: '' });
    const exported = cli(['export', '--emulator', '--configuration-only', '--source-sha', sourceSha, '--publication', receiptFile, '--output', directory]);
    expect(exported.status, exported.stderr).toBe(0);
    const { path } = JSON.parse(exported.stdout);
    const validated = cli(['validate', '--manifest', path]);
    expect(validated.status, validated.stderr).toBe(0);
    for (const apply of [false, true]) {
      const result = cli(['import', '--emulator', '--configuration-only', '--manifest', path, ...(apply ? ['--apply'] : [])]);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ applied: apply, changed: 7, deleted: 0 });
      expect((await dev.doc('sections/news').get()).exists).toBe(apply);
    }
    expect((await dev.collection('system').get()).empty).toBe(true);
    const fullPath = join(directory, 'full-manifest.json');
    await writeFile(fullPath, canonical(await exportSeed()));
    const refused = cli(['import', '--emulator', '--configuration-only', '--manifest', fullPath, '--apply']);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('requires a configuration-only export');
  });
  it('rejects brand-host PDFs at export, validation and import while preserving media-host documents', async () => {
    const pdfUrl = 'https://media.njpbs.org/cms-media/notice.pdf';
    const brandUrl = 'https://njpbs.org/brand/notice.pdf';
    await source.doc('cmsPages/contact').update({ 'published.blocks': [{
      id: 'notices', type: 'document_list', order: 0, visible: true,
      data: { documents: [{ itemId: 'notice', assetId: 'pdf-notice', title: 'Meeting notice', addedAt: when }] },
    }] });
    await source.doc('media_assets_public/pdf-notice').set({ url: pdfUrl, mimeType: 'application/pdf' });
    const fetchImpl = async () => new Response(null, { headers: { 'content-type': 'application/pdf', 'content-length': '100' } });
    const manifest = await exportSeed({ fetchImpl });
    expect(validateManifest(manifest).hash).toBe(manifest.hash);

    // The review scenario must fail by host/type policy, even with valid hashes.
    const invalid = structuredClone(manifest);
    const asset = invalid.records.find(record => record.id === 'pdf-notice');
    asset.projection.url = brandUrl;
    asset.hash = digest(asset.projection);
    invalid.mediaUrls = [];
    const { hash, ...body } = invalid;
    invalid.hash = digest(body);
    expect(() => validateManifest(invalid)).toThrow('Public PDF URL must use the media host');
    await expect(importPublished({ firestore: dev, manifest: invalid, apply: true })).rejects.toThrow('Public PDF URL must use the media host');
    expect(await dev.listCollections()).toEqual([]);

    await importPublished({ firestore: dev, manifest, apply: true });
    const imported = (await dev.doc('media_assets_public/pdf-notice').get()).data();
    const rendered = publicProjection.projectPublicPageDocument({ pageId: 'contact',
      document: (await dev.doc('cmsPages/contact').get()).data(), assets: new Map([['pdf-notice', imported]]), now: new Date() });
    expect(rendered.state).toBe('live');
    expect(rendered.page.assets['pdf-notice']).toEqual({ url: pdfUrl, mimeType: 'application/pdf' });

    await source.doc('media_assets_public/pdf-notice').update({ url: brandUrl });
    await expect(exportSeed({ fetchImpl })).rejects.toThrow('Public PDF URL must use the media host');
  });
  it('exports, validates and imports all seven launch assets from the repository backfill unchanged', async () => {
    const ids = ['launch-contact', 'launch-give', 'launch-passport', 'launch-politics', 'launch-support', 'launch-under-the-dome', 'launch-watch'];
    await backfillPageSeedMedia({ firestore: source, nowIso: when });
    await source.doc('cmsPages/contact').update({ 'published.blocks': [page().published.blocks[0], ...ids.map((assetId, index) => ({
      id: `launch-image-${index}`, type: 'image', order: index + 1, visible: true, data: { assetId, alt: assetId, decorative: false },
    }))] });
    const fetchHead = vi.fn(async url => {
      if (url === mediaUrl) return new Response(null, { headers: { 'content-type': 'image/png', 'content-length': String(mediaBytes.length) } });
      const seed = PAGE_SEED_MEDIA.find(item => ids.includes(item.id) && url === `https://njpbs.org/${item.path}`);
      expect(seed).toBeDefined();
      const bytes = await readFile(new URL(`../../site/public/${seed.path}`, import.meta.url));
      return new Response(null, { headers: { 'content-type': seed.mimeType, 'content-length': String(bytes.length) } });
    });
    const manifest = await exportSeed({ fetchImpl: fetchHead });
    expect(manifest.counts).toEqual({ cmsPages: 1, media_assets_public: 8, sections: 5, mediaCategories: 2 });
    expect(fetchHead).toHaveBeenCalledTimes(8);
    for (const id of ids) expect(fetchHead).toHaveBeenCalledWith(`https://njpbs.org/brand/spotlight/${id.slice(7)}.jpg`,
      expect.objectContaining({ method: 'HEAD', redirect: 'manual', credentials: 'omit' }));
    expect(validateManifest(JSON.parse(canonical(manifest))).hash).toBe(manifest.hash);
    const manifestFile = join(directory, 'launch-manifest.json');
    await writeFile(manifestFile, canonical(manifest));
    const validation = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/seed-dev-published.mjs',
      'validate', '--manifest', manifestFile], { encoding: 'utf8', input: '' });
    expect(validation.status, validation.stderr).toBe(0);
    // Brand files remain a public dependency, outside the optional CMS-media copy.
    expect(manifest.mediaUrls).toEqual([mediaUrl]);
    const copyFetch = vi.fn(async () => new Response(mediaBytes, { headers: { 'content-type': 'image/png' } }));
    const copy = await copyMedia({ manifest, directory, fetchImpl: copyFetch });
    expect(copyFetch).toHaveBeenCalledExactlyOnceWith(mediaUrl, expect.objectContaining({ redirect: 'manual', credentials: 'omit' }));
    await importPublished({ firestore: dev, manifest, copy, apply: true });
    const assets = new Map();
    for (const id of ['image-1', ...ids]) {
      const imported = (await dev.doc(`media_assets_public/${id}`).get()).data();
      assets.set(id, imported);
      if (id !== 'image-1') expect(imported.url).toBe(`https://njpbs.org/brand/spotlight/${id.slice(7)}.jpg`);
    }
    const rendered = publicProjection.projectPublicPageDocument({ pageId: 'contact',
      document: (await dev.doc('cmsPages/contact').get()).data(), assets, now: new Date() });
    expect(rendered.state).toBe('live');
    for (const id of ids) expect(rendered.page.assets[id].url).toBe(assets.get(id).url);
  });
  it.each([
    'http://njpbs.org/brand/spotlight/contact.jpg',
    'https://njpbs.org:444/brand/spotlight/contact.jpg',
    'https://njpbs.org.evil.test/brand/spotlight/contact.jpg',
    'https://www.njpbs.org/brand/spotlight/contact.jpg',
    'https://dev-public.example.org/brand/spotlight/contact.jpg',
    'https://dev-media.example.org/cms-media/contact.jpg',
    'https://127.0.0.1/brand/spotlight/contact.jpg',
    'https://user:fixture-df18f8782c@example.org/brand/spotlight/contact.jpg',
    'https://njpbs.org/brand/spotlight/contact.jpg?token=secret',
    'https://njpbs.org/brand/spotlight/contact.jpg#fragment',
    'https://njpbs.org/cms-media/contact.jpg',
    'https://media.njpbs.org/brand/spotlight/contact.jpg',
    'https://njpbs.org/brand-other/contact.jpg',
    'https://njpbs.org/brand/../private/contact.jpg',
    'https://njpbs.org/brand/spotlight%2fcontact.jpg',
    'https://njpbs.org/brand/private/contact.jpg',
    'https://njpbs.org/brand/originals/contact.jpg',
    'https://njpbs.org/brand/staging/contact.jpg',
  ])('refuses off-policy media before HTTP at the exporter boundary: %s', async url => {
    await source.doc('media_assets_public/image-1').update({ url });
    const fetchImpl = vi.fn();
    await expect(exportSeed({ fetchImpl })).rejects.toThrow('Media URL is outside the public allowlist');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([
    [302, 'image/png', '1'],
    [200, 'text/html', '1'],
    [200, 'image/png', '0'],
    [200, 'image/png', String(25 * 1024 * 1024 + 1)],
  ])('checks brand HEAD status, type and bounded size: %s %s %s', async (status, mimeType, size) => {
    await source.doc('media_assets_public/image-1').update({ url: 'https://njpbs.org/brand/spotlight/contact.jpg' });
    const headers = { 'content-type': mimeType, location: 'https://127.0.0.1/private' };
    if (size !== null) headers['content-length'] = size;
    const fetchImpl = vi.fn(async () => new Response(null, { status, headers }));
    await expect(exportSeed({ fetchImpl })).rejects.toThrow(/Cannot verify public media metadata|Invalid public media size/);
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith('https://njpbs.org/brand/spotlight/contact.jpg',
      expect.objectContaining({ method: 'HEAD', redirect: 'manual', credentials: 'omit' }));
  });
  it('uses a valid HEAD length without GET or the stored size', async () => {
    await source.doc('media_assets_public/image-1').update({ sizeBytes: 999 });
    const fetchImpl = vi.fn(async () => new Response(null, { headers: {
      'content-type': 'image/png', 'content-length': String(mediaBytes.length),
    } }));
    const manifest = await exportSeed({ fetchImpl });
    expect(manifest.records.find(record => record.id === 'image-1').projection.sizeBytes).toBe(mediaBytes.length);
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(mediaUrl,
      expect.objectContaining({ method: 'HEAD', redirect: 'manual', credentials: 'omit', signal: expect.any(AbortSignal) }));
  });
  it.each([null, '', 'unknown', '1.5'])('measures a streamed brand GET when HEAD length is %s', async headLength => {
    const url = 'https://njpbs.org/brand/newsletter/abstract-blue-folds.webp';
    await source.doc('media_assets_public/image-1').update({ url, mimeType: 'image/webp', sizeBytes: 999 });
    const headers = { 'content-type': 'image/webp; charset=binary' };
    if (headLength !== null) headers['content-length'] = headLength;
    const fetchImpl = vi.fn(async (_url, options) => options.method === 'HEAD'
      ? new Response(null, { headers })
      : new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4, 5]));
        controller.close();
      } }), { headers: { 'content-type': 'image/webp', 'content-length': '5' } }));
    const manifest = await exportSeed({ fetchImpl });
    expect(manifest.records.find(record => record.id === 'image-1').projection.sizeBytes).toBe(5);
    expect(validateManifest(manifest).hash).toBe(manifest.hash);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [index, method] of ['HEAD', 'GET'].entries()) expect(fetchImpl).toHaveBeenNthCalledWith(index + 1, url,
      expect.objectContaining({ method, redirect: 'manual', credentials: 'omit', signal: expect.any(AbortSignal) }));
  });
  it('aborts and cancels an oversized GET stream at the 25 MiB boundary', async () => {
    let signal; let chunks = 0;
    const cancel = vi.fn();
    const fetchImpl = async (_url, options) => {
      if (options.method === 'HEAD') return new Response(null, { headers: { 'content-type': 'image/png' } });
      signal = options.signal;
      return new Response(new ReadableStream({
        pull(controller) { chunks++; controller.enqueue(new Uint8Array(chunks === 1 ? 25 * 1024 * 1024 : 1)); },
        cancel,
      }, { highWaterMark: 0 }), { headers: { 'content-type': 'image/png' } });
    };
    await expect(exportSeed({ fetchImpl })).rejects.toThrow('Invalid public media size');
    expect(signal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(chunks).toBe(2);
  });
  it.each([
    [302, 'image/png', null, 'bytes', /Cannot verify public media metadata/],
    [404, 'image/png', null, 'bytes', /Cannot verify public media metadata/],
    [200, 'text/html', null, 'bytes', /Cannot verify public media metadata/],
    [200, 'image/jpeg', null, 'bytes', /Cannot verify public media metadata/],
    [200, 'image/png', null, null, /Invalid public media size/],
    [200, 'image/png', '0', null, /Invalid public media size/],
    [200, 'image/png', String(25 * 1024 * 1024 + 1), 'bytes', /Invalid public media size/],
    [200, 'image/png', 'unknown', 'bytes', /Invalid public media size/],
    [200, 'image/png', '4', 'bytes', /length does not match streamed bytes/],
    [200, 'image/png', '6', 'bytes', /length does not match streamed bytes/],
  ])('refuses unsafe GET responses after a lengthless HEAD: %s %s %s', async (status, mimeType, length, body, error) => {
    let signal;
    const fetchImpl = vi.fn(async (_url, options) => {
      if (options.method === 'HEAD') return new Response(null, { headers: { 'content-type': 'image/png' } });
      signal = options.signal;
      const headers = { 'content-type': mimeType, location: 'https://127.0.0.1/private' };
      if (length !== null) headers['content-length'] = length;
      return new Response(body, { status, headers });
    });
    await expect(exportSeed({ fetchImpl })).rejects.toThrow(error);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(signal.aborted).toBe(true);
  });
  it('accepts a GET without Content-Length at exactly 25 MiB', async () => {
    const fetchImpl = async (_url, options) => new Response(
      options.method === 'HEAD' ? null : new Uint8Array(25 * 1024 * 1024),
      { headers: { 'content-type': 'image/png' } });
    const manifest = await exportSeed({ fetchImpl });
    expect(manifest.records.find(record => record.id === 'image-1').projection.sizeBytes).toBe(25 * 1024 * 1024);
  });
  it('exports only immutable public content and public settings; excludes private collections and fields', async () => {
    await source.doc('cmsPages/draft-only').set({ ...page(), publiclyVisible: false });
    await source.doc('cmsPages/deleted').set({ ...page(), deleted: true });
    await source.doc('cmsPages/future').set({ ...page(), status: 'published', publishAt: '2099-01-01T00:00:00.000Z' });
    await source.doc('cmsPosts/staff').set({ ...page(), type: 'staff', published: { ...page().published, metadata: { title: 'Staff private', type: 'staff' } } });
    for (const name of ['users', 'admin_logs', 'cmsStaffRecords', 'cmsAuthorProfiles', 'media_assets', 'cmsPublishQueue']) await source.doc(`${name}/private`).set({ email: 'private@example.test', secret: 'private marker' });
    const values = settings.DEFAULT_PUBLIC_HOMEPAGE_BANNER_SETTINGS;
    await source.doc('cmsSettings/public-homepage-banner').set({ version: 7, values: { ...values, message: 'Draft banner' },
      published: { schemaVersion: 1, values, sourceVersion: 3, publishedAt: when } });
    const manifest = await exportSeed();
    expect(manifest.counts).toEqual({ cmsPages: 1, cmsSettings: 1, media_assets_public: 1, sections: 5, mediaCategories: 2 });
    const content = manifest.records.find(record => record.collection === 'cmsPages');
    expect(content.projection.metadata.title).toBe('Public title');
    expect(content.sourceVersion).toBe(4); expect(content.confirmedLive).toBe(false);
    expect(content.projection.publishedBy).toBe(ACTOR);
    expect(manifest.records.find(record => record.collection === 'cmsSettings').projection.values.message).toBe(values.message);
    for (const privateValue of ['Private working draft', 'Draft banner', 'private marker', 'private snapshot note', 'production-user', 'Do not export', 'Hidden draft note', '@example.test', 's3://']) expect(canonical(manifest)).not.toContain(privateValue);
    expect(manifest.publication.generation).toBe(42);
    expect(validateManifest(JSON.parse(canonical(manifest))).hash).toBe(manifest.hash);
  });
  it('keeps routed immutable Post, Program, Event and public author fields without private profiles', async () => {
    const authorId = `au_${'1'.repeat(32)}`;
    const richText = { type: 'doc', notes: 'Hidden rich text extension', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Public description' }] }] };
    const metadata = { title: 'Public story', slug: 'story', previousSlugs: [], locale: 'en' };
    for (const type of ['post', 'program', 'event']) {
      await source.doc(`cmsPosts/${type}-one`).set({ ...page(), type, published: {
        ...page().published, blocks: [], metadata: { ...metadata, type,
          ...(type === 'post' ? { tags: [], date: '2026-01-01', credits: [{ kind: 'registered', authorId, displayName: 'Public author', slug: 'public-author' }] } : { description: richText }),
          ...(type === 'event' ? { startsAt: '2026-01-02T12:00:00.000Z' } : {}),
        } } });
    }
    await source.doc(`cmsAuthorProfilesPublic/${authorId}`).set({ authorId, slug: 'public-author', displayName: 'Public author',
      jobTitle: 'Reporter', bio: 'Public biography', previousSlugs: [],
      photo: { assetId: 'image-1', url: mediaUrl, mimeType: 'image/png', width: 2, height: 2, focalX: 0.5, focalY: 0.5, credit: 'Public credit' }, links: {}, publishedAt: when, snapshotVersion: 2,
      uid: 'production-uid', email: 'author@example.test', privateBiography: 'private author note' });
    await source.doc(`cmsAuthorProfiles/${authorId}`).set({ bio: 'New private biography' });
    const manifest = await exportSeed();
    expect(manifest.counts.cmsPosts).toBe(3); expect(manifest.counts.cmsAuthorProfilesPublic).toBe(1);
    for (const text of ['production-uid', '@example.test', 'private author note', 'New private biography', 'Hidden rich text extension']) expect(canonical(manifest)).not.toContain(text);
    const copy = await copied(manifest);
    await importPublished({ firestore: dev, manifest, copy, apply: true });
    expect((await dev.doc(`cmsBylineDirectory/${authorId}`).get()).data().displayName).toBe('Public author');
    expect((await dev.doc(`cmsAuthorProfiles/${authorId}`).get()).data()).toMatchObject({ uid: null, bio: 'Public biography' });
    expect((await dev.collection('users').get()).empty).toBe(true);
    expect((await dev.doc(`cmsAuthorProfilesPublic/${authorId}`).get()).data().photo.url).toBe(mediaUrl);
    expect((await dev.doc(`cmsAuthorProfiles/${authorId}`).get()).data().photo).toBeNull();
    expect((await dev.doc('cmsPosts/post-one').get()).data().published.metadata.credits[0].displayName).toBe('Public author');
    const author = manifest.records.find(record => record.collection === 'cmsAuthorProfilesPublic').projection;
    const cutoffAt = Timestamp.fromDate(new Date(when));
    const receipt = createPublicArtifactInventoryReceipt({ reservation: { schemaVersion: 1, buildBatchId: 'build-1', generation: 42,
      status: 'reserved', commitSha: sourceSha, reservedAgainstGeneration: 41, reservedAgainstDeploymentId: 'deployment-41',
      reservedAgainstCommitSha: sourceSha, cutoffAt, reservedAt: cutoffAt }, pages: [], posts: [], programs: [], settings: [],
      authors: [{ documentId: authorId, sourceVersion: 2, canonicalPath: '/authors/public-author/', aliases: [], publishedSnapshot: author }] });
    const context = { schemaVersion: 3, pages: [], posts: [], programs: [], events: [], settings: [], recordCards: [], receipt,
      authors: [{ ...author, path: '/authors/public-author/', sourceVersion: 2 }] };
    const live = { ...publication, artifactReceiptDigest: createHash('sha256').update(JSON.stringify(receipt)).digest('hex'), mediaManifestDigest: receipt.mediaManifestDigest };
    await source.doc('system/publicDeployment/buildBatches/build-1/candidates/worker').set(live);
    const confirmed = await exportSeed({ publication: live, context });
    expect(confirmed.records.find(record => record.collection === 'cmsAuthorProfilesPublic').confirmedLive).toBe(true);
  });
  it('copies a referenced Sponsor only from the matched retained release', async () => {
    await source.doc('cmsPages/contact').update({ 'published.blocks': [{ id: 'sponsors', type: 'sponsor_strip', order: 0, visible: true,
      data: { heading: 'Sponsors', sponsorIds: ['sponsor-1', 'missing-sponsor'], layout: 'grid' } },
      { id: 'missing-event', type: 'record_card', order: 1, visible: true, data: { recordKind: 'event', recordId: 'missing-event', variant: 'card' } }] });
    await source.doc('cmsPosts/sponsor-1').set({ type: 'sponsor', name: 'Unreleased sponsor', status: 'approved' });
    const cutoffAt = Timestamp.fromDate(new Date(when));
    const receipt = createPublicArtifactInventoryReceipt({ reservation: { schemaVersion: 1, buildBatchId: 'build-1', generation: 42,
      status: 'reserved', commitSha: sourceSha, reservedAgainstGeneration: 41, reservedAgainstDeploymentId: 'deployment-41',
      reservedAgainstCommitSha: sourceSha, cutoffAt, reservedAt: cutoffAt }, pages: [], posts: [], programs: [], authors: [], settings: [],
      libraryCards: [{ documentId: 'sponsor-1', sourceVersion: 2, kind: 'sponsor', assetIds: [] }] });
    const context = { schemaVersion: 3, pages: [], posts: [], programs: [], events: [], authors: [], settings: [], receipt,
      recordCards: [{ kind: 'sponsor', id: 'sponsor-1', title: 'Released sponsor', href: 'https://example.test/', sourceVersion: 2,
        sponsor: { sponsorId: 'sponsor-1', name: 'Released sponsor', href: 'https://example.test/', logoUrl: null, logoAlt: '', logoDecorative: true } }] };
    const live = { ...publication, artifactReceiptDigest: createHash('sha256').update(JSON.stringify(receipt)).digest('hex'), mediaManifestDigest: receipt.mediaManifestDigest };
    await source.doc('system/publicDeployment/buildBatches/build-1/candidates/worker').set(live);
    const manifest = await exportSeed({ publication: live, context });
    expect(manifest.records.find(record => record.collection === 'cards').projection.name).toBe('Released sponsor');
    expect(canonical(manifest)).not.toContain('Unreleased sponsor');
    expect(manifest.omissions).toEqual(expect.arrayContaining([
      expect.objectContaining({ collection: 'cards', id: 'missing-sponsor' }),
      expect.objectContaining({ collection: 'cmsPosts', id: 'missing-event' }),
    ]));
    await importPublished({ firestore: dev, manifest, copy: await copied(manifest), apply: true });
    expect((await dev.doc('cmsPosts/sponsor-1').get()).data().name).toBe('Released sponsor');
  });
  it('retains built-in navigation fallbacks and redacts mailto settings without breaking their schema', async () => {
    const values = structuredClone(DEFAULT_SITE_NAVIGATION);
    values.header.push({ id: 'email', label: 'Email', target: { type: 'href', href: 'mailto:desk@example.test' }, external: false });
    await source.doc('cmsSettings/site-navigation').set({ version: 1, published: { schemaVersion: 1, values, sourceVersion: 1, publishedAt: when } });
    await source.doc('cmsSettings/public-site-chrome').set({ version: 1, published: { schemaVersion: 1,
      values: { newsletterEnabled: true, newsletterLabel: 'Newsletter', newsletterHref: 'mailto:newsletter@example.test', newsletterOpensInNewTab: false }, sourceVersion: 1, publishedAt: when } });
    const manifest = await exportSeed();
    expect(manifest.omissions).toContainEqual(expect.objectContaining({ collection: 'cmsPages', id: 'live' }));
    const navigation = manifest.records.find(record => record.id === 'site-navigation').projection.values;
    expect(navigation.header.find(link => link.id === 'email').target.href).toBe('/contact/');
    expect(manifest.records.find(record => record.id === 'public-site-chrome').projection.values.newsletterHref).toBe('/contact/');
    expect(canonical(manifest)).not.toContain('@example.test');
    await importPublished({ firestore: dev, manifest, apply: true });
    await source.doc('cmsSettings/public-site-chrome').update({ 'published.values.newsletterEnabled': 'invalid' });
    await expect(exportSeed()).rejects.toThrow('Invalid published contract: cmsSettings/public-site-chrome');
  });
  it('keeps outbound PDF and image links outside the media copy inventory', async () => {
    const urls = ['https://www.nj.gov/reports/report.pdf', 'https://example.test/chart.png'];
    await source.doc('cmsPages/contact').update({ 'published.blocks': urls.map((url, index) => ({
      id: `link-${index}`, type: 'link_card', order: index, visible: true, data: { title: 'Public report', url },
    })) });
    const manifest = await exportSeed();
    expect(manifest.mediaUrls).toEqual([]);
    expect(manifest.records.find(record => record.collection === 'cmsPages').projection.blocks.map(block => block.data.url)).toEqual(urls);
  });
  it('starts the documented native CLI and reports safe target and retained-context diagnostics', async () => {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/seed-dev-published.mjs',
      'validate', '--source', DESTINATION, '--destination', SOURCE], { encoding: 'utf8', input: '' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Only njpbs-site -> njpbs-site-dev is permitted');
    const receiptFile = join(directory, 'receipt.json'); const contextFile = join(directory, 'context.json');
    await writeFile(receiptFile, JSON.stringify(publication));
    await writeFile(contextFile, JSON.stringify({ receipt: { privateNote: 'Do not echo this input' } }));
    const contextResult = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/seed-dev-published.mjs',
      'export', '--emulator', '--source-sha', sourceSha, '--publication', receiptFile, '--context', contextFile,
      '--output', directory], { encoding: 'utf8', input: '' });
    expect(contextResult.status).toBe(1);
    expect(contextResult.stderr).toContain('Dev seed refused: Invalid published contract: publication/retained-context');
    expect(contextResult.stderr).not.toContain('Do not echo this input');
  });
  it('imports published video URLs unchanged and keeps the renderer contract valid', async () => {
    await source.doc('cmsPages/contact').update({ 'published.blocks': [{ id: 'video', type: 'video', order: 0, visible: true,
      data: { sourceId: 'video-library', assetId: 'video-one', title: 'Published video', public: {
        url: `https://media.njpbs.org/cms-media/video/video-one/${'a'.repeat(64)}.mp4`,
        posterUrl: `https://media.njpbs.org/cms-media/video/video-one/${'b'.repeat(64)}.jpg`, mimeType: 'video/mp4', width: 640, height: 360,
      } } }] });
    const manifest = await exportSeed();
    await importPublished({ firestore: dev, manifest, apply: true });
    const record = (await dev.doc('cmsPages/contact').get()).data();
    expect(record.published.blocks[0].data.public.url).toBe(`https://media.njpbs.org/cms-media/video/video-one/${'a'.repeat(64)}.mp4`);
    expect(blocks.parseBlocks(record.blocks, { complete: true }).ok).toBe(true);
  });
  it('refuses every other project pair and mismatched clients before any writes', async () => {
    for (const pair of [[DESTINATION, SOURCE], [SOURCE, SOURCE], ['other', DESTINATION], [SOURCE, 'other']]) expect(() => assertPair(...pair)).toThrow();
    await expect(exportPublished({ firestore: dev, sourceSha, publication })).rejects.toThrow('project');
    await expect(importPublished({ firestore: source, manifest: {}, copy: {}, apply: true })).rejects.toThrow('project');
  });
  it('uses one historical snapshot and produces a deterministic manifest at that read time', async () => {
    const first = await exportSeed();
    const readTime = new Timestamp(first.readTime.seconds, first.readTime.nanoseconds);
    await source.doc('cmsPages/contact').update({ 'published.metadata.title': 'Later publication' });
    const again = await exportSeed({ readTime });
    expect(canonical(again)).toBe(canonical(first));
    expect((await exportSeed()).records.find(record => record.collection === 'cmsPages').projection.metadata.title).toBe('Later publication');
  });
  it('defaults to dry run, imports editable records and media, and repeats as a no-op', async () => {
    const manifest = await exportSeed(); const copy = await copied(manifest);
    const before = await importPublished({ firestore: dev, manifest });
    expect(before.applied).toBe(false); expect((await dev.doc('cmsPages/contact').get()).exists).toBe(false);
    const first = await importPublished({ firestore: dev, manifest, copy, apply: true });
    expect(first.changed).toBe(11);
    const record = (await dev.doc('cmsPages/contact').get()).data();
    const publicPage = publicProjection.projectPublicPageDocument({ pageId: 'contact', document: record,
      assets: new Map([['image-1', (await dev.doc('media_assets_public/image-1').get()).data()]]), now: new Date() });
    expect(publicPage.state).toBe('live');
    expect(publicPage.page.assets['image-1'].url).toBe(mediaUrl);
    expect(record.title).toBe('Public title'); expect(record.version).toBe(4); expect(record.createdBy).toBe(ACTOR);
    const media = (await dev.doc('media_assets/image-1').get()).data();
    expect(media.url).toBe(mediaUrl); expect(media.mediaDiscovery.eligible).toBe(true);
    expect((await dev.doc('media_assets_public/image-1').get()).data()).toEqual(mediaContract.mediaProjection(media));
    expect(await mediaSafety.assertPublishedMediaSafe({ firestore: dev })).toMatchObject({ assetCount: 1 });
    const usage = mediaUsage.collectPublishedMediaUsage({ collection: 'cmsPages', documentId: 'contact',
      documentVersion: record.version, snapshot: record.published });
    const prepared = await dev.runTransaction(transaction => mediaUsage.prepareMediaUsageWrites({ firestore: dev,
      transaction, collection: 'cmsPages', documentId: 'contact', states: [{ state: 'published', sourceVersion: record.version, usage }] }));
    expect(prepared.published.document.assetIds).toEqual(['image-1']);
    expect((await dev.doc('mediaCategories/dev-seed').get()).exists).toBe(true);
    expect((await dev.doc('system/publicDeployment').get()).data().activeGeneration).toBe(0);
    expect((await importPublished({ firestore: dev, manifest, copy, apply: true })).changed).toBe(0);
    expect((await source.doc('cmsPages/contact').get()).data().title).toBe('Private working draft');
    const later = await exportSeed();
    expect((await importPublished({ firestore: dev, manifest: later, copy: await copied(later), apply: true })).changed).toBe(0);
  });
  it('imports more than one transaction group and safely updates an untouched seed', async () => {
    const batch = source.batch();
    for (let index = 0; index < 101; index++) {
      const record = page(); record.published.metadata.slug = `seed-${index}`;
      batch.set(source.doc(`cmsPages/page-${index.toString(16).padStart(32, '0')}`), record);
    }
    await batch.commit();
    const manifest = await exportSeed();
    const copy = await copied(manifest);
    const first = await importPublished({ firestore: dev, manifest, copy, apply: true });
    expect(first.changed).toBe(112);
    expect((await importPublished({ firestore: dev, manifest, copy, apply: true })).unchanged).toBe(112);
    await source.doc('cmsPages/contact').update({ 'published.metadata.title': 'Updated public title', 'published.sourceVersion': 5 });
    const newer = await exportSeed();
    expect((await importPublished({ firestore: dev, manifest: newer, copy: await copied(newer), apply: true })).changed).toBe(1);
    expect((await dev.doc('cmsPages/contact').get()).data().title).toBe('Updated public title');
  });
  it('refuses staff edits atomically, including edits to public media', async () => {
    const manifest = await exportSeed(); const copy = await copied(manifest);
    await importPublished({ firestore: dev, manifest, copy, apply: true });
    await dev.doc('media_assets_public/image-1').update({ altText: 'Dev staff edit' });
    await expect(importPublished({ firestore: dev, manifest, copy, apply: true })).rejects.toThrow('Dev edit conflict');
    expect((await dev.doc('media_assets_public/image-1').get()).data().altText).toBe('Dev staff edit');
  });
  it('does not recreate a deleted seeded record or erase records missing from a later seed', async () => {
    const manifest = await exportSeed(); const copy = await copied(manifest);
    await importPublished({ firestore: dev, manifest, copy, apply: true });
    await dev.doc('cmsPages/contact').delete();
    await expect(importPublished({ firestore: dev, manifest, copy, apply: true })).rejects.toThrow('explicit reset');
    await dev.doc('cmsPages/local-page').set({ title: 'Dev-only work' });
    await source.doc('cmsPages/contact').update({ publiclyVisible: false });
    const next = await exportSeed(); const nextCopy = await copied(next);
    expect((await importPublished({ firestore: dev, manifest: next, copy: nextCopy, apply: true })).deleted).toBe(0);
    expect((await dev.doc('cmsPages/local-page').get()).data().title).toBe('Dev-only work');
  });
  it('requires a fresh dev coordinator and refuses a source receipt mismatch', async () => {
    await expect(exportSeed({ publication: {} })).rejects.toThrow('Invalid published contract: publication/receipt');
    await expect(exportSeed({ publication: { ...publication, generation: 41 } })).rejects.toThrow('active source generation');
    const manifest = await exportSeed(); const copy = await copied(manifest);
    await dev.doc('cmsPublishQueue/existing').set({ status: 'pending' });
    await expect(importPublished({ firestore: dev, manifest, copy, apply: true })).rejects.toThrow('empty queues');
  });
  it('refuses tampering, broken media references, and unreleased Sponsor cards', async () => {
    const manifest = await exportSeed(); manifest.records[0].projection.metadata.title = 'Tampered';
    expect(() => validateManifest(manifest)).toThrow('hash');
    await source.doc('media_assets_public/image-1').delete();
    await expect(exportSeed()).rejects.toThrow('Missing referenced public media');
    await source.doc('cmsPages/contact').update({ 'published.blocks': [{ id: 'sponsors', type: 'sponsor_strip', order: 0, visible: true, data: { heading: 'Sponsors', sponsorIds: ['sponsor-1'], layout: 'grid' } }] });
    await source.doc('cmsPosts/sponsor-1').set({ type: 'sponsor', name: 'Unreleased sponsor', status: 'approved' });
    await expect(exportSeed()).rejects.toThrow('retained released context');
  });
  it('copies only manifest URLs, hashes bytes, and refuses signed/private URLs or redirects', async () => {
    const manifest = await exportSeed(); const copy = await copied(manifest);
    const object = copy.objects[0]; const bytes = await readFile(join(directory, object.key));
    expect(object.hash).toBe(createHash('sha256').update(bytes).digest('hex'));
    for (const url of ['https://media.njpbs.org/cms-media/x?token=secret', 'http://media.njpbs.org/cms-media/x', 'https://127.0.0.1/cms-media/x', 'https://media.njpbs.org/private/x', 'https://user:fixture-12f58ab792@example.org/cms-media/x']) expect(() => assertPublicMediaUrl(url)).toThrow();
    await expect(copyMedia({ manifest, directory, fetchImpl: async () => new Response('unsupported', { headers: { 'content-type': 'application/octet-stream' } }) })).rejects.toThrow('Unsupported public media response');
    await expect(copyMedia({ manifest, directory, fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }) })).rejects.toThrow('redirected');
    const corrupted = structuredClone(copy); corrupted.objects[0].url = 'https://media.njpbs.org/production';
    const { hash, ...body } = corrupted; corrupted.hash = digest(body);
    await expect(importPublished({ firestore: dev, manifest, copy: corrupted, apply: true })).rejects.toThrow('mapping');
  });
});
