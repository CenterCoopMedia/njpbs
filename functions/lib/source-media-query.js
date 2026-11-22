"use strict";

function nextNamePrefix(prefix) {
  const characters = Array.from(prefix);
  while (characters.length > 0) {
    const last = characters.pop().codePointAt(0);
    if (last === 0x10FFFF) continue;
    const next = last === 0xD7FF ? 0xE000 : last + 1;
    return characters.join("") + String.fromCodePoint(next);
  }
  return null;
}

function sourceMediaQuery(firestore, sourceId, request, documentIdField) {
  let query = firestore.collection("mediaSourceAssets")
    .where("sourceId", "==", sourceId)
    .where("lifecycle", "==", "active");
  if (request.tag) query = query.where("tags", "array-contains", request.tag);
  if (request.createdBy) query = query.where("createdBy", "==", request.createdBy);
  if (request.rightsStatus) query = query.where("rightsStatus", "==", request.rightsStatus);
  if (request.metadataUpdateRequested) query = query.where("metadataUpdateRequested", "==", true);
  const order = request.q ? "name_asc" : (request.sort ?? "updated_desc");
  let sortField = "updatedAtSort";
  if (order === "name_asc") sortField = "nameSort";
  if (order === "size_desc" || order === "size_asc") sortField = "sizeBytes";
  const direction = order.endsWith("_desc") ? "desc" : "asc";
  if (request.q) {
    const upper = nextNamePrefix(request.q);
    query = query.where("nameSort", ">=", request.q);
    if (upper !== null) query = query.where("nameSort", "<", upper);
  }
  query = query.orderBy(sortField, direction).orderBy(documentIdField, direction);
  if (request.cursor) query = query.startAfter(request.cursor.sort, request.cursor.id);
  return { query, order, sortField };
}

module.exports = { sourceMediaQuery };
