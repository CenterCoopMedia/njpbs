// Generated from packages/content-core/src/town-lookup.ts.
// Regenerate with: node scripts/generate-town-lookup.mjs
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

// packages/content-core/src/town-lookup.ts
var town_lookup_exports = {};
__export(town_lookup_exports, {
  TOWN_LOOKUP_DEFAULTS: () => TOWN_LOOKUP_DEFAULTS,
  isTownLookupData: () => isTownLookupData
});
module.exports = __toCommonJS(town_lookup_exports);
var TOWN_LOOKUP_DEFAULTS = {
  heading: "How your town voted",
  introduction: "Find your municipality to compare past presidential, U.S. Senate and U.S. House results, plus 2024 voter turnout.",
  sourceLine: "Historical results compiled by NJ Spotlight News from election records."
};
function isTownLookupData(value, complete = true) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value;
  if (Object.keys(data).some((key) => !["heading", "introduction", "sourceLine"].includes(key))) return false;
  return typeof data.heading === "string" && data.heading.length <= 200 && (!complete || !!data.heading.trim()) && typeof data.introduction === "string" && data.introduction.length <= 4e3 && typeof data.sourceLine === "string" && data.sourceLine.length <= 500;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  TOWN_LOOKUP_DEFAULTS,
  isTownLookupData
});
