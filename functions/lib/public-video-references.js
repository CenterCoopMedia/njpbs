"use strict";
const { liveBlogVideoBlocks } = require("./live-blog");

const { leadVideoBlocks } = require("./post-lead-media");
const { visibleLayoutBlocks } = require("./content-layout");
const {
  isPublicVideoData,
  isPublicVideoUrl,
  VIDEO_BLOCK_SOURCE_ID,
} = require("./video-block");

function publiclyVisible(document) {
  return (
    !document?.deleted &&
    (document?.publiclyVisible === true ||
      (document?.publiclyVisible === undefined &&
        document?.status === "published"))
  );
}

function validCopy(copy) {
  return (
    typeof copy?.assetId === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(copy.assetId) &&
    (isPublicVideoUrl(copy.url, "mp4") || isPublicVideoUrl(copy.url, "jpg")) &&
    new URL(copy.url).pathname.startsWith(`/cms-media/video/${copy.assetId}/`)
  );
}

function videoCopies(blocks) {
  if (!Array.isArray(blocks)) return [];
  return visibleLayoutBlocks(blocks).flatMap((block) => {
    const media = block?.data?.public;
    if (block.type !== "video" || !isPublicVideoData(media)) return [];
    const copies = [media.url, media.posterUrl].map((url) => ({
      assetId: block.data.assetId,
      url,
    }));
    return copies.every(validCopy) ? copies : [];
  });
}

function previousVideoCopies(snapshot) {
  return Array.isArray(snapshot?.previousVideoCopies)
    ? snapshot.previousVideoCopies
        .filter(validCopy)
        .map(({ assetId, url }) => ({ assetId, url }))
    : [];
}

function pendingPublicRevision(document) {
  return (
    publiclyVisible(document) &&
    (document.publishBuildPending === true ||
      (document.publicSourceVersion !== undefined &&
        document.publicSourceVersion !== document.published?.sourceVersion))
  );
}

function publicCopies(document, includePrevious = false) {
  if (!publiclyVisible(document)) return [];
  return [
    ...videoCopies([...(document.published?.blocks ?? []), ...leadVideoBlocks(document.published?.metadata?.leadMedia),
      ...liveBlogVideoBlocks(document.published?.metadata?.type === "post" ? document.published.metadata.liveBlog : undefined)]),
    ...(pendingPublicRevision(document) || includePrevious
      ? previousVideoCopies(document.published)
      : []),
  ];
}

function scheduledVideoAssetIds(document) {
  if (
    document?.deleted ||
    document?.status !== "scheduled" ||
    !Array.isArray(document.blocks)
  )
    return [];
  return visibleLayoutBlocks(
    [...leadVideoBlocks(document.leadMedia), ...liveBlogVideoBlocks(document.type === "post" ? document.liveBlog : undefined), ...document.blocks.filter((block) => block && typeof block === "object")],
  )
    .filter(
      (block) =>
        block.type === "video" &&
        block.data?.sourceId === VIDEO_BLOCK_SOURCE_ID &&
        typeof block.data.assetId === "string" &&
        /^[A-Za-z0-9_-]{1,128}$/.test(block.data.assetId),
    )
    .map((block) => block.data.assetId);
}

module.exports = {
  publiclyVisible,
  publicCopies,
  videoCopies,
  previousVideoCopies,
  pendingPublicRevision,
  scheduledVideoAssetIds,
};
