// Generated from packages/content-core/src/published-vocabulary.ts.
// Regenerate with: node scripts/generate-published-vocabulary.mjs
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// packages/content-core/src/published-vocabulary.ts
var published_vocabulary_exports = {};
__export(published_vocabulary_exports, {
  editorialTermKey: () => editorialTermKey,
  publishedVocabulary: () => publishedVocabulary
});
module.exports = __toCommonJS(published_vocabulary_exports);
var editorialTermKey = (value) => value.trim().toLocaleLowerCase("en-US");
function terms(values, seen) {
  if (!Array.isArray(values)) return;
  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    const key = editorialTermKey(value);
    if (key && !key.startsWith("format:") && !seen.has(key)) seen.set(key, value);
  }
}
function publishedVocabulary(records) {
  const tags = /* @__PURE__ */ new Map();
  const categories = /* @__PURE__ */ new Map();
  for (const record of records) {
    if (record.type !== "post" || record.deleted === true || record.publiclyVisible === false || record.publiclyVisible !== true && record.status !== "published" || record.publishBuildPending === true) continue;
    const snapshot = record.published;
    const sourceVersion = snapshot?.sourceVersion;
    if (typeof sourceVersion !== "number" || !Number.isSafeInteger(sourceVersion) || sourceVersion < 1 || record.publicSourceVersion !== void 0 && record.publicSourceVersion !== sourceVersion) continue;
    terms(snapshot?.metadata?.tags, tags);
    terms(snapshot?.metadata?.categories, categories);
  }
  const sorted = (values) => [...values.values()].sort((a, b) => a.localeCompare(b, "en-US"));
  return { tags: sorted(tags), categories: sorted(categories) };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  editorialTermKey,
  publishedVocabulary
});
