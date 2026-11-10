// Generated from packages/content-core/src/posts-browse.ts.
// Regenerate with: node scripts/generate-posts-browse-contract.mjs
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

// <stdin>
var stdin_exports = {};
__export(stdin_exports, {
  validatePostsBrowse: () => validatePostsBrowse
});
module.exports = __toCommonJS(stdin_exports);

// packages/content-core/src/posts-browse.ts
var POSTS_BROWSE_ICONS = ["ballot", "heart", "train", "leaf", "play", "pin"];
var postsBrowseTermKey = (term) => JSON.stringify([term.filter, term.value]);
var object = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var text = (value, max) => typeof value === "string" && value.trim() === value && value.length > 0 && new TextEncoder().encode(value).length <= max && !/[\u0000-\u001f\u007f]/.test(value);
function validPostsBrowseTerm(value) {
  return object(value) && Object.keys(value).length === 2 && (value.filter === "category" || value.filter === "tag") && text(value.value, 200) && !/^format:/i.test(value.value);
}
function validatePostsBrowse(value) {
  if (!object(value) || Object.keys(value).length !== 1 || !Array.isArray(value.groups) || value.groups.length > 8)
    return "Posts browsing needs at most eight groups.";
  const ids = /* @__PURE__ */ new Set(), terms = /* @__PURE__ */ new Set();
  let total = 0;
  for (const group of value.groups) {
    if (!object(group) || Object.keys(group).some((key) => !["id", "label", "icon", "terms", "cover"].includes(key)) || !text(group.id, 64) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(group.id) || (ids.has(group.id) || group.id === "unassigned-subjects")) return "Each Posts browsing group needs a unique id.";
    ids.add(group.id);
    if (!text(group.label, 80) || !POSTS_BROWSE_ICONS.includes(group.icon)) return "Each Posts browsing group needs a name and an available icon.";
    if (!Array.isArray(group.terms) || group.terms.length > 300) return "A Posts browsing group can contain at most 300 subjects.";
    for (const term of group.terms) {
      if (!validPostsBrowseTerm(term)) return "Choose an exact category or topic for every subject.";
      const key = postsBrowseTermKey(term);
      if (terms.has(key)) return "A subject can belong to only one Posts browsing group.";
      terms.add(key);
    }
    total += group.terms.length;
    if (group.cover !== void 0 && (!validPostsBrowseTerm(group.cover) || !group.terms.some((term) => postsBrowseTermKey(term) === postsBrowseTermKey(group.cover))))
      return "Choose a cover subject that belongs to its group.";
  }
  return total > 600 ? "Posts browsing can arrange at most 600 subjects; other subjects remain searchable." : null;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  validatePostsBrowse
});
