"use strict";

// Shape parity is held against content-core's document-list.ts in site tests.
const DOCUMENT_LIST_MAX = 100;
function isNoticeAddedAt(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function isDocumentListData(value, complete = true) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).some(key => key !== "documents") || !Array.isArray(value.documents)
    || value.documents.length > DOCUMENT_LIST_MAX) return false;
  const ids = new Set();
  return value.documents.every(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    if (Object.keys(item).some(key => !["itemId", "assetId", "title", "publisher", "addedAt"].includes(key))) return false;
    if (typeof item.itemId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(item.itemId) || ids.has(item.itemId)) return false;
    ids.add(item.itemId);
    return typeof item.assetId === "string" && (item.assetId === "" && !complete || /^[A-Za-z0-9_-]{1,128}$/.test(item.assetId))
      && typeof item.title === "string" && item.title.length <= 300 && (!complete || item.title.trim().length > 0)
      && (item.publisher === undefined || item.publisher === "njpba" || item.publisher === "njpbs")
      && (item.addedAt === undefined && !complete || isNoticeAddedAt(item.addedAt));
  });
}

// Block and entry identities, rather than position or asset, preserve the first-added
// date through title edits, replacement files, reorder, and transaction retries.
function stampDocumentLists(blocks, storedBlocks, timestamp) {
  if (!Array.isArray(blocks)) return blocks;
  const prior = new Map((Array.isArray(storedBlocks) ? storedBlocks : [])
    .filter(block => block?.type === "document_list")
    .map(block => [block.id, new Map((Array.isArray(block.data?.documents) ? block.data.documents : [])
      .filter(item => item && typeof item === "object").map(item => [item.itemId, item.addedAt]))]));
  return blocks.map(block => {
    if (block?.type !== "document_list" || !Array.isArray(block.data?.documents)) return block;
    const documents = block.data.documents.map(item => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const existing = prior.get(block.id)?.get(item.itemId);
      return { ...item, addedAt: isNoticeAddedAt(existing) ? existing : timestamp };
    });
    return { ...block, data: { ...block.data, documents } };
  });
}

module.exports = { DOCUMENT_LIST_MAX, isNoticeAddedAt, isDocumentListData, stampDocumentLists };
