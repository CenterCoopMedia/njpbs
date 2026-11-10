"use strict";

const sharp = require("sharp");
const {
  MAX_WEB_COPY_PIXELS,
  publicMediaUrl,
  thumbnailObjectKey,
} = require("./media-contract");

class MediaThumbnailError extends Error {
  constructor(message) {
    super(message);
    this.name = "MediaThumbnailError";
  }
}

function thumbnailWidths(width) {
  if (!Number.isSafeInteger(width) || width < 1) {
    throw new Error("The image width is invalid");
  }
  const smaller = [480, 960, 1600].filter((target) => target <= width);
  return smaller.length ? smaller : [width];
}

async function createMediaThumbnails({
  buffer,
  width,
  category,
  assetId,
  contentHash,
  publicOrigin,
  storage,
  // Receives the keys this call wrote, so a caller whose record changed meanwhile
  // can remove objects that nothing will reference.
  createdKeys = [],
}) {
  const thumbnails = [];
  // Inspection allows larger originals than this synchronous work can safely
  // decode. Bound the first-frame input to the web-copy budget before resizing;
  // each width renders from a clone of the same pipeline.
  const source = sharp(buffer, {
    animated: false,
    failOn: "error",
    limitInputPixels: MAX_WEB_COPY_PIXELS,
  }).rotate();
  // A failed width leaves any earlier width in R2 without a record. That object
  // is not deleted: a concurrent upload or backfill of the same asset may already
  // have adopted the same content-addressed key. A later backfill attaches it.
  for (const target of thumbnailWidths(width)) {
    let rendered;
    try {
      rendered = await source
        .clone()
        .resize({ width: target, withoutEnlargement: true })
        .webp({ quality: 75 })
        .toBuffer({ resolveWithObject: true });
    } catch {
      // Keep image failures distinct from R2 and database failures.
      throw new MediaThumbnailError("The image cannot be rendered as a thumbnail");
    }
    const { data, info } = rendered;
    const storageKey = thumbnailObjectKey({
      category, assetId, contentHash, width: info.width,
    });
    const metadata = {
      contenthash: contentHash,
      assetid: assetId,
      width: String(info.width),
    };
    const result = await storage.putFinal({
      key: storageKey,
      body: data,
      mimeType: "image/webp",
      metadata,
    });
    if (result?.created === false) {
      const existing = await storage.head(storageKey);
      // WebP bytes can differ between sharp versions, so an earlier render of
      // the same hash and width is accepted by its metadata, not by its length.
      if (
        existing.contentType !== "image/webp" ||
        existing.metadata?.contenthash !== contentHash ||
        existing.metadata?.assetid !== assetId ||
        existing.metadata?.width !== String(info.width)
      ) {
        throw new Error("The immutable thumbnail key is occupied");
      }
    } else {
      createdKeys.push(storageKey);
    }
    thumbnails.push({
      width: info.width,
      height: info.height,
      storageKey,
      url: publicMediaUrl(publicOrigin, storageKey),
    });
  }
  return thumbnails;
}

async function addMediaThumbnails({
  firestore,
  storage,
  record,
  buffer,
  publicOrigin,
  log,
}) {
  if (record.kind !== "image") return record;
  const createdKeys = [];
  try {
    // The original and its retry state are already committed. Only an image
    // failure is permanent; storage or persistence failures leave it retryable.
    let patch;
    try {
      const thumbnails = await createMediaThumbnails({
        buffer,
        width: record.width,
        category: record.category,
        assetId: record.id,
        contentHash: record.contentHash,
        publicOrigin,
        storage,
        createdKeys,
      });
      patch = { thumbnails, thumbnailStatus: "ready" };
    } catch (error) {
      if (!(error instanceof MediaThumbnailError)) throw error;
      log.warn("Media thumbnails could not be saved", { assetId: record.id, error: error.name });
      patch = { thumbnailStatus: "unavailable" };
    }
    const ref = firestore.collection("media_assets").doc(record.id);
    const updated = await firestore.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const current = snapshot.exists ? snapshot.data() : null;
      if (
        !current ||
        current.lifecycle !== "active" ||
        current.contentHash !== record.contentHash ||
        current.storageKey !== record.storageKey
      ) {
        return "stale";
      }
      // Return the committed document so a metadata edit that landed after the
      // upload keeps its fields and version in the response.
      if (Array.isArray(current.thumbnails) && thumbnailWidths(record.width).every((width) =>
        current.thumbnails.some((thumbnail) => thumbnail.width === width))) {
        return { ...current, id: record.id };
      }
      transaction.update(ref, patch);
      return { ...current, id: record.id, ...patch };
    });
    if (updated === "stale") {
      // The asset was replaced or withdrawn meanwhile. No record can name these
      // keys, because each key holds this asset id and the old content hash.
      await Promise.allSettled(createdKeys.map((key) => storage.deleteFinal(key)));
      return record;
    }
    return updated;
  } catch (error) {
    log.warn("Media thumbnails could not be saved", {
      assetId: record.id,
      error: error?.name || "Error",
    });
    return record;
  }
}

module.exports = {
  MediaThumbnailError,
  addMediaThumbnails,
  createMediaThumbnails,
  thumbnailWidths,
};
