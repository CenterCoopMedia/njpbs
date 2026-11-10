"use strict";

function refuse() { throw Object.assign(new Error("Rendered record source binding is unavailable"), { status: 409 }); }
function canonical(value) {
  return Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
/** Bind the actual live render input before shadow projection drops source
 * tags. The Page's native Post lineup has its own joined record inputs too.
 * This is a rendered-input fence, never evidence of family completion. */
function recordSourceBindingPayload(context) {
  const entries = new Map();
  for (const records of [context?.joinedRecords ?? [], ...(context?.posts ?? []).map(post => post.joinedRecords ?? [])]) {
    if (!Array.isArray(records) || records.length > 100) refuse();
    for (const record of records) {
      if (!record?.activeSource) continue;
      if (typeof record.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(record.id) ||
          !Number.isSafeInteger(record.published?.sourceVersion) || record.published.sourceVersion < 1 ||
          !["code", "preparation"].includes(record.activeSource.kind)) refuse();
      const value = canonical({ documentId: record.id, sourceVersion: record.published.sourceVersion, activeSource: record.activeSource });
      const encoded = JSON.stringify(value);
      if (entries.has(record.id) && entries.get(record.id) !== encoded) refuse();
      entries.set(record.id, encoded);
    }
  }
  if (entries.size > 1000) refuse();
  return JSON.stringify([...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
module.exports = { recordSourceBindingPayload };
