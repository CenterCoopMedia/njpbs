// Generated from packages/content-core/src/data-figure.ts and dataset-figures.ts.
// Regenerate with: node scripts/generate-data-figure.mjs
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

// packages/content-core/src/data-figure.ts
var data_figure_exports = {};
__export(data_figure_exports, {
  isDataFigureData: () => isDataFigureData
});
module.exports = __toCommonJS(data_figure_exports);

// packages/content-core/src/datasets.ts
var MAX_DATASET_BYTES = 200 * 1024;
function validDatasetId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

// packages/content-core/src/data-figure.ts
function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function hasOnlyFields(value, fields) {
  return Object.keys(value).every((key) => fields.includes(key));
}
function isDraftId(value, complete) {
  return typeof value === "string" && (!complete && value === "" || validDatasetId(value));
}
function isDataFigureData(value, complete = false) {
  if (!isObject(value) || !hasOnlyFields(value, ["datasetId", "version", "display"]) || !isDraftId(value.datasetId, complete) || value.display !== "compact" && value.display !== "expanded" || !isObject(value.version)) return false;
  if (value.version.mode === "latestApproved") {
    return hasOnlyFields(value.version, ["mode"]);
  }
  if (value.version.mode === "pinned") {
    return hasOnlyFields(value.version, ["mode", "releaseId"]) && isDraftId(value.version.releaseId, complete);
  }
  return false;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  isDataFigureData
});
