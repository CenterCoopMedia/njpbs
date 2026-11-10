// Generated from packages/content-core/src/home-newscast-data.ts.
// Regenerate with: node scripts/generate-home-newscast-data.mjs
"use strict";
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

// packages/content-core/src/home-newscast-data.ts
var home_newscast_data_exports = {};
__export(home_newscast_data_exports, {
  HOME_NEWSCAST_DEFAULTS: () => HOME_NEWSCAST_DEFAULTS,
  HOME_NEWSCAST_LAYOUTS: () => HOME_NEWSCAST_LAYOUTS,
  isHomeNewscastData: () => isHomeNewscastData
});
module.exports = __toCommonJS(home_newscast_data_exports);

// packages/content-core/src/editorial-dates.ts
var EDITORIAL_DATE_SOURCES = Object.freeze([
  "firstPublish",
  "backdated",
  "legacy"
]);

// packages/content-core/src/content-link.ts
var CONTENT_LINK_DIRECTORY_MAX_BYTES = 1024 * 1024;

// packages/content-core/src/media-origin.ts
var deploymentEnvironment = typeof __CMS_BROWSER_DEPLOYMENT_ENVIRONMENT__ !== "undefined" ? __CMS_BROWSER_DEPLOYMENT_ENVIRONMENT__ : typeof process !== "undefined" ? process.env.CMS_DEPLOYMENT_ENVIRONMENT : void 0;

// packages/content-core/src/home-source-curation.ts
function homeSourceObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// packages/content-core/src/home-newscast-source.ts
var HOME_NEWSCAST_SHOW_ID = "ad1f378e-9779-4ef1-a629-40a8a6f8f8d5";
var HOME_NEWSCAST_ASSETS_URL = `https://media.services.pbs.org/api/v1/assets/?show-id=${HOME_NEWSCAST_SHOW_ID}&type=full_length&parent-type=episode&available=public&country=US&platform-slug=bento&sort=-premiered_on`;

// packages/content-core/src/home-newscast-data.ts
var HOME_NEWSCAST_LAYOUTS = ["feature", "compact"];
var HOME_NEWSCAST_DEFAULTS = Object.freeze({
  showId: HOME_NEWSCAST_SHOW_ID,
  heading: "Latest newscast",
  summary: "",
  layout: "feature",
  watchLabel: "Watch the latest",
  pastLabel: "Past newscasts",
  liveLabel: "Watch live"
});
function isHomeNewscastData(value, complete) {
  if (!homeSourceObject(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== 7 || Reflect.ownKeys(value).some((key) => typeof key !== "string" || !["showId", "heading", "summary", "layout", "watchLabel", "pastLabel", "liveLabel"].includes(key)) || value.showId !== HOME_NEWSCAST_SHOW_ID || !HOME_NEWSCAST_LAYOUTS.includes(value.layout)) return false;
  return ["heading", "watchLabel", "pastLabel", "liveLabel"].every((key) => typeof value[key] === "string" && value[key].length <= 120 && !/[\u0000-\u001f\u007f]/.test(value[key]) && (!complete || !!value[key].trim())) && typeof value.summary === "string" && value.summary.length <= 2e3 && !/[\u0000-\u001f\u007f]/.test(value.summary);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  HOME_NEWSCAST_DEFAULTS,
  HOME_NEWSCAST_LAYOUTS,
  isHomeNewscastData
});
