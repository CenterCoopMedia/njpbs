"use strict";

// Media tab counts ride on list calls the Admin already makes (cmsListMedia and
// cmsListMediaSources, each behind an opt-in `counts: true` flag). Every number is an exact
// read-time answer: a Firestore count() or a total the caller already holds. Nothing is stored.
//
// A count is included only when the caller could open that tab's list, and it is left out,
// never sent as 0, when its check or query fails. The helper logs one warning per request and
// never throws, so a count failure cannot break the list it rides on.

const { aggregationCount } = require("./count-query");
const { isAudioReadAdmitted } = require("./media-access");
const { hasCapability } = require("./rbac");
const {
  MediaSourceAccessError,
  authorizeMediaSource,
  hasActiveArchiveCategory,
} = require("./media-sources");

const MEDIA_CAPABILITIES = Object.freeze(["media.upload", "media.manage"]);
const IMAGE_CAPABILITIES = Object.freeze(["media.image.read", ...MEDIA_CAPABILITIES]);
const AUDIO_CAPABILITIES = Object.freeze(["media.audio.read", ...MEDIA_CAPABILITIES]);
const FAVORITES_COLLECTION = "mediaFavorites";
const FAVORITES_ITEMS_COLLECTION = "items";

class CountUnavailable extends Error {}

function exactCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new CountUnavailable("invalid count");
  return value;
}

function mayOpenImages(principal) {
  return MEDIA_CAPABILITIES.some((capability) => hasCapability(principal, capability));
}

// Counts use the same site-wide media capability as the list. Areas never
// constrain media; an absent capability returns no assets.
async function countVisibleMedia(principal, query, capabilities = MEDIA_CAPABILITIES) {
  if (!capabilities.some((capability) => hasCapability(principal, capability))) return 0;
  return exactCount(await aggregationCount(query));
}

function activeMedia(firestore) {
  return firestore.collection("media_assets").where("lifecycle", "==", "active");
}

// Audio files appear only on the Audio tab.
function countVisibleAudio(firestore, principal, capabilities = AUDIO_CAPABILITIES) {
  return countVisibleMedia(principal, activeMedia(firestore).where("kind", "==", "audio"), capabilities);
}

// Images lists images and PDF documents: every visible active asset except audio.
async function countVisibleImages(firestore, principal, audioCount) {
  const [all, audio] = await Promise.all([
    countVisibleMedia(principal, activeMedia(firestore), IMAGE_CAPABILITIES),
    audioCount ?? countVisibleAudio(firestore, principal, IMAGE_CAPABILITIES),
  ]);
  return exactCount(all - audio);
}

// The same base query the video tab pages through, so the count matches what it can show.
async function countSourceVideos(firestore, sourceId) {
  return exactCount(await aggregationCount(firestore
    .collection("mediaSourceAssets")
    .where("sourceId", "==", sourceId)
    .where("lifecycle", "==", "active")
    .orderBy("updatedAtSort", "desc")));
}

async function countFavorites(firestore, uid) {
  return exactCount(await aggregationCount(firestore
    .collection(FAVORITES_COLLECTION)
    .doc(uid)
    .collection(FAVORITES_ITEMS_COLLECTION)));
}

async function browsableSources({ firestore, actor, registry, approvedActive, authorizeFn, failed }) {
  let archiveCategory;
  const archiveCategoryActiveFn = (store) => {
    archiveCategory ??= hasActiveArchiveCategory(store);
    return archiveCategory;
  };
  const allowed = [];
  for (const source of registry.values()) {
    try {
      await authorizeFn({
        firestore,
        actor,
        source,
        operation: "browse",
        isApprovedActiveAccountFn: async () => approvedActive,
        archiveCategoryActiveFn,
      });
      allowed.push(source.id);
    } catch (error) {
      if (!(error instanceof MediaSourceAccessError) || error.status >= 500) {
        failed.push(`sources.${source.id}`);
      }
    }
  }
  return allowed;
}

/**
 * @returns {Promise<{images?: number, audio?: number, favorites?: number, voiceovers?: number,
 *   sources?: Record<string, number>}>}
 */
async function computeMediaTabCounts({
  firestore,
  actor,
  registry,
  approvedActive,
  imagesCount,
  browseSourceIds,
  authorizeFn = authorizeMediaSource,
  log,
}) {
  const failed = [];
  const tasks = [];
  const principal = actor?.principal;

  // Explicit null is an indexed list whose global count is still unknown. Do not turn
  // that state into a second unbounded aggregation; callers can display the tab label.
  const audioReadAdmitted = isAudioReadAdmitted(actor, approvedActive);
  const imagesAllowed = mayOpenImages(principal) ||
    (audioReadAdmitted && hasCapability(principal, "media.image.read"));
  const audioCapabilities = audioReadAdmitted ? AUDIO_CAPABILITIES : MEDIA_CAPABILITIES;
  let audio;
  if (imagesAllowed || audioReadAdmitted) {
    audio = countVisibleAudio(firestore, principal, audioCapabilities);
    tasks.push(["audio", audio]);
    // Deprecated response compatibility. Both fields use the same authorized query promise.
    tasks.push(["voiceovers", audio]);
  }
  if (imagesAllowed) {
    if (imagesCount !== null) {
      tasks.push(["images", Number.isSafeInteger(imagesCount) && imagesCount >= 0
        ? Promise.resolve(imagesCount)
        : countVisibleImages(firestore, principal, audio)]);
    }
  }
  if (approvedActive === true && typeof actor?.uid === "string" && actor.uid.length > 0) {
    tasks.push(["favorites", countFavorites(firestore, actor.uid)]);
    const sourceIds = Array.isArray(browseSourceIds)
      ? browseSourceIds.filter((id) => registry.has(id))
      : await browsableSources({ firestore, actor, registry, approvedActive, authorizeFn, failed });
    for (const id of sourceIds) tasks.push([`sources.${id}`, countSourceVideos(firestore, id)]);
  }
  const results = await Promise.allSettled(tasks.map(([, task]) => task));
  const counts = {};
  results.forEach((result, index) => {
    const key = tasks[index][0];
    if (result.status === "rejected") {
      failed.push(key);
      return;
    }
    if (key.startsWith("sources.")) {
      counts.sources ??= {};
      counts.sources[key.slice("sources.".length)] = result.value;
    } else {
      counts[key] = result.value;
    }
  });
  if (failed.length > 0) {
    log?.warn?.("Media tab counts left out", { uid: actor?.uid ?? null, failed });
  }
  return counts;
}

module.exports = {
  computeMediaTabCounts,
  countVisibleAudio,
  countVisibleImages,
};
