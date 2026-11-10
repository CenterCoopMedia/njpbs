"use strict";

const logger = require("firebase-functions/logger");
const { cmsOnRequest } = require("./lib/cms-edge");
const { db } = require("./lib/firebase");
const { requirePrincipal } = require("./lib/auth");
const { validateBoundedJsonRequest } = require("./lib/http-json");
const { isAudioReadAdmitted, mayUseMedia } = require("./lib/media-access");
const {
  REVIEWS_COLLECTION,
  VoiceoverError,
  parseReviewRequest,
  requireAdmittedStaff,
  reviewProjection,
} = require("./lib/voiceover-review");
const {
  projectVoiceoverMedia,
  takeIdFromVoiceoverAssetId,
} = require("./lib/voiceover-media");

const MAX_REVIEW_REQUEST_BYTES = 8 * 1024;
const OBSOLETE_REVIEW_MESSAGE =
  "Voiceovers now live in Audio. Reload Boardwalk to continue.";

function reviewReference(firestore, uid, takeId) {
  return firestore
    .collection(REVIEWS_COLLECTION)
    .doc(uid)
    .collection("takes")
    .doc(takeId);
}

function authorizedVoiceoverMedia(
  assetId,
  snapshot,
  principal,
  audioReadAdmitted = false,
) {
  const stored = snapshot.exists ? snapshot.data() : null;
  const takeId = takeIdFromVoiceoverAssetId(assetId);
  const voiceover = projectVoiceoverMedia(stored);
  if (!stored || stored.lifecycle !== "active" ||
      !mayUseMedia(principal, stored.category, stored.kind, audioReadAdmitted) ||
      !takeId || !voiceover || voiceover.id !== takeId) {
    throw new VoiceoverError(404, "This voiceover take is unavailable.");
  }
  return { takeId, voiceover };
}

function sendFailure({ error, res, log, operation }) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  if (status >= 500) log.error(`${operation} failed`, error);
  res.status(status).json({
    error: status >= 500
      ? "The voiceover library is unavailable. Try again."
      : error.message,
    ...(error instanceof VoiceoverError && error.code ? { code: error.code } : {}),
  });
}

async function getMediaReview(firestore, user, request) {
  const assetSnapshot = await firestore
    .collection("media_assets")
    .doc(request.assetId)
    .get();
  const { takeId, voiceover } = authorizedVoiceoverMedia(
    request.assetId,
    assetSnapshot,
    user.principal,
    isAudioReadAdmitted(user),
  );
  const reviewSnapshot = await reviewReference(firestore, user.uid, takeId).get();
  return {
    success: true,
    review: reviewSnapshot.exists
      ? reviewProjection(takeId, reviewSnapshot.data(), voiceover.manifestVersion)
      : null,
  };
}

async function saveMediaReview(firestore, user, request, now) {
  const takeId = takeIdFromVoiceoverAssetId(request.assetId);
  if (!takeId) {
    throw new VoiceoverError(404, "This voiceover take is unavailable.");
  }
  const assetRef = firestore.collection("media_assets").doc(request.assetId);
  const reviewRef = reviewReference(firestore, user.uid, takeId);

  return firestore.runTransaction(async (transaction) => {
    const [assetSnapshot, reviewSnapshot] = await Promise.all([
      transaction.get(assetRef),
      transaction.get(reviewRef),
    ]);
    const media = authorizedVoiceoverMedia(
      request.assetId,
      assetSnapshot,
      user.principal,
      isAudioReadAdmitted(user),
    );
    const current = reviewSnapshot.exists
      ? reviewProjection(
          takeId,
          reviewSnapshot.data(),
          media.voiceover.manifestVersion,
        )
      : null;
    const currentVersion = current?.version ?? 0;
    if (request.baseVersion !== currentVersion) {
      throw new VoiceoverError(
        409,
        "This voiceover review changed. Reload it before saving.",
        "voiceover_review_conflict",
      );
    }

    const updatedAt = now();
    const stored = {
      schemaVersion: 1,
      manifestVersion: media.voiceover.manifestVersion,
      takeId,
      favorite: current?.favorite ?? false,
      moreLikeThis: request.moreLikeThis,
      notes: request.notes,
      version: currentVersion + 1,
      createdAt: reviewSnapshot.exists
        ? reviewSnapshot.data().createdAt ?? updatedAt
        : updatedAt,
      updatedAt,
    };
    transaction.set(reviewRef, stored);
    return {
      success: true,
      review: reviewProjection(
        takeId,
        stored,
        media.voiceover.manifestVersion,
      ),
    };
  });
}

function createCmsVoiceoverReviewHandler({
  firestore = db,
  requirePrincipalFn = requirePrincipal,
  now = () => new Date().toISOString(),
  log = logger,
} = {}) {
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }
    try {
      validateBoundedJsonRequest(req, MAX_REVIEW_REQUEST_BYTES);
      const user = await requirePrincipalFn(req, { includeAccountStatus: true });
      requireAdmittedStaff(user);
      const request = parseReviewRequest(req.body);
      if (request.action === "list" || request.action === "save") {
        throw new VoiceoverError(
          409,
          OBSOLETE_REVIEW_MESSAGE,
          "voiceover_review_obsolete",
        );
      }
      let body;
      if (request.action === "get-media") {
        body = await getMediaReview(firestore, user, request);
      } else {
        body = await saveMediaReview(firestore, user, request, now);
      }
      return res.status(200).json(body);
    } catch (error) {
      return sendFailure({ error, res, log, operation: "cmsVoiceoverReview" });
    }
  };
}

module.exports = {
  MAX_REVIEW_REQUEST_BYTES,
  OBSOLETE_REVIEW_MESSAGE,
  authorizedVoiceoverMedia,
  createCmsVoiceoverReviewHandler,
  getMediaReview,
  reviewReference,
  saveMediaReview,
  cmsVoiceoverReview: cmsOnRequest(
    { cors: true, cpu: 1, concurrency: 1 },
    createCmsVoiceoverReviewHandler(),
  ),
};
