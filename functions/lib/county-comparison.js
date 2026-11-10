// Generated from packages/content-core/src/county-comparison.ts.
// Regenerate with: node scripts/generate-county-comparison.mjs
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

// packages/content-core/src/county-comparison.ts
var county_comparison_exports = {};
__export(county_comparison_exports, {
  COUNTY_COMPARISON_DEFAULTS: () => COUNTY_COMPARISON_DEFAULTS,
  COUNTY_COMPARISON_VERSION: () => COUNTY_COMPARISON_VERSION,
  isCountyComparisonData: () => isCountyComparisonData
});
module.exports = __toCommonJS(county_comparison_exports);
var COUNTY_COMPARISON_VERSION = "nj-federal-counties-2020-2024-v1";
var COUNTY_COMPARISON_DEFAULTS = {
  datasetVersion: COUNTY_COMPARISON_VERSION,
  heading: "",
  intro: "",
  source: ""
};
function isCountyComparisonData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value;
  return Reflect.ownKeys(data).every((key) => typeof key === "string" && ["datasetVersion", "heading", "intro", "source"].includes(key)) && data.datasetVersion === COUNTY_COMPARISON_VERSION && typeof data.heading === "string" && data.heading.length <= 300 && typeof data.intro === "string" && data.intro.length <= 4e3 && typeof data.source === "string" && data.source.length <= 1e3 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(data.heading + data.intro + data.source);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  COUNTY_COMPARISON_DEFAULTS,
  COUNTY_COMPARISON_VERSION,
  isCountyComparisonData
});
