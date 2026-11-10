"use strict";

// The content authorization decisions for the CMS record boundaries: the write
// path for cmsSaveContent (#529) and the single-record read path for
// cmsGetContent (#536).
//
// Everything here is pure: the caller resolves the principal from the trusted
// user document (lib/auth.js requirePrincipal), reads the stored record inside
// its own transaction, and passes both in. That keeps the decision testable
// without an emulator and keeps the endpoint free of role-name reasoning.
//
// Two layers, in this order:
//
//   1. The capability layer (lib/rbac.js): may this principal create, or edit
//      this record at all? Ownership and section scope are decided there.
//   2. The lifecycle layer, here: which status transitions does this particular
//      capability set allow? The capability core is deliberately free of any
//      document-state model (#379), so the draft-only gate on own-content
//      editing (#380) and the publish/schedule/unpublish/archive-restoration
//      transition gates live at the endpoint, which is the layer that knows the
//      stored status.
//
// Deny-by-default throughout: an unrecognized shape denies rather than falls
// through to allowed.

const { can, canEditContent, hasCapability } = require("./rbac");
const { contentSectionForPage } = require("./public-page-contract");

// The capabilities that give a principal any business at the save endpoint at
// all. Checked coarsely (scope-aware, ownership-blind) before the transaction so
// a principal with no content authority is refused without a document read.
const CONTENT_WRITE_CAPABILITIES = Object.freeze([
  "content.create",
  "content.edit.any",
  "content.edit.own",
]);

// The status a record must be in for own-content authority to allow an edit
// (#380). A contributor is "draft and propose only": they may work and submit
// their own draft, and lose edit authority once it leaves draft for review.
const OWN_EDIT_STATUS = "draft";

// A single denial shape, so the endpoint maps every refusal the same way. The
// `reason` is for the server log; the endpoint decides what the client sees.
function deny(reason) {
  return { allowed: false, reason };
}

const ALLOWED = Object.freeze({ allowed: true, reason: null });

/**
 * Could this principal ever write content? Coarse pre-check for the endpoint, so
 * an unauthorized caller is refused before the transaction reads a document.
 * Passing here does not authorize any particular save.
 */
function mayReachContentWrite(principal) {
  return CONTENT_WRITE_CAPABILITIES.some((capability) =>
    hasCapability(principal, capability),
  );
}

/**
 * The save decision.
 *
 * @param {{id?: string, grants: ReadonlyArray<object>}} principal resolved server-side
 * @param {object} action
 * @param {boolean} action.creating whether this save creates the record
 * @param {boolean} action.publishing whether this save is an explicit publish
 * @param {string|null|undefined} action.storedStatus the status the record holds now
 * @param {string} action.nextStatus the status the save would commit
 * @param {{ownerId?: string, section?: string}} [action.resource] the stored record
 * @returns {{allowed: boolean, reason: string|null}}
 */
function authorizeContentWrite(principal, action) {
  // A malformed action is a caller bug, and the transition gates below read as
  // "no transition" when the statuses are missing -- which would quietly widen
  // authority instead of failing. Refuse it here, where the failure is visible.
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    return deny("the authorization request is missing");
  }
  const { creating, publishing, storedStatus, nextStatus, resource = {} } = action;
  if (
    typeof creating !== "boolean" ||
    typeof publishing !== "boolean" ||
    typeof nextStatus !== "string"
  ) {
    return deny("the authorization request does not state the save it describes");
  }

  if (resource.unassignedDraft === true && (publishing || nextStatus !== "draft")) {
    return deny("Choose a section before moving this draft toward publication");
  }

  const publishesSavedVersion =
    publishing || (nextStatus === "published" && storedStatus !== "published");

  if (creating) {
    if (!can(principal, "content.create", resource)) {
      return deny("content.create is required to create a record");
    }
  } else if (!can(principal, "content.edit.any", resource)) {
    // Own-content authority is the fallback, and it carries the lifecycle gate:
    // it covers a record the principal owns while that record is still a draft.
    if (!can(principal, "content.edit.own", resource)) {
      return deny("content.edit.any or ownership of this record is required");
    }
    if (storedStatus !== OWN_EDIT_STATUS && !publishesSavedVersion) {
      return deny(
        `own-content editing covers a ${OWN_EDIT_STATUS} record; this record is ${String(storedStatus)}`,
      );
    }
  }

  // Editing and publishing are separate grants. Owners may submit drafts, but
  // only a publisher for this section can make a saved version public. The one
  // exception is a direct live blog update to an existing published Post: Editor
  // access (content.edit.any) may publish its entries and coverage state. The save
  // boundary refuses any other change in that request.
  if (publishesSavedVersion) {
    const liveBlogUpdate = action.liveBlogUpdate === true && !creating;
    if (!can(principal, liveBlogUpdate ? "content.edit.any" : "content.publish", resource)) {
      return deny(liveBlogUpdate
        ? "content.edit.any is required to publish a live blog update"
        : "content.publish is required to publish a record");
    }
  }

  // Entering scheduled. A scheduled record publishes later with nobody present,
  // so scheduling is a publish decision taken in advance and takes the same
  // capability. Gating only the publish transition would leave this path open.
  if (nextStatus === "scheduled" && storedStatus !== "scheduled") {
    if (!can(principal, "content.publish", resource)) {
      return deny("content.publish is required to schedule a record");
    }
  }

  // Leaving published. Taking live content down is its own capability, not a
  // side effect of being able to edit.
  if (storedStatus === "published" && nextStatus !== "published" &&
      !(action.revisingPublished === true && nextStatus === "draft")) {
    if (!can(principal, "content.unpublish", resource)) {
      return deny("content.unpublish is required to take a record off the site");
    }
  }

  // Archiving an existing record is an administrator action. A first save can
  // materialize an already-archived legacy seed, but contributors must not use a
  // client-supplied status to create directly into archived. Preserve the existing
  // editor-level unpublish boundary for that one create path.
  if (nextStatus === "archived" && storedStatus !== "archived") {
    const archiveCapability = creating ? "content.unpublish" : "content.delete";
    if (!can(principal, archiveCapability, resource)) {
      return deny(`${archiveCapability} is required to archive a record`);
    }
  }

  // Restoring reverses that administrator decision and uses the same authority.
  if (storedStatus === "archived" && nextStatus !== "archived") {
    if (!can(principal, "content.delete", resource)) {
      return deny("content.delete is required to restore an archived record");
    }
  }

  if (resource.homePage === true && !can(principal, "content.edit.any", resource)) {
    return deny("Home requires content.edit.any in the Station area");
  }

  return ALLOWED;
}

// Shared content.view admits record reads without authoring authority. Legacy
// authoring capabilities keep their record scope. Check before the document read.
const CONTENT_READ_CAPABILITIES = Object.freeze(["content.view", ...CONTENT_WRITE_CAPABILITIES]);

/**
 * Could this principal ever read a content record for editing? Coarse pre-check,
 * so an unauthorized caller is refused before the endpoint reads a document.
 * Passing here does not authorize reading any particular record.
 */
function mayReachContentRead(principal) {
  return CONTENT_READ_CAPABILITIES.some((capability) =>
    hasCapability(principal, capability),
  );
}

/**
 * May this principal receive an honest not-found answer for an addressed
 * record? Site-wide edit authority already exposes the complete active record
 * set through cmsListContent, so found:false adds no existence oracle for that
 * tier. Own-content and section-scoped authority stay fail-closed because an
 * absent record has no owner or section against which to resolve their scope.
 */
function mayAnswerAbsentRecordRead(principal) {
  return can(principal, "content.view", {}) || can(principal, "content.edit.any", {});
}

/**
 * The single-record read decision (#536).
 *
 * The read exists to hydrate an edit: a save sends the whole block list, so the
 * editor has to start from the stored composition or a save from a blank editor
 * would overwrite the live page (#515). That makes the read authorization
 * question "may this principal edit this record", answered by the same
 * capability layer the save uses. The two boundaries can still differ, but only
 * where this function says so: sharing the capability layer is what stops them
 * differing by accident, when one side's role handling is changed and the
 * other's is not.
 *
 * Two deliberate differences from authorizeContentWrite:
 *
 *   - No lifecycle gate. The draft-only rule on own-content authority (#380)
 *     bounds what a contributor may change, not what they may see. A contributor
 *     whose own record has moved on to review keeps the read and loses the
 *     write, so the thing they submitted stays visible to them.
 *   - An absent record is authorized as a create. A never-saved page opens an
 *     empty editor whose first save creates it, so the person who may create it
 *     is the person who may open it.
 *
 * Section scope resolves exactly as it does on the write path: the caller states
 * the stored document's desk through `contentResourceSection`, and a document
 * that carries none -- a legacy record written before the registry, a legacy
 * template singleton -- still authorizes nothing for a scoped grant rather than
 * being widened to site-wide (#845).
 *
 * @param {{id?: string, grants: ReadonlyArray<object>}} principal resolved server-side
 * @param {object} action
 * @param {boolean} action.exists whether the record is stored
 * @param {{ownerId?: string, section?: string}} [action.resource] the stored record
 * @returns {{allowed: boolean, reason: string|null}}
 */
function authorizeContentRead(principal, action) {
  // Same reason as the write decision: a malformed action would otherwise read
  // as "an absent record with no owner", which is a weaker check than intended.
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    return deny("the authorization request is missing");
  }
  const { exists, resource = {} } = action;
  if (typeof exists !== "boolean") {
    return deny("the authorization request does not state whether the record exists");
  }

  if (!exists) {
    if (!can(principal, "content.create", resource)) {
      return deny("content.create is required to open a record that does not exist");
    }
    return ALLOWED;
  }

  if (!can(principal, "content.view") && !canEditContent(principal, resource)) {
    return deny("Shared content read access or permission to edit this record is required");
  }

  return ALLOWED;
}

// A stored `section` is only a desk when it is a plain non-empty id. A malformed
// value (a number, an object, a padded string a registry id could never match)
// resolves to no section at all, which denies every scoped grant rather than
// being compared loosely against one.
function storedSection(stored) {
  const value = stored?.section;
  if (typeof value !== "string") return undefined;
  return value.trim() === "" || value.trim() !== value ? undefined : value;
}

/**
 * The editorial desk an authorization decision is made against (#845).
 *
 * One resolver for every content boundary, because the read and the write must
 * agree about which desk a document sits in: if they could disagree, a scoped
 * editor could open a record they cannot save, or worse, save one they could not
 * open. The rules follow how the section is stored (#619):
 *
 *   - A canonical page's desk is server-owned and recomputed from the public-page
 *     registry on every save, so the registry answers first. A stored section is
 *     the fallback only for a page id that has since left the registry, which
 *     keeps that page reachable by the desk it actually carries instead of
 *     silently becoming unsectioned between the read and its next save.
 *   - A record's desk is fixed at create, so the stored value is the answer. On a
 *     record create there is no stored document, and the desk the request asks
 *     for is the one the record will be created into -- so that is what the
 *     create is authorized against. The save transaction still checks it against
 *     the runtime registry before committing, so an unregistered desk cannot be
 *     created into even when a grant names it.
 *
 * `undefined` is the closed answer, not a hole: rbac.js denies every scoped grant
 * on a resource with no stated section.
 */
function contentResourceSection({
  collection,
  documentId,
  stored,
  requestedSection,
} = {}) {
  if (collection === "cmsPages" && contentSectionForPage(documentId)) {
    return contentSectionForPage(documentId);
  }
  if (stored === null || stored === undefined) {
    return typeof requestedSection === "string" ? requestedSection : undefined;
  }
  return storedSection(stored);
}

// Only a server-created post draft can use the owner-only unassigned state.
function isUnassignedPostDraft(stored) {
  return stored?.type === "post" && stored.status === "draft" &&
    stored.unassignedDraft === true && stored.section === undefined &&
    stored.published === undefined && stored.deleted !== true;
}

function contentResource({ collection, documentId, stored, requestedSection } = {}) {
  return {
    ownerId: stored?.createdBy,
    ...(collection === "cmsPages" && documentId === "home" ? { homePage: true } : {}),
    section: contentResourceSection({ collection, documentId, stored, requestedSection }),
    ...(collection === "cmsPosts" && isUnassignedPostDraft(stored)
      ? { unassignedDraft: true } : {}),
  };
}

/**
 * May this principal read any content record at all? The list boundary's coarse
 * pre-check, so a caller who could never be shown a row is refused before the
 * collection is read.
 *
 * Deliberately not "may this principal read an unsectioned record" (#194). That
 * question was the right one only while no record carried a desk: now that they
 * do, asking it would refuse the whole endpoint to a correctly scoped editor
 * whose records all sit inside their grant, and the scoped grant this whole
 * feature exists to honor would list nothing.
 *
 * It stays a real authorization question rather than a capability count: every
 * answer comes from `authorizeContentRead` itself, asked about resource shapes
 * this principal could actually be handed -- an unsectioned record they own, and
 * a record in each desk their own grants name. Nothing here decides access on its
 * own, so it cannot widen past the per-record filter that follows it. A
 * site-wide grant passes on the first question, a scoped grant on the second, and
 * a malformed grant (`sections` present but empty or not an array) passes
 * neither, because rbac.js confers nothing for it.
 */
function mayReadSomeContentRecord(principal) {
  const ownerId = principal?.id;
  if (
    authorizeContentRead(principal, { exists: true, resource: { ownerId } })
      .allowed
  ) {
    return true;
  }
  const grants = Array.isArray(principal?.grants) ? principal.grants : [];
  return grants.some(
    (grant) =>
      Array.isArray(grant?.sections) &&
      grant.sections.some(
        (section) =>
          authorizeContentRead(principal, {
            exists: true,
            resource: { ownerId, section },
          }).allowed,
      ),
  );
}

module.exports = {
  contentResource,
  isUnassignedPostDraft,
  CONTENT_READ_CAPABILITIES,
  contentResourceSection,
  mayReadSomeContentRecord,
  CONTENT_WRITE_CAPABILITIES,
  OWN_EDIT_STATUS,
  authorizeContentRead,
  mayAnswerAbsentRecordRead,
  mayReachContentRead,
  mayReachContentWrite,
  authorizeContentWrite,
};
