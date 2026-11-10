"use strict";

// Versioned self and admin APIs for the author/staff/profile foundation
// (issue #1044, lane 1). Seven HTTPS callables behind the CMS edge:
//
//   cmsGetAuthorProfile          self   read (and verify-or-create) own profile
//   cmsUpdateAuthorProfile       self   edit own working profile
//   cmsSetAuthorProfileVisibility self  owner Publish / Unpublish
//   cmsListBylineAuthors         staff  the byline picker's feed (#1040)
//   cmsListAuthorPagePosts       self/admin  published Posts by stable authorId
//   cmsListAuthorProfiles        admin  list every profile and linkable user
//   cmsAdminUpdateAuthorProfile  admin  create and manage profile lifecycles
//
// Authorization follows the repo's capability model rather than role names.
// Self editing and withdrawal require content.create. Self publication also
// requires content.edit.any (editor tier and above). The admin endpoints require
// profiles.manage, so administrators can publish a contributor's profile.
//
// Ownership is never taken from the request. Every self call resolves the
// profile from the verified uid, so a caller cannot address someone else's
// profile by naming its authorId.

const { randomBytes } = require("node:crypto");
const logger = require("firebase-functions/logger");
const { cmsOnRequest } = require("./lib/cms-edge");
const { db } = require("./lib/firebase");
const { requirePrincipal, ForbiddenError } = require("./lib/auth");
const { can } = require("./lib/rbac");
const contract = require("./lib/author-profile-contract");
const store = require("./lib/author-profile-store");
const pagePosts = require("./lib/author-page-posts");
const { admittedMediaThumbnails } = require("./lib/media-library");

const { AUTHOR_PROFILE_API_VERSION } = contract;
const { AuthorProfileError } = store;

/** The capability an admin action on someone else's profile requires. */
const ADMIN_CAPABILITY = store.ADMIN_PROFILE_CAPABILITY;

function getClientIp(req) {
  return ( req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || null
  );
}

function nowIso() {
  return new Date().toISOString();
}

function freshAuthorEntropy() {
  return randomBytes(16).toString("hex");
}

/**
 * The self view of a working profile. Built field by field for the same reason
 * the public snapshot is: the response goes over the wire, so it should carry
 * what the editor needs and nothing that happens to be stored beside it.
 */
/**
 * The photograph as the editor sees it: the reference, the crop, the rendering
 * facts, and the rights basis the form has to show back. `attestedBy` is left
 * out -- it is a uid, the audit row already records who attested, and a byline
 * editor has no use for another account's identifier.
 */
function profilePhotoView(photo) {
  if (!photo || typeof photo !== "object") return null;
  const thumbnails = admittedMediaThumbnails(photo.thumbnails);
  return {
    assetId: photo.assetId,
    url: photo.url,
    mimeType: photo.mimeType,
    width: photo.width,
    height: photo.height,
    sizeBytes: photo.sizeBytes,
    focalX: photo.focalX,
    focalY: photo.focalY,
    credit: photo.credit ?? null,
    rightsBasis: photo.rightsBasis,
    attestedAt: photo.attestedAt,
    ...(thumbnails.length ? { thumbnails } : {}),
  };
}

function selfProfileView(profile, staffStatus) {
  return {
    authorId: profile.authorId,
    displayName: profile.displayName,
    jobTitle: profile.jobTitle ?? null,
    bio: profile.bio ?? null,
    photo: profilePhotoView(profile.photo ?? null),
    links: profile.links ?? {},
    pinnedPostId: profile.pinnedPostId ?? null,
    hiddenPostIds: profile.hiddenPostIds ?? [],
    visibility: profile.visibility,
    slug: profile.slug ?? null,
    previousSlugs: profile.previousSlugs ?? [],
    publishedAt: profile.publishedAt ?? null,
    withdrawnAt: profile.withdrawnAt ?? null,
    withdrawnReason: profile.withdrawnReason ?? null,
    version: profile.version,
    updatedAt: profile.updatedAt,
    staffStatus,
    publicPath: contract.isValidAuthorSlug(profile.slug)
      ? contract.authorPublicPath(profile.slug)
      : null,
  };
}

/**
 * The admin view. It adds the owning uid, because account-to-author linkage is
 * the whole point of an admin profile list, and it still omits email: an admin
 * managing a byline does not need the address, and the roster UI already has a
 * capability-gated place to see it.
 */
function adminProfileView(profile) {
  return { ...selfProfileView(profile, null), uid: profile.uid ?? null,
    lifecycle: profile.lifecycle === "archived" ? "archived" : "active",
    archivedAt: profile.archivedAt ?? null, };
}

function respond(res, status, body) {
  res.status(status).json(body);
}

/**
 * One error shape for every endpoint in this module. A validation failure returns the whole
 * error list rather than only the first, so the profile form can mark every bad
 * field at once instead of making the author fix them one request at a time.
 */
function sendError(res, error, log, endpoint) {
  if (res.headersSent) return;
  const status = typeof error?.status === "number" ? error.status : 500;
  if (status >= 500) log.error(`${endpoint} failed`, error);
  respond(res, status, {
    apiVersion: AUTHOR_PROFILE_API_VERSION,
    error: status < 500 ? error.message : "Author profile request failed",
    ...(status < 500 && typeof error?.code === "string"
      ? { code: error.code }
      : {}),
    ...(Array.isArray(error?.errors) ? { errors: error.errors } : {}),
  });
}

function requirePost(req, res) {
  if (req.method !== "POST") {
    respond(res, 405, {
      apiVersion: AUTHOR_PROFILE_API_VERSION,
      error: "Method not allowed",
    });
    return false;
  }
  return true;
}

function requireAdminCapability(caller) {
  if (!can(caller.principal, ADMIN_CAPABILITY)) {
    throw new ForbiddenError(
      "Managing another author profile requires admin access",
    );
  }
}

/**
 * Resolve the caller's own profile, creating the staff record and private
 * profile on first use. Every self endpoint goes through here, so a staff member
 * approved before this foundation existed gets their linkage minted the first
 * time they open their profile rather than needing the backfill to have run.
 */
/**
 * Deny-by-default admission for an endpoint that has no capability to check.
 *
 * `requirePrincipal` answers "which Firebase account is this", not "may this
 * account use the CMS": a token minted for any account in the project resolves
 * to a principal with an empty grant list rather than to a refusal, and an
 * endpoint that reads nothing off the principal would therefore serve it. Every
 * other endpoint here is saved by a capability check or by
 * `ensureAuthorIdentity`, which refuses an unapproved or deactivated account
 * inside its own transaction. An endpoint that does neither has to make the same
 * check itself, against the same authority -- `users/{uid}` -- and before it
 * reads anything it would otherwise return.
 */
async function requireActiveAccount(firestore, uid) {
  const snapshot = await firestore.collection("users").doc(uid).get();
  if (!snapshot.exists) {
    throw new AuthorProfileError(
      403,
      "Account approval required",
      "approval_required",
    );
  }
  if (store.staffStatusFromUserDoc(snapshot.data()) !== "active") {
    throw new AuthorProfileError(
      403,
      "This CMS account is deactivated",
      "account_inactive",
    );
  }
}

async function resolveSelf(firestore, caller, req) {
  return store.ensureAuthorIdentity({
    firestore,
    uid: caller.uid,
    email: caller.email,
    displayName: caller.displayName,
    nowIso: nowIso(),
    actorUid: caller.uid,
    actorEmail: caller.email ?? null,
    source: getClientIp(req),
    randomHex: freshAuthorEntropy(),
    requireAuthoringAccess: true,
  });
}

// -- self endpoints ----------------------------------------------------------

function createGetAuthorProfileHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    log = logger,
  } = deps;

  return async (req, res) => {
    if (!requirePost(req, res)) return;
    try {
      const caller = await requirePrincipalFn(req);
      const { profile, staffStatus, created } = await resolveSelf(
        firestore,
        caller,
        req,
      );
      respond(res, 200, {
        apiVersion: AUTHOR_PROFILE_API_VERSION,
        success: true,
        created,
        profile: selfProfileView(profile, staffStatus),
      });
    } catch (error) {
      sendError(res, error, log, "cmsGetAuthorProfile");
    }
  };
}

function createUpdateAuthorProfileHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    log = logger,
  } = deps;

  return async (req, res) => {
    if (!requirePost(req, res)) return;
    try {
      const caller = await requirePrincipalFn(req);
      const { profile, staffStatus } = await resolveSelf(
        firestore,
        caller,
        req,
      );
      const body = req.body ?? {};
      const { profile: updated } = await store.updateWorkingProfile({
        firestore,
        authorId: profile.authorId,
        patch: {
          displayName: body.displayName,
          jobTitle: body.jobTitle,
          bio: body.bio,
          photo: body.photo,
          links: body.links,
          // Author-page controls. An author curates their OWN page only, which
          // is exactly what this endpoint is scoped to: it resolves the caller's
          // own profile and can address no other.
          pinnedPostId: body.pinnedPostId,
          hiddenPostIds: body.hiddenPostIds,
        },
        // Self-service: a newly attached photograph has to be one this caller
        // uploaded. Their own already-attached photograph still passes, so a
        // photograph an admin set for them survives their next save.
        requireAssetOwnerUid: caller.uid,
        expectedVersion: body.expectedVersion,
        nowIso: nowIso(),
        actorUid: caller.uid,
        actorEmail: caller.email ?? null,
        source: getClientIp(req),
      });
      respond(res, 200, {
        apiVersion: AUTHOR_PROFILE_API_VERSION,
        success: true,
        profile: selfProfileView(updated, staffStatus),
      });
    } catch (error) {
      sendError(res, error, log, "cmsUpdateAuthorProfile");
    }
  };
}

/**
 * Self Publish and Unpublish. Publishing requires editor-tier authority;
 * contributors retain withdrawal. The store rechecks current authority and
 * validation in the publication transaction rather than trusting the form.
 */
function createSetAuthorProfileVisibilityHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    log = logger,
  } = deps;

  return async (req, res) => {
    if (!requirePost(req, res)) return;
    try {
      const caller = await requirePrincipalFn(req);
      const visibility = req.body?.visibility;
      if (visibility !== "published" && visibility !== "private") {
        throw new AuthorProfileError(
          400,
          'visibility must be "published" or "private"',
        );
      }
      const { profile, staffStatus } = await resolveSelf(
        firestore,
        caller,
        req,
      );
      const common = {
        firestore,
        authorId: profile.authorId,
        expectedVersion: req.body?.expectedVersion,
        nowIso: nowIso(),
        actorUid: caller.uid,
        actorEmail: caller.email ?? null,
        source: getClientIp(req),
      };
      const result =
        visibility === "published"
          ? await store.publishProfile({ ...common, requireSelfPublishAccess: true })
          : await store.withdrawProfile({ ...common, reason: "owner" });

      respond(res, 200, {
        apiVersion: AUTHOR_PROFILE_API_VERSION,
        success: true,
        profile: selfProfileView(result.profile, staffStatus),
      });
    } catch (error) {
      sendError(res, error, log, "cmsSetAuthorProfileVisibility");
    }
  };
}

/**
 * The byline picker's feed (#1040): every active author identity an editor may
 * credit, plus the caller's own identity when they have an active one.
 *
 * Needs no capability beyond an approved, active CMS account: crediting a
 * colleague is ordinary staff work, and gating it on `profiles.manage` would mean
 * only admins could spell a byline. It exposes names, opaque ids and boolean
 * profile-completeness facts, never uids, emails, bio text or photo addresses.
 *
 * "No capability" is not "no admission". This endpoint makes the active-account
 * check itself through `requireActiveAccount`.
 *
 * `selfAuthorId` is read, never created. An account with no linked identity gets
 * null and its new posts start with no byline, which is the defaulting rule
 * (#1040): a missing byline is a visible gap an editor fills, while a guessed
 * one looks finished and ships.
 */
function createListBylineAuthorsHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    log = logger,
  } = deps;

  return async (req, res) => {
    if (!requirePost(req, res)) return;
    try {
      const caller = await requirePrincipalFn(req);
      // The staff directory is people data -- names, job titles, and the opaque
      // ids that join them to bylines -- so it is read only after the caller is
      // shown to hold an approved, active CMS account. Checked before the list is
      // read, not filtered out of the response afterwards.
      await requireActiveAccount(firestore, caller.uid);
      const [{ authors, nextCursor }, self] = await Promise.all([
        store.listBylineAuthors({
          firestore,
          limit: req.body?.limit,
          startAfter: req.body?.startAfter ?? null,
        }),
        store.readProfileByUid({ firestore, uid: caller.uid }),
      ]);
      respond(res, 200, {
        apiVersion: AUTHOR_PROFILE_API_VERSION,
        success: true,
        authors,
        nextCursor,
        selfAuthorId:
          self &&
          self.staff.status === "active" &&
          self.profile.lifecycle !== "archived"
            ? self.staff.authorId
            : null,
      });
    } catch (error) {
      sendError(res, error, log, "cmsListBylineAuthors");
    }
  };
}


/**
 * Published Post summaries for the author-page pin/hide picker (#1097).
 *
 * This is deliberately separate from cmsListContent. Editorial read scope and
 * author-page membership answer different questions: a reporter can be credited
 * on another desk's Post even when they cannot edit that desk's record. Ordinary
 * staff can address only their own stable authorId; profiles.manage may address any
 * author for the administrator profile editor.
 */
function createListAuthorPagePostsHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    log = logger,
  } = deps;

  return async (req, res) => {
    if (!requirePost(req, res)) return;
    try {
      const caller = await requirePrincipalFn(req);
      await requireActiveAccount(firestore, caller.uid);

      const requestedAuthorId = req.body?.authorId;
      const mayManageAuthors = can(caller.principal, ADMIN_CAPABILITY);
      const self = await store.readProfileByUid({
        firestore,
        uid: caller.uid,
      });
      const selfAuthorId =
        self && self.staff.status === "active" ? self.staff.authorId : null;
      const authorId =
        requestedAuthorId === undefined ? selfAuthorId : requestedAuthorId;

      if (!contract.isAuthorId(authorId)) {
        throw new AuthorProfileError(
          400,
          "A valid authorId is required",
          "invalid_author_id",
        );
      }
      if (!mayManageAuthors && authorId !== selfAuthorId) {
        throw new ForbiddenError(
          "Authors may curate only their own public author page",
        );
      }

      const { posts, nextCursor } = await pagePosts.listAuthorPagePosts({
        firestore,
        authorId,
        limit: req.body?.limit,
        startAfter: req.body?.startAfter ?? null,
      });
      respond(res, 200, {
        apiVersion: AUTHOR_PROFILE_API_VERSION,
        success: true,
        posts,
        nextCursor,
      });
    } catch (error) {
      sendError(res, error, log, "cmsListAuthorPagePosts");
    }
  };
}

// -- admin endpoints ---------------------------------------------------------

function createListAuthorProfilesHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    log = logger,
  } = deps;

  return async (req, res) => {
    if (!requirePost(req, res)) return;
    try {
      const caller = await requirePrincipalFn(req);
      requireAdminCapability(caller);
      const [{ profiles, nextCursor }, linkableUsers] = await Promise.all([
        store.listAuthorProfiles({
          firestore,
          limit: req.body?.limit,
          startAfter: req.body?.startAfter ?? null,
          authorId: req.body?.authorId,
        }),
        store.listLinkableUsers({ firestore }),
      ]);
      // Recheck after the reads so a revoked caller receives no private roster.
      await store.assertProfileAdmin(firestore, caller.uid);
      respond(res, 200, {
        apiVersion: AUTHOR_PROFILE_API_VERSION,
        success: true,
        profiles: profiles.map(adminProfileView),
        linkableUsers,
        nextCursor,
      });
    } catch (error) {
      sendError(res, error, log, "cmsListAuthorProfiles");
    }
  };
}

/**
 * Admin creation and lifecycle management over every profile. One endpoint keeps
 * the authority -- an admin acting on
 * someone else's profile -- and splitting them would invite a future caller to
 * find the one with the weakest check.
 *
 * None of them touches RBAC. Withdrawing a public profile is a publishing
 * decision, not an access decision, so a withdrawn author keeps every CMS grant
 * they had.
 */
function createAdminUpdateAuthorProfileHandler(deps = {}) {
  const {
    firestore = db,
    requirePrincipalFn = requirePrincipal,
    log = logger,
  } = deps;

  return async (req, res) => {
    if (!requirePost(req, res)) return;
    try {
      const caller = await requirePrincipalFn(req);
      requireAdminCapability(caller);

      const body = req.body ?? {};
      const authorId = body.authorId;
      if (body.action !== "create" && !contract.isAuthorId(authorId)) {
        throw new AuthorProfileError(400, "A valid authorId is required");
      }
      const common = {
        firestore,
        authorId,
        expectedVersion: body.expectedVersion,
        nowIso: nowIso(),
        actorUid: caller.uid,
        // Each store transaction reads this actor again, including on retries.
        requireAdminAccess: true,
        actorEmail: caller.email ?? null,
        source: getClientIp(req),
      };

      let result;
      switch (body.action) {
        case "create":
          result = await store.createManagedProfile({
            firestore,
            displayName: body.displayName,
            nowIso: common.nowIso,
            actorUid: caller.uid,
            requireAdminAccess: true,
            actorEmail: caller.email ?? null,
            source: common.source,
            randomHex: freshAuthorEntropy(),
          });
          break;
        case "edit":
          result = await store.updateWorkingProfile({
            ...common,
            patch: {
              displayName: body.displayName,
              jobTitle: body.jobTitle,
              bio: body.bio,
              photo: body.photo,
              links: body.links,
              pinnedPostId: body.pinnedPostId,
              hiddenPostIds: body.hiddenPostIds,
            },
            // An admin may attach any staff-profile photograph, including one
            // they uploaded on someone else's behalf. The category check still
            // applies, so this is not a way into the rest of the library.
            requireAssetOwnerUid: null,
            auditAction: store.AUDIT_ACTIONS.adminUpdate,
          });
          break;
        case "withdraw":
          result = await store.withdrawProfile({ ...common, reason: "admin" });
          break;
        case "publish":
          result = await store.publishProfile(common);
          break;
        case "link":
          result = await store.linkProfileToUser({ ...common, uid: body.uid });
          break;
        case "archive":
          result = await store.archiveProfile(common);
          break;
        case "delete":
          result = await store.deleteDraftProfile(common);
          break;
        case "rename":
          result = await store.renameProfileSlug({
            ...common,
            slug: body.slug,
          });
          break;
        default:
          throw new AuthorProfileError(
            400,
            'action must be "create", "edit", "publish", "withdraw", "rename", "link", "archive", or "delete"',
          );
      }

      respond(res, 200, {
        apiVersion: AUTHOR_PROFILE_API_VERSION,
        success: true,
        ...(result.profile
          ? { profile: adminProfileView(result.profile) }
          : { deletedAuthorId: result.authorId }),
      });
    } catch (error) {
      sendError(res, error, log, "cmsAdminUpdateAuthorProfile");
    }
  };
}

const cmsGetAuthorProfile = cmsOnRequest(
  { cors: true },
  createGetAuthorProfileHandler(),
);
const cmsUpdateAuthorProfile = cmsOnRequest(
  { cors: true },
  createUpdateAuthorProfileHandler(),
);
const cmsSetAuthorProfileVisibility = cmsOnRequest(
  { cors: true },
  createSetAuthorProfileVisibilityHandler(),
);
const cmsListBylineAuthors = cmsOnRequest(
  { cors: true, minInstances: 1, cpu: 1, concurrency: 80 },
  createListBylineAuthorsHandler(),
);
const cmsListAuthorPagePosts = cmsOnRequest(
  { cors: true },
  createListAuthorPagePostsHandler(),
);
const cmsListAuthorProfiles = cmsOnRequest(
  { cors: true },
  createListAuthorProfilesHandler(),
);
const cmsAdminUpdateAuthorProfile = cmsOnRequest(
  { cors: true },
  createAdminUpdateAuthorProfileHandler(),
);

module.exports = {
  ADMIN_CAPABILITY,
  adminProfileView,
  cmsAdminUpdateAuthorProfile,
  cmsGetAuthorProfile,
  cmsListAuthorProfiles,
  cmsListAuthorPagePosts,
  cmsListBylineAuthors,
  cmsSetAuthorProfileVisibility,
  cmsUpdateAuthorProfile,
  createAdminUpdateAuthorProfileHandler,
  createGetAuthorProfileHandler,
  createListAuthorProfilesHandler,
  createListAuthorPagePostsHandler,
  createListBylineAuthorsHandler,
  createSetAuthorProfileVisibilityHandler,
  createUpdateAuthorProfileHandler,
  profilePhotoView,
  selfProfileView,
};
