// Generated from packages/content-core/src/data-hub-composition.ts.
// Regenerate with: node scripts/generate-data-hub-composition.mjs
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

// packages/content-core/src/data-hub-composition.ts
var data_hub_composition_exports = {};
__export(data_hub_composition_exports, {
  DATA_HUB_SECTIONS: () => DATA_HUB_SECTIONS,
  dataHubCompositionError: () => dataHubCompositionError,
  dataHubFigureSection: () => dataHubFigureSection,
  dataHubPageError: () => dataHubPageError,
  defaultDataHubBlocks: () => defaultDataHubBlocks,
  isDataHubSectionData: () => isDataHubSectionData,
  isDefaultDataHubComposition: () => isDefaultDataHubComposition,
  parseDataHubCompositionVersion: () => parseDataHubCompositionVersion
});
module.exports = __toCommonJS(data_hub_composition_exports);

// packages/content-core/src/data-hub-reporting.ts
var DATA_HUB_FIGURES = {
  unemployment: "Unemployment",
  industryjobs: "Industry jobs",
  propertytax: "Property taxes",
  precipitation: "Precipitation",
  minimumwage: "Minimum wage",
  electricity: "Electricity",
  medianrent: "Median rent",
  medianincome: "Median income",
  housingpermits: "Housing permits",
  voterregistration: "Voter registration",
  statebudget: "State budget",
  temperature: "Temperature",
  familycare: "NJ FamilyCare",
  uninsured: "Health insurance",
  inflationmetro: "Metro inflation",
  schoolabsence: "Chronic absenteeism",
  graduation: "Graduation",
  snap: "NJ SNAP"
};

// packages/content-core/src/data-hub-composition.ts
var DATA_HUB_SECTIONS = {
  introduction: "Page introduction",
  featured: "Featured finding",
  latest: "Latest findings",
  finder: "Find figures",
  overview: "New Jersey in context",
  collection: "Explore the figures",
  ...DATA_HUB_FIGURES,
  methodology: "Reading the numbers"
};
function isDataHubSectionData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value;
  return Reflect.ownKeys(data).every((key) => typeof key === "string" && ["sectionId", "heading", "introduction"].includes(key)) && typeof data.sectionId === "string" && Object.hasOwn(DATA_HUB_SECTIONS, data.sectionId) && typeof data.heading === "string" && data.heading.length <= 300 && typeof data.introduction === "string" && data.introduction.length <= 4e3 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(data.heading + data.introduction);
}
function dataHubFigureSection(id) {
  return Object.hasOwn(DATA_HUB_FIGURES, id);
}
function dataHubCompositionError(blocks, pageId) {
  const seen = /* @__PURE__ */ new Set();
  for (const block of blocks) {
    if (block.type !== "data_hub_section") continue;
    if (pageId !== void 0 && pageId !== "data-hub") return "Data Hub sections belong only on the Data Hub Page.";
    if (seen.has(block.data.sectionId)) return "Each compiled Data Hub section can appear only once.";
    seen.add(block.data.sectionId);
  }
  return null;
}
function defaultDataHubBlocks() {
  const order = [
    "introduction",
    "featured",
    "latest",
    "finder",
    "overview",
    "collection",
    "unemployment",
    "industryjobs",
    "minimumwage",
    "medianincome",
    "propertytax",
    "electricity",
    "medianrent",
    "housingpermits",
    "inflationmetro",
    "precipitation",
    "temperature",
    "voterregistration",
    "statebudget",
    "familycare",
    "uninsured",
    "snap",
    "schoolabsence",
    "graduation",
    "methodology"
  ];
  return order.map((sectionId, order2) => ({
    id: `tmp-seed-data-hub-${sectionId}`,
    type: "data_hub_section",
    order: order2,
    visible: true,
    data: { sectionId, heading: "", introduction: "" }
  }));
}
function isDefaultDataHubComposition(blocks) {
  const defaults = defaultDataHubBlocks();
  return blocks.length === defaults.length && blocks.every((block, index) => block.type === "data_hub_section" && block.visible && block.layout === void 0 && block.section === void 0 && block.order === index && block.data.sectionId === defaults[index].data.sectionId && block.data.heading.trim() === "" && block.data.introduction.trim() === "");
}
function parseDataHubCompositionVersion(value) {
  if (value === void 0) return void 0;
  if (value !== 1) throw new Error("The Data Hub composition version is invalid.");
  return value;
}
function dataHubPageError(pageId, version, blocks) {
  if (pageId !== "data-hub") return version === void 0 ? null : "Data Hub composition belongs only on the Data Hub Page.";
  if (version !== void 0 && version !== 1) return "The Data Hub composition version is invalid.";
  if (version === void 0 && blocks === void 0) return null;
  if (!Array.isArray(blocks)) return "Data Hub content requires a blocks array.";
  if (version === void 0 && blocks.some((block) => block?.type === "data_hub_section")) {
    return "Data Hub sections require an explicit composition version.";
  }
  return null;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DATA_HUB_SECTIONS,
  dataHubCompositionError,
  dataHubFigureSection,
  dataHubPageError,
  defaultDataHubBlocks,
  isDataHubSectionData,
  isDefaultDataHubComposition,
  parseDataHubCompositionVersion
});
