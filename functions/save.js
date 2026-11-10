"use strict";

const { publishedBlockResourceError } = require("./lib/published-resource-check");

const { preparePublicReleaseProducerInTransaction, publicContentChange, publicReleaseProducerOperation } = require("./lib/public-release-producer");

const { readNoBuildFamilyAdmission, selectsNoBuildPost } = require("./lib/no-build-family-admission");
const { readNoBuildPostOwner } = require("./lib/no-build-post-ownership");
const { resolveDatasetFiguresInTransaction } = require("./lib/dataset-dependencies");
const { prepareDatasetUsageWrites } = require("./lib/dataset-usage");
const { prepareNoBuildContentPublication, assertNoBuildContentScheduleInTransaction } = require("./lib/no-build-content-publication");
const { bumpPublicContextRevision } = require("./lib/public-context-revision");
const { contentVersion, hasContentChanges } = require("./lib/content-version");
const { changesPublicLibraryFields } = require("./lib/library-card-publication");
const { stampDocumentLists } = require("./lib/document-list");
const { recordCardSaveWarnings } = require("./lib/record-card-warnings");
const { publicationScheduleError } = require("./lib/publication-schedule");
const { readTemplateDraft } = require("./lib/post-templates");
const { planHomeCompositionV2 } = require("./lib/home-composition-v2");
const { changesCustomHtml } = require("./lib/custom-html");
const { isCustomPageId, isAvailablePageSlug, publicPageDefinition } = require("./lib/public-page-contract");

// cmsSaveContent: the transactional content half of the CMS publishing model
// (ADR 0012). A normal request persists the mutable working document. An explicit
// `publish:true` request also freezes its viewer-visible metadata and canonical
// blocks into `published` and moves the lifecycle to published in that same
// transaction. On the serializer transport, that transaction also creates the
// build queue row. A `scheduleAt` request locks the exact saved revision for
// the scheduled publisher. Other transports use cmsPublish to dispatch the build.
//
// It mirrors createCmsPublishHandler's house patterns: the createXHandler(deps = {})
// dependency-injection factory, bearer-token auth, and failed-precondition -> 503
// mapping. Ordinary saves need no billing gate because they are internal Firestore
// writes. An explicit publish does run the shared transport-readiness gate before
// its snapshot transaction because that write is useful only when the metered build
// and terminal writeback path are ready. The audit is atomic rather than merely
// ordered: cmsPublish writes its audit row before irreversible external dispatch.
// This local mutation commits the content document, version history, audit row,
// and any serializer queue row together. They all land or none do.
//
// The server owns three things the client cannot: the canonical block ids (#515),
// the document's own metadata (id, createdAt, updatedAt, updatedBy, version), and
// the published snapshot (written only by an explicit publish action). A first page-specific
// save may copy those fields from a server-read legacy singleton, but the browser can
// neither supply nor alter them. The function re-validates the block payload with the
// same parseBlocks contract the editor and renderer share, via the CommonJS mirror in
// lib/content-blocks.js -- it never trusts the client's #513 client-side guard.
//
// Authorization (#529): the gate is capability-based, not role-name-based. The
// caller's principal is resolved from the trusted user document (role + grants),
// and lib/content-authorization.js decides the specific save against the record
// that was just read: create, edit-any, or edit-your-own-draft, plus the publish,
// schedule, unpublish, and archived-record restoration transitions. Soft-deleted
// sources and targets are refused before composition. Section scope is decided
// against the document's own editorial desk (#845): a page's server-owned public
// area, an existing record's stored desk, or the desk a record create asks to be
// created into. What it still cannot decide stays deny-by-default rather than
// assumed: a document carrying no desk authorizes nothing for a scoped grant, and
// a record stored before `createdBy` existed has no owner, so own-content editing
// does not reach it.
//
// Concurrency (#530): a save composes its write by overlaying the fields the client
// sent onto the document it just read, so the read is what the write is built from.
// Two saves that both read before either writes are composed against the same
// snapshot, and the second write carries the first's fields back to their pre-save
// values -- silently, because neither editor need have touched the same field. Two
// guards do different jobs here:
//
//   - The read and the writes share one transaction, so Firestore aborts and re-runs
//     this callback when the document moves under it. The re-run re-reads, so the
//     overlay lands on committed state rather than stale state. That is what makes a
//     save of one field safe against a concurrent save of another, and it is what
//     keeps the version-history `before` honest: it becomes the state the write
//     actually replaced, not a snapshot that was already gone.
//   - `version` plus the client's echoed `baseVersion` catch what a transaction
//     cannot: two editors who changed the *same* field. A transaction narrows the
//     window to the server's own read-to-write, but the window that matters is the
//     minutes an editor had the page open. A save whose base version is stale is
//     refused with 409 rather than silently winning. Every existing-document save
//     must echo that version. Omitting the claim never authorizes an overwrite.

const { cmsOnRequest } = require("./lib/cms-edge");
const { automationWriteRefusal, readAutomationAccount } = require("./lib/automation-accounts");
const { withCmsSaveWarmup } = require("./lib/cms-save-warmup");
const { readFrozenLibraryPublicationMessage } = require("./lib/frozen-library-publication");
const { buildFreeRefusalInTransaction } = require("./lib/build-free-refusal");
const { publishSecretBindings } = require("./lib/cms-publish-credentials");
const logger = require("firebase-functions/logger");
const { createHash, randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { FieldValue } = require("firebase-admin/firestore");
const {
  assertSerializerPublicationAdmissionInTransaction,
} = require("./lib/cms-publication-runtime-control");
const { db } = require("./lib/firebase");
const { routePurgeConfig, routePurgeSecretNames, prepareRoutePurgeInTransaction,
  attemptPostRoutePurge } = require("./lib/post-route-purge");
const { requirePrincipal } = require("./lib/auth");
const { can, hasCapability } = require("./lib/rbac");
const {
  authorizeContentRead,
  authorizeContentWrite,
  contentResourceSection,
  contentResource,
  isUnassignedPostDraft,
  mayReachContentWrite,
} = require("./lib/content-authorization");
const {
  AUDIT_COLLECTIONS,
  adminLogEntry,
  versionHistoryEntry,
} = require("./lib/audit");
const { parseBlocks } = require("./lib/content-blocks");
const { isBoundedDocumentId } = require("./get-content");
const { blockContentError } = require("./lib/block-content-validation");
const { remapRowMembership } = require("./lib/content-layout");
const {
  CONTENT_DOCUMENT_CONTRACTS,
  SERVER_MANAGED_CONTENT_FIELDS,
  unsupportedContentFields,
  validateContentFieldValues,
} = require("./lib/content-document-contract");
const { validateSection } = require("./lib/editor-section-contract");
const {
  MAX_DOCUMENT_BYTES,
  documentSizeError,
  firestoreDocumentBytes,
} = require("./lib/document-size");
const { editorTemplateForPage } = require("./lib/public-page-contract");
const { homeEditorBoundaryError } = require("./lib/home-editor-boundary");
const { homeCompositionError, HOME_OPTIONAL_REGIONS } = require("./lib/home-composition-contract");
const { verifyHomeSelections } = require("./lib/home-source-selection-admission");
const { serviceCompositionError } = require("./lib/service-composition");
// The scoped-grant desk registry (#619). Unrelated to `validateSection` above, which
// checks a page-builder block section; these two "section" concepts share a word and
// nothing else.
const {
  REQUIRE_SECTION_ON_RECORD_CREATE,
  contentSectionForPage,
  isSectionId,
  unregisteredSections,
} = require("./lib/content-sections");
const {
  normalizeLegacyPostDate,
  normalizePublishAt,
  validateKnownMetadata,
} = require("./lib/content-metadata");
const {
  isMintablePostSlug,
  mintablePostSlugRoot,
  postSlugCandidate,
} = require("./lib/post-slug-contract");
const {
  PublishSnapshotError,
  createPublishedSnapshot,
} = require("./lib/publish-snapshot");
const { postPresentationError } = require("./lib/post-formats");
const { assertLiveBlogRetainsPublished, LiveBlogDraftError } = require("./lib/live-blog");
const { recordKindHasPublicRoute } = require("./lib/public-record-kinds");
const {
  applyFirstPublish,
  applyMeaningfulUpdate,
  resolveEditorialDateWrite,
} = require("./lib/editorial-dates");
const {
  normalizeStoryCredits,
  registeredAuthorIds,
  registeredCreditsError,
  resolveStoryCredits,
} = require("./lib/story-credits");
const {
  readAuthorIdentities,
  prepareLiveBlogDraftInTransaction,
  withFrozenCredits,
} = require("./lib/story-credit-directory");
const { PublicVideoError, withPublicVideos } = require("./lib/public-video");
const { withoutPublicLeadVideo } = require("./lib/post-lead-media");
const { withoutPublicVideoData } = require("./lib/video-block");
const {
  MediaUsageError,
  collectPublishedMediaUsage,
  collectWorkingMediaUsage,
  prepareMediaUsageWrite,
} = require("./lib/media-usage");
const {
  PUBLISH_BUILD_PENDING_FIELD,
  PUBLISH_BUILD_QUEUE_FIELD,
  PUBLIC_SOURCE_VERSION_FIELD,
} = require("./lib/publish-build-state");
const { CONTENT_STATUSES } = require("./lib/content-statuses");
const { advanceReviewRequest } = require("./lib/review-queue");

// The two content collections and their id strategy (ADR 0013):
//  - cmsPages holds one document per canonical public page id ("home", "contact", ...).
//    The document separately carries its editor template; the public page id is required.
//  - cmsPosts holds an EditorialRecord keyed by an immutable server-minted id.
//    An absent id means "create"; a present id means "update that record".
const SAVE_COLLECTIONS = new Set(["cmsPages", "cmsPosts"]);

// Save persists whatever valid status the document carries. Only the explicit
// publish and schedule actions may enter their public lifecycle states; an
// ordinary save cannot smuggle either transition through `status`.
// A block arriving without a canonical id gets one minted here (#515). The client
// uses a temporary key for React identity while a block is unsaved; that key is
// never persisted as canonical. Absent, empty, and temp-prefixed ids are all treated
// as "needs a canonical id"; any other string is an existing block id and is kept.
const TEMP_ID_PREFIX = "tmp-";

// What a refused caller sees. The precise reason (which capability was missing,
// whose record it is) goes to the server log instead: it describes other people's
// authority and the record's ownership, neither of which the refused client should
// learn from a 403 body.
const FORBIDDEN_MESSAGE = "You do not have permission to save this record.";
const SCHEDULED_PUBLISH_ACTOR = "system:scheduler";

async function defaultAssertPublishReady(fields) {
  const { assertPublishReady } = require("./publish");
  return assertPublishReady(fields);
}

async function defaultAssertPublishedMediaSafe(fields) {
  const { assertPublishedMediaSafe } = require("./lib/published-media-safety");
  return assertPublishedMediaSafe(fields);
}

// Keep the tombstone response aligned with cmsGetContent. A deleted record is
// neither a blank create base nor an editable stored record, so the editor must
// not hydrate, clone, or save it back into existence.
const DELETED_MESSAGE = "This record is no longer available.";

// Server-owned document fields the client must never set through a save. They are
// stripped from the incoming document and re-applied from server state so a confused
// or hostile client cannot forge a creation time, an author, a publish snapshot, or a
// version. `version` is here rather than in the request envelope for a reason: the
// number the client *reports having started from* is `baseVersion`, which the server
// checks; the number stored on the document is the server's own count of saves, and a
// client that could set it could defeat the check by echoing its own answer.
const SERVER_OWNED_FIELDS = SERVER_MANAGED_CONTENT_FIELDS;

// A rejection that carries the status the client should see. Thrown from inside the
// transaction so the read-dependent checks can refuse without a response object in
// scope, then mapped back to a response by the catch below. This rides the `err.status`
// convention the auth helpers already use.
class SaveRejection extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.name = "SaveRejection";
    this.status = status;
    this.details = details;
  }
}

class PublicationReadinessRequired extends Error {}

// A dry run (#4716) runs the whole save transaction, then throws this before commit. Firestore
// buffers transaction writes until commit, so the throw discards every staged write.
class DryRunResult extends Error {
  constructor(result) {
    super("dry run");
    this.result = result;
  }
}

const AUTOMATION_KEYS = new Set(["requestReference", "planDigest"]);

/** The audit details an automation account sends with every save: who asked, and what plan. */
function automationDetailsError(automation) {
  if (automation === undefined) return null;
  if (!isPlainObject(automation) || Object.keys(automation).some(key => !AUTOMATION_KEYS.has(key)) ||
      typeof automation.requestReference !== "string" || !/^[\x20-\x7e]{1,200}$/.test(automation.requestReference) ||
      automation.requestReference.trim() !== automation.requestReference ||
      typeof automation.planDigest !== "string" || !/^[a-f0-9]{64}$/.test(automation.planDigest)) {
    return "automation must carry a request reference and a SHA-256 plan digest.";
  }
  return null;
}

const STALE_VERSION_MESSAGE = "This document changed since you opened it. Reload to get the current version before saving.";

/** Staff must pause an active source before publishing manual result edits. */
async function withElectionResultsOrReject(fields) {
  const { withElectionSourceProjection, ElectionSourceProjectionError } = require("./lib/election-source-refresh");
  try { return await withElectionSourceProjection(fields); }
  catch (error) {
    if (error instanceof ElectionSourceProjectionError) throw new SaveRejection(error.status, error.message);
    throw error;
  }
}

/** Keep expected live-blog validation distinct from retryable SDK failures. */
async function withFrozenCreditsOrReject(freeze, fields) {
  try { return await freeze(fields); }
  catch (error) {
    if (error instanceof LiveBlogDraftError) throw new SaveRejection(400, error.message);
    throw error;
  }
}

/** Stamps public video copies and turns a missing copy into a 409 for staff. */
async function withPublicVideosOrReject(withPublicVideosFn, args) {
  try {
    return await withPublicVideosFn(args);
  } catch (error) {
    if (error instanceof PublicVideoError) throw new SaveRejection(error.status, error.message);
    throw error;
  }
}

function getClientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || null;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function confirmedPublicSourceVersion(document) {
  if (
    Number.isSafeInteger(document?.[PUBLIC_SOURCE_VERSION_FIELD]) &&
    document[PUBLIC_SOURCE_VERSION_FIELD] >= 1
  ) {
    return document[PUBLIC_SOURCE_VERSION_FIELD];
  }
  const legacyVersion = document?.published?.sourceVersion;
  const legacyWasConfirmed =
    document?.publishBuildPending !== true &&
    (document?.publiclyVisible === true ||
      (document?.publiclyVisible === undefined && document?.status === "published"));
  return Number.isSafeInteger(legacyVersion) && legacyVersion >= 1 && legacyWasConfirmed
    ? legacyVersion
    : null;
}

// A direct live blog update is for a public live blog Post whose working copy
// has no review in progress. A pending draft revision is allowed; the scope check
// below refuses it when that draft changes anything outside the live updates.
function liveBlogUpdateRefusal(stored) {
  const publishedBlog = stored?.type === "post" ? stored.published?.metadata?.liveBlog : undefined;
  if (stored?.type !== "post" || (stored.liveBlog === undefined && publishedBlog === undefined)) {
    return "Only a live blog Post can publish live updates directly.";
  }
  if (publishedBlog === undefined) {
    return "Publish this live blog through review and approval before publishing live updates directly.";
  }
  const visible = stored.publiclyVisible === true ||
    (stored.publiclyVisible === undefined && stored.status === "published");
  if (!visible) {
    return "This live blog is withdrawn. Republish it through review and approval before publishing live updates.";
  }
  if (!["published", "draft"].includes(stored.status)) {
    return "Finish or cancel this Post's review, approval or schedule before publishing live updates directly.";
  }
  return null;
}

// Revision bookkeeping that every publication changes. Everything else in the
// public snapshot, including coverage branding, must stay exactly as published.
const LIVE_BLOG_UPDATE_REVISION_FIELDS = new Set([
  "publishedAt", "publishedBy", "sourceVersion", "contentVersion", "previousVideoCopies",
]);

// Publication stamps each video with the current shared public copy, and another
// publication can refresh that copy (the old URLs move to previousVideoCopies).
// The same chosen asset is the same parent media, so compare without the copy.
function withoutMediaCopies(value) {
  if (Array.isArray(value)) return value.map(withoutMediaCopies);
  if (!value || typeof value !== "object") return value;
  const sameAsset = typeof value.assetId === "string";
  return Object.fromEntries(Object.entries(value)
    .filter(([field]) => !(sameAsset && field === "public"))
    .map(([field, item]) => [field, withoutMediaCopies(item)]));
}

function parentPublication(snapshot) {
  const parent = Object.fromEntries(Object.entries(snapshot ?? {})
    .filter(([field]) => !LIVE_BLOG_UPDATE_REVISION_FIELDS.has(field)));
  const { liveBlog, ...metadata } = parent.metadata ?? {};
  return withoutMediaCopies({ ...parent, metadata, liveBlogBranding: liveBlog?.branding ?? null });
}

// A direct update does not republish the parent byline. When the Post still credits
// the same people, keep the names frozen at its last approved publication, so a
// later profile rename cannot block live updates. A changed byline stays refused.
function creditIdentity(credit) {
  return credit?.kind === "registered" ? `registered:${credit.authorId}` : `custom:${credit?.name}`;
}

function withPublishedParentByline(previous, next) {
  const before = previous?.metadata?.credits;
  const after = next.metadata?.credits;
  if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length ||
      before.some((credit, index) => creditIdentity(credit) !== creditIdentity(after[index]))) return next;
  return { ...next, metadata: { ...next.metadata, credits: structuredClone(before) } };
}

function liveBlogUpdateScopeRefusal(previous, next) {
  if (!isDeepStrictEqual(parentPublication(previous), parentPublication(next))) {
    return "This Post has changes outside its live updates. Send the Post through review and approval to publish them.";
  }
  if (isDeepStrictEqual(previous?.metadata?.liveBlog, next.metadata?.liveBlog)) {
    return "There are no live update changes to publish.";
  }
  return null;
}

// A legacy document already above the new safety budget must still be able to
// cross a protective lifecycle boundary. Compare the complete before and after
// content while ignoring only the fields this transaction necessarily changes
// for that status transition. A changed title, block, metadata field, routing
// field, snapshot, or assignment therefore cannot ride the exception.
const LIFECYCLE_COMPARISON_IGNORED_FIELDS = new Set([
  "status",
  "createdAt",
  "updatedAt",
  "updatedBy",
  "version",
]);

function lifecycleContent(document, { ignorePublishAt = false } = {}) {
  return Object.fromEntries(
    Object.entries(document ?? {}).filter(
      ([key]) =>
        !LIFECYCLE_COMPARISON_IGNORED_FIELDS.has(key) &&
        !(ignorePublishAt && key === "publishAt"),
    ),
  );
}

function isProtectiveLifecycleOnlyTransition(
  stored,
  composed,
  { collection, expectedPageTemplate } = {},
) {
  if (!stored || !composed || stored.status === composed.status) return false;
  // Entering a public state is never a size-relief operation. The exception is
  // only for cancelling a scheduled publish, unpublishing, entering archived,
  // or restoring archived to a non-public workflow state.
  if (composed.status === "published" || composed.status === "scheduled") {
    return false;
  }
  const crossesProtectiveBoundary =
    stored.status === "published" ||
    stored.status === "scheduled" ||
    stored.status === "archived" ||
    composed.status === "archived";

  // Leaving scheduled state also cancels the pending instant. The editor sends
  // a cleared date as an empty string, which normalization replaces with the
  // current timestamp before this comparison. Ignore that scheduling metadata
  // only on the way out of scheduled; entering either public state was refused
  // above, so a content edit cannot use this exception to change a live date.
  const ignorePublishAt = stored.status === "scheduled";
  let storedContent = lifecycleContent(stored, { ignorePublishAt });
  const composedContent = lifecycleContent(composed, { ignorePublishAt });
  // The page-id contract deterministically backfills the canonical editor
  // template on every save. Treat that one server-owned legacy migration as
  // content-preserving, but only when the stored page lacked a template and the
  // composed value is the template derived and validated for this page id.
  if (
    collection === "cmsPages" &&
    storedContent.template === undefined &&
    typeof expectedPageTemplate === "string" &&
    composedContent.template === expectedPageTemplate
  ) {
    storedContent = { ...storedContent, template: expectedPageTemplate };
  }
  return (
    crossesProtectiveBoundary &&
    isDeepStrictEqual(storedContent, composedContent)
  );
}

function needsCanonicalId(id) {
  return typeof id !== "string" || id.length === 0 || id.startsWith(TEMP_ID_PREFIX);
}

// A create is the one save whose address the client cannot name: a record's canonical id
// is server-owned (#515), so the client omits it and adopts the id from the response. When
// that response is lost -- a timeout, a dropped connection, a closed tab -- the retry omits
// the id again and used to mint a second document holding the same content (#542). A page
// never had this problem: it is keyed by its section, so a page create is an upsert on a
// fixed address.
//
// This gives a record create a fixed address too. The client sends a nonce it reuses across
// retries of one create attempt, and the server derives the document id from it, so the retry
// addresses the document the first attempt made and the create-vs-update read below decides
// what happens next.
//
// The address covers the payload as well as the nonce, and that is the part that makes it safe
// to answer a retry with the stored record. A client that reused one nonce across two different
// drafts would otherwise be told its second draft was saved while the first one is what is
// stored -- a silent loss of the newer edit. Binding the payload in means a changed draft
// derives a different address and creates its own record, which is exactly what a create
// without a nonce does today, so the worst case degrades to current behavior instead of losing
// work. A genuine retry re-sends the same document and lands back on the same address.
//
// Derived, not accepted: the hash is one-way, so a caller holding a record id cannot work out
// the nonce that addresses it, and the id stays a value only the server can compute. The
// 32-hex-character shape also cannot collide with the 36-character UUIDs mintId produces, so
// a document sitting at a derived address can only have come from this same attempt.
const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
const IDEMPOTENCY_KEY_MAX_LENGTH = 200;

// Stable across re-serialization: two requests carrying the same fields hash the same even if
// their key order differs, so a retry is not mistaken for a different draft over JSON ordering.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// Start remains recovery data; the hero stays in metadata.
// The Newsletter starts as an empty slot; no source content is invented.
// Remaining authored content keeps its
// existing v1 visual order, including manual shelf placements and row children.
function editorialHomeBlocks(blocks, mintId) {
  const planned = planHomeCompositionV2(blocks);
  if (HOME_OPTIONAL_REGIONS.some(([section, type]) => section === "home-newscast" && type === "home_newscast")) {
    planned.push({ id: mintId(), type: "home_newscast", section: "home-newscast", order: planned.length, visible: true,
      data: { showId: "ad1f378e-9779-4ef1-a629-40a8a6f8f8d5", heading: "Latest newscast", summary: "", layout: "feature",
        watchLabel: "Watch the latest", pastLabel: "Past newscasts", liveLabel: "Watch live" } });
  }
  planned.push({ id: mintId(), section: "home-newsletter", type: "newsletter_signup", order: planned.length,
    visible: true, data: { newsletterIds: [], actionLabel: "Sign up by email" } });
  const sections = ["home-start", "home-start-action", "home-spotlight", "home-newscast",
    "home-featured", "home-more", "home-newsletter", "home-passport-copy",
    "home-passport-action", "home-posts", "home-donor"];
  const named = sections.flatMap(section => planned.filter(block => block.section === section));
  return [...named, ...planned.filter(block => !sections.includes(block.section))]
    .map((block, order) => ({ ...block, order }));
}

function homeConversionRequestError(body) {
  if (body.convertHomeV2 !== undefined) {
    if (body.convertHome !== undefined || body.collection !== "cmsPages" || body.id !== "home") {
      return "Use one explicit conversion for cmsPages/home.";
    }
    if (typeof body.convertHomeV2 !== "string" || body.convertHomeV2.length < IDEMPOTENCY_KEY_MIN_LENGTH || body.convertHomeV2.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
      return "convertHomeV2 must be a request key of 8 to 200 characters.";
    }
    if (!Number.isSafeInteger(body.baseVersion) || body.baseVersion < 1) return "Home conversion requires the exact saved baseVersion.";
    const allowed = new Set(["collection", "id", "document", "baseVersion", "convertHomeV2"]);
    if (Object.keys(body).some(key => !allowed.has(key)) || Object.keys(body.document).length !== 0) {
      return "Version 2 conversion accepts no content replacement or other save/publication action.";
    }
    return null;
  }
  if (body.convertHome === undefined) return null;
  if (body.collection !== "cmsPages" || body.id !== "home") {
    return "Home conversion is only available for cmsPages/home.";
  }
  if (
    typeof body.convertHome !== "string" ||
    body.convertHome.length < IDEMPOTENCY_KEY_MIN_LENGTH ||
    body.convertHome.length > IDEMPOTENCY_KEY_MAX_LENGTH
  ) return "convertHome must be a request key of 8 to 200 characters.";
  if (!Number.isSafeInteger(body.baseVersion) || body.baseVersion < 1) {
    return "Home conversion requires the exact saved baseVersion.";
  }
  const allowed = new Set(["collection", "id", "document", "baseVersion", "convertHome"]);
  if (Object.keys(body).some(key => !allowed.has(key))) {
    return "Home conversion cannot include another save or publication action.";
  }
  if (Object.keys(body.document).length !== 1 || !Array.isArray(body.document.blocks)) {
    return "Home conversion accepts only the seven proposed Home regions.";
  }
  if (body.document.blocks.length !== 7) {
    return "Home conversion requires seven Home regions; the server preserves the manual shelf.";
  }
  return null;
}

// The read endpoint crosses an HTTP JSON boundary. Firestore class instances such as
// Timestamp therefore return from the browser as plain JSON objects even when the editor did
// not change them. Compare that transport representation, not the in-memory prototypes, while
// still preserving the trusted stored value instead of writing the client copy back.
function transportValuesEqual(left, right) {
  try {
    const leftJson = JSON.stringify(left);
    const rightJson = JSON.stringify(right);
    if (leftJson === undefined || rightJson === undefined) return false;
    return canonicalJson(JSON.parse(leftJson)) === canonicalJson(JSON.parse(rightJson));
  } catch {
    return false;
  }
}

const RECORD_IMAGE_ACCESSIBILITY_FIELDS = Object.freeze({
  post: Object.freeze({
    asset: "heroImage",
    alt: "heroImageAlt",
    decorative: "heroImageDecorative",
  }),
  program: Object.freeze({
    asset: "keyArtAssetId",
    alt: "keyArtAlt",
    decorative: "keyArtDecorative",
  }),
  sponsor: Object.freeze({
    asset: "logoAssetId",
    alt: "logoAlt",
    decorative: "logoDecorative",
  }),
  event: Object.freeze({ asset: "imageAssetId", alt: "imageAlt", decorative: "imageDecorative" }),
  newsletter: Object.freeze({
    asset: "imageAssetId",
    alt: "imageAlt",
    decorative: "imageDecorative",
  }),
});

function prepareRecordImageAccessibilityOverlay({
  collection,
  contentKind,
  creating,
  base,
  request,
  overlay,
}) {
  if (collection !== "cmsPosts" || creating) return;
  const fields = RECORD_IMAGE_ACCESSIBILITY_FIELDS[contentKind];
  if (
    !fields ||
    !Object.prototype.hasOwnProperty.call(request, fields.asset) ||
    transportValuesEqual(request[fields.asset], base?.[fields.asset])
  ) {
    return;
  }

  // A new or cleared image never keeps the old image's description. Empty alt text is
  // allowed (#242), so an omitted accessibility key is reset instead of rejected: the
  // editor drops optional keys that match their default when staff replace an image.
  const cleared =
    typeof request[fields.asset] === "string" &&
    request[fields.asset].trim() === "";
  if (cleared || !Object.prototype.hasOwnProperty.call(request, fields.alt)) {
    overlay[fields.alt] = "";
  }
  if (cleared || !Object.prototype.hasOwnProperty.call(request, fields.decorative)) {
    overlay[fields.decorative] = false;
  }
}

// The create nonce addresses one create attempt, and the address is bound to what that
// attempt asked for -- so a reused nonce over different fields creates its own record
// rather than replaying the first one. The requested section is part of that ask even
// though it rides the envelope rather than the document (#619): without it, a retry that
// changes only the section lands on the first section's record and comes back as a
// successful replay, telling the caller the second desk took when it never did.
function recordIdForCreateAttempt(key, document, section, collection = "cmsPosts", slug) {
  const scope = section === undefined ? "" : section;
  return createHash("sha256")
    .update(`${collection}:create:${key}:${scope}:${canonicalJson(document)}${slug === undefined ? "" : `:slug:${slug}`}`)
    .digest("hex")
    .slice(0, 32);
}

// A duplicate starts from the exact saved Post the server read, never from the
// mutable browser form. Copy only editor-owned Post fields, then clear every
// publication and story-date decision that must belong to the new record.
function duplicatedPostDocument(source) {
  const copied = {};
  for (const field of Object.keys(CONTENT_DOCUMENT_CONTRACTS.post.fields)) {
    if (Object.prototype.hasOwnProperty.call(source, field)) copied[field] = source[field];
  }
  delete copied.publishAt;
  delete copied.scheduledPublicationTransport;
  if (copied.liveBlog) copied.liveBlog = { ...copied.liveBlog,
    updates: copied.liveBlog.updates.filter(entry => entry.withdrawal === undefined).map((entry, index) => {
      const copy = { ...entry, id: `tmp-copy-${index}` };
      delete copy.correction;
      if (copy.followUps !== undefined) copy.followUps = copy.followUps.filter(item => item.withdrawal === undefined).map((item, followIndex) => {
        const followUp = { ...item, id: `tmp-copy-${index}-${followIndex}` };
        delete followUp.correction;
        delete followUp.withdrawal;
        return followUp;
      });
      return copy;
    }),
  };
  return {
    ...copied,
    type: "post",
    status: "draft",
    title: `Copy of ${typeof source.title === "string" && source.title.trim() ? source.title : "Untitled Post"}`,
    date: "",
    recordMeaningfulUpdate: false,
    showUpdatedDate: false,
    credits: resolveStoryCredits(source),
  };
}

// Assign a canonical id to every block the stored document does not already own,
// leaving stored ids untouched (#515). The server -- not the client -- owns canonical
// block ids: on a create nothing is stored yet, so every id is minted; on an update
// only ids already present in the stored blocks are kept, and any other id (an absent
// or empty id, a "tmp-" editor key, a client-chosen UUID, or an attempt to reassign an
// existing block's id) is minted server-side. `knownIds` is the set of stored canonical
// block ids. Only plain-object entries are minted for; malformed entries pass through so
// parseBlocks -- not this step -- rejects them, keeping one source of validation truth.
//
// It also reports what it minted, so the response can tell the client which id
// replaced which instead of leaving it to infer that from position (#538). The map
// carries a sent id only when that id is a non-empty string and appears once in the
// request: an omitted id is nothing to key on, and a repeated one cannot name a
// single canonical result. Position is still what the client uses, so an omitted
// entry costs it nothing; the map is additive and there is nothing to fall back
// from yet.
function assignBlockIds(blocks, mintId, knownIds, preserveKnownIds = false) {
  const sentIdCounts = new Map();
  for (const block of blocks) {
    if (!isPlainObject(block) || typeof block.id !== "string" || block.id.length === 0) {
      continue;
    }
    sentIdCounts.set(block.id, (sentIdCounts.get(block.id) ?? 0) + 1);
  }
  // Collected in a Map and converted at the end: assigning "__proto__" as a key
  // on a plain object hits the prototype's setter instead of creating an own
  // property, so that one id would go unreported while the code claimed
  // otherwise. Object.fromEntries defines rather than assigns.
  const minted = new Map();
  const assigned = blocks.map((block) => {
    if (
      !isPlainObject(block) ||
      (preserveKnownIds && knownIds.has(block.id)) ||
      !(needsCanonicalId(block.id) || !knownIds.has(block.id))
    ) {
      return block;
    }
    const canonicalId = mintId();
    if (typeof block.id === "string" && sentIdCounts.get(block.id) === 1) {
      minted.set(block.id, canonicalId);
    }
    return { ...block, id: canonicalId };
  });
  return { blocks: assigned, mintedIds: Object.fromEntries(minted) };
}

// Slugs are routing aliases, not identity. Derive one from editor-owned display metadata and
// reserve a unique suffix inside the same transaction that creates the record. A transaction
// query participates in Firestore's serializable retry contract, so two simultaneous creates
// with the same title cannot both commit the unsuffixed candidate (#541).
//
// Every candidate comes from the shared post-slug contract rather than from string
// concatenation here. The public build imports the same module, so the rule that mints a
// slug and the rule that routes one cannot drift: the contract bounds the slug and keeps it
// off the reserved list, which is what stops a post titled "New" being reserved forever and
// then refused by the build it was published into.
async function uniqueRecordSlug(tx, firestore, base) {
  let suffix = 1;
  while (suffix <= 10_000) {
    const candidate = postSlugCandidate(base, suffix);
    const canonicalQuery = firestore
      .collection("cmsPosts")
      .where("slug", "==", candidate)
      .limit(1);
    const redirectQuery = firestore
      .collection("cmsPosts")
      .where("previousSlugs", "array-contains", candidate)
      .limit(1);
    const [canonicalSnapshot, redirectSnapshot] = await Promise.all([
      tx.get(canonicalQuery),
      tx.get(redirectQuery),
    ]);
    if (canonicalSnapshot.empty && redirectSnapshot.empty) return candidate;
    suffix += 1;
  }
  throw new SaveRejection(503, "A unique record route could not be reserved");
}

async function requestedRoute(tx, firestore, collection, id, base, slug, baseVersion) {
  const page = collection === "cmsPages";
  // Built-in pages can use their original route without a stored slug.
  const oldSlug = base?.slug ?? (page && base && !isCustomPageId(id)
    ? publicPageDefinition(id)?.path.slice(1, -1) : undefined);
  if (slug === undefined || slug === oldSlug) return {};
  if (!page && slug === "" && !base?.slug) return {};
  if (!(page ? isAvailablePageSlug(id, slug) : isMintablePostSlug(slug))) {
    throw new SaveRejection(400, "Use a URL slug of at most 80 lowercase letters, numbers and single hyphens. This address must not be reserved.");
  }
  if (base && baseVersion === undefined) {
    throw new SaveRejection(400, "Reload this content before changing its URL.");
  }
  if (page) await require("./lib/no-build-page-ownership").assertNoBuildPageRouteAvailable({
    firestore, transaction: tx, pageId: id, path: `/${slug}/`,
  });
  const refs = firestore.collection(collection);
  const snapshots = await Promise.all([
    tx.get(refs.where("slug", "==", slug)),
    tx.get(refs.where("previousSlugs", "array-contains", slug)),
  ]);
  if (snapshots.some(snapshot => snapshot.docs.some(doc => doc.id !== id))) {
    throw new SaveRejection(400, "This URL is already used by other content. Choose another slug.");
  }
  const previousSlugs = [...new Set([...(Array.isArray(base?.previousSlugs) ? base.previousSlugs : []),
    ...(oldSlug && oldSlug !== slug ? [oldSlug] : [])])].filter(value => value !== slug);
  return { slug, previousSlugs };
}

function createCmsSaveHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    versionHistoryEntryFn = versionHistoryEntry,
    adminLogEntryFn = adminLogEntry,
    parseBlocksFn = parseBlocks,
    validateSectionFn = validateSection,
    documentSizeErrorFn = documentSizeError,
    mintId = randomUUID,
    readAuthorIdentitiesFn = readAuthorIdentities,
    withFrozenCreditsFn = withFrozenCredits,
    withPublicVideosFn = withPublicVideos,
    now = () => new Date().toISOString(),
    log = logger,
    enablePublishSnapshot = false,
    assertPublishReadyFn = null,
    assertPublishedMediaSafeFn = defaultAssertPublishedMediaSafe,
    enforceHomeEditorBoundary = true,
    routePurge = {},
    readAutomationAccountFn = (uid) => readAutomationAccount(firestore, uid),
  } = deps;
  const purgeConfig = routePurge.config ?? routePurgeConfig();

  return async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    try {
      const user = await requirePrincipalFn(req);

      // Coarse gate: a caller holding no content-write capability at all has no
      // business here, and refusing now keeps an unauthorized request from
      // costing a document read. The record-level decision still runs inside the
      // transaction, where the stored owner and status are known.
      if (!mayReachContentWrite(user.principal)) {
        log.warn("cmsSaveContent denied", {
          uid: user.uid,
          reason: "principal holds no content-write capability",
        });
        res.status(403).json({ error: FORBIDDEN_MESSAGE });
        return;
      }

      const body = req.body ?? {};
      const {
        collection,
        id: providedId,
        document,
        baseVersion,
        saveGroupId,
        createOnly,
        seedFromLegacyPage,
        publish,
        scheduleAt,
        idempotencyKey,
        convertHome,
        convertHomeV2,
        section: requestedSection,
        slug: requestedSlug,
        postTemplate,
        postSource,
        liveBlogUpdate,
        dryRun,
        automation,
      } = body;

      if (postTemplate !== undefined && (
        !isPlainObject(postTemplate) || Object.keys(postTemplate).some(key => !["id", "version"].includes(key)) ||
        typeof postTemplate.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(postTemplate.id) ||
        !Number.isSafeInteger(postTemplate.version) || postTemplate.version < 1 ||
        collection !== "cmsPosts" || providedId !== undefined || idempotencyKey === undefined ||
        publish === true || scheduleAt !== undefined || seedFromLegacyPage !== undefined ||
        !isPlainObject(document) || document.type !== "post" ||
        Object.keys(document).some(key => !["type", "title"].includes(key))
      )) {
        res.status(400).json({ error: "Use a current template to create a new Post draft with a unique save key." });
        return;
      }
      if (postSource !== undefined && (
        !isPlainObject(postSource) || Object.keys(postSource).some(key => !["id", "version"].includes(key)) ||
        !isBoundedDocumentId(postSource.id) ||
        !Number.isSafeInteger(postSource.version) || postSource.version < 1 ||
        collection !== "cmsPosts" || providedId !== undefined || idempotencyKey === undefined ||
        postTemplate !== undefined || publish !== undefined || scheduleAt !== undefined ||
        seedFromLegacyPage !== undefined || baseVersion !== undefined || createOnly !== undefined ||
        convertHome !== undefined || convertHomeV2 !== undefined || saveGroupId !== undefined || requestedSection !== undefined ||
        requestedSlug !== undefined || !isPlainObject(document) || document.type !== "post" ||
        Object.keys(document).some(key => key !== "type")
      )) {
        res.status(400).json({ error: "Duplicate one current saved Post as a draft with a unique save key." });
        return;
      }
      const requestedDocument = document;
      const templateCreateFingerprint = postTemplate === undefined ? null : createHash("sha256")
        .update(canonicalJson({ document, postTemplate,
          ...(requestedSection === undefined ? {} : { section: requestedSection }),
          ...(requestedSlug === undefined ? {} : { slug: requestedSlug }),
        })).digest("hex");

      if (!SAVE_COLLECTIONS.has(collection)) {
        res.status(400).json({ error: "Unknown collection" });
        return;
      }
      if (!isPlainObject(document)) {
        res.status(400).json({ error: "Document must be an object" });
        return;
      }
      const conversionError = homeConversionRequestError(body);
      if (conversionError) {
        res.status(400).json({ error: conversionError });
        return;
      }
      const conversionTarget = convertHomeV2 === undefined ? 1 : 2;
      // Keep v1 fingerprints byte-identical so outstanding v1 retries still replay.
      const conversionPayload = convertHomeV2 === undefined
        ? (convertHome === undefined ? null : { uid: user.uid, convertHome, baseVersion, document })
        : { uid: user.uid, convertHomeV2, baseVersion, document, targetVersion: 2 };
      const conversionFingerprint = conversionPayload === null ? null : createHash("sha256")
        .update(canonicalJson(conversionPayload)).digest("hex");
      if (publish !== undefined && typeof publish !== "boolean") {
        res.status(400).json({ error: "publish must be a boolean" });
        return;
      }
      if (
        scheduleAt !== undefined &&
        (typeof scheduleAt !== "string" || scheduleAt.trim() === "")
      ) {
        res.status(400).json({ error: "scheduleAt must be a valid date" });
        return;
      }
      if (publish === true && scheduleAt !== undefined) {
        res.status(400).json({ error: "Publish now and schedule cannot be combined" });
        return;
      }
      // A direct live blog update publishes only entries and coverage state on an
      // existing published Post. It rides the ordinary publish transaction, so it
      // keeps the exact baseVersion, validation, credit freezing and snapshot rules.
      if (liveBlogUpdate !== undefined && (liveBlogUpdate !== true || publish !== true ||
          collection !== "cmsPosts" || typeof providedId !== "string" || !Number.isInteger(baseVersion) ||
          scheduleAt !== undefined || createOnly !== undefined || seedFromLegacyPage !== undefined ||
          idempotencyKey !== undefined || saveGroupId !== undefined || requestedSection !== undefined ||
          requestedSlug !== undefined || postTemplate !== undefined || postSource !== undefined ||
          convertHome !== undefined || convertHomeV2 !== undefined || !isPlainObject(document) ||
          Object.keys(document).some(key => key !== "liveBlog") || !isPlainObject(document.liveBlog))) {
        res.status(400).json({ error: "A live update sends only the live blog of a saved Post with its exact baseVersion." });
        return;
      }
      // Slice 1 checks only an ordinary save of saved content. Publication, creation and
      // conversion paths have effects that a discarded transaction cannot preview.
      if (dryRun !== undefined && (dryRun !== true || publish !== undefined || scheduleAt !== undefined ||
          liveBlogUpdate !== undefined || createOnly !== undefined || seedFromLegacyPage !== undefined ||
          idempotencyKey !== undefined || postTemplate !== undefined || postSource !== undefined ||
          convertHome !== undefined || convertHomeV2 !== undefined || typeof providedId !== "string" ||
          !Number.isInteger(baseVersion))) {
        res.status(400).json({ error: "A dry run checks an ordinary save of saved content at its exact baseVersion." });
        return;
      }
      const automationError = automationDetailsError(automation);
      if (automationError) {
        res.status(400).json({ error: automationError });
        return;
      }
      if (scheduleAt !== undefined && (Object.keys(document).length > 0 || requestedSlug !== undefined)) {
        res.status(400).json({
          error: "Schedule the saved version without content changes.",
        });
        return;
      }
      let normalizedScheduleAt;
      if (scheduleAt !== undefined) {
        try {
          normalizedScheduleAt = normalizePublishAt(
            scheduleAt,
            "1970-01-01T00:00:00.000Z",
          );
        } catch (error) {
          res.status(400).json({ error: error.message });
          return;
        }
      }
      if (document.dataHubReporting !== undefined && (collection !== "cmsPages" || providedId !== "data-hub")) {
        res.status(400).json({ error: "Reporting mappings belong to the Data Hub Page." }); return;
      }
      if (document.dataHubCompositionVersion !== undefined && (collection !== "cmsPages" || providedId !== "data-hub")) {
        res.status(400).json({ error: "Data Hub composition belongs only on the Data Hub Page." }); return;
      }
      if (collection === "cmsPages" && providedId === "data-hub" && requestedSlug !== undefined && requestedSlug !== "data-hub") {
        res.status(400).json({ error: "The Data Hub address stays fixed." }); return;
      }
      // Contact's active runtime updates its dedicated heading hooks, not a Page theme.
      if (collection === "cmsPages" && providedId === "contact" && Object.hasOwn(document, "pageTheme")) {
        res.status(400).json({ error: "Contact keeps its standard header. Page theme changes are not available there." });
        return;
      }
      const metadataError = validateKnownMetadata(document, {
        descriptionIsString: collection === "cmsPages",
      });
      if (metadataError) {
        res.status(400).json({ error: metadataError });
        return;
      }
      // Validate the explicitly supplied value before opening a transaction. Blank is valid and
      // means “now”; the actual fallback instant is minted alongside the write below.
      if (document.publishAt !== undefined) {
        try {
          normalizePublishAt(document.publishAt, "1970-01-01T00:00:00.000Z");
        } catch (error) {
          res.status(400).json({ error: error.message });
          return;
        }
      }
      // Check the claim's shape here; whether it is required depends on the stored
      // target and is checked after authorization inside the transaction.
      if (saveGroupId !== undefined && (collection !== "cmsPages" ||
          typeof saveGroupId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(saveGroupId))) {
        res.status(400).json({ error: "saveGroupId must identify a page save." });
        return;
      }
      const echoesVersion = baseVersion !== undefined;
      if (echoesVersion && (!Number.isSafeInteger(baseVersion) || baseVersion < 0)) {
        res.status(400).json({ error: "baseVersion must be a nonnegative safe integer" });
        return;
      }
      if (createOnly !== undefined && typeof createOnly !== "boolean") {
        res.status(400).json({ error: "createOnly must be a boolean" });
        return;
      }
      if (createOnly === true && collection !== "cmsPages") {
        res.status(400).json({ error: "createOnly is only supported for page saves" });
        return;
      }
      // The create nonce (#542). Narrow on purpose: it addresses a record create, so
      // sending it with a page save or beside a record id is a client bug worth surfacing
      // rather than a value to ignore. The length floor is there because a short nonce is
      // one two editors can collide on, and a collision means one editor's create replays
      // the other's record.
      if (idempotencyKey !== undefined) {
        if (
          typeof idempotencyKey !== "string" ||
          idempotencyKey.length < IDEMPOTENCY_KEY_MIN_LENGTH ||
          idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH
        ) {
          res.status(400).json({
            error:
              `idempotencyKey must be a string of ${IDEMPOTENCY_KEY_MIN_LENGTH} to ` +
              `${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
          });
          return;
        }
        if (providedId !== undefined) {
          res
            .status(400)
            .json({ error: "idempotencyKey addresses a create; omit id to use it" });
          return;
        }
      }
      // The scoped-grant desk for a new record (#619). It rides the request envelope, not
      // the document: `section` is a server-managed field, so the overlay strips it, and a
      // client may only ask for one here, on a record create, where the transaction checks
      // it against the runtime registry. A new custom Page requires a registered editing
      // group here; built-in Pages omit it and use their fixed public page registry area.
      if (requestedSection !== undefined) {
        if (!isSectionId(requestedSection)) {
          res
            .status(400)
            .json({ error: "section must be a section id with no surrounding spaces" });
          return;
        }
        if (collection === "cmsPages" && providedId !== undefined && !isCustomPageId(providedId)) {
          res.status(400).json({ error: "This page's editing group is fixed." });
          return;
        }
      }
      if (createOnly === true && echoesVersion) {
        res.status(400).json({ error: "createOnly and baseVersion cannot be combined" });
        return;
      }
      // A template-keyed legacy page can seed the first canonical page-id save. This is a
      // server-side pointer, not client-supplied metadata: the transaction reads the source and
      // carries its title/SEO/status/published snapshot forward without making protected fields
      // client-writable. An explicit zero claims a source that has no version yet.
      if (seedFromLegacyPage !== undefined && !isPlainObject(seedFromLegacyPage)) {
        res.status(400).json({ error: "seedFromLegacyPage must be an object" });
        return;
      }
      if (seedFromLegacyPage !== undefined && collection !== "cmsPages") {
        res.status(400).json({ error: "seedFromLegacyPage is only supported for page saves" });
        return;
      }
      if (seedFromLegacyPage !== undefined && createOnly !== true) {
        res.status(400).json({ error: "seedFromLegacyPage requires createOnly" });
        return;
      }
      if (
        seedFromLegacyPage !== undefined &&
        (!Number.isSafeInteger(seedFromLegacyPage.version) || seedFromLegacyPage.version < 0)
      ) {
        res.status(400).json({ error: "seedFromLegacyPage.version must be a nonnegative safe integer" });
        return;
      }

      // A publish decision must fail before its content transaction if the
      // metered dispatch or terminal writeback path is unavailable. Gate the
      // readiness probe on holding publish authority somewhere, so readiness does
      // not become an oracle for callers who cannot publish at all.
      //
      // Coarse and scope-aware rather than site-wide (#845): the document's desk is
      // not known until the transaction reads it, and demanding a site-wide grant
      // here would refuse every publish by a correctly scoped editor before the
      // decision that could allow it. The authoritative publish check still runs
      // inside the transaction against the record's own section; all this one
      // decides is whether the caller may learn that dispatch is unavailable.
      const pairRootHint = (publish === true || scheduleAt !== undefined) && ["cmsPosts", "cmsPages"].includes(collection)
        ? (await firestore.doc("system/publicDeployment").get()).data() : null;
      if (pairRootHint?.schemaVersion === 2) require("./lib/public-release-media-fence").parseStoredSelector(pairRootHint);
      const noBuildConfig = deps.noBuildConfig ?? ((publish === true || scheduleAt !== undefined) && ["cmsPosts", "cmsPages"].includes(collection)
        ? await readNoBuildFamilyAdmission({ firestore }) : { enabled: false, postId: "" });
      const retainedPost = (publish === true || scheduleAt !== undefined) && collection === "cmsPosts" && providedId
        ? (await readNoBuildPostOwner({ firestore, postId: providedId })).state : null;
      const retainedRecord = (publish === true || scheduleAt !== undefined) && collection === "cmsPosts" && providedId
        ? (await require("./lib/no-build-record-ownership").readNoBuildRecordOwner({ firestore, documentId: providedId })).state : null;
      const selectedRecord = ["programs", "events"].some(family =>
        require("./lib/no-build-family-admission").selectsNoBuildRecord(noBuildConfig, family, providedId) ||
        noBuildConfig.valid && noBuildConfig.families?.[family]?.mode === "all");
      const mayUseNoBuild = pairRootHint?.schemaVersion === 2 || (collection === "cmsPosts" &&
        (retainedRecord || selectedRecord || retainedPost?.operationId || providedId === noBuildConfig.postId || selectsNoBuildPost(noBuildConfig, providedId) ||
          (noBuildConfig.valid && noBuildConfig.families?.posts?.mode === "all"))) ||
        ((publish === true || scheduleAt !== undefined) && collection === "cmsPages" && (providedId
          ? await require("./lib/no-build-page-publication").pagePublicationSelected({ firestore, documentId: providedId, config: noBuildConfig })
          : noBuildConfig.valid && noBuildConfig.families?.pages?.mode === "all"));
      let publishReadiness = null;
      let publicationReadinessChecked = false;
      if ((publish === true || scheduleAt !== undefined) && assertPublishReadyFn) {
        const canReachPublication = hasCapability(user.principal,
          liveBlogUpdate === true ? "content.edit.any" : "content.publish");
        if (!canReachPublication) {
          res.status(403).json({ error: FORBIDDEN_MESSAGE });
          return;
        }
        if (!mayUseNoBuild) {
          publishReadiness = await assertPublishReadyFn({ firestore });
          publicationReadinessChecked = true;
        }
      }

      // The serializer needs no external dispatch. Reserve its queue before the
      // transaction so the snapshot, its queue id, and the queue row can commit
      // together. A failed request then leaves none of those records behind.
      const atomicSerializerPublish =
        publish === true && (publishReadiness?.transport === "serializer" || mayUseNoBuild);
      let legacyPublishQueueRef = null;
      let legacyPublishQueueAuditRef = null;
      // cmsPublish needs publication access, so a direct live update uses only the
      // atomic fast path that queues its publication in the save transaction.
      if (liveBlogUpdate === true && !atomicSerializerPublish) {
        res.status(409).json({ error: "Live updates cannot be published directly right now. Save a draft and use the normal Publish action." });
        return;
      }
      if (atomicSerializerPublish) {
        if (pairRootHint?.schemaVersion !== 2) await assertPublishedMediaSafeFn({ firestore });
        legacyPublishQueueRef = firestore.collection("cmsPublishQueue").doc();
        legacyPublishQueueAuditRef = firestore
          .collection(AUDIT_COLLECTIONS.adminLogs)
          .doc();
      }

      // Built-in pages retain their registry ids. New custom pages and records use
      // server-owned canonical ids (#515): the
      // client omits it to create and the server mints one; a provided record id only
      // ever names an existing record to update, enforced against the read below.
      let docId;
      let recordIdWasProvided = false;
      let expectedPageTemplate = null;
      if (collection === "cmsPages" && providedId === undefined) {
        if (seedFromLegacyPage !== undefined || !isAvailablePageSlug("page-new", requestedSlug)) {
          res.status(400).json({ error: "A new page requires an available URL slug." });
          return;
        }
        const createId = idempotencyKey === undefined ? createHash("sha256").update(mintId()).digest("hex").slice(0, 32)
          : recordIdForCreateAttempt(idempotencyKey, document, requestedSection, collection, requestedSlug);
        docId = `page-${createId}`;
        expectedPageTemplate = "genericPage";
        if (document.template !== undefined && document.template !== expectedPageTemplate) {
          res.status(400).json({ error: "New pages use the genericPage editor template." });
          return;
        }
      } else if (collection === "cmsPages") {
        if (typeof providedId !== "string" || providedId.length === 0) {
          res.status(400).json({ error: "A page save requires a page id" });
          return;
        }
        expectedPageTemplate = editorTemplateForPage(providedId);
        if (expectedPageTemplate === null) {
          res.status(400).json({ error: `Unknown public page id ${providedId}` });
          return;
        }
        if (
          document.template !== undefined &&
          document.template !== expectedPageTemplate
        ) {
          res.status(400).json({
            error: `Page ${providedId} requires the ${expectedPageTemplate} editor template`,
          });
          return;
        }
        if (seedFromLegacyPage !== undefined) {
          if (
            typeof seedFromLegacyPage.id !== "string" ||
            seedFromLegacyPage.id !== expectedPageTemplate ||
            seedFromLegacyPage.id === providedId
          ) {
            res.status(400).json({
              error: `Page ${providedId} can only seed from its legacy ${expectedPageTemplate} document`,
            });
            return;
          }
        }
        docId = providedId;
        recordIdWasProvided = isCustomPageId(providedId);
      } else if (providedId === undefined) {
        if (postTemplate !== undefined) {
          docId = recordIdForCreateAttempt(idempotencyKey, { templateCreate: user.uid }, undefined);
        } else if (postSource !== undefined) {
          docId = recordIdForCreateAttempt(
            idempotencyKey,
            { postDuplicate: user.uid, postSource },
            undefined,
          );
        } else {
          docId = idempotencyKey === undefined ? mintId()
            : recordIdForCreateAttempt(idempotencyKey, document, requestedSection, collection, requestedSlug);
        }
      } else if (typeof providedId === "string" && providedId.length > 0) {
        docId = providedId;
        recordIdWasProvided = true;
      } else {
        res.status(400).json({ error: "A record id must be a non-empty string" });
        return;
      }

      const ref = firestore.collection(collection).doc(docId);
      // The account, the staff request and the reviewed plan, on every audit row this save writes.
      const withAutomationAudit = entry => automation === undefined ? entry
        : { ...entry, automation: { requestReference: automation.requestReference, planDigest: automation.planDigest } };
      const templateCreateRef = postTemplate === undefined ? null : ref.collection("templateCreate").doc("receipt");
      const source = getClientIp(req);

      // One transaction from the read to the writes (#530). Everything below depends on
      // the stored document, so it all belongs inside: if the document moves under this
      // callback, Firestore aborts and re-runs it, and the re-run re-reads. That is what
      // makes the overlay land on committed state. The callback must therefore stay
      // re-runnable -- it only reads, composes, and stages writes, so a retry is free.
      // A rejection thrown from in here is a decision, not contention, so it propagates
      // instead of retrying.
      if ((publish === true || scheduleAt !== undefined) && collection === "cmsPages" &&
          ["schedule", "live"].includes(docId) &&
          !can(user.principal, "content.publish", { section: contentSectionForPage(docId) })) {
        res.status(403).json({ error: FORBIDDEN_MESSAGE }); return;
      }
      const [pageScheduleCapture, automationAccount] = await Promise.all([
        require("./lib/no-build-page-publication").capturePageScheduleForPublication({
          firestore, collection, documentId: docId, publishing: publish === true || scheduleAt !== undefined,
          config: noBuildConfig, currentCodeRequest: deps.currentCodeRequest,
          ...(pairRootHint?.schemaVersion === 2 ? { releaseSelector: require("./lib/public-release-media-fence").parseStoredSelector(pairRootHint) } : {}) }),
        readAutomationAccountFn(user.uid),
      ]);
      // A dry run discards the transaction at every exit, including early returns that
      // stage writes, by throwing its result out of the callback.
      const dryRunAware = (callback) => async (tx) => {
        const result = await callback(tx);
        if (dryRun === true) throw new DryRunResult(result);
        return result;
      };
      const saveTransaction = () => firestore.runTransaction(dryRunAware(async (tx) => {
        // The read: create-vs-update, the version-history "before" snapshot, status
        // preservation, the base-version check, and canonical block-id ownership all
        // depend on it. cmsPosts with a minted id is always a create.
        const snap = await tx.get(ref);
        const stored = snap.exists ? snap.data() : null;
        const creating = stored === null;
        const templateCreateReceipt = templateCreateRef === null ? null : (await tx.get(templateCreateRef)).data();
        let duplicateSource = null;
        if (creating && postSource !== undefined) {
          const sourceRef = firestore.collection("cmsPosts").doc(postSource.id);
          const sourceSnap = await tx.get(sourceRef);
          duplicateSource = sourceSnap.exists ? sourceSnap.data() : null;
          const sourceSection = contentResourceSection({
            collection: "cmsPosts",
            documentId: postSource.id,
            stored: duplicateSource,
          });
          const sourceDecision = authorizeContentRead(user.principal, {
            exists: true,
            resource: {
              ownerId: duplicateSource?.createdBy,
              section: sourceSection,
              ...(isUnassignedPostDraft(duplicateSource) ? { unassignedDraft: true } : {}),
            },
          });
          if (!sourceDecision.allowed) {
            log.warn("cmsSaveContent denied", {
              uid: user.uid,
              collection,
              documentId: docId,
              sourceDocumentId: postSource.id,
              reason: `duplicate source: ${sourceDecision.reason}`,
            });
            throw new SaveRejection(403, FORBIDDEN_MESSAGE);
          }
          if (!sourceSnap.exists || duplicateSource?.deleted === true) {
            throw new SaveRejection(404, "The Post to duplicate is no longer available.");
          }
          if (duplicateSource.type !== "post") {
            throw new SaveRejection(400, "Only a saved Post can be duplicated.");
          }
          if (duplicateSource.version !== postSource.version) {
            throw new SaveRejection(409, "This Post changed since you opened it. Reload before duplicating it.");
          }
          if (duplicateSource.section !== undefined && !isSectionId(duplicateSource.section)) {
            throw new SaveRejection(409, "This Post's editing group is no longer available. Reload before duplicating it.");
          }
        }
        // Read the versioned snapshot in this same transaction. A lost-response
        // retry returns its existing draft even if the template was later retired.
        const document = creating && postTemplate !== undefined
          ? { ...await readTemplateDraft({ firestore, transaction: tx, principal: user.principal, selection: postTemplate }), ...requestedDocument }
          : duplicateSource === null
            ? requestedDocument
            : duplicatedPostDocument(duplicateSource);
        const effectiveRequestedSection = duplicateSource?.section ?? requestedSection;

        // The desk every authorization decision below is made against (#845), resolved
        // once so the tombstone read, the legacy-seed read and the write decision cannot
        // disagree about which section this document sits in. A page takes its
        // server-owned area; an existing record its stored desk; a record create the desk
        // it asks to be created into, which the registry check further down still has to
        // accept before the document commits.
        const resourceSection = contentResourceSection({
          collection,
          documentId: docId,
          stored,
          requestedSection: effectiveRequestedSection,
        });

        // A tombstone is not a composition base. First apply the same read
        // decision as cmsGetContent so this check does not reveal deleted state
        // to somebody who could not read the record; an authorized editor gets
        // the same unavailable answer as the read boundary. This must precede
        // createOnly, version, status, and write authorization so no save can
        // mutate or return the deleted document.
        if (stored?.deleted === true) {
          const deletedDecision = authorizeContentRead(user.principal, {
            exists: true,
            resource: { ownerId: stored.createdBy, section: resourceSection },
          });
          if (!deletedDecision.allowed) {
            log.warn("cmsSaveContent denied", {
              uid: user.uid,
              collection,
              documentId: docId,
              reason: `deleted target: ${deletedDecision.reason}`,
            });
            throw new SaveRejection(403, FORBIDDEN_MESSAGE);
          }
          log.warn("cmsSaveContent refused a save of a deleted record", {
            uid: user.uid,
            collection,
            documentId: docId,
          });
          throw new SaveRejection(404, DELETED_MESSAGE);
        }

        // A supplied cmsPosts id is update-only. Treat an absent id like an
        // existing record with unknown ownership before returning the more useful
        // bad-request answer: only a principal who could read every record may
        // learn that this one is absent. Contributors and scoped editors get the
        // same refusal they would get for a stored record they do not own.
        if (recordIdWasProvided && creating) {
          const absentRecordDecision = authorizeContentRead(user.principal, {
            exists: true,
            resource: {},
          });
          if (!absentRecordDecision.allowed) {
            log.warn("cmsSaveContent denied", {
              uid: user.uid,
              collection,
              documentId: docId,
              reason: `absent update target: ${absentRecordDecision.reason}`,
            });
            throw new SaveRejection(403, FORBIDDEN_MESSAGE);
          }
          throw new SaveRejection(
            400,
            "Unknown record id (omit id to create a record; the server mints it)",
          );
        }

        // When the client opened blocks from a legacy template singleton, clone that source as
        // the base for this new page-id document. This second read stays in the same transaction
        // as the create-only check and write, so the page cannot appear between the checks. A
        // versioned source must still be the exact source the editor saw; otherwise its blocks
        // and the metadata cloned here would describe different revisions. An existing target
        // never reaches the seed: it is authorized and rejected by createOnly below.
        let legacySeed = null;
        if (creating && seedFromLegacyPage !== undefined) {
          const legacyRef = firestore
            .collection("cmsPages")
            .doc(seedFromLegacyPage.id);
          const legacySnap = await tx.get(legacyRef);

          // Authorize the seed before reporting absence, version, or deletion.
          // For an absent source, simulate an existing record with unknown
          // ownership: a site-wide edit-any principal may receive the useful
          // conflict, while a caller who could be denied a stored source gets the
          // same 403 either way.
          legacySeed = legacySnap.exists ? legacySnap.data() : null;
          // Authorized against the SOURCE document's desk, not the target page's
          // (#845). Reading the legacy singleton is a read of that document, and a
          // template-keyed singleton belongs to no public area, so it carries no desk
          // and a scoped grant is refused: cloning a shared legacy template into a new
          // canonical page is site-wide work. Borrowing the target's desk here would
          // hand a scoped editor a read of a document their grant does not cover.
          const seedDecision = authorizeContentRead(user.principal, {
            exists: true,
            resource: {
              ownerId: legacySeed?.createdBy,
              section: contentResourceSection({
                collection: "cmsPages",
                documentId: seedFromLegacyPage.id,
                stored: legacySeed,
              }),
            },
          });
          if (!seedDecision.allowed) {
            log.warn("cmsSaveContent denied", {
              uid: user.uid,
              collection,
              documentId: docId,
              seedDocumentId: seedFromLegacyPage.id,
              reason: `legacy seed: ${seedDecision.reason}`,
            });
            throw new SaveRejection(403, FORBIDDEN_MESSAGE);
          }
          if (!legacySnap.exists) {
            throw new SaveRejection(
              409,
              "The legacy page changed since you opened it. Reload before saving this page.",
            );
          }
          // A soft-deleted legacy singleton is unavailable through the read
          // boundary and must be unavailable as a hidden composition source too.
          // Run this only after source authorization so the answer does not tell
          // an unauthorized caller that the seed exists or is deleted.
          if (legacySeed.deleted === true) {
            log.warn("cmsSaveContent refused a deleted legacy seed", {
              uid: user.uid,
              collection,
              documentId: docId,
              seedDocumentId: seedFromLegacyPage.id,
            });
            throw new SaveRejection(404, DELETED_MESSAGE);
          }
          if (
            seedFromLegacyPage.version === 0 ? legacySeed.version !== undefined : seedFromLegacyPage.version !== legacySeed.version
          ) {
            throw new SaveRejection(
              409,
              "The legacy page changed since you opened it. Reload before saving this page.",
            );
          }
        }
        const compositionBase = stored ?? legacySeed;

        // Status is needed for lifecycle authorization. Use a sentinel for a
        // malformed value so record-level authority is still decided before a
        // stored record can affect the client-visible validation result; an
        // authorized caller receives the normal 400 below.
        const revisingPublished = !creating && stored?.status === "published" &&
          publish !== true && scheduleAt === undefined &&
          [undefined, "published"].includes(document.status);
        const status =
          revisingPublished ? "draft" : publish === true
            ? "published"
            : scheduleAt !== undefined
              ? "scheduled"
            : document.status ?? compositionBase?.status ?? "draft";
        // A canonical page created from a live legacy singleton is a new public
        // record, not an ordinary edit of the legacy record. Freeze a fresh
        // snapshot for the canonical id in the same transaction. If snapshots
        // are disabled in this deployment, fail closed instead of storing a
        // published document that the strict loader cannot consume (#833).
        const needsSeededPublishedSnapshot =
          creating &&
          legacySeed?.status === "published" &&
          status === "published" &&
          !isPlainObject(legacySeed.published);
        const publishesSnapshot =
          publish === true || needsSeededPublishedSnapshot;
        const schedulesPublication = scheduleAt !== undefined;
        const authorizationStatus =
          typeof status === "string" ? status : "__invalid_status__";
        const incompleteDraftIsAllowed = status === "draft" && !publishesSnapshot &&
          (collection === "cmsPages" || (document.type ?? stored?.type) === "post");
        const newUnassignedDraft = creating && collection === "cmsPosts" &&
          document.type === "post" && incompleteDraftIsAllowed && effectiveRequestedSection === undefined;
        const writeResource = newUnassignedDraft
          ? { ownerId: user.uid, unassignedDraft: true }
          : contentResource({ collection, documentId: docId, stored, requestedSection: effectiveRequestedSection });


        // The record-level authorization decision (#529) must be the first
        // target-state-dependent answer after the tombstone gate. Ownership and
        // stored lifecycle state are known now, and a refusal must precede
        // createOnly conflicts, version mismatches, type-dependent validation,
        // and publish-transition errors so those cannot become record oracles.
        // `section` is the document's desk, resolved once above (#845). A record
        // written before the registry existed still states none, so a scoped grant
        // is denied on it rather than quietly treated as site-wide.
        //
        // The status a lifecycle gate compares against is the target document's,
        // which on a create is absent. `compositionBase` must not stand in for it:
        // on a seeded page create the base is the legacy singleton, a DIFFERENT
        // document at a different public path, so borrowing its status would say
        // this record is already live when it does not exist yet. The create then
        // reads as no transition and skips the gate, which is how a contributor
        // could mint a new published or scheduled page by cloning a live one.
        // Creating public content is entering that status, so it takes the same
        // capability as moving an existing record into it.
        const decision = authorizeContentWrite(user.principal, {
          creating,
          publishing: publishesSnapshot,
          revisingPublished,
          liveBlogUpdate: liveBlogUpdate === true,
          storedStatus: stored?.status ?? null,
          nextStatus: authorizationStatus,
          resource: writeResource,
        });
        if (!decision.allowed) {
          log.warn("cmsSaveContent denied", {
            uid: user.uid,
            collection,
            documentId: docId,
            creating,
            reason: decision.reason,
          });
          throw new SaveRejection(403, FORBIDDEN_MESSAGE);
        }
        // An automation account must hold its own live editing lock and echo the exact
        // version it read (#4717). Staff leases remain courtesy presence indicators.
        // A dry run writes nothing, so it needs no lease; it already requires baseVersion.
        const automationRefusal = await automationWriteRefusal(tx, firestore, {
          automationAccount: automationAccount && dryRun !== true,
          uid: user.uid, collection, documentId: docId, echoesVersion, creating,
        });
        if (automationRefusal) {
          throw new SaveRejection(automationRefusal.status, automationRefusal.message, automationRefusal.details);
        }
        if (automationAccount !== (automation !== undefined)) {
          throw new SaveRejection(400, automationAccount
            ? "Automation saves require a request reference and a plan digest."
            : "Only automation accounts send automation details.");
        }
        const pairRequest = publishesSnapshot || schedulesPublication || seedFromLegacyPage !== undefined ? await require("./lib/public-release-publication-request").preparePairPublicationRequestInTransaction({
          firestore, transaction: tx, endpoint: "save", actorUid: user.uid, body, collection, documentId: docId }) : null;
        if (pairRootHint?.schemaVersion === 2 && !pairRequest) throw new SaveRejection(409, "Publication protocol changed. Retry this save.");
        const publishQueueRef = publishesSnapshot ? pairRequest?.queueRef ?? legacyPublishQueueRef : legacyPublishQueueRef;
        const publishQueueAuditRef = pairRequest && publishesSnapshot
          ? legacyPublishQueueAuditRef ?? firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc() : legacyPublishQueueAuditRef;
        if (pairRequest?.replay) {
          // The request digest binds liveBlogUpdate to the original body. Editor access
          // replays only an accepted direct live update. Its history action survives the
          // bounded before-image that the size repair can write.
          const directLiveBlogReplay = liveBlogUpdate === true && pairRequest.replay.action === "live-blog-update";
          if (!can(user.principal, directLiveBlogReplay ? "content.edit.any" : "content.publish", writeResource)) {
            throw new SaveRejection(403, FORBIDDEN_MESSAGE);
          }
          return { persisted: pairRequest.replay.after, ...pairRequest.replay.metadata, replayed: true };
        }
        if (liveBlogUpdate === true) {
          // A stale form gets reload or discard recovery before any state refusal.
          if (baseVersion !== stored?.version) throw new SaveRejection(409, STALE_VERSION_MESSAGE, { versionConflict: true });
          const refusal = liveBlogUpdateRefusal(stored);
          if (refusal) throw new SaveRejection(409, refusal);
        }
        const pairRecord = pairRequest && collection === "cmsPosts" && ["program", "event"].includes(stored?.type ?? document.type);
        if ((publishesSnapshot || schedulesPublication) && !pairRecord) {
          const message = await readFrozenLibraryPublicationMessage({ firestore, transaction: tx, collection,
            documentId: docId, document: { type: stored?.type ?? document.type } });
          if (message) throw new SaveRejection(409, message);
        }
        if (creating && legacySeed !== null &&
            (status === "published" || status === "scheduled") &&
            assertPublishReadyFn && !publicationReadinessChecked && !pairRequest) {
          throw new PublicationReadinessRequired();
        }
        if (templateCreateRef !== null && ((!creating && !templateCreateReceipt) ||
            (templateCreateReceipt && (creating || templateCreateReceipt.fingerprint !== templateCreateFingerprint)))) {
          throw new SaveRejection(409, "This template draft request changed. Open the saved draft or start a new request.", {
            conflict: "template-create-request", recordId: docId,
          });
        }
        // Validate the request against the effective editor kind only after the
        // record-level authority gate. An update may omit `type`, so the trusted
        // stored discriminator supplies it. A kind is immutable after create:
        // changing it would reinterpret every sibling field under a different
        // schema and make one record address change meaning.
        if (
          collection === "cmsPosts" &&
          stored?.type !== undefined &&
          document.type !== undefined &&
          document.type !== stored.type
        ) {
          throw new SaveRejection(400, "Record type cannot be changed");
        }
        const contentKind =
          collection === "cmsPages" ? "page" : document.type ?? compositionBase?.type;
        if (collection === "cmsPosts" && contentKind === undefined) {
          throw new SaveRejection(400, "type is required");
        }
        if (requestedSlug !== undefined && collection === "cmsPosts" && !recordKindHasPublicRoute(contentKind)) {
          throw new SaveRejection(400, "URL changes are available for routed content.");
        }
        // Scheduling is a publish decision taken in advance, so it is available to
        // exactly the kinds a publish can complete for. That question belongs to
        // the shared routed-kind contract (#923), not to a local comparison here:
        // Program joined Post when its public route landed, and Event and Staff
        // follow the same way.
        if (
          schedulesPublication &&
          collection === "cmsPosts" &&
          !recordKindHasPublicRoute(contentKind)
        ) {
          throw new SaveRejection(
            400,
            "Only content with a public route can be scheduled.",
          );
        }
        // The optional Event end can be cleared through Save. Keep the shared
        // instant contract strict for restores and publication callers.
        const requestFieldDocument = contentKind === "event" && typeof document.endsAt === "string" && document.endsAt.trim() === ""
          ? Object.fromEntries(Object.entries(document).filter(([field]) => field !== "endsAt"))
          : document;
        const requestFieldError = validateContentFieldValues(
          collection,
          contentKind,
          requestFieldDocument,
          { validateAccessibility: false },
        );
        if (requestFieldError) throw new SaveRejection(400, requestFieldError);

        // Old imports can carry root fields that the current editor no longer
        // owns. RecordForm round-trips its loaded object, so accept such a field
        // only when it is byte-for-byte unchanged from the trusted base. Strip
        // it from the client overlay and preserve the server-read value. A new
        // or modified unknown field is refused instead of spreading to Firestore.
        const legacyRoundTripFields = new Set();
        for (const field of unsupportedContentFields(collection, contentKind, document)) {
          if (
            compositionBase !== null &&
            compositionBase !== undefined &&
            Object.prototype.hasOwnProperty.call(compositionBase, field) &&
            transportValuesEqual(document[field], compositionBase[field])
          ) {
            legacyRoundTripFields.add(field);
            continue;
          }
          throw new SaveRejection(400, `Unknown content field ${field}`);
        }

        // A create whose derived address is already occupied is the retry the nonce
        // exists for: the first attempt committed with this same payload and only its
        // response was lost. Hand back the record that attempt made and write nothing,
        // so one create stays one create with one version and one audit row.
        if (idempotencyKey !== undefined && !creating) {
          // The address already covers the requested section, so a replay normally cannot
          // reach a record in a different desk. Check anyway: a nonce minted before the
          // section joined the fingerprint would still address this record, and a replay
          // is the one path that returns success without composing anything. Never answer
          // an explicit section ask with somebody else's desk and the word "created".
          if (
            effectiveRequestedSection !== undefined &&
            effectiveRequestedSection !== stored.section
          ) {
            throw new SaveRejection(
              409,
              "This record was created in a different section. Reload before saving it again.",
              {
                conflict: "create-replay-section",
                recordId: docId,
              },
            );
          }
          if (stored.version !== 1) {
            throw new SaveRejection(
              409,
              "This record changed after it was created. Reload before saving it again.",
              {
                conflict: "create-replay-advanced",
                recordId: docId,
              },
            );
          }
          return {
            persisted: stored,
            isCreate: true,
            mintedIds: {},
            replayed: true,
          };
        }

        // Replay only the exact authorized conversion while its result is still
        // current. A restored legacy draft keeps the receipt but has a newer
        // version, so an old request cannot repeat the conversion after restore.
        if (conversionFingerprint !== null) {
          if (conversionTarget === 1 && (stored?.status !== "draft" || stored[PUBLISH_BUILD_PENDING_FIELD] === true)) {
            throw new SaveRejection(409, "Open a saved Home draft with no publication in progress before enabling editing.");
          }
          if (conversionTarget === 2 && (!["draft", "published"].includes(stored?.status) ||
              stored[PUBLISH_BUILD_PENDING_FIELD] === true ||
              stored.publishAt != null && (stored.status !== "published" ||
                !Number.isFinite(Date.parse(stored.publishAt)) || Date.parse(stored.publishAt) > Date.parse(now())))) {
            throw new SaveRejection(409, "Open a saved Home with no scheduled or pending publication before changing its layout.");
          }
          if (conversionTarget === 2 && stored.status === "published" &&
              (!isPlainObject(stored.published) || stored.published.metadata?.homeCompositionVersion !== 1 ||
                !Number.isFinite(Date.parse(stored.publishAt)))) {
            throw new SaveRejection(409, "Home needs its retained published version 1 snapshot and publication time before changing its layout.");
          }
          const receipt = stored.homeConversionReceipt;
          if (receipt?.fingerprint === conversionFingerprint) {
            if (stored.version !== receipt.version || stored.homeCompositionVersion !== conversionTarget) {
              throw new SaveRejection(409, "Home changed after conversion. Reload its current draft before editing.");
            }
            return { persisted: stored, isCreate: false, mintedIds: receipt.mintedIds, replayed: true };
          }
          if (conversionTarget === 2 && stored.homeCompositionVersion !== 1) {
            throw new SaveRejection(409, "Version 2 conversion requires an existing version 1 Home draft. Reload its current draft.");
          }
          if (conversionTarget === 1 && stored.homeCompositionVersion !== undefined) {
            throw new SaveRejection(409, "Home editing is already enabled. Reload its current draft.");
          }
        }
        // A page loaded before its page-id document existed must still be absent when the
        // first save reaches this transaction. This is the create half of optimistic
        // concurrency: without it, two editors can both start from the legacy seed or an
        // empty page and the later save silently replaces the document the earlier one made.
        if (createOnly === true && !creating) {
          throw new SaveRejection(
            409,
            "This page was created since you opened it. Reload to get the current version before saving.",
          );
        }

        // The request may be a partial existing-record update with no `type`. If it explicitly
        // supplies `date`, validate that value against the effective stored/composed kind. Do not
        // validate an omitted legacy value during an ordinary unrelated save, and keep root
        // `date` opaque for record kinds that do not own the post editorial-date contract.
        const effectiveRecordType = document.type ?? compositionBase?.type;
        if (
          collection === "cmsPosts" &&
          effectiveRecordType === "post" &&
          Object.prototype.hasOwnProperty.call(document, "date")
        ) {
          const editorialDateError = validateKnownMetadata(
            { type: "post", date: document.date },
            { descriptionIsString: false },
          );
          if (editorialDateError) {
            throw new SaveRejection(400, editorialDateError);
          }
        }

        // The base-version check (#530). The client echoes the version it started from;
        // if the stored document has moved since, this save was composed against content
        // the editor can no longer see, so refuse rather than overwrite. A create cannot
        // have a base version (nothing existed to start from). Zero explicitly claims
        // an existing legacy document with no version; its first save stamps version 1.
        if ((publish === true || schedulesPublication) && !echoesVersion) {
          throw new SaveRejection(
            400,
            `${publish === true ? "Publishing" : "Scheduling"} requires the exact saved baseVersion`,
          );
        }
        if (!creating && !echoesVersion) {
          throw new SaveRejection(400,
            "Reload the current saved version before saving. Your changes have not been saved; keep a copy before reloading.");
        }
        if (echoesVersion && (creating || (baseVersion === 0 ? stored.version !== undefined : baseVersion !== stored.version))) {
          // Lets an editor tell a stale version apart from other 409 refusals.
          throw new SaveRejection(409, STALE_VERSION_MESSAGE, { versionConflict: true });
        }
        if (collection === "cmsPosts" && stored &&
            (stored.liveBlog !== undefined || stored.published?.metadata?.liveBlog !== undefined || document.liveBlog !== undefined) && !echoesVersion) {
          throw new SaveRejection(400, "Saving a live blog requires the exact saved baseVersion.");
        }
        if (collection === "cmsPages" && document.homeCompositionVersion !== undefined && document.homeCompositionVersion !== stored?.homeCompositionVersion) {
          throw new SaveRejection(400, "Use the version-checked Home conversion before changing its composition.");
        }
        if (collection === "cmsPages") {
          const serviceError = serviceCompositionError(docId, document.serviceCompositionVersion ?? stored?.serviceCompositionVersion);
          if (serviceError) throw new SaveRejection(400, serviceError);
          if (document.serviceCompositionVersion !== undefined && document.serviceCompositionVersion !== stored?.serviceCompositionVersion) {
            throw new SaveRejection(400, "Use the reviewed operator migration before changing the service composition.");
          }
          if (stored?.serviceCompositionVersion === 1 && !echoesVersion) {
            throw new SaveRejection(400, "Saving a composed service page requires the exact saved baseVersion.");
          }
        }
        if (collection === "cmsPages" && stored?.homeCompositionVersion !== undefined && !echoesVersion) {
          throw new SaveRejection(400, "Saving a converted Home requires the exact saved baseVersion.");
        }
        const requiresHomePagePublication = enforceHomeEditorBoundary && collection === "cmsPages" &&
          docId === "home" && stored?.homeCompositionVersion === 2;
        if (requiresHomePagePublication && (publishesSnapshot || schedulesPublication) && !mayUseNoBuild) {
          throw new SaveRejection(400, "Version 2 Home publication is not enabled. Save this draft without publishing or scheduling.");
        }

        // Status: preserve the stored status when the client omits it, so a metadata-only
        // edit of a live, scheduled, or in-review document does not silently downgrade it
        // to draft (a save of a published page would otherwise unpublish it on the next
        // build). Only a brand-new document falls back to draft. An explicitly sent
        // unknown status is rejected after record authorization above.
        if (!CONTENT_STATUSES.has(status)) {
          throw new SaveRejection(400, `Unknown status ${String(document.status)}`);
        }

        if (
          !creating &&
          stored?.status === "in_review" &&
          !publishesSnapshot &&
          !schedulesPublication
        ) {
          throw new SaveRejection(
            400,
            "Select Edit before changing reviewed content.",
          );
        }

        if (
          publishesSnapshot &&
          !needsSeededPublishedSnapshot &&
          !["draft", "in_review", "approved"].includes(stored?.status) &&
          !(liveBlogUpdate === true && stored?.status === "published")
        ) {
          throw new SaveRejection(
            400,
            "Save this content as a draft before publishing.",
          );
        }
        if (
          publish === true && liveBlogUpdate !== true &&
          (Object.keys(document).length > 0 || requestedSlug !== undefined)
        ) {
          throw new SaveRejection(
            400,
            "Publish the saved version without content changes.",
          );
        }
        if (schedulesPublication && !["draft", "in_review", "approved"].includes(stored?.status)) {
          throw new SaveRejection(
            400,
            "Save this content as a draft before scheduling.",
          );
        }

        // Approval is evidence about one exact saved version, not a client-owned
        // field. An ordinary save cannot create that evidence, and it cannot
        // change reviewed content while silently retaining it. Publishing and
        // scheduling are the only operations that can consume an approved version.
        if (
          !creating &&
          stored?.status === "approved" &&
          !publishesSnapshot &&
          !schedulesPublication
        ) {
          throw new SaveRejection(400, "Reopen approved content before editing.");
        }
        if (status === "approved" && stored?.status !== "approved") {
          throw new SaveRejection(
            400,
            "Approval must use its dedicated lifecycle action.",
          );
        }
        if (
          !schedulesPublication &&
          status === "scheduled" &&
          stored?.status !== "scheduled"
        ) {
          throw new SaveRejection(
            400,
            "Scheduling must use its dedicated scheduling action.",
          );
        }
        if (!schedulesPublication && stored?.status === "scheduled") {
          throw new SaveRejection(
            400,
            "Cancel scheduled publication before editing.",
          );
        }
        // Unpublish, archive, restore, and approval have their own version-guarded
        // mutation boundary. A content save may preserve any current lifecycle
        // state, but it cannot perform one of those actions as a side effect of
        // editing fields. Run this only after record-level authorization and the
        // exact-version check so the response does not become a status oracle.
        // A create establishes its initial state. It is not a transition of the
        // absent target, including when a canonical page adopts an archived
        // legacy seed after the archive capability check above.
        const requiresDedicatedLifecycleAction =
          !creating &&
          ((stored?.status === "published" && status !== "published" && !revisingPublished) ||
            (status === "archived" && stored?.status !== "archived") ||
            (stored?.status === "archived" && status !== "archived"));
        if (requiresDedicatedLifecycleAction) {
          throw new SaveRejection(
            400,
            "Unpublish, archive, and restore must use their dedicated lifecycle action.",
          );
        }
        if (
          !creating &&
          stored?.status === "published" &&
          !publishesSnapshot && !revisingPublished
        ) {
          throw new SaveRejection(
            400,
            "Start a revision before editing published content.",
          );
        }

        // An ordinary save is decoupled from publishing (ADR 0012). Only the
        // explicit publish action below can enter published and freeze the snapshot.
        if (
          !publishesSnapshot &&
          status === "published" &&
          compositionBase?.status !== "published"
        ) {
          throw new SaveRejection(
            400,
            "Save cannot publish a document; publishing is a separate action",
          );
        }

        const timestamp = now();
        if (schedulesPublication) {
          const scheduleError = publicationScheduleError(
            Date.parse(normalizedScheduleAt), Date.parse(timestamp),
          );
          if (scheduleError) throw new SaveRejection(400, scheduleError);
        }

        // The server owns routing fields. An untitled Post draft waits for its first title
        // before reserving a slug. Title is the normal source, `name` covers staff/sponsor records, and the type is
        // a deterministic final fallback. Updates preserve the established route; a later rename
        // workflow can move the old value into previousSlugs intentionally instead of changing
        // links as a side effect of editing a label (#541).
        let persistenceDefaults = {};
        if (schedulesPublication) {
          persistenceDefaults = { publishAt: normalizedScheduleAt };
        } else if (collection === "cmsPages" && document.publishAt !== undefined) {
          // Page scheduling uses the same strict UTC instant as records and the
          // static publish gate. Validation above proves the value is parseable;
          // normalize it here so date controls and equivalent ISO forms cannot
          // persist a value the scheduler will later fail closed on.
          persistenceDefaults = {
            publishAt: normalizePublishAt(document.publishAt, timestamp),
          };
        }
        if (collection === "cmsPosts") {
          const isUntitledPostDraft = contentKind === "post" && incompleteDraftIsAllowed &&
            !(typeof document.title === "string"
              ? document.title.trim()
              : typeof compositionBase?.title === "string" && compositionBase.title.trim());
          const needsSlug = !isUntitledPostDraft && (
            creating ||
            typeof compositionBase?.slug !== "string" ||
            compositionBase.slug.trim() === ""
          );
          const displayName =
            (typeof document.title === "string" && document.title.trim()) ||
            (typeof document.name === "string" && document.name.trim()) ||
            (typeof compositionBase?.title === "string" && compositionBase.title.trim()) ||
            (typeof compositionBase?.name === "string" && compositionBase.name.trim()) ||
            (typeof document.type === "string" && document.type) ||
            (typeof compositionBase?.type === "string" && compositionBase.type) ||
            "untitled";
          persistenceDefaults = {
            ...persistenceDefaults,
            ...(needsSlug
              ? {
                  slug: await uniqueRecordSlug(
                    tx,
                    firestore,
                    mintablePostSlugRoot(displayName),
                  ),
                }
              : {}),
            ...(creating || !Array.isArray(compositionBase?.previousSlugs)
              ? { previousSlugs: [] }
              : {}),
            ...(creating ||
            typeof compositionBase?.locale !== "string" ||
            compositionBase.locale.trim() === ""
              ? { locale: "en" }
              : {}),
            ...(creating && !schedulesPublication
              ? { publishAt: normalizePublishAt(document.publishAt, timestamp) }
              : {}),
          };
          if (!schedulesPublication && !creating && document.publishAt !== undefined) {
            // RecordForm fills an absent date control with an empty string. On a legacy record
            // that genuinely has no publishAt, that blank is only the form's seed — not a request
            // to invent scheduling metadata during an unrelated edit. A blank on a record that
            // already has a date remains the documented “publish now” choice.
            const blankPublishAt =
              document.publishAt === null ||
              (typeof document.publishAt === "string" && document.publishAt.trim() === "");
            if (!blankPublishAt || compositionBase?.publishAt !== undefined) {
              persistenceDefaults = {
                ...persistenceDefaults,
                publishAt: normalizePublishAt(document.publishAt, timestamp),
              };
            }
          }
        }

        // Blocks: mint a canonical id for every block the stored document does not
        // already own (#515), then re-validate the whole array with the shared
        // parseBlocks contract. A page/post carries blocks; other records do not.
        const hasBlocks = document.blocks !== undefined || (conversionFingerprint !== null && conversionTarget === 2);
        let outBlocks;
        let mintedIds = {};
        if (hasBlocks) {
          let conversionBlocks = document.blocks;
          if (conversionFingerprint !== null && conversionTarget === 2) {
            const parsedStored = parseBlocksFn(stored.blocks, { complete: !incompleteDraftIsAllowed, pageId: docId });
            if (!parsedStored.ok) throw new SaveRejection(400, parsedStored.error);
            try { conversionBlocks = editorialHomeBlocks(parsedStored.blocks, mintId); }
            catch (error) { throw new SaveRejection(400, error.message); }
          } else if (conversionFingerprint !== null) {
            if (!Array.isArray(stored.blocks)) {
              throw new SaveRejection(400, "Home recovery content is not readable. Conversion has not changed it.");
            }
            const manual = stored.blocks.filter(block => block?.type === "promotion_playlist");
            if (manual.length > 8) {
              throw new SaveRejection(400, "Home contains more than eight manual shelves. Review them before conversion.");
            }
            // Retain the stored shelves, never client replacements. Their positions
            // are owned by data.placement; array order follows the seven regions.
            conversionBlocks = [
              ...document.blocks,
              ...manual.map((block, index) => ({ ...block, order: 7 + index })),
            ];
          }
          if (conversionTarget !== 2 || conversionFingerprint === null) conversionBlocks = stampDocumentLists(conversionBlocks, stored?.blocks, timestamp);
          // `public` on a video block is server-owned: only the publish
          // transaction stamps it, from cmsPublicVideos (#2751).
          if (conversionTarget !== 2 || conversionFingerprint === null) conversionBlocks = withoutPublicVideoData(conversionBlocks);
          let withIds = conversionBlocks;
          const hasLayout = Array.isArray(conversionBlocks) && conversionBlocks.some(block =>
            isPlainObject(block) && (block.type === "row" || block.layout !== undefined));
          // Validate temporary identities before minting: duplicate row IDs
          // cannot ambiguously bind a child to one of two newly minted rows.
          if (hasLayout) {
            const proposed = parseBlocksFn(conversionBlocks, { complete: !incompleteDraftIsAllowed, pageId: collection === "cmsPages" ? docId : undefined });
            if (!proposed.ok) throw new SaveRejection(400, proposed.error);
          }
          if (Array.isArray(conversionBlocks) && !(conversionFingerprint !== null && conversionTarget === 2)) {
            const storedBlocks = Array.isArray(stored?.blocks) ? stored.blocks : [];
            const knownIds = new Set(
              storedBlocks
                .map((b) => (isPlainObject(b) ? b.id : undefined))
                .filter((id) => typeof id === "string" && id.length > 0),
            );
            const assigned = assignBlockIds(conversionBlocks, mintId, knownIds,
              collection === "cmsPages" && docId === "home" && stored?.homeCompositionVersion === 2);
            withIds = hasLayout
              ? remapRowMembership(assigned.blocks, assigned.mintedIds)
              : assigned.blocks;
            mintedIds = assigned.mintedIds;
          }
          const parsed = parseBlocksFn(withIds, { complete: !incompleteDraftIsAllowed, pageId: collection === "cmsPages" ? docId : undefined });
          if (!parsed.ok) throw new SaveRejection(400, parsed.error);
          const section =
            collection === "cmsPages"
              ? expectedPageTemplate
              : (document.type ?? stored?.type) === "post"
                ? "post"
                : null;
          if (section !== null) {
            const sectionError = validateSectionFn(section, parsed.blocks);
            if (sectionError) {
              throw new SaveRejection(400, sectionError.reason);
            }
          }
          const contentError = blockContentError(parsed.blocks, { complete: !incompleteDraftIsAllowed });
          if (contentError) throw new SaveRejection(400, contentError);
          outBlocks = parsed.blocks;
          if (
            !can(user.principal, "content.publish", writeResource) &&
            changesCustomHtml(stored?.blocks, outBlocks)
          ) {
            throw new SaveRejection(403, "Only editors and admins can add or change custom HTML.");
          }
          if (conversionFingerprint !== null) {
            const homeError = homeCompositionError(docId, conversionTarget, outBlocks, { complete: !incompleteDraftIsAllowed });
            if (homeError) throw new SaveRejection(400, homeError);
          } else if (enforceHomeEditorBoundary) {
            const boundaryError = homeEditorBoundaryError({
              collection,
              documentId: docId,
              storedBlocks: stored?.blocks,
              nextBlocks: outBlocks,
              storedVersion: stored?.homeCompositionVersion,
              nextVersion: document.homeCompositionVersion ?? stored?.homeCompositionVersion,
              complete: !incompleteDraftIsAllowed,
            });
            if (boundaryError) throw new SaveRejection(400, boundaryError);
          }
        }

        if (collection === "cmsPages" && stored?.homeCompositionVersion !== undefined) {
          const parsedHome = parseBlocksFn(outBlocks ?? stored.blocks, { complete: !incompleteDraftIsAllowed, pageId: docId });
          if (!parsedHome.ok) throw new SaveRejection(400, parsedHome.error);
          const homeError = homeCompositionError(docId, conversionFingerprint === null ? stored.homeCompositionVersion : conversionTarget, parsedHome.blocks, { complete: !incompleteDraftIsAllowed });
          if (homeError) throw new SaveRejection(400, homeError);
        }

        if (collection === "cmsPages" && docId === "home" && stored?.homeCompositionVersion === 2 && outBlocks) {
          try { await verifyHomeSelections({ firestore, transaction: tx, blocks: outBlocks, previousBlocks: stored.blocks }); }
          catch (error) {
            if (error.code === "HOME_SELECTION_ADMISSION") throw new SaveRejection(409, error.publicMessage);
            throw error;
          }
        }

        // Compose the persisted doc. tx.set() replaces the whole document, so a save
        // that leaves a field out would delete it. Start from the stored target, or from
        // the server-read legacy seed during a first page-specific save, and
        // overlay only what the client sent, so an omitted field is preserved rather
        // than wiped: a metadata-only save (e.g. a title edit) keeps the stored blocks,
        // slug, and seo. Present keys are authoritative -- to clear a field a client
        // sends it explicitly (an empty array, or null). Blocks are managed apart from
        // this overlay: they are validated and id-minted above, so `blocks` is stripped
        // from the client payload and re-applied only from `outBlocks` (omitting it
        // keeps the stored blocks; sending `blocks: []` clears them). Server-owned
        // fields are stripped and re-applied from trusted server state last, so the client can
        // never forge id, timestamps, author, or version. The publish snapshot rides forward
        // from that state and is never client-writable.
        const clientDoc = { ...document };
        if (Object.hasOwn(clientDoc, "leadMedia")) clientDoc.leadMedia = withoutPublicLeadVideo(clientDoc.leadMedia);
        for (const field of SERVER_OWNED_FIELDS) delete clientDoc[field];
        for (const field of legacyRoundTripFields) delete clientDoc[field];
        prepareRecordImageAccessibilityOverlay({
          collection,
          contentKind,
          creating,
          base: compositionBase,
          request: document,
          overlay: clientDoc,
        });
        delete clientDoc.blocks;
        // A publish date reaches storage only through the normalized/defaulted
        // overlay above. Removing the raw control value also lets a seeded blank
        // preserve a legacy record's genuine absence.
        delete clientDoc.publishAt;

        // The story-date contract (#1041). Three of a post's four dates are decided
        // here rather than copied out of the request:
        //
        // - `date` is the editorial display date. Submitting a day that differs from
        //   the one the record already displays -- or blanking a date that was set --
        //   is a deliberate backdate. Once the record is public that moves the date
        //   every reader sees, so it takes the same authority as publishing. An
        //   ordinary save round-trips the same value and changes nothing, and a date
        //   set on a draft nobody has seen is a proposal that can only reach readers
        //   through a publish, so neither stops a contributor from working.
        // - `recordMeaningfulUpdate` is a one-shot request, not a stored setting. It
        //   is consumed here and written back false, so the next typo fix cannot
        //   re-stamp the story as updated today.
        // - `showUpdatedDate` is an ordinary editor toggle and rides through as one.
        //
        // Both server-decided values are stripped from the client overlay first: a
        // client may propose a date, never assert one.
        let editorialDateFields = {};
        if (collection === "cmsPosts" && contentKind === "post") {
          // Compare against the migrated base, so a pre-contract post storing its
          // date as an ISO instant is not read as a different day and refused as an
          // unauthorized backdate on an ordinary save.
          const dateBase = normalizeLegacyPostDate(compositionBase ?? { type: "post" });
          const dateWrite = resolveEditorialDateWrite(dateBase, document.date);
          if (dateWrite.error) throw new SaveRejection(400, dateWrite.error);
          if (
            dateWrite.requiresPublishAuthority &&
            !can(user.principal, "content.publish", {})
          ) {
            log.warn("cmsSaveContent denied a backdate", {
              uid: user.uid,
              collection,
              documentId: docId,
            });
            throw new SaveRejection(403, FORBIDDEN_MESSAGE);
          }
          editorialDateFields = {
            ...dateWrite.fields,
            ...applyMeaningfulUpdate({
              requested: document.recordMeaningfulUpdate,
              at: timestamp,
              by: user.uid,
            }),
          };
        }
        delete clientDoc.date;
        delete clientDoc.recordMeaningfulUpdate;

        // The byline contract (#1040). Shape and bounds were checked with every
        // other field above; what is decided here is the part that needs the
        // stored world:
        //
        // - A save that sends no `credits` at all keeps the byline the record
        //   already had. For a pre-contract post that byline is its free-text
        //   `author`, converted deterministically to one custom credit -- never
        //   matched against the staff directory, because a string that reads like
        //   a staff member's name is not evidence that they wrote the story.
        // - A registered credit must name an author identity that exists and is
        //   active. Ids the record ALREADY credited are exempt: a story keeps its
        //   byline, and stays editable, after the person who wrote it leaves.
        //   A duplicate's credits are new to its destination record.
        // - The legacy `author` is dropped from the composed document below, so
        //   the conversion happens once and the record then has exactly one byline.
        let creditFields = {};
        if (collection === "cmsPosts" && contentKind === "post") {
          const baseCredits = resolveStoryCredits(compositionBase ?? {});
          let nextCredits = baseCredits;
          if (Object.prototype.hasOwnProperty.call(document, "credits")) {
            const normalized = normalizeStoryCredits(document.credits);
            if (!normalized.ok) throw new SaveRejection(400, normalized.errors[0]);
            nextCredits = normalized.credits;
          }
          const alreadyCredited = new Set(registeredAuthorIds(baseCredits));
          const addedAuthorIds = registeredAuthorIds(nextCredits).filter(
            (authorId) => !alreadyCredited.has(authorId),
          );
          if (addedAuthorIds.length > 0) {
            const identities = await readAuthorIdentitiesFn({
              firestore,
              tx,
              authorIds: addedAuthorIds,
            });
            const creditError = registeredCreditsError(
              nextCredits,
              identities,
              alreadyCredited,
            );
            if (creditError) throw new SaveRejection(400, creditError);
          }
          creditFields = { credits: nextCredits };
        }
        delete clientDoc.credits;
        if (collection === "cmsPosts" && contentKind === "post" && document.liveBlog != null) {
          try {
            clientDoc.liveBlog = await prepareLiveBlogDraftInTransaction({ firestore, tx, value: document.liveBlog,
              previous: compositionBase?.liveBlog, published: compositionBase?.published?.metadata?.liveBlog,
              mintId: () => randomUUID(), readIdentities: readAuthorIdentitiesFn });
          } catch (error) {
            if (error instanceof LiveBlogDraftError) throw new SaveRejection(400, error.message);
            throw error;
          }
        }
        const nextVersion = (stored?.version ?? 0) + 1;
        const priorPublicSourceVersion = confirmedPublicSourceVersion(stored);
        // A pre-contract post may retain its editorial date as an ISO instant. Migrate only
        // the server-read base on publish or schedule; the client overlay below remains
        // authoritative, so a newly submitted instant is still rejected by composed
        // metadata validation.
        const persistedBase =
          (publishesSnapshot || schedulesPublication) && collection === "cmsPosts"
            ? normalizeLegacyPostDate(compositionBase)
            : compositionBase;
        // Ownership is established by the write that creates the record and never
        // moves after that -- an owner a later save could reassign is not an owner.
        // A record stored before this field existed stays unowned rather than
        // inheriting whoever edits it next. Deliberately not read from
        // `compositionBase`: on a seeded create that is the legacy singleton, and
        // its owner is the wrong answer twice over -- it hands the new page to
        // someone who did not make it, and takes it away from whoever did.
        const recordOwner = creating ? user.uid : stored?.createdBy;
        // The scoped-grant desk (#619), resolved on the same principle as the owner above:
        // a record's section is fixed by the write that creates it, because a scope a
        // later save could move is not a scope. A canonical page does not store an
        // editorial choice at all -- it recomputes its desk from the public page registry
        // on every save, so a page whose area changes there heals on its next write.
        // Every read of the registry stays inside this transaction and ahead of its writes.
        let recordSection;
        if (collection === "cmsPages" && !isCustomPageId(docId)) {
          recordSection = contentSectionForPage(docId) ?? undefined;
        } else if (!creating && !isUnassignedPostDraft(stored)) {
          recordSection = stored?.section;
          if (effectiveRequestedSection !== undefined && effectiveRequestedSection !== recordSection) {
            throw new SaveRejection(
              400,
              "A record's section is set when it is created and cannot be changed",
            );
          }
        } else if (effectiveRequestedSection !== undefined) {
          const targetResource = { ownerId: recordOwner, section: effectiveRequestedSection };
          if (!can(user.principal, "content.create", targetResource) ||
              (!can(user.principal, "content.edit.any", targetResource) &&
               !can(user.principal, "content.edit.own", targetResource))) {
            throw new SaveRejection(403, FORBIDDEN_MESSAGE);
          }
          const unknown = await unregisteredSections(
            firestore,
            [effectiveRequestedSection],
            tx,
          );
          if (unknown.length > 0) {
            throw new SaveRejection(400, `Unknown section ${effectiveRequestedSection}`);
          }
          recordSection = effectiveRequestedSection;
        } else if (REQUIRE_SECTION_ON_RECORD_CREATE && !newUnassignedDraft && !isUnassignedPostDraft(stored)) {
          throw new SaveRejection(400, "A new record requires a section");
        }
        const routeFields = await requestedRoute(tx, firestore, collection, docId, compositionBase, requestedSlug, baseVersion);
        let composed = {
          ...(persistedBase ?? {}),
          ...clientDoc,
          ...editorialDateFields,
          ...creditFields,
          ...persistenceDefaults,
          ...routeFields,
          ...(hasBlocks ? { blocks: outBlocks } : {}),
          ...(expectedPageTemplate === null
            ? {}
            : { template: expectedPageTemplate }),
          id: docId,
          status,
          createdAt: compositionBase?.createdAt ?? timestamp,
          // Who owns this record, for own-content editing (#380). Omitted rather
          // than set to undefined, which Firestore refuses to store.
          ...(recordOwner === undefined ? {} : { createdBy: recordOwner }),
          // Omitted rather than undefined for the same Firestore reason as createdBy. An
          // unsectioned legacy record stays unsectioned rather than gaining a desk from
          // whoever saves it next.
          ...(recordSection === undefined ? {} : { section: recordSection }),
          updatedAt: timestamp,
          updatedBy: user.uid,
          // Count of saves, not of edits: one per committed write, starting at 1. A
          // document stored before this field existed reads as 0 and so gets 1 on its
          // first save here, exactly like a create.
          version: nextVersion,
          ...(conversionFingerprint === null ? {} : {
            homeCompositionVersion: conversionTarget,
            ...(conversionTarget === 2 ? { homeHero: {
              ...(stored.homeHero ?? { mode: "manual", items: [] }), presentation: "editorial",
            } } : {}),
            homeConversionReceipt: { fingerprint: conversionFingerprint, version: nextVersion, mintedIds,
              ...(conversionTarget === 2 ? { targetVersion: 2 } : {}),
            },
          }),
          ...(priorPublicSourceVersion === null
            ? {}
            : { [PUBLIC_SOURCE_VERSION_FIELD]: priorPublicSourceVersion }),
        };
        if (collection === "cmsPosts" && contentKind === "post") {
          if (document.liveBlog === null) delete composed.liveBlog;
        // Null is an explicit clear; omission preserves an existing assignment.
        if (document.coverageLabelId === null) {
          delete composed.coverageLabelId;
          // None also clears the legacy source of the derived election pill.
          if (composed.liveBlog?.branding === "nj-decides-2026") {
            composed.liveBlog = { ...composed.liveBlog };
            delete composed.liveBlog.branding;
          }
        }
          try { assertLiveBlogRetainsPublished(composed.liveBlog, stored?.published?.metadata?.liveBlog); }
          catch (error) { throw new SaveRejection(400, error.message); }
        }
        if (collection === "cmsPosts" && contentKind === "post") {
          try { await require("./lib/live-blog-compatibility").assertLiveBlogFollowUpsRenderer({ firestore, transaction: tx, liveBlog: composed.liveBlog }); }
          catch (error) { if (error.status) throw new SaveRejection(error.status, error.message, error.code ? { code: error.code } : {}); throw error; }
        }
        let liveBlogPresentationPending = false;
        if (collection === "cmsPosts" && contentKind === "post" && composed.liveBlog?.presentation !== undefined &&
            await require("./lib/live-blog-compatibility").readLiveBlogContractVersion({ firestore, transaction: tx }) < 2) {
          if (compositionBase?.liveBlog?.presentation !== undefined || stored?.published?.metadata?.liveBlog?.presentation !== undefined) {
            throw new SaveRejection(409, "Live blog appearance settings are temporarily unavailable. Your saved choices have not changed. Try again after the update.", { code: "live_blog_presentation_unavailable" });
          }
          composed.liveBlog = { ...composed.liveBlog };
          delete composed.liveBlog.presentation;
          liveBlogPresentationPending = true;
        }
        // A schema-two publication or schedule checks liveBlogVersion against its
        // admitted contract and selected pair's Post capability. The schema-one gate
        // reads the old deployment pointer and cannot apply to either.
        if ((publishesSnapshot || schedulesPublication) && collection === "cmsPosts" && contentKind === "post" && composed.liveBlog !== undefined &&
            !pairRequest) {
          try { await require("./lib/live-blog-compatibility").assertLiveBlogRenderer({ firestore, transaction: tx, liveBlog: composed.liveBlog }); }
          catch (error) {
            if (error.status) throw new SaveRejection(error.status, error.message);
            throw error;
          }
        }
        const contentLinkError = require("./lib/content-link").contentLinkError(composed);
        if (contentLinkError) throw new SaveRejection(400, contentLinkError);

        // Data Hub edits reporting and metadata over its compiled layout. A first
        // draft (or one saved before this default) has no editor-owned blocks.
        if (collection === "cmsPages" && docId === "data-hub" && composed.blocks === undefined) {
          composed.blocks = [];
        }
        // Apply an explicit optional-end clear after composition so an older
        // saved end cannot survive the overlay. Omitted ends still remain.
        if (contentKind === "event" && typeof composed.endsAt === "string" && composed.endsAt.trim() === "") {
          delete composed.endsAt;
        }
        if (revisingPublished) {
          composed.publiclyVisible = stored.publiclyVisible !== false;
          delete composed.publishAt;
          delete composed.scheduledPublishFailure;
        }
        if (collection === "cmsPosts" && changesPublicLibraryFields(stored, composed) &&
            !can(user.principal, "content.publish", writeResource)) {
          throw new SaveRejection(403, "You need publication permission to change public sponsor or newsletter fields.");
        }
        if (recordSection === undefined && (newUnassignedDraft || isUnassignedPostDraft(stored))) {
          composed.unassignedDraft = true;
        } else {
          delete composed.unassignedDraft;
        }
        if (status === "in_review") {
          const advancedRequest = advanceReviewRequest(
            compositionBase?.reviewRequest,
            {
              collection,
              id: docId,
              sourceVersion: nextVersion,
            },
          );
          if (advancedRequest) composed.reviewRequest = advancedRequest;
        } else if (compositionBase?.status === "in_review") {
          delete composed.reviewRequest;
        }
        // Complete the one-way byline conversion. The credits above already carry
        // whatever the legacy `author` said, so leaving the old field behind would
        // give the record two bylines that could disagree on the next edit.
        if (collection === "cmsPosts" && composed.type === "post") {
          delete composed.author;
        }
        // First publication is the only thing that mints `firstPublishedAt`, and it
        // is minted from this transaction's trusted server time -- never from a draft
        // timestamp, and never from the `publishAt` the editor asked for. A republish,
        // a revision, and a restore all leave it alone, and a post that was already
        // public before this contract existed never gets one invented for it. The
        // stamp lands before the snapshot below so the frozen public projection and
        // the working document carry the same dates.
        if (publishesSnapshot && collection === "cmsPosts" && composed.type === "post") {
          Object.assign(
            composed,
            applyFirstPublish(composed, { at: timestamp, by: user.uid }),
          );
        }
        // A successful publish or schedule supersedes any recorded scheduled-publish
        // failure carried on the composition base. Drop the stale warning before
        // validation, snapshot creation, history, and persistence so the new
        // publication does not go live carrying it.
        if (publishesSnapshot || schedulesPublication) {
          delete composed.scheduledPublishFailure;
        }
        if (status !== "scheduled" || schedulesPublication) delete composed.scheduledPublicationTransport;
        if (schedulesPublication && collection === "cmsPosts" && composed.type === "post") {
          const scheduleAdmission = await readNoBuildFamilyAdmission({ firestore, transaction: tx });
          const { state: scheduleOwner } = await readNoBuildPostOwner({ firestore, transaction: tx, postId: docId });
          if (scheduleOwner?.mode !== "static" &&
              (scheduleOwner?.operationId || selectsNoBuildPost(scheduleAdmission, docId))) {
            composed.scheduledPublicationTransport = "post-no-build-v1";
          }
        }
        if (schedulesPublication && collection === "cmsPages" &&
            await require("./lib/no-build-page-publication").pagePublicationSelected({ firestore, transaction: tx, documentId: docId })) {
          composed.scheduledPublicationTransport = "page-no-build-v1";
        }
        if (schedulesPublication && collection === "cmsPosts") {
          const { recordFamily, recordPublicationSelected } = require("./lib/no-build-record-publication");
          const family = recordFamily(composed);
          if (family && await recordPublicationSelected({ firestore, transaction: tx, documentId: docId, family })) {
            composed.scheduledPublicationTransport = "public-context-no-build-v1";
          }
        }
        if (collection === "cmsPages" && docId === "kids") {
          const kidsBlocks = parseBlocksFn(composed.blocks, { complete: !incompleteDraftIsAllowed, pageId: docId });
          if (!kidsBlocks.ok) throw new SaveRejection(400, kidsBlocks.error);
        }
        // The empty-slot exception is Home-only. Check the composed document too,
        // so metadata-only publication cannot retain a forged Post/Page marker.
        if ((collection !== "cmsPages" || docId !== "home") &&
            Array.isArray(composed.blocks) && composed.blocks.some(block => block?.section === "home-newsletter")) {
          throw new SaveRejection(400, "The Home Newsletter bar belongs only on Home.");
        }
        const hubCompositionError = collection === "cmsPages"
          ? require("./lib/data-hub-composition").dataHubPageError(docId, composed.dataHubCompositionVersion, composed.blocks)
          : composed.dataHubCompositionVersion !== undefined ? "Data Hub composition belongs only on the Data Hub Page." : null;
        if (hubCompositionError) throw new SaveRejection(400, hubCompositionError);
        const completeFieldError = validateContentFieldValues(
          collection,
          contentKind,
          composed,
          {
            complete: !incompleteDraftIsAllowed,
            allowIncomplete: incompleteDraftIsAllowed,
            // Request-owned values were type-checked above. Retained imported
            // values stay opaque during an unrelated ordinary save, matching the
            // legacy metadata policy; publishing has its stricter projection gate.
            validateTypes: publishesSnapshot || schedulesPublication,
          },
        );
        const protectiveLifecycleOnly = isProtectiveLifecycleOnlyTransition(
          stored,
          composed,
          { collection, expectedPageTemplate },
        );
        if (completeFieldError && !protectiveLifecycleOnly) {
          throw new SaveRejection(400, completeFieldError);
        }
        if (publishesSnapshot && !enablePublishSnapshot) {
          throw new SaveRejection(
            503,
            "Publish snapshots are not enabled in this deployment",
          );
        }
        if (publishesSnapshot || schedulesPublication) {
          // Validate the fully composed metadata, not only the partial request
          // checked before the transaction. A metadata-only publish retains
          // stored/imported fields, and those must not be frozen into a snapshot
          // the strict loader will reject.
          const composedMetadataError = validateKnownMetadata(composed, {
            descriptionIsString: collection === "cmsPages",
          });
          if (composedMetadataError) {
            throw new SaveRejection(400, composedMetadataError);
          }
          // A metadata-only publish still has to validate the retained working
          // blocks. Otherwise a malformed legacy/imported page could bypass the
          // explicit-block check above and freeze a snapshot the strict site
          // build cannot render.
          const publishSection =
            collection === "cmsPages"
              ? expectedPageTemplate
              : composed.type === "post"
                ? "post"
                : null;
          if (publishSection !== null) {
            const parsedForPublish = parseBlocksFn(composed.blocks, { pageId: collection === "cmsPages" ? docId : undefined });
            if (!parsedForPublish.ok) {
              throw new SaveRejection(400, parsedForPublish.error);
            }
            if (collection === "cmsPosts" && composed.type === "post") {
              const presentationError = postPresentationError({
                tags: composed.tags,
                blocks: parsedForPublish.blocks,
                heroImage: composed.heroImage,
                leadMedia: composed.leadMedia,
              });
              if (presentationError) {
                throw new SaveRejection(400, presentationError);
              }
            }
            const sectionError = validateSectionFn(
              publishSection,
              parsedForPublish.blocks,
            );
            if (sectionError) {
              throw new SaveRejection(400, sectionError.reason);
            }
            const contentError = blockContentError(parsedForPublish.blocks);
            if (contentError) throw new SaveRejection(400, contentError);
            const resourceError = publishedBlockResourceError(parsedForPublish.blocks, collection === "cmsPages" ? `/${docId}/` : "/posts/");
            if (resourceError) throw new SaveRejection(400, resourceError);
            composed.blocks = parsedForPublish.blocks;
          }
          if (publishesSnapshot && !mayUseNoBuild) {
            await assertSerializerPublicationAdmissionInTransaction({
              firestore,
              transaction: tx,
            });
          }
          // Publishing is one document transaction, not "save, then copy": the
          // snapshot sees the canonical block ids minted above and the exact
          // metadata/version being committed. Manual publish means go live now;
          // the scheduler preserves its already-normalized due instant through
          // the same snapshot helper.
          // A direct live update carries its own content change, so it advances the
          // editorial version that an ordinary save would otherwise have advanced.
          const directContentVersion = liveBlogUpdate === true
            ? contentVersion(stored) + (hasContentChanges(stored, composed) ? 1 : 0) : null;
          if (publishesSnapshot) {
            let publishedSnapshot;
            // Freeze the byline into the projection only. The working document
            // keeps bare author ids, so renaming an author still corrects every
            // draft; this revision keeps the names as they read at this instant.
            const documentForPublish = await withPublicVideosOrReject(withPublicVideosFn, {
              firestore,
              tx,
              collection,
              documentId: docId,
              document: await withFrozenCreditsOrReject(withFrozenCreditsFn, {
                firestore,
                tx,
                at: timestamp,
                document: await withElectionResultsOrReject({
                  firestore, transaction: tx, collection, documentId: docId, document: composed }),
              }),
            });
            try {
              publishedSnapshot = createPublishedSnapshot({
                collection,
                document: { ...documentForPublish, contentVersion: directContentVersion ?? (contentVersion(stored) || 1) },
                publishedAt: timestamp,
                publishedBy: user.uid,
              });
              publishedSnapshot = await resolveDatasetFiguresInTransaction({ firestore, transaction: tx, snapshot: publishedSnapshot });
            } catch (error) {
              if (error instanceof PublishSnapshotError) {
                throw new SaveRejection(error.status, error.message);
              }
              throw error;
            }
            if (liveBlogUpdate === true) {
              publishedSnapshot = withPublishedParentByline(stored.published, publishedSnapshot);
              const refusal = liveBlogUpdateScopeRefusal(stored.published, publishedSnapshot);
              if (liveBlogPresentationPending && refusal === "There are no live update changes to publish.") {
                return { persisted: stored, isCreate: false, mintedIds: {}, publication: null, liveBlogPresentationPending, replayed: false };
              }
              if (refusal) throw new SaveRejection(409, refusal);
            }
            composed = {
              ...composed,
              ...(directContentVersion === null ? {} : { contentVersion: directContentVersion }),
              publishAt: timestamp,
              publiclyVisible: true,
              // cmsPublish either clears this exact marker after a verified runtime
              // receipt or claims it with the fallback queue id. Failed, cancelled,
              // omitted, or stale builds remain eligible for the scheduled retry.
              [PUBLISH_BUILD_PENDING_FIELD]: true,
              [PUBLISH_BUILD_QUEUE_FIELD]: publishQueueRef?.id ?? null,
              published: publishedSnapshot,
            };
          }
        }

        // Validate retained publication blocks before checking their installed
        // readers, so malformed content keeps the native validation response.
        if (collection === "cmsPages") {
          try {
            await require("./lib/page-reader-compatibility").assertInstalledPageReaders({
              firestore, transaction: tx, pageId: docId, blocks: composed.blocks, preview: true,
              requireIdle: publishesSnapshot || schedulesPublication });
          } catch (error) {
            if (error.status) throw new SaveRejection(error.status, error.message, error.code ? { code: error.code } : {});
            throw error;
          }
        }

        const contentChanged = creating || hasContentChanges(stored, composed) ||
          (effectiveRequestedSection !== undefined && effectiveRequestedSection !== stored?.section);
        // One composition write can group only its next metadata write. Consume
        // the marker so a reused caller identifier cannot suppress later revisions.
        const startsPageSave = saveGroupId !== undefined && hasBlocks &&
          Object.keys(document).every((key) => key === "blocks" || key === "template");
        const continuesPageSave = saveGroupId !== undefined && !hasBlocks && echoesVersion &&
          stored?.contentSaveGroup === saveGroupId && stored?.updatedBy === user.uid;
        composed.contentVersion = creating ? 1 : liveBlogUpdate === true ? composed.published.contentVersion : contentVersion(stored) +
          (contentChanged && !publishesSnapshot && !schedulesPublication && !continuesPageSave ? 1 : 0);
        if (startsPageSave) composed.contentSaveGroup = saveGroupId;
        else delete composed.contentSaveGroup;
        if (!creating && !publishesSnapshot && !schedulesPublication &&
            !contentChanged && (stored.status === status || revisingPublished)) {
          const persisted = { ...stored };
          if (continuesPageSave) {
            tx.update(ref, { contentSaveGroup: FieldValue.delete() });
            delete persisted.contentSaveGroup;
          }
          return { persisted, isCreate: false, mintedIds: {}, replayed: false, publication: null, liveBlogPresentationPending };
        }

        // Size is checked here, on the fully composed document, because that is the
        // only point where it is known: the publish branch above folds a snapshot of
        // the page into the same document, so a save that fits and a publish that
        // does not are the same request until this line (#531). Firestore would
        // otherwise refuse the commit with an opaque INVALID_ARGUMENT naming no
        // field, at the moment the editor is trying to go live.
        // Both documents this write stores, not only the visible one. The
        // version-history row carries the full before AND after, so it runs to
        // roughly their sum and is what actually hits the ceiling first when a
        // large page is re-published. Checking only `composed` would let that
        // through to the failure this guard exists to replace.
        let historyEntry = versionHistoryEntryFn({
          collection,
          documentId: docId,
          action: liveBlogUpdate === true
            ? "live-blog-update"
            : publishesSnapshot
            ? "publish"
            : schedulesPublication
              ? "schedule"
              : creating
                ? "create"
                : "update",
          before: stored,
          after: composed,
          actorUid: user.uid,
          actorEmail: user.email ?? null,
          source,
        });
        const documentPath = `${collection}/${docId}`;
        const historyRef = firestore
          .collection(AUDIT_COLLECTIONS.versionHistory)
          .doc();
        const historyPath = historyRef.path;
        let boundedLegacyBefore = null;
        const contentSizeError = documentSizeErrorFn(composed, documentPath, {
          publishing: publishesSnapshot,
        });
        let historySizeError = documentSizeErrorFn(historyEntry, historyPath, {
          publishing: publishesSnapshot,
          label: "the version-history row for this save",
        });

        const storedBytes = stored
          ? firestoreDocumentBytes(stored, documentPath)
          : null;
        const composedBytes = firestoreDocumentBytes(composed, documentPath);
        const legacyLifecycleOnly = Boolean(
          historySizeError &&
          !publishesSnapshot &&
          storedBytes !== null &&
          storedBytes <= MAX_DOCUMENT_BYTES &&
          composedBytes <= MAX_DOCUMENT_BYTES &&
          isProtectiveLifecycleOnlyTransition(stored, composed, {
            collection,
            expectedPageTemplate,
          }),
        );
        const effectiveContentSizeError = legacyLifecycleOnly
          ? null
          : contentSizeError;

        // Requiring a document's full before-state beside its repaired after-state
        // can make shortening it impossible even when both content documents fit:
        // the history row stores their sum. Only when the saved document fits and
        // is strictly smaller do we replace that before-state with a bounded
        // receipt in both history and the compliance log. The repaired after-state
        // remains complete.
        // A content-preserving lifecycle transition receives the same bounded
        // before receipt even though its after-state remains above the safety
        // budget. That lets an authorized operator unpublish or archive it
        // without weakening the guard for any content edit.
        if (!effectiveContentSizeError && historySizeError && stored && conversionFingerprint === null &&
            !(collection === "cmsPages" && docId === "home" && stored.homeCompositionVersion === 2)) {
          if (
            composedBytes < storedBytes ||
            legacyLifecycleOnly
          ) {
            boundedLegacyBefore = {
              ...(stored.id === undefined ? {} : { id: stored.id }),
              ...(stored.status === undefined ? {} : { status: stored.status }),
              ...(stored.version === undefined ? {} : { version: stored.version }),
              beforeTruncated: true,
              beforeEstimatedBytes: storedBytes,
            };
            historyEntry = {
              ...versionHistoryEntryFn({
                collection,
                documentId: docId,
                action: liveBlogUpdate === true ? "live-blog-update" : publishesSnapshot ? "publish" : "update",
                before: boundedLegacyBefore,
                after: composed,
                actorUid: user.uid,
                actorEmail: user.email ?? null,
                source,
              }),
              beforeTruncated: true,
              beforeEstimatedBytes: storedBytes,
            };
            historySizeError = documentSizeErrorFn(historyEntry, historyPath, {
              publishing: publishesSnapshot,
              label: "the bounded version-history row for this repair",
            });

            // The ordinary reserve keeps new content comfortably below the hard
            // limit. A legacy lifecycle-only row may consist almost entirely of
            // the already-stored after-state, so accept it only when the measured
            // complete row still fits Firestore's actual limit.
            if (
              legacyLifecycleOnly &&
              historySizeError &&
              firestoreDocumentBytes(historyEntry, historyPath) <=
                MAX_DOCUMENT_BYTES
            ) {
              historySizeError = null;
            }
          }
        }

        // Scheduling is a publish decision taken in advance. For pages and post
        // records the scheduler supports, size the document and version-history
        // row it will create now, so the editor gets the actionable 413 while
        // they can still shorten it. Unsupported record kinds are refused above.
        let scheduledSizeError = null;
        let scheduledPublishedSnapshot = null;
        if (
          !effectiveContentSizeError &&
          !historySizeError &&
          !publishesSnapshot &&
          status === "scheduled" &&
          typeof composed.publishAt === "string" &&
          (collection === "cmsPages" ||
            (collection === "cmsPosts" && recordKindHasPublicRoute(composed.type)))
        ) {
          const scheduledBase =
            collection === "cmsPosts" ? normalizeLegacyPostDate(composed) : composed;
          const scheduledPublished = {
            ...scheduledBase,
            // The run itself stamps the instant it actually completed; the due time
            // is the closest estimate available now, and this projection exists only
            // to size the document that run will write.
            ...(collection === "cmsPosts" && scheduledBase.type === "post"
              ? applyFirstPublish(scheduledBase, {
                  at: composed.publishAt,
                  by: SCHEDULED_PUBLISH_ACTOR,
                })
              : {}),
            status: "published",
            publiclyVisible: true,
            updatedAt: composed.publishAt,
            updatedBy: SCHEDULED_PUBLISH_ACTOR,
            version: nextVersion + 1,
            [PUBLISH_BUILD_PENDING_FIELD]: true,
            [PUBLISH_BUILD_QUEUE_FIELD]: null,
          };
          // Frozen here too, so the size estimate accounts for the display names
          // the scheduled run will write rather than the shorter bare ids.
          // Scheduling stamps video now too: the copy to the public media store
          // happened before this save, so the record must already exist (#2751).
          const scheduledForPublish = await withPublicVideosOrReject(withPublicVideosFn, {
            firestore,
            tx,
            collection,
            documentId: docId,
            document: await withFrozenCreditsOrReject(withFrozenCreditsFn, {
              firestore,
              tx,
              at: composed.publishAt,
              document: await withElectionResultsOrReject({
                firestore, transaction: tx, collection, documentId: docId, document: scheduledPublished }),
            }),
          });
          try {
            scheduledPublished.published = createPublishedSnapshot({
              collection,
              document: scheduledForPublish,
              publishedAt: composed.publishAt,
              publishedBy: SCHEDULED_PUBLISH_ACTOR,
            });
            scheduledPublished.published = await resolveDatasetFiguresInTransaction({ firestore, transaction: tx, snapshot: scheduledPublished.published });
            scheduledPublishedSnapshot = scheduledPublished.published;
          } catch (error) {
            // Scheduling is a publish decision taken in advance, so a document
            // that cannot form a public snapshot is an expected client refusal.
            // Keep it out of the unexpected function-error stream just like the
            // handler's other validation decisions.
            if (error instanceof PublishSnapshotError) {
              throw new SaveRejection(error.status, error.message);
            }
            throw error;
          }
          const scheduledHistory = versionHistoryEntryFn({
            collection,
            documentId: docId,
            action: "publish",
            before: composed,
            after: scheduledPublished,
            actorUid: SCHEDULED_PUBLISH_ACTOR,
            source: "scheduler",
          });
          scheduledSizeError =
            documentSizeErrorFn(scheduledPublished, documentPath, {
              publishing: true,
              label: "the future scheduled publish",
            }) ??
            documentSizeErrorFn(scheduledHistory, historyPath, {
              publishing: true,
              label: "the version-history row for the future scheduled publish",
            });
        }

        const sizeError =
          effectiveContentSizeError ?? historySizeError ?? scheduledSizeError;
        if (sizeError) {
          log.warn("cmsSaveContent refused an oversized document", {
            uid: user.uid,
            collection,
            documentId: docId,
            detail: sizeError.detail,
          });
          throw new SaveRejection(413, sizeError.reason);
        }

        // These reads share the transaction with the content write. A media
        // tombstone that races this save changes the same private/projection
        // pair, so Firestore retries one side and the new reference cannot land
        // after the asset becomes unavailable. Usage stays one bounded write per
        // state, independent of how many assets the record uses.
        let workingMediaUsageWrite;
        let publishedMediaUsageWrite = null;
        try {
          workingMediaUsageWrite = await prepareMediaUsageWrite({
            firestore,
            transaction: tx,
            collection,
            documentId: docId,
            state: "working",
            sourceVersion: composed.version,
            usage: collectWorkingMediaUsage({ collection, document: composed }),
          });
          if (publishesSnapshot || schedulesPublication) {
            const preparedPublishedMediaUsage = await prepareMediaUsageWrite({
              firestore,
              transaction: tx,
              collection,
              documentId: docId,
              state: "published",
              releaseSelector: pairRequest?.selector,
              sourceVersion: publishesSnapshot
                ? composed.version
                : composed.version + 1,
              usage: collectPublishedMediaUsage({
                collection,
                snapshot: publishesSnapshot
                  ? composed.published
                  : scheduledPublishedSnapshot,
              }),
            });
            if (publishesSnapshot) {
              publishedMediaUsageWrite = preparedPublishedMediaUsage;
            }
          }
        } catch (error) {
          if (error instanceof MediaUsageError) {
            throw new SaveRejection(error.status, error.message, {
              ...(typeof error.code === "string" ? { code: error.code } : {}),
            });
          }
          throw error;
        }

        if (schedulesPublication) {
          const scheduledTransport = await assertNoBuildContentScheduleInTransaction({
            firestore, transaction: tx, collection, documentId: docId,
            nextDocument: { ...composed, published: scheduledPublishedSnapshot },
            pageScheduleCapture,
          });
          if (requiresHomePagePublication && !["page-no-build-v1", "release-pair-publication-v2"].includes(scheduledTransport)) {
            throw new SaveRejection(409, "Version 2 Home requires the Page publication owner.");
          }
          if (composed.scheduledPublicationTransport && scheduledTransport !== composed.scheduledPublicationTransport) {
            // First admission can select the existing transport before acceptance.
            // Removing the tentative field only reduces the sizes checked above.
            delete composed.scheduledPublicationTransport;
            historyEntry = { ...historyEntry, after: composed };
          }
          if (scheduledTransport === "release-pair-publication-v2") composed.scheduledPublicationTransport = scheduledTransport;
          if (!scheduledTransport) {
            // A schedule with no build-free owner can only fire through the
            // retired full build. Refuse now, with the cause, not at fire time.
            const refusal = await buildFreeRefusalInTransaction({ firestore, transaction: tx, collection,
              document: { ...composed, published: scheduledPublishedSnapshot } });
            if (refusal) throw new SaveRejection(409, refusal);
          }
          if (!scheduledTransport && !publicationReadinessChecked && assertPublishReadyFn) {
            throw new PublicationReadinessRequired();
          }
        }
        const noBuildFallback = {};
        const noBuildPublication = publishesSnapshot
          ? await prepareNoBuildContentPublication({ firestore, transaction: tx, collection,
              documentId: docId, nextDocument: composed, queueRef: publishQueueRef ?? firestore.collection("cmsPublishQueue").doc(),
              actor: user, source, config: deps.noBuildConfig, fallback: noBuildFallback, pageScheduleCapture }) : null;
        if (requiresHomePagePublication && publishesSnapshot && !["page-no-build-v1", "release-pair-publication-v2"].includes(noBuildPublication?.transport)) {
          throw new SaveRejection(409, "Version 2 Home requires the Page publication owner.");
        }
        if (noBuildPublication && (!publishQueueRef || !publishQueueAuditRef)) {
          throw new SaveRejection(409, "Publication admission changed. Retry this save.");
        }
        if (publishesSnapshot && mayUseNoBuild && !noBuildPublication) {
          const refusal = await buildFreeRefusalInTransaction({ firestore, transaction: tx, collection,
            document: composed, fallbackReason: noBuildFallback.reason });
          if (refusal) throw new SaveRejection(409, refusal);
          if (!publicationReadinessChecked) throw new PublicationReadinessRequired();
          if (publishReadiness?.transport !== "serializer") {
            throw new SaveRejection(409, "This content requires the existing publication serializer.");
          }
          await assertSerializerPublicationAdmissionInTransaction({ firestore, transaction: tx });
        }
        const datasetUsageWrite = publishesSnapshot ? await prepareDatasetUsageWrites({ firestore, transaction: tx,
          collection, documentId: docId, snapshot: composed.published, previousSnapshot: stored?.published,
          operationId: noBuildPublication?.operation.operationId, visible: true }) : () => {};
        const publicationTransport = noBuildPublication?.transport ?? "serializer";
        const purgeState = publishQueueRef && !noBuildPublication ? await prepareRoutePurgeInTransaction({ firestore, transaction: tx,
          changes: [{ collection, id: docId, sourceVersion: composed.published.sourceVersion }], config: purgeConfig,
          publishedSnapshots: [composed.published], now: (routePurge.now ?? Date.now)() }) : undefined;

        const writeReleaseChange = !noBuildPublication && publishesSnapshot
          ? await preparePublicReleaseProducerInTransaction({ firestore, transaction: tx,
              operationId: publishQueueRef?.id ?? publicReleaseProducerOperation(collection, docId, composed.version, composed.published),
              changes: [publicContentChange(collection, docId, composed)] }) : () => {};

        // Atomic write (mirrors roles' audit-inside-the-transaction pattern): the
        // content mutation, the version-history snapshot, and the audit row commit
        // together, so they either all land or none do. A local Firestore write can join
        // the transaction (unlike publish's external dispatch, which can only be preceded
        // by its audit), which closes the window in both directions: no unlogged
        // mutation, and no compliance row claiming a change that never wrote.
        writeReleaseChange();
        if (!noBuildPublication && publishesSnapshot) bumpPublicContextRevision(tx, firestore, {
          homePublication: publishesSnapshot && collection === "cmsPages" && docId === "home",
        });
        datasetUsageWrite();
        tx.set(ref, composed);
        if (templateCreateRef !== null) tx.create(templateCreateRef, { fingerprint: templateCreateFingerprint });
        tx.set(historyRef, historyEntry);
        tx.set(
          workingMediaUsageWrite.ref,
          workingMediaUsageWrite.document,
        );
        if (publishedMediaUsageWrite) {
          tx.set(
            publishedMediaUsageWrite.ref,
            publishedMediaUsageWrite.document,
          );
        }
        if (publishQueueRef && publishQueueAuditRef) {
          const changes = [{
            collection,
            id: docId,
            sourceVersion: composed.published.sourceVersion,
          }];
          if (noBuildPublication) noBuildPublication.write();
          else tx.create(publishQueueRef, {
            status: "pending",
            transport: publicationTransport,
            triggeredBy: user.uid,
            triggeredByEmail: user.email ?? null,
            triggeredAt: FieldValue.serverTimestamp(),
            completedAt: null,
            error: null,
            changes,
            ...(purgeState === undefined ? {} : { routePurge: purgeState }),
          });
          tx.create(
            publishQueueAuditRef,
            withAutomationAudit(adminLogEntryFn({
              actorUid: user.uid,
              actorEmail: user.email ?? null,
              action: "cms.publish",
              target: publishQueueRef.id,
              after: {
                status: "pending",
                transport: publicationTransport,
                ...(noBuildFallback.reason ? { message: noBuildFallback.reason } : {}),
                ...(noBuildPublication ? { affectedHomeSections: noBuildPublication.affectedHomeSections,
                  warnings: noBuildPublication.warnings } : {}),
                changesCount: changes.length,
              },
              source,
            })),
          );

        }
        const contentLinkBefore = { mode: stored?.contentLinkMode ?? "normal", url: stored?.contentLinkUrl ?? "", newTab: stored?.contentLinkNewTab !== false };
        const contentLinkAfter = { mode: composed.contentLinkMode ?? "normal", url: composed.contentLinkUrl ?? "", newTab: composed.contentLinkNewTab !== false };
        const contentLinkChanged = !isDeepStrictEqual(contentLinkBefore, contentLinkAfter);
        tx.set(
          firestore.collection(AUDIT_COLLECTIONS.adminLogs).doc(),
          withAutomationAudit(adminLogEntryFn({
            actorUid: user.uid,
            actorEmail: user.email ?? null,
            action: liveBlogUpdate === true
              ? "cms.live-blog-update"
              : publishesSnapshot
              ? "cms.publish-snapshot"
              : schedulesPublication
                ? "cms.schedule"
                : "cms.save",
            target: `${collection}/${docId}`,
            // Both sides summarize status and block count; only the after side
            // also carries `created`. The row therefore reads as one
            // before-and-after instead of a whole document beside a digest (#538).
            // The full documents live in the version-history row written in this
            // same transaction, so a full `before` here was a second copy of the
            // page that grew the admin-log row in step with it. A legacy shrink
            // repair carries its measured bounded receipt instead.
            before:
              boundedLegacyBefore ??
              (stored
                ? {
                    ...(contentLinkChanged ? { contentLink: contentLinkBefore } : {}),
                    status: stored.status ?? null,
                    blockCount: Array.isArray(stored.blocks)
                      ? stored.blocks.length
                      : 0,
                  }
                : null),
            after: {
              status,
              created: creating,
              ...(contentLinkChanged ? { contentLink: contentLinkAfter } : {}),
              // Count the blocks actually stored, not just the ones this save sent: a
              // metadata-only save carries the stored blocks forward, so the compliance
              // record must reflect the committed after-state, not a misleading zero.
              blockCount: Array.isArray(composed.blocks) ? composed.blocks.length : 0,
            },
            source,
          })),
        );

        const publicationResult = {
          liveBlogPresentationPending,
          isCreate: creating,
          mintedIds,
          publication: publishQueueRef
            ? {
                queueId: publishQueueRef.id,
                dispatched: false,
                status: "pending",
                transport: publicationTransport,
                ...(noBuildFallback.reason ? { message: noBuildFallback.reason } : {}),
                ...(noBuildPublication ? { affectedHomeSections: noBuildPublication.affectedHomeSections,
                  warnings: noBuildPublication.warnings } : {}),
              }
            : null,
        };
        if (noBuildPublication?.transport === "release-pair-publication-v2") {
          if (!pairRequest || noBuildPublication.queueId !== pairRequest.operationId) throw new SaveRejection(409, "Publication request identity changed.");
          pairRequest.write({ historyRef, version: composed.version, metadata: publicationResult });
        }
        return { persisted: composed, ...publicationResult, replayed: false };
      }));
      let saved;
      try {
        saved = await saveTransaction();
      } catch (error) {
        if (error instanceof DryRunResult) {
          saved = error.result;
        } else {
          if (!(error instanceof PublicationReadinessRequired)) throw error;
          // Release the content transaction before readiness can reconcile queue rows.
          // Then re-read and authorize the source and target before saving anything.
          publishReadiness = await assertPublishReadyFn({ firestore });
          publicationReadinessChecked = true;
          saved = await saveTransaction();
        }
      }
      const { persisted, isCreate, mintedIds, replayed, publication } = saved;
      if (publication?.queueId) {
        await attemptPostRoutePurge({ firestore, queueId: publication.queueId, config: purgeConfig, log, ...routePurge });
      }
      if (replayed) {
        // A replay can mean a response was lost after its transaction committed.
        log.info("cmsSaveContent replayed a saved request", {
          collection,
          documentId: docId,
          actorUid: user.uid,
        });
      }
      // A missing or archived reference is editorial guidance, never a save veto.
      // Read after commit so this cannot turn a valid Page/Post save into a failed write.
      const cardWarnings = saved.liveBlogPresentationPending ? [require("./lib/live-blog-compatibility").PRESENTATION_PENDING] : [];
      if (collection === "cmsPages" && docId === "home" && persisted.blocks?.some(block =>
          block.section === "home-newsletter" && block.visible && block.data.newsletterIds.length === 0)) {
        cardWarnings.push("The standard newsletter band appears until a newsletter is chosen.");
      }
      if (collection === "cmsPages" || persisted.type === "post") {
        try {
          const resourceWarning = publishedBlockResourceError(persisted.blocks ?? [], collection === "cmsPages" ? `/${docId}/` : "/posts/");
          if (resourceWarning) cardWarnings.push(resourceWarning);
        } catch (error) {
          log.warn("cmsSaveContent could not check Custom HTML resources", error);
          cardWarnings.push("Custom HTML resources could not be checked. Reopen this content to verify them before publishing.");
        }
        try {
          cardWarnings.push(...await recordCardSaveWarnings(firestore, persisted));
        } catch (error) {
          log.warn("cmsSaveContent could not check record card references", error);
          cardWarnings.push("Record card references could not be checked. Reopen this content to verify them.");
        }
      }
      res.status(200).json({
        success: true,
        ...(dryRun === true ? { dryRun: true } : {}),
        collection,
        id: docId,
        created: isCreate,
        replayed,
        // Which id replaced which, for every minted block whose sent id can name
        // it: an absent, empty, or repeated sent id is left out, because none of
        // those identifies one block (#538). The editor reconciles by position
        // today, which holds only while assignment preserves order; the map does
        // not need that to hold.
        mintedIds,
        document: persisted,
        warnings: cardWarnings,
        ...(publication ? { publication } : {}),
      });
    } catch (err) {
      if (res.headersSent) return;
      const status =
        err?.status || (err?.code === "failed-precondition" ? 503 : 500);
      // A SaveRejection is this handler refusing a request on purpose -- a bad payload,
      // or a lost conflict. Those used to return before reaching this catch, so they were
      // never logged; keep it that way, or the function's error rate becomes a measure of
      // how often editors collide. Everything else still logs exactly as it did.
      if (!(err instanceof SaveRejection)) log.error("cmsSaveContent failed", err);
      res.status(status).json({
        error: err?.message || "Failed to save content",
        ...(isPlainObject(err?.details) ? err.details : {}),
      });
    }
  };
}

const cmsSaveContent = cmsOnRequest(
  { cors: true, secrets: [...publishSecretBindings, ...routePurgeSecretNames()] },
  withCmsSaveWarmup(createCmsSaveHandler({
    enablePublishSnapshot: true,
    assertPublishReadyFn: defaultAssertPublishReady,
  })),
);

module.exports = {
  cmsSaveContent,
  createCmsSaveHandler,
  assignBlockIds,
  uniqueRecordSlug,
  needsCanonicalId,
  SAVE_COLLECTIONS,
  CONTENT_STATUSES,
  TEMP_ID_PREFIX,
  SERVER_OWNED_FIELDS,
};
