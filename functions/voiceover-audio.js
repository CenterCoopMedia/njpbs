"use strict";

const { pipeline } = require("node:stream/promises");
const { defineSecret, defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { cmsOnRequest } = require("./lib/cms-edge");
const { db } = require("./lib/firebase");
const { requirePrincipal } = require("./lib/auth");
const { validateBoundedJsonRequest } = require("./lib/http-json");
const { isAudioReadAdmitted, mayUseMedia } = require("./lib/media-access");
const { R2VoiceoverStorage } = require("./lib/r2-voiceover");
const {
  VoiceoverError,
  parseAudioRequest,
  requireAdmittedStaff,
} = require("./lib/voiceover-review");
const {
  SHA256_PATTERN,
  VOICEOVER_MEDIA_PREFIX,
  VOICEOVER_OBJECT_KEY_PATTERN: OBJECT_KEY_PATTERN,
  projectVoiceoverMedia,
  voiceoverMediaLocator,
} = require("./lib/voiceover-media");

const R2_ACCESS_KEY_ID = defineSecret("CMS_VOICEOVER_R2_ACCESS_KEY_ID");
const R2_SECRET_ACCESS_KEY = defineSecret("CMS_VOICEOVER_R2_SECRET_ACCESS_KEY");
const R2_ENDPOINT = defineString("CMS_VOICEOVER_R2_ENDPOINT", { default: "" });
const R2_BUCKET = defineString("CMS_VOICEOVER_R2_BUCKET", {
  default: "njpbs-cms-voiceover",
});
const MAX_AUDIO_REQUEST_BYTES = 2 * 1024;

function configuredStorage() {
  return new R2VoiceoverStorage({
    endpoint: R2_ENDPOINT.value(),
    bucket: R2_BUCKET.value(),
    accessKeyId: R2_ACCESS_KEY_ID.value(),
    secretAccessKey: R2_SECRET_ACCESS_KEY.value(),
  });
}

async function sendAudio({ audio, metadata, takeId, res }) {
  if (!audio?.body || audio.contentType !== "audio/wav" ||
      audio.contentLength !== metadata.sizeBytes ||
      audio.metadata?.sha256 !== metadata.contentHash) {
    throw new VoiceoverError(503, "The voiceover audio is unavailable.");
  }
  res.status(200);
  res.set("Cache-Control", "private, no-store");
  res.set("Content-Type", "audio/wav");
  res.set("Content-Length", String(metadata.sizeBytes));
  res.set("Content-Disposition", `inline; filename="${takeId}.wav"`);
  res.set("X-Content-Type-Options", "nosniff");
  if (typeof audio.body.pipe !== "function") {
    throw new VoiceoverError(503, "The voiceover audio is unavailable.");
  }
  await pipeline(audio.body, res);
}

function createCmsGetVoiceoverAudioHandler({
  firestore = db,
  requirePrincipalFn = requirePrincipal,
  storageFactory = configuredStorage,
  log = logger,
} = {}) {
  return async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }
    try {
      validateBoundedJsonRequest(req, MAX_AUDIO_REQUEST_BYTES);
      const user = await requirePrincipalFn(req, { includeAccountStatus: true });
      requireAdmittedStaff(user);
      const request = parseAudioRequest(req.body);
      const assetId = request.assetId ?? `${VOICEOVER_MEDIA_PREFIX}${request.takeId}`;
      const assetSnapshot = await firestore
        .collection("media_assets")
        .doc(assetId)
        .get();
      const stored = assetSnapshot.exists ? assetSnapshot.data() : null;
      if (!stored || stored.lifecycle !== "active" ||
          !mayUseMedia(
            user.principal, stored.category, stored.kind, isAudioReadAdmitted(user),
          ) ||
          !projectVoiceoverMedia(stored)) {
        throw new VoiceoverError(404, "This voiceover take is unavailable.");
      }
      const metadata = voiceoverMediaLocator(assetId, stored);
      if (!metadata) {
        throw new VoiceoverError(503, "The voiceover audio is unavailable.");
      }
      const audio = await storageFactory().getIfExists(metadata.objectKey);
      if (!audio) {
        throw new VoiceoverError(503, "The voiceover audio is unavailable.");
      }
      await sendAudio({ audio, metadata, takeId: metadata.takeId, res });
    } catch (error) {
      if (res.headersSent) {
        log.error("cmsGetVoiceoverAudio stream failed", error);
        res.destroy(error);
        return;
      }
      const status = Number.isInteger(error?.status) ? error.status : 500;
      if (status >= 500) log.error("cmsGetVoiceoverAudio failed", error);
      res.status(status).json({
        error: status >= 500
          ? "The voiceover audio is unavailable. Try again."
          : error.message,
      });
    }
  };
}

module.exports = {
  MAX_AUDIO_REQUEST_BYTES,
  OBJECT_KEY_PATTERN,
  SHA256_PATTERN,
  configuredStorage,
  createCmsGetVoiceoverAudioHandler,
  sendAudio,
  cmsGetVoiceoverAudio: cmsOnRequest(
    {
      cors: true,
      secrets: [R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY],
      timeoutSeconds: 30,
    },
    createCmsGetVoiceoverAudioHandler(),
  ),
};
