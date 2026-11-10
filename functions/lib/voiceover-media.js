"use strict";

const {
  MAX_AUDIO_BYTES,
  SUPPORTED_MANIFEST_VERSION,
  VoiceoverError,
  isPlainObject,
  takeProjection,
  validId,
} = require("./voiceover-review");

const VOICEOVER_MEDIA_PREFIX = "voiceover-";
const VOICEOVER_OBJECT_KEY_PATTERN = /^takes\/v1\/[a-z0-9][a-z0-9-]{0,149}\.wav$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function projectVoiceoverMedia(data) {
  if (data?.source !== "voiceover" || data.kind !== "audio" ||
      data.mimeType !== "audio/wav" || !validId(data.voiceoverTakeId) ||
      !isPlainObject(data.voiceover) ||
      data.voiceover.manifestVersion !== SUPPORTED_MANIFEST_VERSION ||
      data.voiceover.id !== data.voiceoverTakeId ||
      typeof data.voiceover.performer_name !== "string" ||
      data.voiceover.performer_name.trim().length === 0 ||
      data.voiceover.performer_name.length > 120) {
    return null;
  }

  let take;
  try {
    take = takeProjection(
      data.voiceoverTakeId,
      {
        ...data.voiceover,
        schemaVersion: 1,
        active: true,
      },
      data.voiceover.manifestVersion,
    );
  } catch (error) {
    if (error instanceof VoiceoverError) return null;
    throw error;
  }

  return {
    manifestVersion: data.voiceover.manifestVersion,
    ...take,
    performer_name: data.voiceover.performer_name.trim(),
  };
}

function takeIdFromVoiceoverAssetId(assetId) {
  if (typeof assetId !== "string" || !assetId.startsWith(VOICEOVER_MEDIA_PREFIX)) {
    return null;
  }
  const takeId = assetId.slice(VOICEOVER_MEDIA_PREFIX.length);
  return validId(takeId) ? takeId : null;
}

function voiceoverMediaLocator(assetId, data) {
  const takeId = takeIdFromVoiceoverAssetId(assetId);
  const voiceover = projectVoiceoverMedia(data);
  if (!takeId || !voiceover || voiceover.id !== takeId ||
      data.lifecycle !== "active" ||
      !VOICEOVER_OBJECT_KEY_PATTERN.test(data.storageKey) ||
      data.storageKey !== `takes/v1/${takeId}.wav` ||
      !Number.isSafeInteger(data.sizeBytes) || data.sizeBytes < 1 ||
      data.sizeBytes > MAX_AUDIO_BYTES ||
      !SHA256_PATTERN.test(data.contentHash)) {
    return null;
  }
  return {
    takeId,
    voiceover,
    objectKey: data.storageKey,
    sizeBytes: data.sizeBytes,
    contentHash: data.contentHash,
  };
}

module.exports = {
  SHA256_PATTERN,
  VOICEOVER_MEDIA_PREFIX,
  VOICEOVER_OBJECT_KEY_PATTERN,
  projectVoiceoverMedia,
  takeIdFromVoiceoverAssetId,
  voiceoverMediaLocator,
};
