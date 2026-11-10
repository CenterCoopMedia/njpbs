#!/usr/bin/env -S node --experimental-strip-types
// This operator never uses ADC or production storage credentials. See the runbook.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { readFile, mkdir, writeFile, open, link, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { cert, initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import snapshotContract from '../functions/lib/publish-snapshot.js';
import blockContract from '../functions/lib/content-blocks.js';
import publicProjection from '../functions/lib/public-content-projection.js';
import pageContract from '../functions/lib/public-page-contract.js';
import settingsContract from '../functions/lib/cms-settings-contract.js';
import mediaUsage from '../functions/lib/media-usage.js';
import mediaContract from '../functions/lib/media-contract.js';
import mediaDiscovery from '../functions/lib/media-discovery.js';
import mediaCategories from '../functions/lib/media-categories.js';
import { parseContentSectionDefinition, SEEDED_CONTENT_SECTIONS } from '../packages/content-core/src/content-sections.ts';
import publicAssetHosts from '../functions/lib/public-asset-hosts.json' with { type: 'json' };
import authorContract from '../functions/lib/author-profile-contract.js';
import deploymentContract from '../functions/lib/public-deployment.js';
import { visibleLayoutBlocks } from '../packages/content-core/src/content-layout.ts';
import { isPublishable } from '../packages/content-core/src/publish-gate.ts';
import { assertContextMatchesPublication } from '../site/src/lib/retained-public-context.ts';
import { canonicalPublicationReceipt } from '../site/src/lib/public-publication-receipt.ts';

export const SOURCE = 'njpbs-site';
export const DESTINATION = 'njpbs-site-dev';
export const ACTOR = 'system:dev-published-seed';
const CONFIGURATION_FIELDS = {
  sections: ['id', 'label', 'description', 'order'],
  mediaCategories: ['id', 'label', 'description', 'order', 'active', 'version'],
};
const SETTINGS = ['public-homepage-banner', 'public-site-chrome', 'site-navigation'];
const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const PUBLIC_ORIGIN = 'https://media.njpbs.org';
const DEV_ORIGIN = 'https://dev-media.example.org';
const MAX_OBJECT_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
const COPY_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'application/pdf', 'video/mp4'];
const MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024;
const OMITTED = ['Auth users', 'staff records', 'drafts', 'revisions', 'audit logs', 'schedules',
  'queues', 'leases', 'reports', 'UGC', 'billing', 'private storage', 'private biographies', 'emails'];

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    if (typeof value.toDate === 'function') return canonical(value.toDate().toISOString());
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Non-JSON seed value');
  return JSON.stringify(value);
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
class SeedError extends Error {}
const fail = message => { throw new SeedError(message); };
function instant(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail('Invalid seed timestamp');
  return new Date(value).toISOString();
}
export function assertPair(source = SOURCE, destination = DESTINATION) {
  if (source !== SOURCE || destination !== DESTINATION) fail('Only njpbs-site -> njpbs-site-dev is permitted');
}
function assertDatabase(db, project) {
  if (db?.projectId !== project) fail('Firestore client project does not match the fixed target');
}

// Even public projections are rebuilt and scrubbed: a stale or manually edited row
// must not carry operational identities or private extension fields into a seed.
function publicRichText(node) {
  const result = pick(node, ['type', 'text']);
  if (result.text !== undefined) result.text = sanitize(result.text);
  if (node.attrs) result.attrs = sanitize(pick(node.attrs, ['level', 'href', 'allowLegacyHost']));
  if (node.content) result.content = node.content.map(publicRichText);
  if (node.marks) result.marks = node.marks.map(publicRichText);
  return result;
}
function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    if (value.type === 'doc' && Array.isArray(value.content)) return publicRichText(value);
    return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
      if (/^(?:__proto__|constructor|prototype)$/.test(key) ||
          /email|private|credential|secret|token|storage|objectKey|originalKey|transcript|internal|assigned|createdBy|updatedBy|uid$/i.test(key)) return [];
      if (/^(publishedBy|firstPublishedBy|meaningfulUpdatedBy)$/.test(key)) return [[key, ACTOR]];
      return [[key, sanitize(child)]];
    }));
  }
  if (typeof value === 'string') {
    if (/^mailto:/i.test(value)) return '/contact/';
    if (/^(?:gs|s3):\/\//i.test(value)) return '';
    return value.replace(/(?:mailto:)?[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted]');
  }
  return value;
}
function publicSnapshot(collection, id, value) {
  if (!ID.test(id)) fail('Invalid content identity');
  if (!value?.metadata || !Array.isArray(value.blocks)) fail(`Missing immutable projection: ${collection}/${id}`);
  const cleaned = sanitize(value);
  for (const key of ['seo', 'social']) if (cleaned.metadata[key]) cleaned.metadata[key] = pick(cleaned.metadata[key],
    key === 'seo' ? ['title', 'description', 'noindex', 'canonicalUrl'] : ['title', 'description', 'imageAssetId', 'imageAlt']);
  if (cleaned.metadata.credits) cleaned.metadata.credits = cleaned.metadata.credits.map(credit =>
    pick(credit, credit.kind === 'registered' ? ['kind', 'authorId', 'displayName', 'slug'] : ['kind', 'name']));
  if (collection === 'cmsPages' && !pageContract.publicPagePath(id, cleaned.metadata)) fail(`Invalid public page route: ${id}`);
  const parsed = blockContract.parseBlocks(cleaned.blocks, { complete: true, ...(collection === 'cmsPages' ? { pageId: id } : {}) });
  if (!parsed.ok) fail(`Invalid published blocks: ${collection}/${id}`);
  return snapshotContract.createPublishedSnapshot({ collection, document: {
    ...cleaned.metadata, id, blocks: visibleLayoutBlocks(parsed.blocks).map(block => block.type === 'bio_card'
      ? pick(block, ['id', 'type', 'section', 'layout', 'order', 'visible', 'data']) : publicProjection.selectedBlock(block)), version: value.sourceVersion,
    contentVersion: value.contentVersion ?? value.sourceVersion,
  }, publishedAt: instant(value.publishedAt), publishedBy: ACTOR });
}
function publicSetting(id, value) {
  const published = settingsContract.projectPublishedCmsSettings({
    documentId: id, document: { version: value.sourceVersion, published: value },
  });
  if (!published) fail(`Missing published setting: ${id}`);
  // Revalidate after redaction so a scrubbed URL cannot produce invalid settings.
  return settingsContract.projectPublishedCmsSettings({
    documentId: id, document: { version: value.sourceVersion, published: sanitize(published) },
  });
}
// These registries are current editor configuration at T, not published content.
// Never carry grants, actors, timestamps or arbitrary extension fields from them.
function editorConfiguration(collection, id, value) {
  if (!ID.test(id) || value?.id !== id) fail('Invalid editor configuration identity');
  const fields = CONFIGURATION_FIELDS[collection];
  const selected = sanitize(pick(value, fields));
  const parsed = collection === 'sections'
    ? parseContentSectionDefinition(selected)
    : mediaCategories.parseMediaCategoryDefinition(id, selected);
  if (!parsed) fail(`Invalid editor configuration: ${collection}/${id}`);
  // This identity belongs to the importer, including on installations already seeded.
  if (collection === 'mediaCategories' && id === 'dev-seed') fail('Source uses the reserved dev-seed category');
  return pick(parsed, fields);
}
function assertRequiredConfiguration(records) {
  for (const [collection, required] of [['sections', SEEDED_CONTENT_SECTIONS], ['mediaCategories', mediaCategories.SEEDED_MEDIA_CATEGORIES]]) {
    for (const { id } of required) {
      if (!records.some(record => record.collection === collection && record.id === id)) fail(`Missing required editor configuration: ${collection}/${id}`);
    }
  }
}
async function exportEditorConfiguration(firestore, transaction) {
  const records = [];
  for (const [collection, fields] of Object.entries(CONFIGURATION_FIELDS)) {
    const snapshots = await transaction.get(firestore.collection(collection).select(...fields));
    for (const snapshot of snapshots.docs) {
      const projection = editorConfiguration(collection, snapshot.id, snapshot.data());
      // Sections have no stored revision. Their projection hash is the change detector.
      records.push(seedRecord(collection, snapshot.id, projection, projection.version ?? 1));
    }
  }
  assertRequiredConfiguration(records);
  return records;
}
function publicAuthor(id, value) {
  const result = authorContract.toPublicAuthorSnapshot({ ...sanitize(value), photo: null, authorId: id, version: value.snapshotVersion });
  if (value.photo) {
    const photo = sanitize(value.photo);
    publicMediaFields(photo);
    if (!photo.mimeType.startsWith('image/')) fail('Invalid public author photo type');
    if (!ID.test(photo.assetId) || !['focalX', 'focalY'].every(key => typeof photo[key] === 'number' && photo[key] >= 0 && photo[key] <= 1)) fail('Invalid public author photo');
    result.photo = pick(photo, ['assetId', 'url', 'mimeType', 'width', 'height', 'focalX', 'focalY', 'credit']);
    if (photo.thumbnails?.length) result.photo.thumbnails = photo.thumbnails.map(thumbnail => {
      publicMediaFields({ ...thumbnail, mimeType: photo.mimeType });
      return pick(thumbnail, ['url', 'width', 'height']);
    });
  }
  if (!result.publishedAt) fail(`Missing public author timestamp: ${id}`);
  instant(result.publishedAt);
  return result;
}
export function assertPublicMediaUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('Invalid public media URL'); }
  // The source is always production, even when the operator runs in a dev shell.
  const hosts = publicAssetHosts.production;
  const admittedPath = (hosts.media.includes(url.hostname) && url.pathname.startsWith('/cms-media/')) ||
    (hosts.brand.includes(url.hostname) && url.pathname.startsWith('/brand/') && url.pathname.length > 7);
  if (url.protocol !== 'https:' || url.port || !admittedPath || url.username || url.password || url.search || url.hash ||
      /%|\\/.test(url.pathname) ||
      /(?:private|originals|staging)/i.test(url.pathname)) fail('Media URL is outside the public allowlist');
  return url.href;
}
function publicMediaFields(value) {
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'application/pdf'].includes(value?.mimeType)) fail('Unsupported public media type');
  if (value.mimeType.startsWith('image/') && (!Number.isSafeInteger(value.width) || value.width < 1 || !Number.isSafeInteger(value.height) || value.height < 1)) fail('Invalid public media dimensions');
  const url = assertPublicMediaUrl(value.url);
  if (value.mimeType === 'application/pdf' && !publicAssetHosts.production.media.includes(new URL(url).hostname)) fail('Public PDF URL must use the media host');
  return { url, altText: typeof value.altText === 'string' ? sanitize(value.altText) : '',
    mimeType: value.mimeType, width: value.width ?? null, height: value.height ?? null };
}
function publicMedia(value) {
  if (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > MAX_OBJECT_BYTES) fail('Invalid public media size');
  return { ...publicMediaFields(value), sizeBytes: value.sizeBytes };
}
async function publicMediaSize(url, mimeType, id, fetchImpl) {
  const head = await fetchImpl(url, { method: 'HEAD', redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(30_000) });
  const headType = (head.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (head.status !== 200 || headType !== mimeType) fail(`Cannot verify public media metadata: ${id}`);
  const headLength = head.headers.get('content-length');
  if (headLength !== null && /^\d+$/.test(headLength)) return Number(headLength);

  // Some public hosts omit HEAD length. Count bytes without retaining the body.
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]);
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'manual', credentials: 'omit', signal });
    const responseType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (response.status !== 200 || responseType !== mimeType) fail(`Cannot verify public media metadata: ${id}`);
    const lengthHeader = response.headers.get('content-length');
    const expectedSize = lengthHeader === null ? null : Number(lengthHeader);
    if (lengthHeader !== null && (!/^\d+$/.test(lengthHeader) || !Number.isSafeInteger(expectedSize) ||
        expectedSize < 1 || expectedSize > MAX_OBJECT_BYTES)) fail('Invalid public media size');
    let sizeBytes = 0;
    if (response.body) for await (const chunk of response.body) {
      sizeBytes += chunk.byteLength;
      if (sizeBytes > MAX_OBJECT_BYTES) {
        controller.abort();
        fail('Invalid public media size');
      }
    }
    if (sizeBytes === 0) fail('Invalid public media size');
    if (expectedSize !== null && expectedSize !== sizeBytes) fail('Public media length does not match streamed bytes');
    return sizeBytes;
  } catch (error) {
    controller.abort();
    throw error;
  }
}
function referenceSets(records) {
  const media = new Set(); const authors = new Set(); const cards = new Map(); const content = new Set();
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (typeof value.authorId === 'string') authors.add(value.authorId);
    if (typeof value.pageId === 'string') content.add(`cmsPages/${value.pageId}`);
    if (typeof value.recordId === 'string') {
      if (['sponsor', 'newsletter'].includes(value.recordKind)) cards.set(value.recordId, value.recordKind);
      else content.add(`cmsPosts/${value.recordId}`);
    }
    for (const id of value.sponsorIds ?? []) cards.set(id, 'sponsor');
    for (const id of value.newsletterIds ?? []) cards.set(id, 'newsletter');
    for (const child of Object.values(value)) visit(child);
  }
  for (const record of records) {
    if (Object.hasOwn(CONFIGURATION_FIELDS, record.collection)) continue;
    const usage = projectAt(record.collection, record.id, () => mediaUsage.collectPublishedMediaUsage({ collection: record.collection, documentId: record.id,
      documentVersion: record.sourceVersion, snapshot: record.projection }));
    usage.assetIds.forEach(id => media.add(id));
    visit(record.projection);
  }
  return { media, authors, cards, content };
}
function seedRecord(collection, id, projection, sourceVersion, confirmedLive = false) {
  if (!ID.test(id) || !Number.isSafeInteger(sourceVersion) || sourceVersion < 1) fail('Invalid seed record identity');
  return { collection, id, sourceVersion, confirmedLive, projection, hash: digest(projection) };
}
function cardProjection(value) {
  const keys = value?.type === 'sponsor'
    ? ['type', 'sponsorId', 'name', 'href', 'logoUrl', 'logoAlt', 'logoDecorative', 'tier', 'description', 'logoAssetId']
    : ['type', 'title', 'signupUrl', 'frequency', 'summary', 'imageAssetId', 'imageAlt', 'imageDecorative'];
  if (!['sponsor', 'newsletter'].includes(value?.type)) fail('Invalid card kind');
  const result = sanitize(pick(value, keys));
  if (result.type === 'sponsor' && (!result.name || !ID.test(result.sponsorId))) fail('Invalid Sponsor card');
  if (result.type === 'newsletter' && (!result.title || !result.signupUrl)) fail('Invalid Newsletter card');
  return result;
}
function retainedCard(card) {
  if (!['sponsor', 'newsletter'].includes(card?.kind) || !ID.test(card.id) || !Number.isSafeInteger(card.sourceVersion) || card.sourceVersion < 1) fail('Invalid released card');
  const details = card.kind === 'sponsor'
    ? pick(card.sponsor, ['sponsorId', 'name', 'href', 'logoUrl', 'logoAlt', 'logoDecorative', 'tier', 'description'])
    : pick(card.newsletter?.card, ['title', 'signupUrl', 'frequency', 'summary', 'imageAssetId', 'imageAlt', 'imageDecorative']);
  if (card.kind === 'sponsor' && (!details.name || details.sponsorId !== card.id)) fail('Invalid released Sponsor');
  if (card.kind === 'newsletter' && (!details.title || !details.signupUrl)) fail('Invalid released Newsletter');
  return seedRecord('cards', card.id, cardProjection({ type: card.kind, ...details }), card.sourceVersion, true);
}
function mediaUrls(records) {
  const urls = new Set();
  function visit(value) {
    // Outbound editorial links and third-party embeds stay as published. Only
    // objects on the fixed public media origin enter the optional local copy.
    if (typeof value === 'string' && value.startsWith(PUBLIC_ORIGIN)) urls.add(assertPublicMediaUrl(value));
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  }
  records.forEach(record => visit(record.projection));
  return [...urls].sort();
}
function projectAt(collection, id, project) {
  try { return project(); }
  catch (error) {
    if (error instanceof SeedError) throw error;
    fail(`Invalid published contract: ${collection}/${id}`);
  }
}
function finishManifest(body) {
  body.records.sort((a, b) => `${a.collection}/${a.id}`.localeCompare(`${b.collection}/${b.id}`, 'en'));
  const counts = {};
  body.records.forEach(record => { counts[record.collection] = (counts[record.collection] ?? 0) + 1; });
  const manifest = { ...body, counts, mediaUrls: mediaUrls(body.records) };
  return { ...manifest, hash: digest(manifest) };
}

export async function exportPublished({ firestore, source = SOURCE, destination = DESTINATION, sourceSha, publication, context, readTime, fetchImpl = fetch, configurationOnly = false }) {
  assertPair(source, destination); assertDatabase(firestore, SOURCE);
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) fail('An exact source SHA is required');
  const receipt = projectAt('publication', 'receipt', () => canonicalPublicationReceipt(publication));
  const released = context ? projectAt('publication', 'retained-context', () => assertContextMatchesPublication(context, receipt)) : null;
  return firestore.runTransaction(async transaction => {
    const pointerSnapshot = await transaction.get(firestore.doc('system/publicDeployment'));
    const pointer = deploymentContract.assertPublicDeploymentPointer(pointerSnapshot.data());
    if (pointer.activeGeneration !== receipt.generation || pointer.activeCommitSha !== receipt.commitSha) fail('Publication receipt does not match the active source generation');
    const batch = (await transaction.get(firestore.doc(`system/publicDeployment/buildBatches/${receipt.buildBatchId}`))).data();
    const candidate = (await transaction.get(firestore.doc(`system/publicDeployment/buildBatches/${receipt.buildBatchId}/candidates/worker`))).data();
    if (batch?.status !== 'deployed' || batch.generation !== receipt.generation || batch.commitSha !== receipt.commitSha ||
        batch.deploymentId !== pointer.activeDeploymentId ||
        ['artifactDigest', 'artifactReceiptDigest', 'mediaManifestDigest'].some(key => candidate?.[key] !== receipt[key])) fail('Active receipt lacks matching retained deployment evidence');
    const cutoff = readTime ?? pointerSnapshot.readTime;
    const time = cutoff.toDate().toISOString();
    const records = await exportEditorConfiguration(firestore, transaction); const omissions = [];
    const manifestBody = { schemaVersion: 1, source: SOURCE, destination: DESTINATION, sourceSha,
      readTime: { seconds: cutoff.seconds, nanoseconds: cutoff.nanoseconds }, exportedAt: time,
      publication: receipt, records, omissions, excluded: OMITTED };
    if (configurationOnly) return validateManifest(finishManifest({ ...manifestBody, configurationOnly: true }));
    const confirmed = (collection, id, version) => released?.receipt.families.some(family => family.collection === collection &&
      family.artifacts.some(artifact => artifact.documentId === id && artifact.sourceVersion === version)) ?? false;
    for (const collection of ['cmsPages', 'cmsPosts']) {
      const snapshots = await transaction.get(firestore.collection(collection));
      for (const snapshot of snapshots.docs) {
        const data = snapshot.data();
        if (!isPublishable(data, new Date(time)) || !data.published ||
            (collection === 'cmsPosts' && !['post', 'program', 'event'].includes(data.published.metadata?.type))) {
          omissions.push({ collection, id: snapshot.id, reason: 'Not an admitted routed published projection' }); continue;
        }
        if (Date.parse(instant(data.published.publishedAt)) > Date.parse(time)) fail('Published snapshot is after the export cutoff');
        const projected = projectAt(collection, snapshot.id, () => publicSnapshot(collection, snapshot.id, data.published));
        records.push(seedRecord(collection, snapshot.id, projected, projected.sourceVersion, confirmed(collection, snapshot.id, projected.sourceVersion)));
      }
    }
    for (const id of SETTINGS) {
      const snapshot = await transaction.get(firestore.doc(`cmsSettings/${id}`));
      if (!snapshot.exists || !snapshot.data().published) { omissions.push({ collection: 'cmsSettings', id, reason: 'No published setting; use the public contract default' }); continue; }
      const projection = projectAt('cmsSettings', id, () => publicSetting(id, snapshot.data().published));
      if (Date.parse(projection.publishedAt) > Date.parse(time)) fail('Published settings are after the export cutoff');
      records.push(seedRecord('cmsSettings', id, projection, projection.sourceVersion, confirmed('cmsSettings', id, projection.sourceVersion)));
    }
    let refs = referenceSets(records);
    for (const id of [...refs.authors].sort()) {
      if (!ID.test(id)) fail('Invalid author reference');
      const snapshot = await transaction.get(firestore.doc(`cmsAuthorProfilesPublic/${id}`));
      // A frozen freeform byline needs no private profile or staff lookup.
      if (!snapshot.exists) { omissions.push({ collection: 'cmsAuthorProfilesPublic', id, reason: 'No public author profile; retain frozen byline only' }); continue; }
      const projection = projectAt('cmsAuthorProfilesPublic', id, () => publicAuthor(id, snapshot.data()));
      if (Date.parse(projection.publishedAt) > Date.parse(time)) fail('Public author is after the export cutoff');
      records.push(seedRecord('cmsAuthorProfilesPublic', id, projection, projection.snapshotVersion,
        confirmed('cmsAuthorProfilesPublic', id, projection.snapshotVersion)));
    }
    refs = referenceSets(records);
    for (const [id, kind] of [...refs.cards].sort()) {
      if (!ID.test(id)) fail('Invalid released card reference');
      const card = released?.recordCards?.find(item => item.id === id && item.kind === kind);
      if (!released) fail(`Referenced ${kind} requires its retained released context: ${id}`);
      if (!card) { omissions.push({ collection: 'cards', id, reason: 'Absent from the retained release; renderer hides this card' }); continue; }
      records.push(retainedCard(card));
      if (kind === 'newsletter' && card.newsletter.card.imageAssetId) refs.media.add(card.newsletter.card.imageAssetId);
      if (kind === 'sponsor' && card.sponsor.logoUrl) {
        // The released card has only a URL. Give this public object a deterministic
        // dev asset identity instead of reading the latest mutable Sponsor record.
        const matches = await transaction.get(firestore.collection('media_assets_public').where('url', '==', card.sponsor.logoUrl));
        if (matches.size !== 1) fail('Released Sponsor logo needs one public media projection');
        refs.media.add(matches.docs[0].id);
        records.at(-1).projection.logoAssetId = matches.docs[0].id;
        records.at(-1).hash = digest(records.at(-1).projection);
      }
    }
    for (const id of [...refs.media].sort()) {
      if (!ID.test(id)) fail('Invalid media reference');
      const snapshot = await transaction.get(firestore.doc(`media_assets_public/${id}`));
      if (!snapshot.exists) fail(`Missing referenced public media: ${id}`);
      const value = snapshot.data();
      const url = assertPublicMediaUrl(value.url);
      const sizeBytes = await publicMediaSize(url, value.mimeType, id, fetchImpl);
      records.push(seedRecord('media_assets_public', id, publicMedia({ ...value, sizeBytes }), 1));
    }
    const identities = new Set(records.map(record => `${record.collection}/${record.id}`));
    for (const identity of refs.content) {
      if (!identities.has(identity)) {
        const [collection, id] = identity.split('/');
        omissions.push({ collection, id, reason: 'No admitted target; renderer uses its fallback or hides this link' });
      }
    }
    const manifest = finishManifest({ ...manifestBody, omissions: omissions.sort((a, b) => canonical(a).localeCompare(canonical(b), 'en')) });
    validateManifest(manifest);
    return manifest;
  }, { readOnly: true, ...(readTime ? { readTime } : {}) });
}

export function validateManifest(manifest) {
  assertPair(manifest?.source, manifest?.destination);
  const { hash, ...body } = manifest;
  if (manifest.schemaVersion !== 1 || !SHA.test(hash) || digest(body) !== hash || !/^[a-f0-9]{40}$/.test(manifest.sourceSha)) fail('Invalid manifest hash or schema');
  if (manifest.configurationOnly !== undefined && manifest.configurationOnly !== true) fail('Invalid configuration-only scope');
  if (canonical(Object.keys(body).sort()) !== canonical(['schemaVersion', 'source', 'destination', 'sourceSha', 'readTime', 'exportedAt', 'publication', 'records', 'omissions', 'excluded', 'counts', 'mediaUrls', ...(manifest.configurationOnly ? ['configurationOnly'] : [])].sort())) fail('Unexpected manifest field');
  const time = new Timestamp(manifest.readTime.seconds, manifest.readTime.nanoseconds);
  if (time.toDate().toISOString() !== instant(manifest.exportedAt)) fail('Invalid export read time');
  projectAt('publication', 'receipt', () => canonicalPublicationReceipt(manifest.publication));
  if (canonical(manifest.excluded) !== canonical(OMITTED) || !Array.isArray(manifest.records)) fail('Invalid manifest exclusions');
  const omissionReasons = new Set(['Not an admitted routed published projection',
    'No published setting; use the public contract default',
    'No public author profile; retain frozen byline only',
    'Absent from the retained release; renderer hides this card',
    'No admitted target; renderer uses its fallback or hides this link']);
  if (!Array.isArray(manifest.omissions) || manifest.omissions.some(item =>
      canonical(Object.keys(item).sort()) !== canonical(['collection', 'id', 'reason']) ||
      !['cmsPages', 'cmsPosts', 'cmsSettings', 'cmsAuthorProfilesPublic', 'cards'].includes(item.collection) ||
      !ID.test(item.id) || !omissionReasons.has(item.reason))) fail('Invalid manifest omissions');
  const omitted = (collection, id) => manifest.omissions.some(item => item.collection === collection && item.id === id);
  const identities = new Set();
  for (const record of manifest.records) {
    const identity = `${record.collection}/${record.id}`;
    if (identities.has(identity) || !ID.test(record.id) || !Number.isSafeInteger(record.sourceVersion) || record.sourceVersion < 1 || typeof record.confirmedLive !== 'boolean') fail('Invalid or duplicate seed identity');
    identities.add(identity);
    const configuration = Object.hasOwn(CONFIGURATION_FIELDS, record.collection);
    if (manifest.configurationOnly && !configuration) fail('Configuration-only manifest contains content');
    if (configuration && (record.confirmedLive || record.sourceVersion !== (record.collection === 'sections' ? 1 : record.projection.version))) fail('Invalid editor configuration provenance');
    const normalized = projectAt(record.collection, record.id, () => {
      switch (record.collection) {
        case 'cmsPages': case 'cmsPosts': return publicSnapshot(record.collection, record.id, record.projection);
        case 'cmsSettings':
          if (!SETTINGS.includes(record.id)) fail('Private settings refused');
          return publicSetting(record.id, record.projection);
        case 'cmsAuthorProfilesPublic': return publicAuthor(record.id, record.projection);
        case 'media_assets_public': return publicMedia(record.projection);
        case 'cards': return cardProjection(record.projection);
        case 'sections': case 'mediaCategories': return editorConfiguration(record.collection, record.id, record.projection);
        default: fail('Private collection refused');
      }
    });
    if (canonical(normalized) !== canonical(record.projection) || digest(normalized) !== record.hash ||
        canonical(seedRecord(record.collection, record.id, normalized, record.sourceVersion, record.confirmedLive)) !== canonical(record)) fail('Invalid or unsanitized seed projection');
    const version = normalized.sourceVersion ?? normalized.snapshotVersion;
    if (version !== undefined && version !== record.sourceVersion) fail('Source version mismatch');
    if (normalized.publishedAt && Date.parse(normalized.publishedAt) > time.toMillis()) fail('Projection is after cutoff');
  }
  if (manifest.configurationOnly) {
    assertRequiredConfiguration(manifest.records);
    if (manifest.omissions.length) fail('Configuration-only manifest contains omissions');
  }
  const publicRecords = manifest.records.filter(record => record.collection !== 'cards' && record.collection !== 'media_assets_public');
  const refs = referenceSets(publicRecords);
  for (const record of manifest.records.filter(item => item.collection === 'cards')) {
    for (const key of ['logoAssetId', 'imageAssetId']) if (record.projection[key]) refs.media.add(record.projection[key]);
  }
  for (const id of refs.media) if (!identities.has(`media_assets_public/${id}`)) fail(`Unresolved media reference: ${id}`);
  for (const [id, kind] of refs.cards) if (!manifest.records.some(record => record.collection === 'cards' && record.id === id && record.projection.type === kind) && !omitted('cards', id)) fail('Unresolved released card');
  for (const identity of refs.content) if (!identities.has(identity) && !omitted(...identity.split('/'))) fail(`Unresolved content reference: ${identity}`);
  if (canonical(finishManifest({ ...body, records: [...manifest.records] })) !== canonical(manifest)) fail('Non-canonical manifest inventory');
  return manifest;
}

export async function copyMedia({ manifest, directory, fetchImpl = fetch }) {
  validateManifest(manifest);
  if (!directory) fail('A local output directory is required');
  const objects = []; let totalBytes = 0;
  const objectDirectory = resolve(directory, 'cms-media/dev-seed');
  await mkdir(objectDirectory, { recursive: true, mode: 0o700 });
  for (const sourceUrl of manifest.mediaUrls) {
    assertPublicMediaUrl(sourceUrl);
    const response = await fetchImpl(sourceUrl, { redirect: 'manual', signal: AbortSignal.timeout(120_000), credentials: 'omit' });
    if (response.status !== 200 || !response.body) fail('Public media download failed or redirected');
    const mimeType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!COPY_TYPES.includes(mimeType)) fail('Unsupported public media response type');
    const limit = mimeType === 'video/mp4' ? MAX_VIDEO_BYTES : MAX_OBJECT_BYTES;
    if (Number(response.headers.get('content-length')) > limit) fail('Public media object is too large');
    const expected = manifest.records.find(record => record.collection === 'media_assets_public' && record.projection.url === sourceUrl)?.projection;
    if (expected && expected.mimeType !== mimeType) fail('Public media content type changed since export');
    const temporary = resolve(objectDirectory, `.copy-${randomUUID()}`);
    const handle = await open(temporary, 'wx', 0o600);
    const hasher = createHash('sha256'); let sizeBytes = 0;
    try {
      for await (const chunk of response.body) {
        sizeBytes += chunk.length;
        if (sizeBytes > limit || totalBytes + sizeBytes > MAX_TOTAL_BYTES) fail('Public media copy exceeds its byte limit');
        hasher.update(chunk); await handle.writeFile(chunk);
      }
      if (!sizeBytes || (expected && expected.sizeBytes !== sizeBytes)) fail('Public media size changed since export');
      await handle.close();
      totalBytes += sizeBytes;
      const hash = hasher.digest('hex'); const key = `cms-media/dev-seed/${hash}`;
      const path = resolve(directory, key);
      try { await link(temporary, path); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); const oldHash = createHash('sha256');
        try { for await (const chunk of existing.readableWebStream()) oldHash.update(new Uint8Array(chunk)); }
        finally { await existing.close(); }
        if (oldHash.digest('hex') !== hash) fail('Existing media copy has different bytes');
      }
      objects.push({ sourceUrl, key, hash, sizeBytes, mimeType, url: `${DEV_ORIGIN}/${key}` });
    } finally { await handle.close(); await unlink(temporary); }
  }
  const body = { schemaVersion: 1, manifestHash: manifest.hash, bucket: 'template-dev-media', objects };
  return { ...body, hash: digest(body) };
}
function validateCopy(manifest, copy) {
  const { hash, ...body } = copy ?? {};
  if (copy?.schemaVersion !== 1 || copy.manifestHash !== manifest.hash || copy.bucket !== 'template-dev-media' || digest(body) !== hash ||
      !Array.isArray(copy.objects) || copy.objects.length !== manifest.mediaUrls.length) fail('A complete verified dev media copy is required');
  for (const [index, object] of copy.objects.entries()) {
    if (object.sourceUrl !== manifest.mediaUrls[index] || !SHA.test(object.hash) ||
        !COPY_TYPES.includes(object.mimeType) ||
        object.key !== `cms-media/dev-seed/${object.hash}` || object.url !== `${DEV_ORIGIN}/${object.key}` ||
        !Number.isSafeInteger(object.sizeBytes) || object.sizeBytes < 1 || object.sizeBytes > (object.mimeType === 'video/mp4' ? MAX_VIDEO_BYTES : MAX_OBJECT_BYTES)) fail('Invalid dev media mapping');
  }
  return new Map(copy.objects.map(object => [object.sourceUrl, object]));
}
function editableRecords(manifest) {
  const output = [];
  const dates = { createdAt: manifest.exportedAt, updatedAt: manifest.exportedAt, createdBy: ACTOR, updatedBy: ACTOR };
  for (const record of manifest.records) {
    const projection = structuredClone(record.projection); const version = record.sourceVersion;
    const base = { id: record.id, version, ...dates };
    if (projection.metadata?.credits) projection.metadata.credits = projection.metadata.credits.map(credit => {
      if (credit.kind !== 'registered' || manifest.records.some(item => item.collection === 'cmsAuthorProfilesPublic' && item.id === credit.authorId)) return credit;
      if (!credit.displayName) fail('Registered byline without a public name');
      return { kind: 'custom', name: credit.displayName };
    });
    if (projection.authorIds) projection.authorIds = (projection.metadata.credits ?? []).filter(credit => credit.kind === 'registered').map(credit => credit.authorId);
    if (['cmsPages', 'cmsPosts'].includes(record.collection)) {
      output.push({ path: `${record.collection}/${record.id}`, data: { ...base, ...projection.metadata,
        type: record.collection === 'cmsPages' ? 'page' : projection.metadata.type,
        ...(record.collection === 'cmsPages' ? { template: pageContract.publicPageDefinition(record.id)?.template ?? 'genericPage' } : {}),
        blocks: projection.blocks, contentVersion: projection.contentVersion, status: 'published', publiclyVisible: true,
        deleted: false, publishAt: projection.publishedAt, published: projection } });
    } else if (Object.hasOwn(CONFIGURATION_FIELDS, record.collection)) {
      output.push({ path: `${record.collection}/${record.id}`, data: { ...projection, ...dates } });
    } else if (record.collection === 'cmsSettings') {
      output.push({ path: `cmsSettings/${record.id}`, data: { version, schemaVersion: projection.schemaVersion, values: projection.values, published: projection } });
    } else if (record.collection === 'media_assets_public') {
      const type = mediaContract.MEDIA_TYPES[projection.mimeType];
      const data = mediaDiscovery.withMediaDiscovery(record.id, { ...base, ...projection, lifecycle: 'active', kind: type.kind,
        name: record.id, originalName: `${record.id}.${type.extension}`, category: 'dev-seed', categories: ['dev-seed'], tags: [],
        sizeBytes: projection.sizeBytes, source: 'site_seed' });
      output.push({ path: `media_assets/${record.id}`, data }, { path: `media_assets_public/${record.id}`, data: mediaContract.mediaProjection(data) });
    } else if (record.collection === 'cmsAuthorProfilesPublic') {
      const profile = authorContract.newAuthorWorkingProfile({ authorId: record.id, uid: null, displayName: projection.displayName, nowIso: manifest.exportedAt, actor: ACTOR });
      output.push({ path: `cmsAuthorProfilesPublic/${record.id}`, data: projection },
        { path: `cmsAuthorProfiles/${record.id}`, data: { ...profile, ...projection, photo: null, version, visibility: 'published', publishedBy: ACTOR } },
        { path: `cmsBylineDirectory/${record.id}`, data: { authorId: record.id, eligible: true, displayName: projection.displayName, jobTitle: projection.jobTitle } });
      for (const slug of [projection.slug, ...projection.previousSlugs]) output.push({ path: `cmsAuthorSlugs/${slug}`, data: { authorId: record.id } });
    } else {
      const { sponsorId, logoUrl, ...fields } = projection;
      output.push({ path: `cmsPosts/${record.id}`, data: { ...base, ...fields, status: 'approved', deleted: false, publiclyVisible: false } });
    }
  }
  if (manifest.records.some(record => record.collection === 'media_assets_public')) output.push({ path: 'mediaCategories/dev-seed', data: { id: 'dev-seed', label: 'Dev seed', description: 'Copied public media', order: 1000, active: true, version: 1, ...dates } });
  const paths = output.map(item => item.path);
  if (new Set(paths).size !== paths.length) fail('Duplicate import path');
  return output.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

export async function importPublished({ firestore, manifest, copy, source = SOURCE, destination = DESTINATION, apply = false }) {
  assertPair(source, destination); assertDatabase(firestore, DESTINATION);
  validateManifest(manifest);
  if (copy) validateCopy(manifest, copy);
  const records = editableRecords(manifest);
  // Preflight every record before any write. Each bounded apply transaction then
  // repeats the conflict check. An interrupted large import resumes by seed hashes.
  const run = (selected, write) => firestore.runTransaction(async transaction => {
    const pointerRef = firestore.doc('system/publicDeployment');
    const pointer = manifest.configurationOnly ? null : await transaction.get(pointerRef);
    const runtimeRef = firestore.doc('system/cmsPreviewRuntime');
    const runtime = manifest.configurationOnly ? null : await transaction.get(runtimeRef);
    const markerRef = firestore.doc('system/devPublishedSeed');
    const marker = manifest.configurationOnly ? null : await transaction.get(markerRef);
    if (!manifest.configurationOnly && !marker.exists) {
      if (pointer.exists || runtime.exists) fail('Initial seed requires a fresh dev publication coordinator');
      for (const collection of ['cmsPublishQueue', 'cmsPreviewQueue']) {
        if (!(await transaction.get(firestore.collection(collection).limit(1))).empty) fail('Initial dev seed requires empty queues');
      }
    }
    const changes = []; let unchanged = 0;
    for (const record of selected) {
      const ref = firestore.doc(record.path);
      const priorRef = firestore.doc(`devSeedRecords/${digest(record.path)}`);
      const [current, prior] = await transaction.getAll(ref, priorRef);
      const seedData = Object.fromEntries(Object.entries(record.data).filter(([key]) => !['createdAt', 'updatedAt'].includes(key)));
      if (seedData.mediaDiscovery) seedData.mediaDiscovery = Object.fromEntries(Object.entries(seedData.mediaDiscovery).filter(([key]) => !['createdAtKey', 'updatedAtKey'].includes(key)));
      const seedHash = digest(seedData);
      let data = record.data;
      if (current.exists) {
        if (!prior.exists || prior.data().path !== record.path || digest(current.data()) !== prior.data().recordHash) fail(`Dev edit conflict: ${record.path}`);
        if (prior.data().seedHash === seedHash) { unchanged++; continue; }
        if (!record.path.startsWith('cmsSettings/') && current.data().createdAt !== undefined) data = { ...data, createdAt: current.data().createdAt };
        if (data.mediaDiscovery) data = mediaDiscovery.withMediaDiscovery(record.path.split('/')[1], data);
      } else if (prior.exists) fail(`Dev deletion conflict: ${record.path}; explicit reset required`);
      changes.push({ ref, priorRef, record, data, seedHash });
    }
    if (write && changes.some(({ record }) => /^(cmsPosts|cmsPages|cmsSettings|cmsAuthorProfilesPublic|media_assets_public)\//.test(record.path))) {
      const enrollment = await transaction.get(firestore.doc('system/publicReleaseChangeLog'));
      if (enrollment.exists && enrollment.data()?.enabled !== false) fail('Published seeding refuses an enrolled public change log; use its publication owners');
    }
    if (write) {
      for (const { ref, priorRef, record, data, seedHash } of changes) {
        transaction.set(ref, data);
        transaction.set(priorRef, { path: record.path, recordHash: digest(data), seedHash, manifestHash: manifest.hash });
      }
      if (!manifest.configurationOnly && !marker.exists) {
        transaction.create(pointerRef, deploymentContract.initialPublicDeploymentPointer());
        transaction.create(runtimeRef, { schemaVersion: 1, phase: 'paused', rendererSha: manifest.sourceSha, serializerId: 'dev-seed-unconfigured' });
        transaction.create(markerRef, { schemaVersion: 1, firstManifestHash: manifest.hash, actor: ACTOR });
      }
    }
    return { applied: write, changed: changes.length, unchanged, deleted: 0, manifestHash: manifest.hash };
  }, write ? {} : { readOnly: true });
  const preflight = await run(records, false);
  if (!apply) return preflight;
  const result = { ...preflight, applied: true, changed: 0, unchanged: 0 };
  // The empty seed still initializes the fresh coordinator.
  for (let offset = 0; offset < Math.max(1, records.length); offset += 100) {
    const batch = await run(records.slice(offset, offset + 100), true);
    result.changed += batch.changed; result.unchanged += batch.unchanged;
  }
  return result;
}

async function cliDatabase(mode, emulator) {
  const projectId = mode === 'export' ? SOURCE : DESTINATION;
  if (emulator) {
    if (!/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')) fail('Emulator mode requires an explicit loopback FIRESTORE_EMULATOR_HOST');
    const app = initializeApp({ projectId }, `dev-seed-${mode}`);
    return { app, firestore: getFirestore(app) };
  }
  if (process.env.FIRESTORE_EMULATOR_HOST || process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_CONFIG) fail('Ambient Firebase configuration is refused');
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 32_768) fail('Credential input too large'); }
  const account = JSON.parse(input);
  const identity = mode === 'export' ? `dev-seed-reader@${SOURCE}.iam.gserviceaccount.com` : `dev-seed-writer@${DESTINATION}.iam.gserviceaccount.com`;
  if (account.project_id !== projectId || account.client_email !== identity) fail('The dedicated seed service identity is required');
  const credential = cert(account);
  if (mode === 'export') {
    const token = await credential.getAccessToken();
    const permissions = ['datastore.entities.get', 'datastore.entities.list', 'datastore.entities.create', 'datastore.entities.update', 'datastore.entities.delete', 'datastore.databases.import', 'datastore.databases.export'];
    const response = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${SOURCE}:testIamPermissions`, {
      method: 'POST', headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ permissions }),
    });
    if (!response.ok) fail('Cannot verify export read-only authority');
    const granted = (await response.json()).permissions ?? [];
    if (!permissions.slice(0, 2).every(item => granted.includes(item)) || granted.some(item => !permissions.slice(0, 2).includes(item))) fail('Export identity must have read-only Firestore authority');
  }
  const app = initializeApp({ projectId, credential }, `dev-seed-${mode}`);
  return { app, firestore: getFirestore(app) };
}
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: Object.fromEntries([
    ...['source', 'destination', 'manifest', 'copy', 'output', 'source-sha', 'publication', 'context', 'directory'].map(name => [name, { type: 'string' }]),
    ...['apply', 'emulator', 'configuration-only'].map(name => [name, { type: 'boolean', default: false }]),
  ]) });
  const [mode] = positionals;
  if (positionals.length !== 1 || !['export', 'validate', 'copy-media', 'import'].includes(mode)) fail('Usage: seed-dev-published.mjs export|validate|copy-media|import [options]');
  assertPair(values.source, values.destination);
  if (values['configuration-only'] && !['export', 'import'].includes(mode)) fail('Configuration-only is an export/import option');
  const json = async file => JSON.parse(await readFile(file, 'utf8'));
  const save = async (value, directory) => {
    if (!directory) fail('An output directory is required');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = resolve(directory, `${value.hash}.json`);
    try { await writeFile(path, `${canonical(value)}\n`, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST' || canonical(await json(path)) !== canonical(value)) throw error; }
    console.log(JSON.stringify({ path, hash: value.hash }));
  };
  if (mode === 'validate') { const manifest = validateManifest(await json(values.manifest)); console.log(JSON.stringify({ hash: manifest.hash, counts: manifest.counts, valid: true })); return; }
  if (mode === 'copy-media') { await save(await copyMedia({ manifest: await json(values.manifest), directory: values.directory }), values.output); return; }
  const { app, firestore } = await cliDatabase(mode, values.emulator);
  try {
    if (mode === 'export') await save(await exportPublished({ firestore, sourceSha: values['source-sha'], publication: await json(values.publication), context: values.context ? await json(values.context) : undefined, configurationOnly: values['configuration-only'] }), values.output);
    else {
      const manifest = await json(values.manifest);
      if (values['configuration-only'] && manifest.configurationOnly !== true) fail('Configuration-only import requires a configuration-only export');
      console.log(JSON.stringify(await importPublished({ firestore, manifest, copy: values.copy ? await json(values.copy) : undefined, apply: values.apply })));
    }
  } finally { await deleteApp(app); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    // Only messages authored here can be printed. SDK, JSON and credential errors
    // can embed request bodies or credential input and must remain suppressed.
    console.error(error instanceof SeedError ? `Dev seed refused: ${error.message}` : 'Dev seed failed: Contract, credential input or transport error. No payload was logged.');
    process.exitCode = 1;
  });
}
