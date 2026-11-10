"use strict";

const { recordOutputForPath } = require("./no-build-record-namespace");
const OUTPUTS = ["home", "listings", "authors", "feed", "contentApi", "sitemap", "search"];
function outputForPath(path) {
  if (path === "/" || path === "/index.html" || path === "/_home-sources.json") return "home";
  if (/^\/posts(?:\/index\.html|\/)?$/.test(path) || /^\/posts\/page(?:\/|$)/.test(path)) return "listings";
  if (/^\/authors(?:\/|$)/.test(path)) return "authors";
  if (path === "/feeds/news.xml") return "feed";
  if (path === "/api/v1/content.json" || /^\/api\/v1\/content(?:\/|$)/.test(path)) return "contentApi";
  if (/^\/sitemap(?:-index|-\d+)?\.xml$/.test(path)) return "sitemap";
  if (/^\/pagefind(?:\/|$)/.test(path) || path === "/search/meaning-index.json") return "search";
  return null;
}
function backgroundOutputForPath(path) { return outputForPath(path) ?? recordOutputForPath(path); }
function canonicalPath(path) {
  if (typeof path !== "string" || path.length > 512 || !path.startsWith("/") || /[%?#\\]/.test(path) ||
      [...path].some(character => character.charCodeAt(0) <= 32)) return false;
  return new URL(path, "https://background.invalid").pathname === path && !path.startsWith("//");
}
function isBackgroundAssetPath(path) {
  return /^\/_astro\/[A-Za-z0-9_./-]+$/.test(path) && canonicalPath(path);
}
module.exports = { OUTPUTS, outputForPath, backgroundOutputForPath, canonicalPath, isBackgroundAssetPath };
