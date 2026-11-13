"use strict";
const { isPostLeadMedia, readPostLeadMedia, leadMediaAssetIds } = require("./lib/post-lead-media");

const { createHmac, timingSafeEqual } = require("node:crypto");
const logger = require("firebase-functions/logger");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { db } = require("./lib/firebase");
const { requestHeader } = require("./lib/cms-edge");
const { parsePublishInstant } = require("./lib/publish-instant");
const { isServerMintableSlugShape } = require("./lib/post-slug-contract");
const { parseBlocks } = require("./lib/content-blocks");
const { visibleLayoutBlocks } = require("./lib/content-layout");
const { validateKnownMetadata } = require("./lib/content-metadata");
const { POST_METADATA_FIELDS } = require("./lib/publish-snapshot");
const { collectPublishedMediaUsage } = require("./lib/media-usage");
const { assertPublishedAssetProjection } = require("./lib/published-media-safety");
const { assertPublishedMediaReadiness } = require("./lib/public-deployment");
const chrome = require("./lib/published-chrome-projection");
const { selectedBlock, selectedAssets } = require("./lib/public-content-projection");
const { instantBlockAllowed, joinedRecordIds, shapeJoinedRecord, joinedAssetIds, readLibraryHistory, pairedAssetPaths, projectPairedAsset } = require("./lib/joined-records");
const { registeredAuthorIds } = require("./lib/story-credits");
const { selectPublishedStoryCredits } = require("./lib/published-story-credits");
const { publiclyVisible } = require("./lib/public-video-references");
const { isAuthorId, isValidAuthorSlug, isPostReference, SOCIAL_PLATFORMS, normalizeSocialLink,
  AUTHOR_NAME_MAX, AUTHOR_JOB_TITLE_MAX, AUTHOR_BIO_MAX, AUTHOR_HIDDEN_POSTS_MAX } = require("./lib/author-profile-contract");

const PUBLISHED_POST_READER_HMAC_KEY = defineSecret("PUBLISHED_POST_READER_HMAC_KEY");
const SKEW_MS = 60_000;
const PRIVATE_METADATA = new Set(["firstPublishedBy", "meaningfulUpdatedBy", "credits", "seo", "social"]);
const READER_FAILURE_CODES = new Set(["reader_invalid_snapshot", "reader_unsupported_dependency", "reader_ambiguous_route",
  "reader_invalid_version", "reader_media_ineligible", "reader_media_fence"]);
const SDK_FAILURE_CODES = new Map([[7, "reader_read_denied"], [9, "reader_read_precondition"], [14, "reader_read_unavailable"]]);
function readerFailure(code) { return Object.assign(new Error("Published content is unavailable"), { readerCode: code }); }
function refuseReaderMedia(error, releaseSelector) {
  if (releaseSelector !== undefined && !(error instanceof require("./lib/public-release-pair").PublicReleaseProtocolError)) throw error;
  throw readerFailure("reader_media_fence");
}
function failureCode(error, fallback) {
  if (READER_FAILURE_CODES.has(error?.readerCode)) return error.readerCode;
  return SDK_FAILURE_CODES.get(error?.code) ?? fallback;
}

// These are authoritative refusals, not transport outages. Cached public HTML
// must not hide a media, ownership, version or permission failure.
function isPublishedPostRefusal(error) {
  return READER_FAILURE_CODES.has(error?.readerCode) || error?.code === 7 || error?.code === 9;
}

function pick(value, fields) {
  return Object.fromEntries(fields.filter(field => value?.[field] !== undefined)
    .map(field => [field, structuredClone(value[field])]));
}

function boundedAuthorText(value, max) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 && text.length <= max ? text : undefined;
}

function reporterBio(value) {
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/\s+/g, " ");
  let sentence = text;
  for (const match of text.matchAll(/[.!?](?:[”’"')\]]*)(?=\s|$)/gu)) {
    const token = text.slice(0, match.index + 1).match(/([\p{L}.]+)$/u)?.[1] ?? "";
    if (match[0].startsWith(".") && /^(?:(?:\p{L}\.)+|(?:Dr|Mr|Mrs|Ms|Jr|Sr|St|Gov|Sen|Rep|Lt|No)\.)$/iu.test(token)) continue;
    sentence = text.slice(0, match.index + match[0].length); break;
  }
  const characters = Array.from(sentence);
  return characters.length <= 140 ? sentence || undefined : `${characters.slice(0, 139).join("").trimEnd()}…`;
}

function publicAuthorPhoto(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const photo = {};
  for (const field of ["url", "mimeType"]) if (typeof value[field] === "string") photo[field] = value[field];
  for (const field of ["width", "height", "focalX", "focalY"]) {
    if (typeof value[field] === "number" && Number.isFinite(value[field])) photo[field] = value[field];
  }
  const credit = boundedAuthorText(value.credit, 300);
  if (credit !== undefined) photo.credit = credit;
  if (Array.isArray(value.thumbnails)) photo.thumbnails = value.thumbnails.flatMap(thumbnail => {
    if (!thumbnail || typeof thumbnail.url !== "string" || !Number.isSafeInteger(thumbnail.width) ||
        thumbnail.width < 1 || !Number.isSafeInteger(thumbnail.height) || thumbnail.height < 1) return [];
    return [{ url: thumbnail.url, width: thumbnail.width, height: thumbnail.height }];
  });
  return photo;
}

function publicAuthorSnapshot(snapshot, { strict = false } = {}) {
  const value = snapshot.data();
  if (typeof value.authorId === "string" && value.authorId !== snapshot.id) throw readerFailure("reader_invalid_snapshot");
  const author = { id: snapshot.id, photo: publicAuthorPhoto(value.photo), links: {} };
  if (typeof value.authorId === "string") author.authorId = value.authorId;
  if (isValidAuthorSlug(value.slug)) author.slug = value.slug;
  for (const [field, max] of [["displayName", AUTHOR_NAME_MAX], ["jobTitle", AUTHOR_JOB_TITLE_MAX], ["bio", AUTHOR_BIO_MAX]]) {
    const text = boundedAuthorText(value[field], max);
    if (text !== undefined) author[field] = text;
  }
  if (Number.isSafeInteger(value.snapshotVersion)) author.snapshotVersion = value.snapshotVersion;
  if (strict && (!isAuthorId(snapshot.id) || !isValidAuthorSlug(author.slug) ||
      typeof author.displayName !== "string" || !author.displayName.trim() ||
      !Number.isSafeInteger(author.snapshotVersion) || author.snapshotVersion < 1)) throw readerFailure("reader_invalid_snapshot");
  author.previousSlugs = [...new Set((Array.isArray(value.previousSlugs) ? value.previousSlugs : []).filter(isValidAuthorSlug))];
  if (isPostReference(value.pinnedPostId)) author.pinnedPostId = value.pinnedPostId;
  author.hiddenPostIds = [...new Set((Array.isArray(value.hiddenPostIds) ? value.hiddenPostIds : [])
    .filter(id => isPostReference(id) && id !== author.pinnedPostId))]
    .slice(0, AUTHOR_HIDDEN_POSTS_MAX);
  for (const platform of SOCIAL_PLATFORMS) {
    const link = normalizeSocialLink(platform, value.links?.[platform]);
    if (link.ok && link.value) author.links[platform] = { handle: link.value.handle, url: link.value.url };
  }
  return author;
}

async function readPublishedAuthors(firestore, tx, metadata) {
  const credits = [...(metadata.credits ?? []), ...(metadata.liveBlog?.updates ?? []).flatMap(entry =>
    [...entry.credits, ...(entry.withdrawal === undefined ? entry.followUps ?? [] : []).flatMap(reply => reply.credits)])];
  // Match the background dependency cap. Other credits retain their frozen name
  // and initials; missing public profiles never prevent the reporting from rendering.
  const ids = registeredAuthorIds(credits).slice(0, 100);
  const snapshots = ids.length ? await tx.getAll(...ids.map(id => firestore.doc(`cmsAuthorProfilesPublic/${id}`))) : [];
  const bylineIds = new Set(registeredAuthorIds(metadata.credits ?? []));
  return projectPublishedAuthors(ids, snapshots).map(author => {
    if (bylineIds.has(author.id)) return author;
    const reporter = pick(author, ["id", "authorId", "slug", "previousSlugs", "displayName", "jobTitle", "photo", "snapshotVersion"]);
    const bio = reporterBio(author.bio);
    if (bio !== undefined) reporter.bio = bio;
    return reporter;
  });
}

function projectPublishedAuthors(ids, snapshots) {
  if (new Set(snapshots.map(snapshot => snapshot.id)).size !== snapshots.length ||
      snapshots.some(snapshot => !isAuthorId(snapshot.id) || !ids.includes(snapshot.id))) throw readerFailure("reader_invalid_snapshot");
  return snapshots.filter(snapshot => snapshot.exists).map(snapshot => publicAuthorSnapshot(snapshot));
}

const { publicRichText, publicLiveBlogData } = require("./lib/live-blog");

function publicSnapshot(snapshot, cardsOnly = false) {
  if (!cardsOnly) require("./lib/dataset-dependencies").validateFrozenDatasetFigures(snapshot);
  const readable = { ...snapshot.metadata };
  if (readable.leadMedia !== undefined && readable.leadMedia !== null && !isPostLeadMedia(readable.leadMedia)) readable.leadMedia = null;
  if (validateKnownMetadata(readable)) throw readerFailure("reader_invalid_snapshot");
  const metadata = pick(readable, POST_METADATA_FIELDS.filter(field => !PRIVATE_METADATA.has(field)));
  if (metadata.coverageLabelId === undefined && snapshot.metadata.liveBlog?.branding === "nj-decides-2026") metadata.coverageLabelId = "nj-decides-2026";
  delete metadata.liveBlog;
  if (!cardsOnly && snapshot.metadata.liveBlog !== undefined) {
    try { metadata.liveBlog = publicLiveBlogData(snapshot.metadata.liveBlog, snapshot.publishedAt); }
    catch { throw readerFailure("reader_invalid_snapshot"); }
  }
  metadata.spotlightNews = snapshot.metadata.spotlightNews === true;
  if (snapshot.metadata.credits !== undefined) {
    try { metadata.credits = selectPublishedStoryCredits(snapshot.metadata.credits); }
    catch { throw readerFailure("reader_invalid_snapshot"); }
  }
  if (snapshot.metadata.seo !== undefined) metadata.seo = pick(snapshot.metadata.seo, ["title", "description", "noindex"]);
  if (snapshot.metadata.social !== undefined) metadata.social = pick(snapshot.metadata.social, ["title", "description", "imageAssetId"]);
  const parsed = parseBlocks(cardsOnly ? [] : snapshot.blocks, { complete: true });
  if (!parsed.ok) throw readerFailure("reader_invalid_snapshot");
  const blocks = visibleLayoutBlocks(parsed.blocks).map(block => {
    if (!instantBlockAllowed(block.type)) throw readerFailure("reader_unsupported_dependency");
    const selected = selectedBlock(block);
    if (block.type === "prose") selected.data.content = publicRichText(block.data.content);
    if (block.type === "video" && block.data.public !== undefined) {
      selected.data.public = pick(block.data.public, ["url", "posterUrl", "width", "height", "mimeType"]);
    }
    return selected;
  });
  return { sourceVersion: snapshot.sourceVersion, publishedAt: snapshot.publishedAt, metadata, blocks,
    ...(!cardsOnly && snapshot.datasetFigures ? { datasetFigures: structuredClone(snapshot.datasetFigures) } : {}) };
}

async function readPublishedChrome(firestore, tx, now, options = {}) {
  const records = new Map();
  const settingsRows = await tx.getAll(...chrome.PUBLIC_CHROME_SETTINGS_IDS.map(id => firestore.doc(`cmsSettings/${id}`)));
  settingsRows.forEach(row => { if (row.exists) records.set(`cmsSettings/${row.id}`, row.data()); });
  const settings = chrome.publishedChromeSettings(records, options), ids = chrome.publishedChromeBrandAssetIds(settings);
  if (ids.length) {
    const paths = pairedAssetPaths(ids), media = await tx.getAll(...paths.map(path => firestore.doc(path)));
    media.forEach((row, index) => { if (row.exists) records.set(paths[index], row.data()); });
    if (media.some((row, index) => index % 2 === 0 && row.data()?.source === "upload")) {
      const deployment = await tx.get(firestore.doc("system/publicDeployment"));
      if (deployment.exists) records.set("system/publicDeployment", deployment.data());
      if (deployment.data()?.schemaVersion === 2) {
        const pairMedia = await tx.get(firestore.doc("system/publicDeployment/pairMedia/current"));
        if (pairMedia.exists) records.set("system/publicDeployment/pairMedia/current", pairMedia.data());
      }
    }
  }
  const pageIds = chrome.publishedChromePageIds(settings);
  const [pages, news] = await Promise.all([
    tx.getAll(...pageIds.map(id => firestore.doc(`cmsPages/${id}`))),
    tx.get(firestore.collection("cmsPages").where("published.metadata.slug", "==", "in-the-news").limit(2)),
  ]);
  pages.forEach((row, index) => { if (row.exists) records.set(`cmsPages/${pageIds[index]}`, row.data()); });
  for (const row of news.docs) records.set(`cmsPages/${row.id}`, row.data());
  for (const collection of ["cmsPages", "cmsPosts"]) {
    const rows = await tx.get(require("./lib/content-link-directory").publicContentLinksQuery(firestore, collection)
      .select("type", "status", "deleted", "publiclyVisible", "publishAt", "published.sourceVersion", "published.publishedAt", "published.metadata.type", "published.metadata.slug", "published.metadata.previousSlugs", "published.metadata.contentLinkMode", "published.metadata.contentLinkUrl", "published.metadata.contentLinkNewTab"));
    for (const row of rows.docs) if (!records.has(`${collection}/${row.id}`)) records.set(`${collection}/${row.id}`, row.data());
  }
  return chrome.projectPublishedChromeRecords(records, now, options);
}

async function readPublishedPostSnapshot({ firestore, transaction: tx, slug, now, cardsOnly, allowLegacyVisibility, nextDocument, documentId }) {
  const posts = firestore.collection("cmsPosts").where("published.metadata.type", "==", "post");
  const canonical = await tx.get(posts.where("published.metadata.slug", "==", slug).limit(2));
  const aliases = await tx.get(posts.where("published.metadata.previousSlugs", "array-contains", slug).limit(2));
  const owners = new Map([...canonical.docs, ...aliases.docs].map(doc => [doc.id, doc]));
  // Trusted acceptance can validate a prospective frozen owner in this same
  // read transaction. HTTP callers never supply this override.
  if (nextDocument !== undefined) {
    if (typeof documentId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(documentId)) throw readerFailure("reader_invalid_snapshot");
    owners.set(documentId, { id: documentId, data: () => nextDocument });
  }
  return projectPublishedPostSnapshot(owners, slug, now, cardsOnly, allowLegacyVisibility);
}

function projectPublishedPostSnapshot(owners, slug, now, cardsOnly, allowLegacyVisibility = false) {
  if (owners.size > 1) throw readerFailure("reader_ambiguous_route");
  const owner = [...owners.values()][0];
  if (!owner) return { kind: "not-found" };
  const document = owner.data();
  if (document.deleted === true) return { kind: "gone" };
  const snapshot = document.published;
  if (!(cardsOnly || allowLegacyVisibility ? publiclyVisible(document) : document.publiclyVisible === true) || snapshot?.metadata?.type !== "post" || snapshot.metadata.slug !== slug) {
    return { kind: "not-found" };
  }
  const instant = parsePublishInstant(snapshot.publishedAt);
  if (instant === null) throw readerFailure("reader_invalid_snapshot");
  if (instant > now.getTime()) return { kind: "not-found" };
  if (!Number.isSafeInteger(snapshot.sourceVersion) || snapshot.sourceVersion < 1 ||
      !Number.isSafeInteger(document.version) || snapshot.sourceVersion > document.version ||
      (Number.isSafeInteger(document.publicSourceVersion) && snapshot.sourceVersion < document.publicSourceVersion)) {
    throw readerFailure("reader_invalid_version");
  }
  const published = publicSnapshot(snapshot, cardsOnly);
  return { kind: "snapshot", owner, published };
}

function optionalLeadAssetIds(published) {
  const { assetIds: required } = collectPublishedMediaUsage({ collection: "cmsPosts", snapshot: {
    ...published, metadata: { ...published.metadata, leadMedia: null },
  } });
  return new Set(leadMediaAssetIds(readPostLeadMedia(published.metadata)).filter(id => !required.includes(id)));
}

function projectPublishedPostAssets(assetIds, media, uploadedMediaReady, optional = new Set()) {
  const assets = new Map();
  assetIds.forEach((id, index) => {
    try {
      assets.set(id, assertPublishedAssetProjection({ assetId: id, owner: "published Post",
        privateSnapshot: media[index * 2], publicSnapshot: media[index * 2 + 1], uploadedMediaReady }));
    } catch {
      const record = media[index * 2]?.data();
      // An absent or retired lead can disappear safely. A current asset with a
      // lagging public projection must retain the existing retry/refusal path.
      if (!optional.has(id) || (media[index * 2]?.exists && record?.lifecycle === "active"
        && ["site_seed", "upload"].includes(record.source)
        && typeof record.mimeType === "string" && record.mimeType.startsWith("image/"))) {
        throw readerFailure("reader_media_ineligible");
      }
      logger.warn("Omitting an invalid Post lead image projection", { assetId: id });
    }
  });
  return selectedAssets({ assetIds: [...assets.keys()] }, assets);
}

async function assertReaderMediaFence({ firestore, transaction, actual, releaseSelector }) {
  if (releaseSelector === undefined) { assertPublishedMediaReadiness(actual); return; }
  const pair = require("./lib/public-release-pair");
  if (pair.publicReleaseDigest(require("./lib/public-release-media-fence").parseStoredSelector(actual)) !==
      pair.publicReleaseDigest(pair.parsePublicReleaseSelector(releaseSelector))) throw new pair.PublicReleaseProtocolError();
  await require("./lib/public-release-media-fence").assertPairMediaFenceInTransaction({ firestore, transaction, selector: releaseSelector });
}
async function readPublishedPost({ firestore, slug, now, transaction, includeChrome = true, cardsOnly = false, allowLegacyVisibility = false, nextDocument, documentId, releaseSelector }) {
  // A read-only transaction pins slug ownership, visibility, snapshot, authors and media
  // to one authoritative Firestore read time. It never locks or writes content.
  const read = async tx => {
    const selected = await readPublishedPostSnapshot({ firestore, transaction: tx, slug, now, cardsOnly, allowLegacyVisibility, nextDocument, documentId });
    if (selected.kind !== "snapshot") return selected;
    const { owner, published } = selected;
    const authors = await readPublishedAuthors(firestore, tx, published.metadata);
    const { assetIds } = collectPublishedMediaUsage({ collection: "cmsPosts", snapshot: published });
    if (assetIds.length > 100) throw readerFailure("reader_invalid_snapshot");
    const optional = optionalLeadAssetIds(published);
    const refs = assetIds.flatMap(id => [firestore.doc(`media_assets/${id}`), firestore.doc(`media_assets_public/${id}`)]);
    const media = refs.length ? await tx.getAll(...refs) : [];
    let uploadedMediaReady = false;
    if (media.some((record, index) => index % 2 === 0 && record.data()?.source === "upload")) {
      const deployment = await tx.get(firestore.doc("system/publicDeployment"));
      try { await assertReaderMediaFence({ firestore, transaction: tx, actual: deployment.data(), releaseSelector }); uploadedMediaReady = true; }
      catch (error) { refuseReaderMedia(error, releaseSelector); }
    }
    const safeAssets = projectPublishedPostAssets(assetIds, media, uploadedMediaReady, optional);
    const chrome = includeChrome ? await readPublishedChrome(firestore, tx, now) : {};
    const ctaRules = chrome.settings?.find(setting => setting.id === "story-ctas")?.published.values.rules ?? [];
    const ctaBlocks = ctaRules.filter(rule => rule.enabled).map((rule, order) => ({ ...rule.content, id: `story-cta-${rule.id}`, visible: true, order }));
    const recordIds = [...new Set([...joinedRecordIds(published.blocks), ...joinedRecordIds(ctaBlocks)])];
    if (recordIds.length > 100) throw readerFailure("reader_unsupported_dependency");
    const joinedRecords = [];
    if (recordIds.length) {
      const snaps = await tx.getAll(...recordIds.map(id => firestore.doc(`cmsPosts/${id}`)));
      const libraryIds = snaps.filter(snap => snap.exists && (snap.data()?.type === "sponsor" || snap.data()?.type === "newsletter")).map(snap => snap.id);
      const historyById = await readLibraryHistory(firestore, tx, libraryIds);
      for (const snap of snaps) {
        if (!snap.exists) continue;
        const shaped = shapeJoinedRecord(snap.id, snap.data(), historyById.get(snap.id) ?? []);
        if (shaped) joinedRecords.push(shaped);
      }
    }
    const extraAssetIds = joinedAssetIds(joinedRecords).filter(id => !safeAssets[id]);
    let joinedReady = uploadedMediaReady;
    const joinedSafe = {};
    if (extraAssetIds.length) {
      const joinedMedia = await tx.getAll(...pairedAssetPaths(extraAssetIds).map(path => firestore.doc(path)));
      if (!joinedReady && joinedMedia.some((record, index) => index % 2 === 0 && record.data()?.source === "upload")) {
        const deployment = await tx.get(firestore.doc("system/publicDeployment"));
        try {
          if (releaseSelector === undefined) assertPublishedMediaReadiness(deployment.data());
          else await assertReaderMediaFence({ firestore, transaction: tx, actual: deployment.data(), releaseSelector });
        }
        catch (error) { refuseReaderMedia(error, releaseSelector); }
        joinedReady = true;
      }
      let projected;
      try {
        projected = new Map(extraAssetIds.map((id, index) => [id, projectPairedAsset({
          assetId: id, privateSnapshot: joinedMedia[index * 2], publicSnapshot: joinedMedia[index * 2 + 1], uploadedMediaReady: joinedReady,
        })]));
      } catch { throw readerFailure("reader_media_ineligible"); }
      Object.assign(joinedSafe, selectedAssets({ assetIds: extraAssetIds }, projected));
    }
    const joinedAssets = extraAssetIds.filter(id => joinedSafe[id]).map(id => ({ id, ...joinedSafe[id] }));
    const result = { kind: cardsOnly ? "published-post-card" : "published-post", document: { id: owner.id, status: "published", publiclyVisible: true, deleted: false,
      publishAt: published.publishedAt, published }, assets: [...assetIds.filter(id => safeAssets[id]).map(id => ({ id, ...safeAssets[id] })), ...joinedAssets],
      joinedRecords, authors, ...chrome };
    if (!require("./lib/content-link").contentLinkReadFits(result, 2 * 1024 * 1024)) throw readerFailure("reader_invalid_snapshot");
    return result;
  };
  return transaction ? read(transaction) : firestore.runTransaction(read, { readOnly: true });
}

/** Home cards share one fresh authority transaction. Batch their document
 * dependencies without retaining any value for the next request. */
async function readPublishedHomePostCards({ firestore, transaction, slugs, now, releaseSelector }) {
  const uniqueSlugs = [...new Set(slugs)];
  const chunks = [];
  for (let offset = 0; offset < uniqueSlugs.length; offset += 30) chunks.push(uniqueSlugs.slice(offset, offset + 30));
  // Cards validate the frozen metadata and version, but never render body blocks.
  const posts = firestore.collection("cmsPosts").where("published.metadata.type", "==", "post")
    .select("deleted", "publiclyVisible", "status", "version", "publicSourceVersion",
      "published.sourceVersion", "published.publishedAt", "published.metadata");
  const matches = await Promise.all(chunks.map(async chunk => {
    const limit = 2 * chunk.length + 1;
    const [canonical, aliases] = await Promise.all([
      transaction.get(posts.where("published.metadata.slug", "in", chunk).limit(limit)),
      transaction.get(posts.where("published.metadata.previousSlugs", "array-contains-any", chunk).limit(limit)),
    ]);
    // More than two rows per requested slug proves ambiguity. Refuse the
    // entire frame instead of allowing a bounded query to hide an owner.
    if (canonical.size >= limit || aliases.size >= limit) throw readerFailure("reader_ambiguous_route");
    return [...canonical.docs, ...aliases.docs];
  }));
  const owners = new Map(uniqueSlugs.map(slug => [slug, new Map()]));
  for (const row of new Map(matches.flat().map(row => [row.id, row])).values()) {
    const metadata = row.data().published.metadata;
    for (const slug of [metadata.slug, ...(metadata.previousSlugs ?? [])]) {
      owners.get(slug)?.set(row.id, row);
    }
  }
  const selected = slugs.map(slug => projectPublishedPostSnapshot(owners.get(slug), slug, now, true));
  const cards = selected.filter(result => result.kind === "snapshot").map(result => {
    const authorIds = registeredAuthorIds(result.published.metadata.credits ?? []);
    const { assetIds } = collectPublishedMediaUsage({ collection: "cmsPosts", snapshot: result.published });
    if (assetIds.length > 100) throw readerFailure("reader_invalid_snapshot");
    return { ...result, authorIds, assetIds };
  });
  const { mediaReplacementRef } = require("./lib/media-replacement");
  const refs = cards.flatMap(card => [
    ...card.authorIds.map(id => firestore.doc(`cmsAuthorProfilesPublic/${id}`)),
    ...card.assetIds.flatMap(id => [firestore.doc(`media_assets/${id}`),
      firestore.doc(`media_assets_public/${id}`), mediaReplacementRef(firestore, id)]),
  ]);
  const uniqueRefs = [...new Map(refs.map(ref => [ref.path, ref])).values()];
  const snapshots = uniqueRefs.length ? await transaction.getAll(...uniqueRefs) : [];
  const rows = new Map(snapshots.map(snapshot => [snapshot.ref.path, snapshot]));
  const uploadedMedia = cards.some(card => card.assetIds.some(id => rows.get(`media_assets/${id}`).data()?.source === "upload"));
  const pointer = uploadedMedia ? (await transaction.get(firestore.doc("system/publicDeployment"))).data() : null;
  const pairMediaReady = uploadedMedia && releaseSelector !== undefined;
  if (pairMediaReady) {
    try { await assertReaderMediaFence({ firestore, transaction, actual: pointer, releaseSelector }); }
    catch (error) { refuseReaderMedia(error, releaseSelector); }
  }
  const replies = new Map(cards.map(card => {
    const authors = projectPublishedAuthors(card.authorIds, card.authorIds.map(id => rows.get(`cmsAuthorProfilesPublic/${id}`)));
    const media = card.assetIds.flatMap(id => [rows.get(`media_assets/${id}`), rows.get(`media_assets_public/${id}`)]);
    const optional = optionalLeadAssetIds(card.published);
    let uploadedMediaReady = false;
    if (media.some((snapshot, index) => index % 2 === 0 && snapshot.data()?.source === "upload")) {
      try { if (!pairMediaReady) assertPublishedMediaReadiness(pointer); uploadedMediaReady = true; }
      catch { throw readerFailure("reader_media_fence"); }
    }
    const assets = projectPublishedPostAssets(card.assetIds, media, uploadedMediaReady, optional);
    if (card.assetIds.some(id => rows.get(mediaReplacementRef(firestore, id).path).exists)) {
      throw Object.assign(new Error("Build-free Page context: Home Post media replacement is pending"), { status: 409 });
    }
    const reply = { kind: "published-post-card", document: { id: card.owner.id,
      status: "published", publiclyVisible: true, deleted: false, publishAt: card.published.publishedAt,
      published: card.published }, assets: card.assetIds.filter(id => assets[id]).map(id => ({ id, ...assets[id] })), joinedRecords: [], authors };
    if (Buffer.byteLength(JSON.stringify(reply)) > 2 * 1024 * 1024) throw readerFailure("reader_invalid_snapshot");
    return [card.owner.id, reply];
  }));
  return selected.map(result => result.kind === "snapshot" ? replies.get(result.owner.id) : result);
}

function authenticated(req, secret, now) {
  const timestamp = requestHeader(req, "x-njpbs-post-timestamp");
  const supplied = requestHeader(req, "x-njpbs-post-signature");
  if (typeof secret !== "string" || secret.length < 32 || !/^\d{13}$/.test(timestamp ?? "") ||
      !/^[a-f0-9]{64}$/.test(supplied ?? "") || Math.abs(now.getTime() - Number(timestamp)) > SKEW_MS) return false;
  const expected = createHmac("sha256", secret)
    .update(`njpbs-post-reader-v1\n${req.method}\n${req.path}\n${timestamp}`).digest();
  return timingSafeEqual(expected, Buffer.from(supplied, "hex"));
}

function createCmsGetPublishedPostHandler(deps = {}) {
  const firestore = deps.firestore ?? db;
  const log = deps.log ?? logger;
  const now = deps.now ?? (() => new Date());
  const readSecret = deps.readSecret ?? (() => PUBLISHED_POST_READER_HMAC_KEY.value());
  const config = deps.config ?? (() => ({ enabled: process.env.SHADOW_POST_READER_ENABLED === "true",
    slugs: (process.env.SHADOW_POST_READER_SLUGS ?? "").split(",").map(slug => slug.trim()) }));
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    let code = "reader_unconfigured";
    let slug;
    try {
      slug = /^\/posts\/([^/]+)\/$/.exec(req.path)?.[1];
      const time = now();
      const secret = readSecret();
      code = "published_read_refused";
      if (req.method !== "GET" || req.originalUrl !== req.path || !isServerMintableSlugShape(slug) ||
          !authenticated(req, secret, time)) {
        log.warn("Published Post request refused", { code, slug: isServerMintableSlugShape(slug) ? slug.slice(0, 1000) : null });
        return res.status(403).json({ error: "Published read refused" });
      }
      const settings = config();
      if (!settings.enabled || !settings.slugs.includes(slug)) return res.status(404).json({ kind: "not-found" });
      code = "published_snapshot_unavailable";
      const result = await readPublishedPost({ firestore, slug, now: time });
      if (!require("./lib/content-link").contentLinkReadFits(result, 2 * 1024 * 1024)) throw new Error("Published read too large");
      return res.status(result.kind === "gone" ? 410 : result.kind === "not-found" ? 404 : 200).json(result);
    } catch (error) {
      // Never log arbitrary SDK errors, content, headers or secret values.
      code = failureCode(error, code);
      if (isPublishedPostRefusal(error)) res.set("X-Njpbs-Post-Read-Failure", "refusal");
      log.warn("Published Post read unavailable", { code, slug: isServerMintableSlugShape(slug) ? slug.slice(0, 1000) : null });
      return res.status(503).json({ error: "Published content is unavailable" });
    }
  };
}

// The shadow and relay abort after 10 seconds; a cold start measured 4.7-9.6 s.
const cmsGetPublishedPost = onRequest({ invoker: "public", minInstances: 1, maxInstances: 10, cpu: 1, concurrency: 80,
  serviceAccount: "njpbs-published-post-reader@njpbs-site.iam.gserviceaccount.com",
  secrets: [PUBLISHED_POST_READER_HMAC_KEY] },
  createCmsGetPublishedPostHandler());
module.exports = { cmsGetPublishedPost, createCmsGetPublishedPostHandler, readPublishedPost, readPublishedHomePostCards, readPublishedChrome,
  publicAuthorSnapshot, publicRichText, isPublishedPostRefusal };
