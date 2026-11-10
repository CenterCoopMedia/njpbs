"use strict";

// Staff-readable byline fields are separate from private author and account data.
// Keep a redacted row for each source profile so document-id cursors still page
// the unfiltered source collection before the caller filters ineligible authors.

const { isAuthorId, toPublicAuthorPhoto } = require("./author-profile-contract");

const DIRECTORY_COLLECTION = "cmsBylineDirectory";
const SELF_COLLECTION = "cmsBylineSelf";

function profileReadiness(profile) {
  return {
    hasPhoto: toPublicAuthorPhoto(profile.photo) !== null,
    hasJobTitle: typeof profile.jobTitle === "string" && Boolean(profile.jobTitle.trim()),
    hasBio: typeof profile.bio === "string" && Boolean(profile.bio.trim()),
    published: profile.visibility === "published",
  };
}

function directoryRow(authorId, profile, staff) {
  const eligible =
    profile?.authorId === authorId &&
    isAuthorId(authorId) &&
    profile.lifecycle !== "archived" &&
    typeof profile.displayName === "string" &&
    (profile.jobTitle == null || typeof profile.jobTitle === "string") &&
    (profile.uid === null ||
      (typeof profile.uid === "string" && staff?.status === "active"));

  if (!eligible) return { authorId, eligible: false };
  return {
    authorId,
    displayName: profile.displayName,
    jobTitle: profile.jobTitle ?? null,
    profileReadiness: profileReadiness(profile),
    eligible: true,
  };
}

function syncBylineProjection(transaction, firestore, authorId, profile, staff = null) {
  const directoryRef = firestore.collection(DIRECTORY_COLLECTION).doc(authorId);
  if (profile) {
    transaction.set(directoryRef, directoryRow(authorId, profile, staff));
  } else {
    transaction.delete(directoryRef);
  }

  const uid = typeof profile?.uid === "string" ? profile.uid : staff?.uid;
  if (typeof uid !== "string" || uid.length === 0) return;
  const selfRef = firestore.collection(SELF_COLLECTION).doc(uid);
  if (
    profile &&
    profile.lifecycle !== "archived" &&
    staff?.status === "active" &&
    staff.authorId === authorId
  ) {
    transaction.set(selfRef, { authorId });
  } else {
    transaction.delete(selfRef);
  }
}

module.exports = {
  DIRECTORY_COLLECTION,
  SELF_COLLECTION,
  directoryRow,
  profileReadiness,
  syncBylineProjection,
};
