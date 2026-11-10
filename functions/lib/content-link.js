// Generated from packages/content-core/src/content-link.ts.
// Regenerate with: node scripts/generate-content-link.mjs
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

// packages/content-core/src/content-link.ts
var content_link_exports = {};
__export(content_link_exports, {
  CONTENT_LINK_DIRECTORY_MAX_BYTES: () => CONTENT_LINK_DIRECTORY_MAX_BYTES,
  CONTENT_LINK_URL_MAX: () => CONTENT_LINK_URL_MAX,
  contentLink: () => contentLink,
  contentLinkDirectoryFits: () => contentLinkDirectoryFits,
  contentLinkError: () => contentLinkError,
  contentLinkMetadata: () => contentLinkMetadata,
  contentLinkReadFits: () => contentLinkReadFits,
  contentLinkRedirect: () => contentLinkRedirect
});
module.exports = __toCommonJS(content_link_exports);

// packages/content-core/src/exact-https-url.ts
function isExactHttpsUrl(value, maxLength = Number.POSITIVE_INFINITY) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.trim() !== value || /[\u0000-\u0020\u007F]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

// packages/content-core/src/content-link.ts
var CONTENT_LINK_URL_MAX = 2048;
function contentLinkError(value) {
  if (value.contentLinkMode !== void 0 && !(typeof value.contentLinkMode === "string" && ["normal", "custom"].includes(value.contentLinkMode))) return "Choose the normal NJ PBS address or a custom URL.";
  if (value.contentLinkNewTab !== void 0 && typeof value.contentLinkNewTab !== "boolean") return "Open in a new tab must be on or off.";
  if (value.contentLinkUrl !== void 0 && (typeof value.contentLinkUrl !== "string" || value.contentLinkUrl.length > CONTENT_LINK_URL_MAX)) return "The custom URL must be at most 2,048 characters.";
  if (value.contentLinkMode === "custom" && (!isExactHttpsUrl(value.contentLinkUrl, CONTENT_LINK_URL_MAX) || value.contentLinkUrl.includes("\\"))) return "Enter a full https:// address without a username or password.";
  if (value.contentLinkMode === "custom" && new URL(value.contentLinkUrl).href.length > CONTENT_LINK_URL_MAX) return "The custom URL must be at most 2,048 characters.";
  return null;
}
function contentLinkMetadata(value) {
  const error = contentLinkError(value);
  if (error) throw new Error(error);
  return {
    ...value.contentLinkMode === void 0 ? {} : { contentLinkMode: value.contentLinkMode },
    ...value.contentLinkUrl === void 0 ? {} : { contentLinkUrl: value.contentLinkUrl },
    ...value.contentLinkNewTab === void 0 ? {} : { contentLinkNewTab: value.contentLinkNewTab }
  };
}
function contentLink(value, normalHref) {
  const error = contentLinkError(value);
  if (error) throw new Error(error);
  const external = value.contentLinkMode === "custom";
  const newTab = external && value.contentLinkNewTab !== false;
  return {
    href: external ? new URL(value.contentLinkUrl).href : normalHref,
    external,
    newTab,
    ...newTab ? { target: "_blank", rel: "noopener noreferrer" } : {}
  };
}
function contentLinkRedirect(value, headers = {}) {
  const link = contentLink(value, "");
  if (!link.external) return null;
  const result = new Headers(headers);
  result.set("Location", link.href);
  result.set("X-Robots-Tag", "noindex, nofollow");
  result.set("Cache-Control", "no-store");
  return new Response(null, { status: 302, headers: result });
}
var CONTENT_LINK_DIRECTORY_MAX_BYTES = 1024 * 1024;
function contentLinkDirectoryFits(entries) {
  return Array.isArray(entries) && entries.length <= 1e3 && new TextEncoder().encode(JSON.stringify(entries)).length <= CONTENT_LINK_DIRECTORY_MAX_BYTES;
}
function contentLinkReadFits(value, contentMaxBytes, directoryContainer) {
  const nested = directoryContainer && value[directoryContainer];
  const source = nested && typeof nested === "object" && !Array.isArray(nested) ? nested : value;
  const { contentLinks, ...content } = source;
  const envelope = source === value ? content : { ...value, [directoryContainer]: content };
  return (contentLinks === void 0 || contentLinkDirectoryFits(contentLinks)) && new TextEncoder().encode(JSON.stringify(envelope)).length <= contentMaxBytes;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CONTENT_LINK_DIRECTORY_MAX_BYTES,
  CONTENT_LINK_URL_MAX,
  contentLink,
  contentLinkDirectoryFits,
  contentLinkError,
  contentLinkMetadata,
  contentLinkReadFits,
  contentLinkRedirect
});
