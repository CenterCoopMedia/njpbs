"use strict";

const { preparePublicReleaseProducerInTransaction, publicReleaseProducerOperation } = require("./public-release-producer");

// Transactional storage for the author/staff/profile foundation (issue #1044,
// lane 1). Every function here takes its Firestore client, clock, and entropy as
// arguments so the callable boundary stays thin and the emulator suite can drive
// the real transactions directly.
//
// Two invariants this module exists to hold:
//
//   1. A public snapshot is only ever written by `toPublicAuthorSnapshot`, and
//      it is deleted in the same transaction that takes a profile private. There
//      is no code path that updates the public document field by field, so the
//      public surface cannot drift away from the redaction contract.
//   2. Every mutation writes an admin_logs row inside the same transaction as
//      the change it describes. A missing audit row is a compliance defect
//      (#196), so the audit write cannot be skipped by an early return or lost
//      to a partial failure.

const { bumpPublicContextRevision } = require("./public-context-revision");
const { FieldPath } = require("firebase-admin/firestore");
const { adminLogEntry } = require("./audit");
const { mediaUsageDocument } = require("./media-usage");
const {
  DIRECTORY_COLLECTION,
  SELF_COLLECTION,
  syncBylineProjection,
  profileReadiness,
} = require("./byline-projection");
const { principalFromStoredUserDoc } = require("./principal");
const { hasCapability } = require("./rbac");
const contract = require("./author-profile-contract");
const { mediaAssetSummary } = require("./media-library");
const { mediaReplacementRef } = require("./media-replacement");
const {
  CmsPublicationRuntimeControlError,
  assertCmsPublicationAdmissionInTransaction,
} = require("./cms-publication-runtime-control");

const AUTHOR_PROFILE_CAPABILITY = "content.create";
const ADMIN_PROFILE_CAPABILITY = "profiles.manage";

const {
  AUTHOR_PROFILE_COLLECTIONS,
  applyAuthorProfileEdit,
  checkAuthorPhotoAsset,
  checkAuthorProfilePublishReadiness,
  composeAuthorPhoto,
  normalizeAuthorPhotoRequest,
  isAuthorId,
  isValidAuthorSlug,
  mintAuthorId,
  newAuthorWorkingProfile,
  publishAuthorProfile,
  renameAuthorSlug,
  resolveAuthorSlug,
  slugifyAuthorName,
  toPublicAuthorSnapshot,
  validateAuthorProfileDraft,
  withdrawAuthorProfile,
} = contract;

/** Slug index states. A retired slug stays claimed so it can redirect. */
const SLUG_STATE = Object.freeze({ active: "active", retired: "retired" });

const AUDIT_ACTIONS = Object.freeze({
  create: "author_profile.create",
  update: "author_profile.update",
  publish: "author_profile.publish",
  unpublish: "author_profile.unpublish",
  adminUpdate: "author_profile.admin_update",
  resync: "author_profile.staff_resync",
  withdraw: "author_profile.withdraw",
  rename: "author_profile.slug_rename",
  link: "author_profile.account_link",
  archive: "author_profile.archive",
  delete: "author_profile.delete_draft",
  backfill: "author_profile.backfill",
  // A photograph of a real person is its own audited event, separate from the
  // edit that carried it: "who put this face on the site, under what rights
  // basis, and when was it taken down" has to be answerable without diffing
  // profile versions.
  photoAttach: "author_profile.photo_attach",
  photoRemove: "author_profile.photo_remove",
});

/** The media collection a profile photograph is resolved against. */
const MEDIA_ASSETS_COLLECTION = "media_assets";

// Older photographs were stored with only the original address. A later save or
// publish copies the library thumbnails onto the profile so the public snapshot
// can render a portrait without reading the media library again.
async function profileWithLibraryThumbnails(transaction, firestore, profile) {
  const photo = profile?.photo;
  if (!photo || typeof photo.assetId !== "string") return profile;
  if (Array.isArray(photo.thumbnails) && photo.thumbnails.length > 0) return profile;
  const snapshot = await transaction.get(
    firestore.collection(MEDIA_ASSETS_COLLECTION).doc(photo.assetId),
  );
  if (!snapshot.exists) return profile;
  const summary = mediaAssetSummary(snapshot.id, snapshot.data());
  // A replaced binary keeps the asset id and changes the address. Thumbnails
  // from that replacement are a different photograph and were not attested.
  if (
    !summary?.thumbnails?.length ||
    summary.url !== photo.url ||
    summary.mimeType !== photo.mimeType ||
    summary.width !== photo.width ||
    summary.height !== photo.height
  ) return profile;
  return { ...profile, photo: { ...photo, thumbnails: summary.thumbnails } };
}

class AuthorProfileError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.name = "AuthorProfileError";
    this.status = status;
    if (code) this.code = code;
  }
}

function refs(firestore) {
  return {
    users: firestore.collection("users"),
    staff: firestore.collection(AUTHOR_PROFILE_COLLECTIONS.staffRecords),
    profiles: firestore.collection(AUTHOR_PROFILE_COLLECTIONS.workingProfiles),
    publicProfiles: firestore.collection(
      AUTHOR_PROFILE_COLLECTIONS.publicProfiles,
    ),
    slugs: firestore.collection(AUTHOR_PROFILE_COLLECTIONS.slugIndex),
    auditLogs: firestore.collection("admin_logs"),
    versionHistory: firestore.collection("cmsVersionHistory"),
    posts: firestore.collection("cmsPosts"),
  };
}

async function linkedStaff(transaction, collections, profile) {
  if (typeof profile.uid !== "string") return null;
  const snapshot = await transaction.get(collections.staff.doc(profile.uid));
  return snapshot.exists ? snapshot.data() : null;
}

function profileLifecycle(profile) {
  return profile?.lifecycle === "archived" ? "archived" : "active";
}

function assertProfileActive(profile) {
  if (profileLifecycle(profile) === "archived") {
    throw new AuthorProfileError(
      409,
      "This staff profile is archived",
      "profile_archived",
    );
  }
}

function normalizedEmail(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().toLowerCase()
    : null;
}

/**
 * The staff status a user document implies. Status is stored on the staff record
 * for querying, but it is re-derived from `users/{uid}` on every read that can
 * change anything, so a stale copy can never authorize a publish.
 */
function staffStatusFromUserDoc(userDoc) {
  return userDoc && userDoc.active !== false ? "active" : "inactive";
}

async function assertProfileAdmin(firestore, actorUid, transaction) {
  const ref = refs(firestore).users.doc(actorUid);
  const snapshot = transaction ? await transaction.get(ref) : await ref.get();
  const principal = await principalFromStoredUserDoc(
    firestore, actorUid, snapshot.exists ? snapshot.data() : null, transaction,
  );
  if (!hasCapability(principal, ADMIN_PROFILE_CAPABILITY)) {
    throw new AuthorProfileError(
      403,
      "Managing another author profile requires admin access",
    );
  }
}

/**
 * A readable display name for a brand-new profile. Never an email address: the
 * local part of a work address is close enough to a real name that it would look
 * deliberate on a public page, and the domain is private data.
 *
 * Precedence depends on who supplied the name. On the self-service path the
 * caller's name is a hint from a sign-in profile, so the account's own
 * `users/{uid}.displayName` wins. On the backfill it is the operator's explicit
 * `mapping[uid]` decision -- the whole reason that mapping exists is to correct a
 * wrong or missing user-document name -- so it must win instead, or the
 * correction is silently discarded and the stale name is what a byline shows.
 */
function seedDisplayName(userDoc, fallback, { preferSupplied = false } = {}) {
  const stored =
    userDoc && typeof userDoc.displayName === "string"
      ? userDoc.displayName.trim()
      : "";
  const supplied = typeof fallback === "string" ? fallback.trim() : "";
  const ordered = preferSupplied ? [supplied, stored] : [stored, supplied];
  for (const candidate of ordered) {
    if (candidate.length > 0) return candidate.slice(0, contract.AUTHOR_NAME_MAX);
  }
  return "NJ PBS staff";
}

function auditRow(transaction, firestore, fields) {
  transaction.create(refs(firestore).auditLogs.doc(), adminLogEntry(fields));
}

/** The audited "before"/"after" pair for a private staff linkage row. */
function staffAuditShape(staff) {
  if (!staff) return null;
  return {
    uid: staff.uid,
    authorId: staff.authorId,
    email: staff.email ?? null,
    status: staff.status,
  };
}

/**
 * The audited "before"/"after" pair for a profile change. Deliberately narrow:
 * an audit row is read by people reviewing access, so it records what changed
 * about visibility, slug, and version rather than copying a bio into a second
 * collection.
 */
function auditShape(profile) {
  if (!profile) return null;
  return {
    authorId: profile.authorId,
    uid: profile.uid,
    lifecycle: profileLifecycle(profile),
    visibility: profile.visibility,
    slug: profile.slug ?? null,
    previousSlugs: profile.previousSlugs ?? [],
    version: profile.version,
    displayName: profile.displayName,
    photoAssetId: profile.photo?.assetId ?? null,
    // The author-page controls are audited because they change what the public
    // page lists. The hidden list is recorded as a count and not as ids: the
    // row exists to show that a curation choice was made and by whom, and the
    // full list is already on the profile document the row points at.
    pinnedPostId: profile.pinnedPostId ?? null,
    hiddenPostCount: Array.isArray(profile.hiddenPostIds)
      ? profile.hiddenPostIds.length
      : 0,
  };
}

/** The audited shape of a photograph: the rights record, not the image. */
function photoAuditShape(photo) {
  if (!photo) return null;
  return {
    assetId: photo.assetId,
    rightsBasis: photo.rightsBasis,
    credit: photo.credit ?? null,
    attestedAt: photo.attestedAt,
    attestedBy: photo.attestedBy,
    focalX: photo.focalX,
    focalY: photo.focalY,
  };
}

function validationError(errors) {
  const error = new AuthorProfileError(
    400,
    errors[0] ?? "Profile is not valid",
    "validation_failed",
  );
  error.errors = errors;
  return error;
}

/**
 * Turn a client photo request into the stored photograph, against the media
 * library's own record of the asset.
 *
 * Three things are decided here and nowhere else. The asset must satisfy the
 * ratified photo policy -- profile category, still-image type, at most 5 MiB, at
 * least 400x400 -- read from `media_assets`, never from the request, because a
 * client that could state its own dimensions could state its way past the
 * minimum. `requireAssetOwnerUid` confines the self-service path: a staff member
 * may attach a photograph they uploaded, and may keep the one already on their
 * profile (an admin may have set it for them), but cannot bind an arbitrary
 * asset id someone else created. And the returned photograph is composed field
 * by field, so nothing extra the client sent can reach the stored document.
 */
async function resolveAuthorPhoto(
  transaction,
  firestore,
  { request: rawRequest, existingPhoto, requireAssetOwnerUid, nowIso, actorUid, },
) {
  const normalized = normalizeAuthorPhotoRequest(rawRequest);
  if (!normalized.ok) throw validationError(normalized.errors);
  const request = normalized.value;

  const snapshot = await transaction.get(
    firestore.collection(MEDIA_ASSETS_COLLECTION).doc(request.assetId),
  );
  const asset = snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null;
  // Integrity checks block. Library category and license do not: staff may use
  // any active library image, and the rights basis they confirm is saved with
  // the profile and its audit row. The Admin warns when the library license
  // does not record the same basis. A photograph already on this profile may
  // omit a frame flag. A file the library marks animated is still refused.
  const alreadyAttached =
    existingPhoto !== null &&
    existingPhoto !== undefined &&
    existingPhoto.assetId === request.assetId;
  const errors = checkAuthorPhotoAsset(asset, request.assetId, {
    requireFrameClassification: !alreadyAttached,
  });
  if (errors.length > 0) throw validationError(errors);

  if (
    typeof requireAssetOwnerUid === "string" &&
    !alreadyAttached &&
    asset.createdBy !== requireAssetOwnerUid
  ) {
    throw new AuthorProfileError(
      403,
      "You can only use a profile photo you uploaded yourself",
      "photo_not_owned",
    );
  }

  const replacement = await transaction.get(mediaReplacementRef(firestore, request.assetId));
  if (replacement.exists) {
    throw new AuthorProfileError(
      409,
      "A file replacement is in progress for this image. Wait for it to finish before using it as a profile photo.",
      "photo_replacement_in_progress",
    );
  }

  return composeAuthorPhoto({
    request,
    asset,
    existing: existingPhoto ?? null,
    nowIso,
    actor: actorUid,
  });
}

// -- reads -------------------------------------------------------------------

/** Every slug ever claimed -- active and retired -- so none is ever reissued. */
async function readTakenSlugs(transaction, firestore) {
  const snapshot = await transaction.get(refs(firestore).slugs);
  return new Set(snapshot.docs.map((doc) => doc.id));
}

// -- identity ----------------------------------------------------------------

async function assertAuthorProfileCapability(firestore, uid, userDoc, transaction) {
  if (!hasCapability(await principalFromStoredUserDoc(firestore, uid, userDoc, transaction), AUTHOR_PROFILE_CAPABILITY)) {
    throw new AuthorProfileError(
      403,
      "Author profile access requires CMS authoring access",
      "author_access_required",
    );
  }
}

/**
 * Verify-or-create the private staff record and working profile for one active
 * CMS user. Idempotent: an existing pair is returned and its status resynced
 * from `users/{uid}` rather than recreated, so this is safe to call on every
 * self read and safe to re-run from the backfill.
 *
 * Refuses an account that has no `users/{uid}` document or is deactivated. A
 * pre-approval identity therefore cannot mint itself an authorId by signing in,
 * and a deactivated one cannot read, edit, publish, or silently re-create a
 * profile. A deactivated account whose earlier offboarding half-failed still
 * gets its linkage row resynced and audited before the rejection, so the repair
 * is not lost to the refusal.
 */
async function ensureAuthorIdentity({
  firestore,
  uid,
  email = null,
  displayName = null,
  nowIso,
  actorUid,
  actorEmail = null,
  source = null,
  randomHex,
  auditAction = AUDIT_ACTIONS.create,
  requireAuthoringAccess = false,
  // True only for the operator backfill, whose `displayName` is an explicit
  // mapping decision rather than a hint from a sign-in profile.
  preferSuppliedName = false,
}) {
  if (typeof uid !== "string" || uid.trim().length === 0) {
    throw new AuthorProfileError(400, "A uid is required");
  }
  const collections = refs(firestore);

  const outcome = await firestore.runTransaction(async (transaction) => {
    const userSnapshot = await transaction.get(collections.users.doc(uid));
    if (!userSnapshot.exists) {
      throw new AuthorProfileError(
        403,
        "Account approval required",
        "approval_required",
      );
    }
    const userDoc = userSnapshot.data();
    const status = staffStatusFromUserDoc(userDoc);

    const staffRef = collections.staff.doc(uid);
    const staffSnapshot = await transaction.get(staffRef);
    const existingStaff = staffSnapshot.exists ? staffSnapshot.data() : null;

    if (existingStaff && !isAuthorId(existingStaff.authorId)) {
      // Refuse to guess. A staff record whose authorId is not a minted id is a
      // corrupted linkage row, and silently reminting would fork one person's
      // byline history into two identities.
      throw new AuthorProfileError(
        409,
        "Stored staff record has an invalid authorId",
      );
    }

    const resolvedEmail = normalizedEmail(email) ?? normalizedEmail(userDoc.email);
    const authorId = existingStaff
      ? existingStaff.authorId
      : status === "active" ? mintAuthorId(randomHex) : null;
    const profileRef = authorId ? collections.profiles.doc(authorId) : null;
    const profileSnapshot = profileRef ? await transaction.get(profileRef) : null;
    const statusChanged = existingStaff && existingStaff.status !== status;

    /**
     * Bring the linkage row back in line with `users/{uid}`. Audited in the same
     * transaction as the change: `cmsStaffRecords` is account data, so a silent
     * mutation of it is the compliance defect this module exists to prevent
     * (#196).
     */
    const resyncStaffRecord = () => {
      if (
        !existingStaff ||
        (existingStaff.status === status && existingStaff.email === resolvedEmail)
      ) {
        return false;
      }
      const after = { ...existingStaff, status, email: resolvedEmail };
      transaction.update(staffRef, {
        status,
        email: resolvedEmail,
        updatedAt: nowIso,
        updatedBy: actorUid,
      });
      auditRow(transaction, firestore, {
        actorUid,
        actorEmail,
        action: AUDIT_ACTIONS.resync,
        target: `${AUTHOR_PROFILE_COLLECTIONS.staffRecords}/${uid}`,
        before: staffAuditShape(existingStaff),
        after: staffAuditShape(after),
        source,
      });
      return true;
    };

    if (status === "inactive") {
      // Repair first, then report. Committing the resync keeps a half-failed
      // offboarding from leaving a stale "active" linkage row behind, and the
      // caller is still refused: no read, no create, no edit for a deactivated
      // account.
      resyncStaffRecord();
      if (statusChanged) {
        syncBylineProjection(
          transaction, firestore, authorId,
          profileSnapshot?.exists ? profileSnapshot.data() : null,
          { ...existingStaff, status },
        );
      }
      return { inactive: true, staffStatus: status };
    }

    if (requireAuthoringAccess) await assertAuthorProfileCapability(firestore, uid, userDoc, transaction);

    let created = false;

    if (!existingStaff) {
      created = true;
      transaction.create(staffRef, {
        uid,
        authorId,
        email: resolvedEmail,
        status,
        version: 1,
        createdAt: nowIso,
        createdBy: actorUid,
        updatedAt: nowIso,
        updatedBy: actorUid,
      });
    } else {
      resyncStaffRecord();
    }

    let profile;
    if (profileSnapshot.exists) {
      profile = profileSnapshot.data();
    } else {
      created = true;
      profile = newAuthorWorkingProfile({
        authorId,
        uid,
        displayName: seedDisplayName(userDoc, displayName, {
          preferSupplied: preferSuppliedName,
        }),
        nowIso,
        actor: actorUid,
      });
      transaction.create(profileRef, profile);
    }

    if (profileLifecycle(profile) === "archived") {
      if (statusChanged) {
        syncBylineProjection(
          transaction, firestore, authorId, profile,
          { ...existingStaff, status },
        );
      }
      return { inactive: false, archived: true, staffStatus: status };
    }

    if (created || statusChanged) {
      syncBylineProjection(
        transaction, firestore, authorId, profile,
        { ...(existingStaff ?? { uid, authorId }), status },
      );
    }

    if (created) {
      auditRow(transaction, firestore, {
        actorUid,
        actorEmail,
        action: auditAction,
        target: `${AUTHOR_PROFILE_COLLECTIONS.workingProfiles}/${authorId}`,
        before: null,
        after: auditShape(profile),
        source,
      });
    }

    return {
      inactive: false,
      created,
      staffStatus: status,
      staff: {
        uid,
        authorId,
        email: resolvedEmail,
        status,
      },
      profile,
    };
  });

  if (outcome.inactive) {
    // Thrown after the transaction commits so the audited resync survives the
    // refusal. A clear error beats a silent create: a deactivated person opening
    // their profile page should be told their account is closed, not handed a
    // fresh empty profile they cannot publish.
    throw new AuthorProfileError(
      403,
      "This CMS account is deactivated",
      "account_inactive",
    );
  }
  if (outcome.archived) {
    throw new AuthorProfileError(
      409,
      "This staff profile is archived",
      "profile_archived",
    );
  }
  return outcome;
}

/**
 * Mark one staff linkage row inactive, inside the caller's transaction.
 *
 * `cmsStaffRecords/{uid}.status` is the queryable copy of the account state, and
 * the offboarding path never flipped it: a deactivated account kept an "active"
 * linkage row, so the directory contradicted the account, and the disabled person
 * could not resync it themselves because every self endpoint refuses them.
 *
 * The audit row follows the resync pattern this module already uses, for the same
 * reason: `cmsStaffRecords` is account data, so a silent mutation of it is the
 * compliance defect the module exists to prevent (#196). The snapshot must have
 * been read by the same transaction, before any write, in Firestore's order.
 */
async function deactivateStaffLinkage(
  transaction,
  firestore,
  { snapshot, uid, nowIso, actorUid, actorEmail = null, source = null },
) {
  if (!snapshot || !snapshot.exists) return false;
  const before = snapshot.data();
  if (isAuthorId(before.authorId)) {
    const profileSnapshot = await transaction.get(
      refs(firestore).profiles.doc(before.authorId),
    );
    syncBylineProjection(
      transaction,
      firestore,
      before.authorId,
      profileSnapshot.exists ? profileSnapshot.data() : null,
      { ...before, status: "inactive" },
    );
  } else {
    transaction.delete(firestore.collection(SELF_COLLECTION).doc(uid));
  }
  if (before.status === "inactive") return false;
  const after = { ...before, status: "inactive" };
  transaction.update(snapshot.ref, {
    status: "inactive",
    updatedAt: nowIso,
    updatedBy: actorUid,
  });
  auditRow(transaction, firestore, {
    actorUid,
    actorEmail,
    action: AUDIT_ACTIONS.resync,
    target: `${AUTHOR_PROFILE_COLLECTIONS.staffRecords}/${uid}`,
    before: staffAuditShape(before),
    after: staffAuditShape(after),
    source,
  });
  return true;
}

/**
 * Mark one staff linkage row active again, inside the caller's transaction.
 *
 * The counterpart of `deactivateStaffLinkage` for staff reactivation. The caller
 * writes the single `staff.reactivate` audit row, so this returns the linkage
 * before/after pair instead of writing its own resync row. The private byline
 * projection follows the linkage; the public profile stays withdrawn until an
 * Owner or the person publishes it again.
 */
async function reactivateStaffLinkage(
  transaction,
  firestore,
  { snapshot, nowIso, actorUid },
) {
  if (!snapshot || !snapshot.exists) return null;
  const before = snapshot.data();
  const after = { ...before, status: "active" };
  if (isAuthorId(before.authorId)) {
    const profileSnapshot = await transaction.get(
      refs(firestore).profiles.doc(before.authorId),
    );
    syncBylineProjection(
      transaction,
      firestore,
      before.authorId,
      profileSnapshot.exists ? profileSnapshot.data() : null,
      after,
    );
  }
  if (before.status !== "active") {
    transaction.update(snapshot.ref, {
      status: "active",
      updatedAt: nowIso,
      updatedBy: actorUid,
    });
  }
  return { before: staffAuditShape(before), after: staffAuditShape(after) };
}

/** The private staff linkage row for one uid. */
function staffRecordRef(firestore, uid) {
  return refs(firestore).staff.doc(uid);
}

/**
 * Load one profile by its owning uid, without creating anything. Used by the
 * admin read paths, where creating a profile as a side effect of an admin
 * looking at a list would be wrong.
 */
async function readProfileByUid({ firestore, uid }) {
  const collections = refs(firestore);
  const staffSnapshot = await collections.staff.doc(uid).get();
  if (!staffSnapshot.exists) return null;
  const staff = staffSnapshot.data();
  const profileSnapshot = await collections.profiles.doc(staff.authorId).get();
  return {
    staff,
    profile: profileSnapshot.exists ? profileSnapshot.data() : null,
  };
}

async function readProfileByAuthorId({ firestore, authorId }) {
  if (!isAuthorId(authorId)) {
    throw new AuthorProfileError(400, "A valid authorId is required");
  }
  const snapshot = await refs(firestore).profiles.doc(authorId).get();
  return snapshot.exists ? snapshot.data() : null;
}

// -- mutations ---------------------------------------------------------------

/**
 * Optimistic concurrency, enforced rather than offered. Every mutation must name
 * the version it was opened against: an omitted `expectedVersion` used to pass,
 * which quietly turned two concurrent editors into last-write-wins instead of
 * the promised 409.
 *
 * `enforce: false` exists for exactly one caller -- the system-driven withdrawal
 * that follows a staff deactivation, which has no opened form to carry a version
 * and must not fail on a race while a public profile is still standing.
 */
function assertVersion(profile, expectedVersion, { enforce = true } = {}) {
  if (!enforce && (expectedVersion === undefined || expectedVersion === null)) {
    return;
  }
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new AuthorProfileError(
      400,
      "expectedVersion must be the version this profile was opened at",
      "expected_version_required",
    );
  }
  if (expectedVersion !== profile.version) {
    throw new AuthorProfileError(
      409,
      "This profile changed since it was opened",
      "version_conflict",
    );
  }
}

const EMPTY_MEDIA_USAGE = Object.freeze({ assetIds: [], occurrenceCount: 0 });

/** The usage record one profile owns for one mutable state. */
function profileMediaUsageRef(firestore, authorId, state) {
  return firestore
    .collection(
      `${AUTHOR_PROFILE_COLLECTIONS.workingProfiles}/${authorId}/mediaUsage`,
    )
    .doc(state);
}

function photoMediaUsage(photo) {
  return photo && typeof photo.assetId === "string"
    ? { assetIds: [photo.assetId], occurrenceCount: 1 }
    : EMPTY_MEDIA_USAGE;
}

/**
 * Register the profile's claim on its photograph in the media usage fence.
 *
 * The media lifecycle boundary decides "is this asset still in use" with one
 * collection-group query over `mediaUsage` documents, so an asset that nothing
 * registers is an asset a media manager may tombstone. Without this write a
 * published profile kept a URL to a file the library had already retired. The
 * document shape, path and clearing convention are exactly the ones content
 * records use (`prepareMediaUsageWrite` in save, the emptied published record in
 * lifecycle-transition), because the fence is that shared query.
 *
 * Both states are written on every profile write: a private profile and a
 * removed photograph both mean an empty list, so a cleared photo frees its asset
 * in the same commit that clears it, and a withdrawal frees the published claim.
 */
function writePhotoMediaUsage(transaction, firestore, profile) {
  const working = photoMediaUsage(profile.photo ?? null);
  const published =
    profile.visibility === "published" ? working : EMPTY_MEDIA_USAGE;
  transaction.set(
    profileMediaUsageRef(firestore, profile.authorId, "working"),
    mediaUsageDocument({
      state: "working",
      sourceVersion: profile.version,
      usage: working,
    }),
  );
  transaction.set(
    profileMediaUsageRef(firestore, profile.authorId, "published"),
    mediaUsageDocument({
      state: "published",
      sourceVersion: profile.version,
      usage: published,
    }),
  );
}

// Read before the first transaction write. Private drafts remain editable during
// a handoff, but deleting a stray public snapshot is still a public mutation.
async function assertPublicProfileMutationAllowed(transaction, firestore, before, after) {
  if (before?.visibility !== "published" && after?.visibility !== "published") {
    const snapshot = await transaction.get(
      refs(firestore).publicProfiles.doc(before?.authorId ?? after.authorId),
    );
    if (!snapshot.exists) return false;
  }
  try {
    await assertCmsPublicationAdmissionInTransaction({ firestore, transaction });
  } catch (error) {
    if (error instanceof CmsPublicationRuntimeControlError) {
      throw new AuthorProfileError(409, error.message, error.code);
    }
    throw error;
  }
  const profile = after ?? before;
  const snapshot = after?.visibility === "published" ? toPublicAuthorSnapshot(after) : null;
  return preparePublicReleaseProducerInTransaction({ firestore, transaction,
    operationId: publicReleaseProducerOperation("author", profile.authorId, profile.version, snapshot),
    changes: [{ kind: "author", id: profile.authorId, action: snapshot ? "dependency" : "withdraw",
      sourceVersion: profile.version, snapshot }] });
}

/**
 * Write the public projections of a profile: the public snapshot for a published
 * profile (removed when it is private), and the media usage records that hold the
 * tombstone fence over its photograph. Both halves live here so no caller can
 * publish without minting a snapshot, take a profile private without deleting
 * one, or move a photograph without moving the claim that protects it.
 */
function writeSnapshot(transaction, firestore, profile, publicChange) {
  const collections = refs(firestore);
  const publicRef = collections.publicProfiles.doc(profile.authorId);
  if (publicChange) { publicChange(); bumpPublicContextRevision(transaction, firestore, { withdrawal: profile.visibility !== "published" }); }
  writePhotoMediaUsage(transaction, firestore, profile);
  if (profile.visibility === "published") {
    const snapshot = toPublicAuthorSnapshot(profile);
    transaction.set(publicRef, snapshot);
    return snapshot;
  }
  transaction.delete(publicRef);
  return null;
}

/**
 * Apply a validated content edit to a profile. A published profile is
 * re-snapshotted in the same transaction, so the public page cannot keep showing
 * a name or a link the author has already changed.
 */
async function updateWorkingProfile({
  firestore,
  authorId,
  patch,
  expectedVersion,
  nowIso,
  actorUid,
  requireAdminAccess = false,
  actorEmail = null,
  source = null,
  auditAction = AUDIT_ACTIONS.update,
  // Non-null on the self-service path: the uid whose own uploads may be newly
  // attached. Null for an admin, who may attach any profile-category photograph.
  requireAssetOwnerUid = null,
}) {
  // Cheap early exit on the text fields, before a transaction is opened. The
  // photograph cannot be judged here -- it needs the media library -- so it is
  // withheld and the whole draft is validated again inside the transaction, with
  // the resolved photograph, as the single gate.
  const preflight = validateAuthorProfileDraft({ ...patch, photo: undefined });
  if (!preflight.ok) throw validationError(preflight.errors);

  const collections = refs(firestore);
  const profileRef = collections.profiles.doc(authorId);

  return firestore.runTransaction(async (transaction) => {
    if (requireAdminAccess) await assertProfileAdmin(firestore, actorUid, transaction);
    const snapshot = await transaction.get(profileRef);
    if (!snapshot.exists) {
      throw new AuthorProfileError(404, "Author profile not found");
    }
    const before = snapshot.data();
    assertVersion(before, expectedVersion);
    assertProfileActive(before);
    const staff = await linkedStaff(transaction, collections, before);

    // Omitted preserves, explicit null clears -- the contract's three-state rule,
    // so a form that does not render the photo section cannot silently take
    // someone's photograph down. Clearing withdraws the use, not the binary: the
    // media asset is untouched, so the tombstone fence and the immutable
    // original stay exactly as the media contract left them.
    let photo;
    if (patch.photo === undefined) {
      photo = undefined;
    } else if (patch.photo === null) {
      photo = null;
    } else {
      photo = await resolveAuthorPhoto(transaction, firestore, {
        request: patch.photo,
        existingPhoto: before.photo ?? null,
        requireAssetOwnerUid,
        nowIso,
        actorUid,
      });
    }

    const validation = validateAuthorProfileDraft({ ...patch, photo });
    if (!validation.ok) throw validationError(validation.errors);

    const after = applyAuthorProfileEdit(before, validation.value, {
      nowIso,
      actor: actorUid,
    });
    if (after.visibility === "published" && before.uid) {
      const userSnapshot = await transaction.get(
        collections.users.doc(before.uid),
      );
      await assertAuthorProfileCapability(
        firestore, before.uid, userSnapshot.exists ? userSnapshot.data() : null, transaction,
      );
    }
    const stored = await profileWithLibraryThumbnails(transaction, firestore, after);
    const publicChange = await assertPublicProfileMutationAllowed(transaction, firestore, before, stored);
    transaction.set(profileRef, stored);
    syncBylineProjection(transaction, firestore, authorId, stored, staff);
    const publicSnapshot = writeSnapshot(transaction, firestore, stored, publicChange);

    auditRow(transaction, firestore, {
      actorUid,
      actorEmail,
      action: auditAction,
      target: `${AUTHOR_PROFILE_COLLECTIONS.workingProfiles}/${authorId}`,
      before: auditShape(before),
      after: auditShape(after),
      source,
    });

    const beforePhoto = before.photo ?? null;
    const afterPhoto = after.photo ?? null;
    // A new file or a new rights attestation on the same file is audited. The
    // library license no longer has to match, so a basis change needs its own row.
    if (
      (beforePhoto?.assetId ?? null) !== (afterPhoto?.assetId ?? null) ||
      (beforePhoto?.rightsBasis ?? null) !== (afterPhoto?.rightsBasis ?? null) ||
      (beforePhoto?.attestedAt ?? null) !== (afterPhoto?.attestedAt ?? null)
    ) {
      auditRow(transaction, firestore, {
        actorUid,
        actorEmail,
        action: afterPhoto
          ? AUDIT_ACTIONS.photoAttach
          : AUDIT_ACTIONS.photoRemove,
        target: `${AUTHOR_PROFILE_COLLECTIONS.workingProfiles}/${authorId}`,
        before: photoAuditShape(beforePhoto),
        after: photoAuditShape(afterPhoto),
        source,
      });
    }

    return { profile: stored, publicSnapshot };
  });
}

/**
 * Publish a profile: validate, mint the slug if this is the first publication,
 * claim it in the slug index, and write the public snapshot. The slug is minted
 * once and reused forever, so withdrawing and republishing never moves an
 * author's public URL.
 */
async function publishProfile({
  firestore,
  authorId,
  expectedVersion,
  nowIso,
  actorUid,
  requireAdminAccess = false,
  requireSelfPublishAccess = false,
  actorEmail = null,
  source = null,
}) {
  const collections = refs(firestore);
  const profileRef = collections.profiles.doc(authorId);

  return firestore.runTransaction(async (transaction) => {
    if (requireAdminAccess) await assertProfileAdmin(firestore, actorUid, transaction);
    const snapshot = await transaction.get(profileRef);
    if (!snapshot.exists) {
      throw new AuthorProfileError(404, "Author profile not found");
    }
    const before = snapshot.data();
    assertVersion(before, expectedVersion);

    assertProfileActive(before);
    const staff = await linkedStaff(transaction, collections, before);
    const userSnapshot =
      typeof before.uid === "string"
        ? await transaction.get(collections.users.doc(before.uid))
        : null;
    const staffStatus = userSnapshot
      ? staffStatusFromUserDoc(userSnapshot.exists ? userSnapshot.data() : null)
      : null;

    const readiness = checkAuthorProfilePublishReadiness(before, staffStatus);
    if (!readiness.ok) {
      const error = new AuthorProfileError(
        400,
        readiness.errors[0] ?? "Profile is not ready to publish",
        "validation_failed",
      );
      error.errors = readiness.errors;
      throw error;
    }

    const profilePrincipal = userSnapshot
      ? await principalFromStoredUserDoc(firestore, before.uid, userSnapshot.data(), transaction)
      : null;
    if (userSnapshot && !hasCapability(profilePrincipal, AUTHOR_PROFILE_CAPABILITY)) {
      throw new AuthorProfileError(
        403,
        "Author profile access requires CMS authoring access",
        "author_access_required",
      );
    }

    // Read authority again on every transaction attempt. Scoped editors qualify
    // by tier; a profile has no content section to authorize against.
    if (requireSelfPublishAccess && !hasCapability(profilePrincipal, "content.edit.any")) {
      throw new AuthorProfileError(
        403,
        "Publishing your own profile requires editor access or higher",
        "profile_publish_access_required",
      );
    }

    let slug = before.slug;
    let claimSlug = false;
    if (!isValidAuthorSlug(slug)) {
      const taken = await readTakenSlugs(transaction, firestore);
      slug = resolveAuthorSlug(
        slugifyAuthorName(before.displayName),
        taken,
        before.displayName,
      );
      claimSlug = true;
    }

    const after = publishAuthorProfile(before, {
      slug,
      nowIso,
      actor: actorUid,
    });
    const stored = await profileWithLibraryThumbnails(transaction, firestore, after);
    const publicChange = await assertPublicProfileMutationAllowed(transaction, firestore, before, stored);
    transaction.set(profileRef, stored);
    syncBylineProjection(transaction, firestore, authorId, stored, staff);
    if (claimSlug) {
      transaction.create(collections.slugs.doc(slug), {
        slug,
        authorId,
        state: SLUG_STATE.active,
        claimedAt: nowIso,
        updatedAt: nowIso,
      });
    }
    const publicSnapshot = writeSnapshot(transaction, firestore, stored, publicChange);

    auditRow(transaction, firestore, {
      actorUid,
      actorEmail,
      action: AUDIT_ACTIONS.publish,
      target: `${AUTHOR_PROFILE_COLLECTIONS.workingProfiles}/${authorId}`,
      before: auditShape(before),
      after: auditShape(after),
      source,
    });

    return { profile: stored, publicSnapshot };
  });
}

/**
 * Take a profile off the public site. `reason` distinguishes the author's own
 * Unpublish from an admin withdrawal and from the automatic withdrawal that
 * follows deactivation, because those are three different things to see in an
 * audit trail even though the resulting state is identical.
 */
async function withdrawProfile({
  firestore,
  authorId,
  reason,
  expectedVersion,
  enforceVersion = true,
  nowIso,
  actorUid,
  requireAdminAccess = false,
  actorEmail = null,
  source = null,
  // Offboarding only: skip when this account is active again by commit time.
  requireInactiveUid = null,
}) {
  const collections = refs(firestore);
  const profileRef = collections.profiles.doc(authorId);
  const action =
    reason === "owner" ? AUDIT_ACTIONS.unpublish : AUDIT_ACTIONS.withdraw;

  return firestore.runTransaction(async (transaction) => {
    if (requireAdminAccess) await assertProfileAdmin(firestore, actorUid, transaction);
    if (requireInactiveUid) {
      const user = await transaction.get(collections.users.doc(requireInactiveUid));
      if (staffStatusFromUserDoc(user.exists ? user.data() : null) === "active") {
        return { profile: null, publicSnapshot: null, accountActive: true };
      }
    }
    const snapshot = await transaction.get(profileRef);
    if (!snapshot.exists) {
      throw new AuthorProfileError(404, "Author profile not found");
    }
    const before = snapshot.data();
    assertVersion(before, expectedVersion, { enforce: enforceVersion });
    assertProfileActive(before);
    const staff = await linkedStaff(transaction, collections, before);

    // Idempotent: withdrawing an already-private profile still deletes any
    // stray public document, so a partially failed earlier withdrawal is
    // repaired rather than reported as already done.
    const after = withdrawAuthorProfile(before, {
      nowIso,
      actor: actorUid,
      reason,
    });
    const publicChange = await assertPublicProfileMutationAllowed(transaction, firestore, before, after);
    transaction.set(profileRef, after);
    syncBylineProjection(transaction, firestore, authorId, after, staff);
    writeSnapshot(transaction, firestore, after, publicChange);

    auditRow(transaction, firestore, {
      actorUid,
      actorEmail,
      action,
      target: `${AUTHOR_PROFILE_COLLECTIONS.workingProfiles}/${authorId}`,
      before: auditShape(before),
      after: auditShape(after),
      source,
    });

    return { profile: after, publicSnapshot: null };
  });
}

/**
 * Deactivation withdrawal, at the schema level. Wiring this into the staff
 * offboarding boundary is a later lane of #1044; exporting it now keeps the
 * semantics -- deactivating a staff account withdraws the public profile while
 * the authorId and any published byline snapshots survive -- in one place rather
 * than being reinvented there.
 */
async function withdrawProfileForDeactivation({ firestore, uid, requireInactiveAccount = false, ...rest }) {
  // The linkage row first, and unconditionally. Deactivation flips
  // `users/{uid}.active`, but `cmsStaffRecords/{uid}.status` is what the byline
  // directory and the save-time identity read treat as authoritative, so a row
  // left at "active" keeps a departed author pickable on new stories -- including
  // for an author who never published a profile and so has nothing to withdraw.
  //
  // This caller has no transaction of its own to join, unlike the offboarding
  // boundary in functions/deactivate-staff.js, so it opens one just to satisfy
  // `deactivateStaffLinkage`'s read-then-write contract: the snapshot has to be
  // read by the same transaction that writes it, in Firestore's order.
  const staffRef = staffRecordRef(firestore, uid);
  let accountActive = false;
  const linkageChanged = await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(staffRef);
    // A delayed offboarding request must not undo a reactivation that committed
    // after it: the account state is read in the same transaction as the write.
    if (requireInactiveAccount) {
      const user = await transaction.get(refs(firestore).users.doc(uid));
      accountActive = staffStatusFromUserDoc(user.exists ? user.data() : null) === "active";
      if (accountActive) return false;
    }
    return deactivateStaffLinkage(transaction, firestore, {
      snapshot,
      uid,
      ...rest,
    });
  });

  if (accountActive) {
    return { profile: null, withdrawn: false, linkageDeactivated: false, accountActive: true };
  }
  const identity = await readProfileByUid({ firestore, uid });
  if (!identity || !identity.profile) {
    return {
      profile: null,
      withdrawn: false,
      linkageDeactivated: linkageChanged,
    };
  }
  if (identity.profile.visibility !== "published") {
    return {
      profile: identity.profile,
      withdrawn: false,
      linkageDeactivated: linkageChanged,
    };
  }
  const result = await withdrawProfile({
    firestore,
    authorId: identity.staff.authorId,
    ...rest,
    // Last, so no caller can weaken either one: offboarding is a forced,
    // system-driven withdrawal with no opened form behind it, and it must not
    // fail on a version race while a public profile is still standing.
    reason: "deactivation",
    enforceVersion: false,
    requireInactiveUid: requireInactiveAccount ? uid : null,
  });
  if (result.accountActive) {
    return { profile: null, withdrawn: false, linkageDeactivated: linkageChanged, accountActive: true };
  }
  return {
    profile: result.profile,
    withdrawn: true,
    linkageDeactivated: linkageChanged,
  };
}

/**
 * Admin slug rename. Restricted to admins by the callable boundary, per the
 * ratified decision; the outgoing slug is retired rather than released so its
 * permanent redirect keeps resolving to the same person.
 */
async function renameProfileSlug({
  firestore,
  authorId,
  slug,
  expectedVersion,
  nowIso,
  actorUid,
  requireAdminAccess = false,
  actorEmail = null,
  source = null,
}) {
  if (!isValidAuthorSlug(slug)) {
    throw new AuthorProfileError(400, "That is not a valid author slug");
  }
  const collections = refs(firestore);
  const profileRef = collections.profiles.doc(authorId);

  return firestore.runTransaction(async (transaction) => {
    if (requireAdminAccess) await assertProfileAdmin(firestore, actorUid, transaction);
    const snapshot = await transaction.get(profileRef);
    if (!snapshot.exists) {
      throw new AuthorProfileError(404, "Author profile not found");
    }
    const before = snapshot.data();
    assertVersion(before, expectedVersion);
    assertProfileActive(before);
    if (!isValidAuthorSlug(before.slug)) {
      throw new AuthorProfileError(
        409,
        "This profile has no published slug to rename",
      );
    }
    if (before.slug === slug) {
      return { profile: before, publicSnapshot: null, changed: false };
    }

    const taken = await readTakenSlugs(transaction, firestore);
    if (taken.has(slug)) {
      throw new AuthorProfileError(409, "That author slug is already claimed");
    }

    const after = renameAuthorSlug(before, { slug, nowIso, actor: actorUid });
    const stored = await profileWithLibraryThumbnails(transaction, firestore, after);
    const publicChange = await assertPublicProfileMutationAllowed(transaction, firestore, before, stored);
    transaction.set(profileRef, stored);
    transaction.update(collections.slugs.doc(before.slug), {
      state: SLUG_STATE.retired,
      updatedAt: nowIso,
    });
    transaction.create(collections.slugs.doc(slug), {
      slug,
      authorId,
      state: SLUG_STATE.active,
      claimedAt: nowIso,
      updatedAt: nowIso,
    });
    const publicSnapshot = writeSnapshot(transaction, firestore, stored, publicChange);

    auditRow(transaction, firestore, {
      actorUid,
      actorEmail,
      action: AUDIT_ACTIONS.rename,
      target: `${AUTHOR_PROFILE_COLLECTIONS.workingProfiles}/${authorId}`,
      before: auditShape(before),
      after: auditShape(after),
      source,
    });

    return { profile: stored, publicSnapshot, changed: true };
  });
}

/**
 * Bounded admin listing. Ordered by authorId so paging is stable, and capped so
 * one call cannot read the whole staff directory into a response.
 */
const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;

async function listAuthorProfiles({ firestore, limit, startAfter = null, authorId = undefined }) {
  if (authorId !== undefined) {
    const profile = await readProfileByAuthorId({ firestore, authorId });
    return { profiles: profile ? [profile] : [], nextCursor: null };
  }
  const bounded = Number.isSafeInteger(limit)
    ? Math.min(Math.max(limit, 1), LIST_LIMIT_MAX)
    : LIST_LIMIT_DEFAULT;
  let query = refs(firestore)
    .profiles.orderBy(FieldPath.documentId())
    .limit(bounded);
  if (typeof startAfter === "string" && startAfter.length > 0) {
    query = query.startAfter(startAfter);
  }
  const snapshot = await query.get();
  return {
    profiles: snapshot.docs.map((doc) => doc.data()),
    nextCursor:
      snapshot.docs.length === bounded
        ? snapshot.docs[snapshot.docs.length - 1].id
        : null,
  };
}

/** Create an account-independent profile identity for a manager to complete. */
async function createManagedProfile({
  firestore,
  displayName,
  nowIso,
  actorUid,
  requireAdminAccess = false,
  actorEmail = null,
  source = null,
  randomHex,
}) {
  const validation = validateAuthorProfileDraft({ displayName });
  if (!validation.ok) throw validationError(validation.errors);
  const authorId = mintAuthorId(randomHex);
  const profile = newAuthorWorkingProfile({
    authorId,
    uid: null,
    displayName: validation.value.displayName,
    nowIso,
    actor: actorUid,
  });
  await firestore.runTransaction(async (transaction) => {
    if (requireAdminAccess) await assertProfileAdmin(firestore, actorUid, transaction);
    const profileRef = refs(firestore).profiles.doc(authorId);
    const snapshot = await transaction.get(profileRef);
    if (snapshot.exists) {
      throw new AuthorProfileError(409, "Could not mint a unique authorId");
    }
    transaction.create(profileRef, profile);
    syncBylineProjection(transaction, firestore, authorId, profile);
    writePhotoMediaUsage(transaction, firestore, profile);
    auditRow(transaction, firestore, {
      actorUid,
      actorEmail,
      action: AUDIT_ACTIONS.create,
      target: `${AUTHOR_PROFILE_COLLECTIONS.workingProfiles}/${authorId}`,
      before: null,
      after: auditShape(profile),
      source,
    });
  });
  return { profile };
}

function isReplaceableSelfIdentity(profile, staff, uid) {
  return (
    profile?.authorId === staff?.authorId &&
    profile?.uid === uid &&
    staff?.uid === uid &&
    profileLifecycle(profile) === "active" &&
    profile.visibility === "private" &&
    profile.slug === null &&
    profile.version === 1 &&
    profile.createdBy === uid &&
    staff.createdBy === uid
  );
}

async function profileHasBylineReferences(transaction, collections, authorId) {
  const registeredCredit = { kind: "registered", authorId };
  const referenceQueries = [
    collections.posts.where("credits", "array-contains", registeredCredit),
    collections.versionHistory.where(
      "before.credits",
      "array-contains",
      registeredCredit,
    ),
    collections.versionHistory.where(
      "after.credits",
      "array-contains",
      registeredCredit,
    ),
  ];
  for (const query of referenceQueries) {
    const snapshot = await transaction.get(query.limit(1));
    if (!snapshot.empty) return true;
  }

  // Published credits are frozen with displayName and sometimes slug, so a
  // Firestore array-contains query for the smaller working-credit map would
  // not match them: map equality is exact. Project and page only the detached
  // published credit field, then compare authorId in application code.
  let publishedCursor = null;
  while (true) {
    let publishedQuery = collections.posts
      .orderBy(FieldPath.documentId())
      .select("published.credits")
      .limit(LIST_LIMIT_MAX);
    if (publishedCursor !== null) {
      publishedQuery = publishedQuery.startAfter(publishedCursor);
    }
    const snapshot = await transaction.get(publishedQuery);
    if (
      snapshot.docs.some((doc) =>
        doc
          .data()
          ?.published?.credits?.some(
            (credit) =>
              credit?.kind === "registered" && credit.authorId === authorId,
          ),
      )
    ) {
      return true;
    }
    if (snapshot.docs.length < LIST_LIMIT_MAX) return false;
    publishedCursor = snapshot.docs[snapshot.docs.length - 1];
  }
}

/** Atomically bind an existing stable author identity to one approved CMS user. */
async function linkProfileToUser({
  firestore,
  authorId,
  uid,
  expectedVersion,
  nowIso,
  actorUid,
  requireAdminAccess = false,
  actorEmail = null,
  source = null,
}) {
  if (typeof uid !== "string" || uid.trim().length === 0) {
    throw new AuthorProfileError(400, "An approved CMS user is required");
  }
  const collections = refs(firestore);
  return firestore.runTransaction(async (transaction) => {
    if (requireAdminAccess) await assertProfileAdmin(firestore, actorUid, transaction);
    const profileRef = collections.profiles.doc(authorId);
    const staffRef = collections.staff.doc(uid);
    const [profileSnapshot, userSnapshot, staffSnapshot] =
      await transaction.getAll(
        profileRef,
        collections.users.doc(uid),
        staffRef,
      );
    if (!profileSnapshot.exists) {
      throw new AuthorProfileError(404, "Author profile not found");
    }
    const before = profileSnapshot.data();
    assertVersion(before, expectedVersion);
    assertProfileActive(before);
    if (
      !userSnapshot.exists ||
      staffStatusFromUserDoc(userSnapshot.data()) !== "active"
    ) {
      throw new AuthorProfileError(
        400,
        "That CMS user is not approved and active",
      );
    }
    if (before.visibility === "published") {
      await assertAuthorProfileCapability(firestore, uid, userSnapshot.data(), transaction);
    }
    if (before.uid && before.uid !== uid) {
      throw new AuthorProfileError(
        409,
        "This profile is already linked to another CMS user",
      );
    }
    const existingStaff = staffSnapshot.exists ? staffSnapshot.data() : null;
    let replacedProfile = null;
    if (existingStaff && existingStaff.authorId !== authorId) {
      if (!isAuthorId(existingStaff.authorId)) {
        throw new AuthorProfileError(
          409,
          "That CMS user already has another staff profile",
        );
      }
      const replacedRef = collections.profiles.doc(existingStaff.authorId);
      const replacedSnapshot = await transaction.get(replacedRef);
      replacedProfile = replacedSnapshot.exists ? replacedSnapshot.data() : null;
      if (
        !isReplaceableSelfIdentity(replacedProfile, existingStaff, uid) ||
        (await profileHasBylineReferences(
          transaction,
          collections,
          existingStaff.authorId,
        ))
      ) {
        throw new AuthorProfileError(
          409,
          "That CMS user already has another staff profile",
        );
      }
    }
    if (before.uid === uid && staffSnapshot.exists) {
      return { profile: before, changed: false };
    }
    const staff = {
      uid,
      authorId,
      email: normalizedEmail(userSnapshot.data().email),
      status: "active",
      version: existingStaff ? (existingStaff.version ?? 1) + 1 : 1,
      createdAt: existingStaff?.createdAt ?? nowIso,
      createdBy: existingStaff?.createdBy ?? actorUid,
      updatedAt: nowIso,
      updatedBy: actorUid,
    };
    const after = {
      ...before,
      uid,
      version: before.version + 1,
      updatedAt: nowIso,
      updatedBy: actorUid,
    };
    if (replacedProfile) {
      const publicChange = await assertPublicProfileMutationAllowed(transaction, firestore, replacedProfile, null);
      if (publicChange) { publicChange(); bumpPublicContextRevision(transaction, firestore, { withdrawal: true }); }
    }
    transaction.set(profileRef, after);
    transaction.set(staffRef, staff);
    syncBylineProjection(transaction, firestore, authorId, after, staff);
    if (replacedProfile) {
      const replacedAuthorId = replacedProfile.authorId;
      transaction.delete(collections.profiles.doc(replacedAuthorId));
      transaction.delete(
        firestore.collection(DIRECTORY_COLLECTION).doc(replacedAuthorId),
      );
      transaction.delete(collections.publicProfiles.doc(replacedAuthorId));
      transaction.delete(
        profileMediaUsageRef(firestore, replacedAuthorId, "working"),
      );
      transaction.delete(
        profileMediaUsageRef(firestore, replacedAuthorId, "published"),
      );
      auditRow(transaction, firestore, {
        actorUid,
        actorEmail,
        action: AUDIT_ACTIONS.delete,
        target: `${AUTHOR_PROFILE_COLLECTIONS.workingProfiles}/${replacedAuthorId}`,
        before: auditShape(replacedProfile),
        after: null,
        source,
      });
    }
    auditRow(transaction, firestore, {
      actorUid,
      actorEmail,
      action: AUDIT_ACTIONS.link,
      target: `${AUTHOR_PROFILE_COLLECTIONS.staffRecords}/${uid}`,
      before: staffAuditShape(existingStaff),
      after: staffAuditShape(staff),
      source,
    });
    return { profile: after, changed: true };
  });
}

/** Archive without releasing the authorId, slug, history, or old bylines. */
async function archiveProfile({
  firestore,
  authorId,
  expectedVersion,
  nowIso,
  actorUid,
  requireAdminAccess = false,
  actorEmail = null,
  source = null,
}) {
  const collections = refs(firestore);
  const profileRef = collections.profiles.doc(authorId);
  return firestore.runTransaction(async (transaction) => {
    if (requireAdminAccess) await assertProfileAdmin(firestore, actorUid, transaction);
    const snapshot = await transaction.get(profileRef);
    if (!snapshot.exists)
      throw new AuthorProfileError(404, "Author profile not found");
    const before = snapshot.data();
    assertVersion(before, expectedVersion);
    assertProfileActive(before);
    const staff = await linkedStaff(transaction, collections, before);
    const withdrawn =
      before.visibility === "published"
        ? withdrawAuthorProfile(before, {
            nowIso,
            actor: actorUid,
            reason: "archive",
          })
        : {
            ...before,
            version: before.version + 1,
            updatedAt: nowIso,
            updatedBy: actorUid,
          };
    const after = {
      ...withdrawn,
      lifecycle: "archived",
      archivedAt: nowIso,
      archivedBy: actorUid,
    };
    const publicChange = await assertPublicProfileMutationAllowed(transaction, firestore, before, after);
    transaction.set(profileRef, after);
    syncBylineProjection(transaction, firestore, authorId, after, staff);
    writeSnapshot(transaction, firestore, after, publicChange);
    auditRow(transaction, firestore, {
      actorUid,
      actorEmail,
      action: AUDIT_ACTIONS.archive,
      target: `${AUTHOR_PROFILE_COLLECTIONS.workingProfiles}/${authorId}`,
      before: auditShape(before),
      after: auditShape(after),
      source,
    });
    return { profile: after };
  });
}

/** Permanently delete only a never-published, unlinked and unreferenced draft. */
async function deleteDraftProfile({
  firestore,
  authorId,
  expectedVersion,
  nowIso,
  actorUid,
  requireAdminAccess = false,
  actorEmail = null,
  source = null,
}) {
  const collections = refs(firestore);
  const profileRef = collections.profiles.doc(authorId);
  return firestore.runTransaction(async (transaction) => {
    if (requireAdminAccess) await assertProfileAdmin(firestore, actorUid, transaction);
    const profileSnapshot = await transaction.get(profileRef);
    if (!profileSnapshot.exists)
      throw new AuthorProfileError(404, "Author profile not found");
    const before = profileSnapshot.data();
    assertVersion(before, expectedVersion);
    assertProfileActive(before);
    if (
      before.visibility !== "private" ||
      before.slug !== null ||
      before.uid !== null
    ) {
      throw new AuthorProfileError(
        409,
        "Only an unpublished, unlinked draft can be permanently deleted",
        "profile_delete_forbidden",
      );
    }
    // A profile is deletable only when no working state, public snapshot, or
    // restorable revision can bring its stable identity back. Each retained
    // byline store is checked explicitly; archive is the safe path once any one
    // of them has ever recorded the identity.
    if (await profileHasBylineReferences(transaction, collections, authorId)) {
      throw new AuthorProfileError(
        409,
        "This profile is referenced by a byline and must be archived instead",
        "profile_referenced",
      );
    }
    const publicChange = await assertPublicProfileMutationAllowed(transaction, firestore, before, null);
    if (publicChange) { publicChange(); bumpPublicContextRevision(transaction, firestore, { withdrawal: true }); }
    transaction.delete(profileRef);
    syncBylineProjection(transaction, firestore, authorId, null);
    transaction.delete(collections.publicProfiles.doc(authorId));
    transaction.delete(profileMediaUsageRef(firestore, authorId, "working"));
    transaction.delete(profileMediaUsageRef(firestore, authorId, "published"));
    auditRow(transaction, firestore, {
      actorUid,
      actorEmail,
      action: AUDIT_ACTIONS.delete,
      target: `${AUTHOR_PROFILE_COLLECTIONS.workingProfiles}/${authorId}`,
      before: auditShape(before),
      after: null,
      source,
    });
    return { authorId, deleted: true, deletedAt: nowIso };
  });
}

/** Approved active users that do not already own an author identity. */
async function listLinkableUsers({ firestore }) {
  const collections = refs(firestore);
  const linkable = [];
  let cursor = null;
  // The output is capped, not the first raw user page. Inactive and already-linked
  // accounts may fill any number of earlier pages, so scan by stable document id
  // until the response cap is full or the collection is exhausted.
  while (linkable.length < LIST_LIMIT_MAX) {
    let query = collections.users
      .orderBy(FieldPath.documentId())
      .limit(LIST_LIMIT_MAX);
    if (cursor !== null) query = query.startAfter(cursor);
    const usersSnapshot = await query.get();
    if (usersSnapshot.empty) break;
    const activeUsers = usersSnapshot.docs.filter(
      (doc) => staffStatusFromUserDoc(doc.data()) === "active",
    );
    const staffSnapshots =
      activeUsers.length === 0
        ? []
        : await firestore.getAll(
            ...activeUsers.map((doc) => collections.staff.doc(doc.id)),
          );
    const linkedProfileSnapshots = new Map();
    const linkedProfiles = staffSnapshots
      .map((snapshot, index) => ({ snapshot, user: activeUsers[index] }))
      .filter(
        ({ snapshot, user }) =>
          snapshot?.exists &&
          snapshot.data().createdBy === user.id &&
          isAuthorId(snapshot.data().authorId),
      );
    if (linkedProfiles.length > 0) {
      const profileSnapshots = await firestore.getAll(
        ...linkedProfiles.map(({ snapshot }) =>
          collections.profiles.doc(snapshot.data().authorId),
        ),
      );
      linkedProfiles.forEach(({ user }, index) => {
        linkedProfileSnapshots.set(user.id, profileSnapshots[index]);
      });
    }
    activeUsers.forEach((doc, index) => {
      const staffSnapshot = staffSnapshots[index];
      const staff = staffSnapshot?.exists ? staffSnapshot.data() : null;
      const profileSnapshot = linkedProfileSnapshots.get(doc.id);
      if (
        linkable.length >= LIST_LIMIT_MAX ||
        (staff &&
          (!profileSnapshot?.exists ||
            !isReplaceableSelfIdentity(
              profileSnapshot.data(),
              staff,
              doc.id,
            )))
      ) {
        return;
      }
      linkable.push({
        uid: doc.id,
        displayName: seedDisplayName(doc.data(), null),
        email: normalizedEmail(doc.data().email),
      });
    });
    if (usersSnapshot.docs.length < LIST_LIMIT_MAX) break;
    cursor = usersSnapshot.docs[usersSnapshot.docs.length - 1].id;
  }
  return linkable.sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );
}

/**
 * The byline picker's feed (#1040): the active author identities an editor may
 * credit on a story, with names, stable ids and boolean completeness facts.
 *
 * Deliberately NOT `listAuthorProfiles`. That one is the admin roster, gated on
 * `profiles.manage`, and it returns the owning uid. Crediting a colleague is
 * ordinary editorial work every contributor does, so this reads the linkage rows
 * instead and returns safe picker and advisory fields. A deactivated account is
 * excluded at the query, so a departed staffer cannot be newly credited by
 * someone scrolling an old list -- which is the same rule the save boundary
 * enforces, reached here before the editor can get it wrong.
 */
async function listBylineAuthors({ firestore, limit, startAfter = null }) {
  const bounded = Number.isSafeInteger(limit)
    ? Math.min(Math.max(limit, 1), LIST_LIMIT_MAX)
    : LIST_LIMIT_MAX;
  const collections = refs(firestore);
  let query = collections.profiles
    .orderBy(FieldPath.documentId())
    .limit(bounded);
  if (typeof startAfter === "string" && startAfter.length > 0) {
    query = query.startAfter(startAfter);
  }
  const profileSnapshot = await query.get();
  const rows = profileSnapshot.docs
    .map((doc) => doc.data())
    .filter(
      (profile) =>
        isAuthorId(profile.authorId) && profileLifecycle(profile) === "active",
    );
  const linked = rows.filter((profile) => typeof profile.uid === "string");
  const staffSnapshots =
    linked.length === 0
      ? []
      : await firestore.getAll(
          ...linked.map((profile) => collections.staff.doc(profile.uid)),
        );
  const activeLinkedIds = new Set();
  linked.forEach((profile, index) => {
    if (staffSnapshots[index]?.data()?.status === "active") {
      activeLinkedIds.add(profile.authorId);
    }
  });
  const authors = [];
  rows.forEach((profile) => {
    if (profile.uid !== null && !activeLinkedIds.has(profile.authorId)) return;
    authors.push({
      authorId: profile.authorId,
      displayName: profile.displayName,
      jobTitle: profile.jobTitle ?? null,
      // Staff need completeness facts, never the private profile or bio text.
      // These come from the records already read for this directory page.
      profileReadiness: profileReadiness(profile),
    });
  });
  // Sorted for the person reading the list, not for the cursor: paging stays on
  // the staff document id, which is stable while a display name is not.
  authors.sort((left, right) =>
    left.displayName.localeCompare(right.displayName),
  );
  return {
    authors,
    nextCursor:
      profileSnapshot.docs.length === bounded
        ? profileSnapshot.docs[profileSnapshot.docs.length - 1].id
        : null,
  };
}

module.exports = {
  ADMIN_PROFILE_CAPABILITY,
  AUDIT_ACTIONS,
  AUTHOR_PROFILE_CAPABILITY,
  AuthorProfileError,
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  SLUG_STATE,
  deactivateStaffLinkage,
  reactivateStaffLinkage,
  archiveProfile,
  assertProfileAdmin,
  createManagedProfile,
  deleteDraftProfile,
  ensureAuthorIdentity,
  listAuthorProfiles,
  listBylineAuthors,
  listLinkableUsers,
  linkProfileToUser,
  publishProfile,
  readProfileByAuthorId,
  readProfileByUid,
  renameProfileSlug,
  staffRecordRef,
  staffStatusFromUserDoc,
  updateWorkingProfile,
  withdrawProfile,
  withdrawProfileForDeactivation,
};
