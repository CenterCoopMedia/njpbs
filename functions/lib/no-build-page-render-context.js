"use strict";

const { Filter } = require("firebase-admin/firestore");

const { readNoBuildPageProjectionInTransaction } = require("./no-build-page-source");
const { validateNoBuildPageSnapshot, noBuildPageOwnerPath } = require("./no-build-page-contract");
const { readPublicContextRevisionInTransaction, publicContextDigest, PUBLIC_CONTEXT_PATH } = require("./public-context-revision");
const { pagePublicationTarget } = require("./no-build-page-target");
const { assertMediaLifecycleDeploymentFence, assertPublicDeploymentPointer, PublicDeploymentFenceError } = require("./public-deployment");
const { readPublishedHomePostCards, readPublishedChrome, publicAuthorSnapshot, publicRichText } = require("../published-post-reader");
const { PROGRAM_METADATA_FIELDS, EVENT_METADATA_FIELDS } = require("./publish-snapshot");
const { joinedAssetIds, shapeJoinedRecord, readLibraryHistory, pairedAssetPaths, projectPairedAsset } = require("./joined-records");
const { mediaReplacementRef } = require("./media-replacement");
const { selectedAssets, PublicContentProjectionError } = require("./public-content-projection");
const { PublishedMediaSafetyError } = require("./published-media-safety");
const { publiclyVisible } = require("./public-video-references");
const { parsePublishInstant } = require("./publish-instant");

function refuse(message) { throw Object.assign(new Error(`Build-free Page context: ${message}`), { status: 409 }); }
const pick = (value, fields) => Object.fromEntries(fields.filter(field => value?.[field] !== undefined)
  .map(field => [field, structuredClone(value[field])]));
function publicJoinedRecord(record) {
  if (!record.published) return record;
  const metadata = pick(record.published.metadata, record.published.metadata.type === "program"
    ? PROGRAM_METADATA_FIELDS : EVENT_METADATA_FIELDS);
  if (metadata.description && typeof metadata.description === "object") metadata.description = publicRichText(metadata.description);
  return { ...record, published: { sourceVersion: record.published.sourceVersion,
    publishedAt: record.published.publishedAt, metadata, blocks: [] } };
}

async function assertUnconfirmedJoinedRecord({ firestore, transaction, row, rendererSha }) {
  const document = row.data(), metadata = document.published.metadata;
  const family = metadata.type === "program" ? "programs" : "events";
  const decision = await require("./public-context-background-reader").readPublicContextBackgroundInTransaction({
    firestore, transaction, path: `/${family}/${metadata.slug}/`, rendererSha });
  const owner = decision?.record;
  if (!owner?.visible || owner.documentId !== row.id || owner.sourceVersion !== document.published.sourceVersion) {
    refuse("unconfirmed joined record has no matching public owner");
  }
  const original = (await transaction.get(firestore.doc(`cmsPublishQueue/${owner.operationId}`))).data()?.recordPublication;
  if (original?.contextRevision !== owner.contextRevision || original.originalOperationId !== owner.operationId ||
      original.operationId !== owner.operationId) {
    refuse("unconfirmed joined record operation changed");
  }
  const accepted = await require("./no-build-record-publication").readRecordPublication({
    firestore, transaction, operationId: owner.operationId, document });
  if (!accepted) refuse("unconfirmed joined record publication is unavailable");
}

/** Both acceptance and serving use the caller's authority transaction. This
 * helper never writes, chooses a provider, or returns a working field. */
async function assertNoBuildPageContextInTransaction({ firestore, transaction, pageId, nextDocument,
  rendererSha, now = new Date(), target, scheduleCapture, readProviderInput, strictPublicReleaseInputs = false, releaseSelector, legacyStaffServing = false }) {
  target = pagePublicationTarget({ firestore, target });
  noBuildPageOwnerPath(pageId);
  if (["schedule", "live"].includes(pageId) && !scheduleCapture) refuse("Schedule and Live require qualified sealed schedule authority.");
  if (!/^[a-f0-9]{40}$/.test(rendererSha ?? "")) refuse("renderer identity is invalid");
  const [pointerSnapshot, contextRevision, contextSnapshot, documentSnapshot] = await Promise.all([
    transaction.get(firestore.doc("system/publicDeployment")),
    readPublicContextRevisionInTransaction(transaction, firestore),
    ["home", "data-hub"].includes(pageId) ? transaction.get(firestore.doc(PUBLIC_CONTEXT_PATH)) : null,
    nextDocument === undefined || nextDocument === null ? transaction.get(firestore.doc(`cmsPages/${pageId}`)) : null,
  ]);
  const pair = require("./public-release-pair");
  const pointer = pointerSnapshot.data()?.schemaVersion === 2
    ? require("./public-release-media-fence").parseStoredSelector(pointerSnapshot.data())
    : assertPublicDeploymentPointer(pointerSnapshot.data());
  if (releaseSelector !== undefined && pair.publicReleaseDigest(pair.parsePublicReleaseSelector(releaseSelector)) !== pair.publicReleaseDigest(pointer)) refuse("selected pair changed");
  if (pointer?.activeCommitSha !== rendererSha || pointer.state !== "idle") refuse("code release is in progress");
  const contextDigest = publicContextDigest(contextRevision);
  const changedAt = contextSnapshot?.data()?.changedAt?.toMillis?.() ?? null;
  const document = nextDocument ?? documentSnapshot.data();
  const plan = validateNoBuildPageSnapshot({ pageId, snapshot: document?.published });
  if (!Number.isSafeInteger(document.version) || document.published.sourceVersion > document.version ||
      (Number.isSafeInteger(document.publicSourceVersion) && document.published.sourceVersion < document.publicSourceVersion)) {
    refuse("published source version is inconsistent");
  }
  const result = await readNoBuildPageProjectionInTransaction({ firestore, transaction, pageId, now, document,
    ...(pointer.schemaVersion === 2 ? { releaseSelector: pointer } : {}) });
  if (result.state !== "live") refuse("Page is not public");

  const dependencies = await readPageRenderDependenciesInTransaction({ firestore, transaction, pageId,
    recordIds: plan.recordIds, page: result.page, pointer, rendererSha, now, target, scheduleCapture, readProviderInput, strictPublicReleaseInputs,
    legacyStaffServing: legacyStaffServing && pointerSnapshot.data()?.schemaVersion !== 2 && !strictPublicReleaseInputs });
  const context = { kind: "published-page", page: { ...result.page,
    ...(document.published.metadata.previousSlugs === undefined ? {} : { previousSlugs: plan.previousSlugs }) },
    ...dependencies,
    sourceSeal: { rendererSha, contextRevision, contextDigest,
      ...(dependencies.schedule ? { codeGeneration: pointer.schemaVersion === 2
        ? dependencies.schedule.receipt.code.generation : pointer.activeGeneration } : {}),
      ...(Number.isFinite(changedAt) && changedAt > 0 ? { cutoffAt: new Date(changedAt).toISOString() } : {}) } };
  if (!require("./content-link").contentLinkReadFits(context, 8 * 1024 * 1024)) refuse("input is too large");
  return context;
}

/** Shared shell, profiles and card dependencies also belong to committed frames.
 * A frame has no editorial snapshot or editorial source version. */
async function readPageRenderDependenciesInTransaction({ firestore, transaction, pageId, recordIds = [],
  page = null, pointer, now, target, scheduleCapture, readProviderInput, strictPublicReleaseInputs = false, legacyStaffServing = false }) {
  const rows = recordIds.length ? await transaction.getAll(...recordIds.map(id => firestore.doc(`cmsPosts/${id}`))) : [];
  const libraryIds = rows.filter(row => row.exists && ["sponsor", "newsletter"].includes(row.data()?.type)).map(row => row.id);
  const history = await readLibraryHistory(firestore, transaction, libraryIds);
  for (const row of rows) {
    if (row.data()?.publicSourceVersion === null && shapeJoinedRecord(row.id, row.data())?.published) {
      await assertUnconfirmedJoinedRecord({ firestore, transaction, row, rendererSha: pointer.activeCommitSha });
    }
  }
  const joinedRecords = rows.flatMap(row => {
    const record = row.exists && shapeJoinedRecord(row.id, row.data(), history.get(row.id) ?? []);
    if (record?.published && (!Number.isSafeInteger(record.published.sourceVersion) || record.published.sourceVersion < 1 ||
        (row.data().version !== undefined && (!Number.isSafeInteger(row.data().version) || record.published.sourceVersion > row.data().version)) ||
        (row.data().publicSourceVersion !== undefined && row.data().publicSourceVersion !== null &&
          (!Number.isSafeInteger(row.data().publicSourceVersion) || record.published.sourceVersion < row.data().publicSourceVersion)))) {
      refuse("joined source version is inconsistent");
    }
    return record ? [publicJoinedRecord(record)] : [];
  });
  const ids = joinedAssetIds(joinedRecords);
  const [media, locks] = ids.length ? await Promise.all([
    transaction.getAll(...pairedAssetPaths(ids).map(path => firestore.doc(path))),
    transaction.getAll(...ids.map(id => mediaReplacementRef(firestore, id))),
  ]) : [[], []];
  if (locks.some(row => row.exists)) refuse("joined media replacement is pending");
  const uploadedMediaReady = media.some((row, index) => index % 2 === 0 && row.data()?.source === "upload");
  if (uploadedMediaReady) {
    if (pointer.schemaVersion === 2) await require("./public-release-media-fence").assertPairMediaFenceInTransaction({ firestore, transaction, selector: pointer });
    else assertMediaLifecycleDeploymentFence(pointer);
  }
  const assets = new Map(ids.map((id, index) => [id, projectPairedAsset({ assetId: id,
    privateSnapshot: media[index * 2], publicSnapshot: media[index * 2 + 1], uploadedMediaReady })]));
  const safeAssets = selectedAssets({ assetIds: ids }, assets);
  const chrome = await readPublishedChrome(firestore, transaction, now, { strictBanner: pageId === "home" });
  const navigationPages = [...chrome.navigationPages.filter(page => page.pageId !== pageId),
    ...(page ? [{ pageId, path: page.path }] : [])].sort((a, b) => a.pageId.localeCompare(b.pageId));
  if (new Set(navigationPages.map(page => page.path)).size !== navigationPages.length) refuse("two Pages own the same URL");
  const settings = [...chrome.settings];
  const posts = [];
  const homeHeroPages = [];
  const authors = [];
  const homeNewsletters = pageId === "home"
    ? await require("./home-newsletter-context").readHomeNewslettersInTransaction({ firestore, transaction, pointer, now,
      recordIds: (page?.blocks ?? []).flatMap(block => block.type === "newsletter_signup" && block.section === "home-newsletter" ? block.data.newsletterIds : []) })
    : undefined;
  if (pageId === "staff") {
    const rows = await transaction.get(firestore.collection("cmsAuthorProfilesPublic").limit(1001));
    if (rows.size > 1000) refuse("Staff author dependencies exceed the current bound");
    authors.push(...rows.docs.sort((a, b) => a.id.localeCompare(b.id)).map(row => publicAuthorSnapshot(row, { strict: true })));
    // Paired promotion contains the roster and author bodies in one view.
    // Legacy background authors promote independently of this live roster.
    if (legacyStaffServing && !strictPublicReleaseInputs && authors.length) {
      const serving = await require("./staff-author-serving").readServingStaffAuthorPaths({
        firestore, transaction, rendererSha: pointer.activeCommitSha, now, path: `/authors/${authors[0].slug}/` });
      if (serving) for (const author of authors) author.profilePageReady = serving.has(`/authors/${author.slug}/`);
    }
  }
  if (pageId === "home") {
    // Resolve only the saved Page pins through the existing published Page
    // projector. A missing or withdrawn Page contributes no card.
    const pins = require("./home-hero").parseHomeHero(page?.homeHero)?.pins ?? [];
    for (const pin of pins.filter(pin => pin.source === "cms_pages")) {
      if (pin.endsAt && Date.parse(pin.endsAt) <= now.getTime()) continue;
      const row = await transaction.get(firestore.doc(`cmsPages/${pin.sourceId}`));
      if (!row.exists || row.data()?.deleted === true || !publiclyVisible(row.data())) continue;
      try {
        const result = await readNoBuildPageProjectionInTransaction({ firestore, transaction, pageId: pin.sourceId, now,
          document: row.data(),
          ...(pointer.schemaVersion === 2 ? { releaseSelector: pointer } : {}) });
        if (result.state === "live") homeHeroPages.push(result.page);
      } catch (error) {
        // A pin is optional. Unavailable Page snapshots or media must not
        // block Home; transaction and release-authority failures still do.
        if (!(error instanceof PublicContentProjectionError || error instanceof PublishedMediaSafetyError ||
            error instanceof PublicDeploymentFenceError)) throw error;
      }
    }
    // Firestore cannot query a missing field. Include published legacy rows,
    // then apply the repository visibility predicate before counting current
    // dependencies. Hitting the candidate cap refuses the entire context,
    // so a bounded read can never hide live rows behind retained history.
    const candidates = await transaction.get(firestore.collection("cmsPosts").where("published.metadata.type", "==", "post")
      .where(Filter.or(Filter.where("publiclyVisible", "==", true), Filter.where("status", "==", "published"))).limit(1001)
      .select("deleted", "publiclyVisible", "status", "publishAt", "published.publishedAt", "published.metadata.slug"));
    if (candidates.size >= 1001) refuse("Home Post candidate reads exceed the current bound");
    const visible = candidates.docs.filter(row => {
      const document = row.data();
      // Match the full build's immutable-snapshot admission clock, including
      // legacy published rows and later working edits to a live snapshot.
      const instant = parsePublishInstant(document.status === "published" ? document.publishAt : document.published?.publishedAt);
      return publiclyVisible(document) && instant !== null && instant <= now.getTime();
    });
    if (visible.length > 200) refuse("Home Post dependencies exceed the current bound");
    const ordered = visible.sort((a, b) => a.id.localeCompare(b.id));
    const cards = await readPublishedHomePostCards({ firestore, transaction, now,
      slugs: ordered.map(row => row.data().published.metadata.slug),
      ...(pointer.schemaVersion === 2 ? { releaseSelector: pointer } : {}) });
    for (const [index, card] of cards.entries()) {
      if (card.kind !== "published-post-card" || card.document.id !== ordered[index].id) refuse("Home Post ownership is ambiguous");
    }
    posts.push(...cards);
  }
  const dataHubSources = pageId === "data-hub" ? await require("./data-hub-reporting-context").readReportingContext({firestore,transaction,now,page,readProviderInput,strictPublicReleaseInputs}) : undefined;
  const schedule = ["schedule", "live"].includes(pageId)
    ? await require("./no-build-page-schedule-reader").readPageScheduleInputsInTransaction({
      firestore, transaction, rendererSha: pointer.activeCommitSha, target, scheduleCapture }) : undefined;
  return { assets: ids.map(id => ({ id, ...safeAssets[id] })), joinedRecords, settings, ...(chrome.contentLinks ? { contentLinks: chrome.contentLinks } : {}), ...(chrome.coverageLabels ? { coverageLabels: chrome.coverageLabels } : {}), navigationPages, posts, authors,
    ...(homeHeroPages.length ? { homeHeroPages } : {}),
    ...(dataHubSources ? {dataHubSources} : {}),
    ...(homeNewsletters ? { homeNewsletters } : {}),
    ...(schedule ? { schedule } : {}) };
}

module.exports = { assertNoBuildPageContextInTransaction, readPageRenderDependenciesInTransaction };
