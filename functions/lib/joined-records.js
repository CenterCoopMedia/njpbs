"use strict";

const { visibleLayoutBlocks } = require("./content-layout");
const { approvedLibraryVersion } = require("./approved-library-records");
const { assertPublishedAssetProjection } = require("./published-media-safety");
const { SECTION_BLOCK_CATALOG } = require("./editor-section-contract");

const HISTORY_CHUNK = 10;

// Every block the editor can place in a Post publishes build-free. The Post
// template renders each one through the shared block renderer, so the editor
// catalog is the single source of truth for acceptance, the public reader and
// the renderer (#3409). A type outside the catalog is refused by name.
const JOINED_TYPES = new Set(["record_card", "sponsor_strip", "newsletter_signup"]);
const RECORD_ID = /^[A-Za-z0-9_-]{1,128}$/;

function instantBlockAllowed(type) {
  return SECTION_BLOCK_CATALOG.post.includes(type);
}

function unsupportedPostBlockReason(type) {
  return `This Post has a ${String(type).replace(/_/g, " ")} block, which Posts cannot publish. Remove or hide it, then publish again.`;
}

function addId(ids, seen, id) {
  if (typeof id !== "string" || !RECORD_ID.test(id) || seen.has(id)) return;
  seen.add(id);
  ids.push(id);
}

/** Ids the Post template joins. Hidden blocks and unknown ids are omitted. */
function joinedRecordIds(blocks) {
  const ids = [];
  const seen = new Set();
  for (const block of visibleLayoutBlocks(blocks ?? [])) {
    if (block.type === "record_card") addId(ids, seen, block.data?.recordId);
    if (block.type === "sponsor_strip") for (const id of block.data?.sponsorIds ?? []) addId(ids, seen, id);
    if (block.type === "newsletter_signup") for (const id of block.data?.newsletterIds ?? []) addId(ids, seen, id);
  }
  return ids;
}

function publicSnapshotFields(published) {
  return {
    sourceVersion: published.sourceVersion,
    publishedAt: published.publishedAt,
    metadata: published.metadata,
    blocks: Array.isArray(published.blocks) ? published.blocks : [],
  };
}

/** Current public fields only. A missing or non-public reference is omitted. */
function shapeJoinedRecord(id, data, history = []) {
  if (!data || typeof data !== "object") return null;
  const publishedType = data.published?.metadata?.type;
  if (publishedType === "program" || publishedType === "event") {
    if (data.publiclyVisible !== true || data.deleted === true || !data.published) return null;
    return {
      id,
      status: data.status,
      publishAt: data.publishAt,
      publiclyVisible: true,
      deleted: false,
      published: publicSnapshotFields(data.published),
    };
  }
  if (data.type !== "sponsor" && data.type !== "newsletter") return null;
  const approved = approvedLibraryVersion({ ...data, id }, history);
  if (!approved) return null;
  return {
    id,
    type: data.type,
    deleted: false,
    status: data.status,
    version: data.version,
    approvedLibraryVersion: publicLibraryCard(approved),
  };
}

function clip(value, max) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, max) : "";
}

function richSummary(value) {
  const walk = (node) => {
    if (!node || typeof node !== "object") return "";
    if (typeof node.text === "string") return node.text;
    return Array.isArray(node.content) ? node.content.map(walk).join(" ") : "";
  };
  return walk(value).replace(/\s+/g, " ").trim().slice(0, 300);
}

/** The response carries the public card, not the stored approval document. */
function publicLibraryCard(approved) {
  const base = { id: approved.id, type: approved.type, status: approved.status, deleted: false, version: approved.version };
  if (approved.type === "newsletter") {
    const summary = clip(approved.summary, 300) || richSummary(approved.body);
    const imageAssetId = clip(approved.imageAssetId, 128);
    return {
      ...base,
      title: clip(approved.title, 300),
      signupUrl: clip(approved.signupUrl, 2000),
      ...(clip(approved.frequency, 80) ? { frequency: clip(approved.frequency, 80) } : {}),
      ...(summary ? { summary } : {}),
      ...(imageAssetId ? {
        imageAssetId,
        imageAlt: approved.imageDecorative === true ? "" : clip(approved.imageAlt, 300),
        imageDecorative: approved.imageDecorative === true,
      } : {}),
    };
  }
  const logoAssetId = clip(approved.logoAssetId, 128);
  return {
    ...base,
    ...(clip(approved.name, 300) ? { name: clip(approved.name, 300) } : {}),
    ...(clip(approved.href, 2000) ? { href: clip(approved.href, 2000) } : {}),
    ...(logoAssetId ? { logoAssetId } : {}),
    ...(approved.logoDecorative === true ? { logoDecorative: true, logoAlt: "" } : {}),
    ...(!approved.logoDecorative && clip(approved.logoAlt, 300) ? { logoAlt: clip(approved.logoAlt, 300) } : {}),
    ...(clip(approved.tier, 80) ? { tier: clip(approved.tier, 80) } : {}),
    ...(clip(approved.description, 300) ? { description: clip(approved.description, 300) } : {}),
    ...(clip(approved.activeFrom, 10) ? { activeFrom: clip(approved.activeFrom, 10) } : {}),
    ...(clip(approved.activeUntil, 10) ? { activeUntil: clip(approved.activeUntil, 10) } : {}),
  };
}

function versionHistoryIdChunks(ids) {
  const chunks = [];
  for (let index = 0; index < ids.length; index += HISTORY_CHUNK) chunks.push(ids.slice(index, index + HISTORY_CHUNK));
  return chunks;
}

async function readLibraryHistory(firestore, tx, ids) {
  const byId = new Map(ids.map(id => [id, []]));
  const snapshots = await Promise.all(versionHistoryIdChunks(ids).map(chunk => tx.get(
    firestore.collection("cmsVersionHistory").where("collection", "==", "cmsPosts").where("documentId", "in", chunk),
  )));
  for (const snapshot of snapshots) {
    for (const doc of snapshot.docs ?? []) {
      const data = doc.data();
      if (byId.has(data.documentId)) byId.get(data.documentId).push(data);
    }
  }
  return byId;
}

function pairedAssetPaths(ids) {
  return ids.flatMap(id => [`media_assets/${id}`, `media_assets_public/${id}`]);
}

function projectPairedAsset({ assetId, privateSnapshot, publicSnapshot, uploadedMediaReady }) {
  return assertPublishedAssetProjection({
    assetId, owner: "published Post", privateSnapshot, publicSnapshot, uploadedMediaReady,
  });
}

function joinedAssetIds(records) {
  const ids = [];
  const seen = new Set();
  for (const record of records) {
    const metadata = record.published?.metadata;
    if (metadata?.type === "program") addId(ids, seen, metadata.keyArtAssetId);
    if (metadata?.type === "event") addId(ids, seen, metadata.imageAssetId);
    if (record.approvedLibraryVersion?.type === "sponsor") addId(ids, seen, record.approvedLibraryVersion.logoAssetId);
    if (record.approvedLibraryVersion?.type === "newsletter") addId(ids, seen, record.approvedLibraryVersion.imageAssetId);
  }
  return ids;
}

function publicJoinedAsset(id, data) {
  if (!data || typeof data.url !== "string" || typeof data.mimeType !== "string") return null;
  return {
    id,
    url: data.url,
    mimeType: data.mimeType,
    ...(Number.isInteger(data.width) ? { width: data.width } : {}),
    ...(Number.isInteger(data.height) ? { height: data.height } : {}),
  };
}

module.exports = {
  JOINED_TYPES, instantBlockAllowed, unsupportedPostBlockReason, joinedRecordIds,
  shapeJoinedRecord, joinedAssetIds, publicJoinedAsset,
  versionHistoryIdChunks, readLibraryHistory, pairedAssetPaths, projectPairedAsset,
};
