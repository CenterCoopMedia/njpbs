// Generated from packages/content-core/src/video-block.ts.
// Regenerate with: node scripts/generate-video-block.mjs
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

// packages/content-core/src/video-block.ts
var video_block_exports = {};
__export(video_block_exports, {
  VIDEO_BLOCK_LIMITS: () => VIDEO_BLOCK_LIMITS,
  VIDEO_BLOCK_SOURCE_ID: () => VIDEO_BLOCK_SOURCE_ID,
  VIDEO_PUBLIC_PREFIX: () => VIDEO_PUBLIC_PREFIX,
  containsVideo: () => containsVideo,
  isPublicVideoData: () => isPublicVideoData,
  isPublicVideoUrl: () => isPublicVideoUrl,
  isVideoBlockData: () => isVideoBlockData,
  renderVideoBlock: () => renderVideoBlock,
  withoutPublicVideoData: () => withoutPublicVideoData
});
module.exports = __toCommonJS(video_block_exports);

// packages/content-core/src/safe-href.ts
var HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};
function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

// packages/content-core/src/media-origin.ts
var deploymentEnvironment = typeof __CMS_BROWSER_DEPLOYMENT_ENVIRONMENT__ !== "undefined" ? __CMS_BROWSER_DEPLOYMENT_ENVIRONMENT__ : typeof process !== "undefined" ? process.env.CMS_DEPLOYMENT_ENVIRONMENT : void 0;
var CMS_MEDIA_ORIGIN = deploymentEnvironment === "development" ? "https://dev-media.example.org" : "https://media.njpbs.org";
function cleanHttpsUrl(url) {
  return url.protocol === "https:" && url.port === "" && url.username === "" && url.password === "" && url.search === "" && url.hash === "";
}
function isCmsMediaUrl(url) {
  return cleanHttpsUrl(url) && (url.origin === "https://media.njpbs.org" || url.origin === CMS_MEDIA_ORIGIN) && url.pathname.startsWith("/cms-media/") && url.pathname.length > 11;
}

// packages/content-core/src/video-block.ts
var VIDEO_BLOCK_SOURCE_ID = "video-library";
var VIDEO_PUBLIC_PREFIX = `${CMS_MEDIA_ORIGIN}/cms-media/video/`;
var VIDEO_BLOCK_LIMITS = Object.freeze({
  assetId: 200,
  title: 200,
  caption: 600,
  url: 2e3
});
var DATA_FIELDS = /* @__PURE__ */ new Set(["sourceId", "assetId", "title", "caption", "public"]);
var PUBLIC_FIELDS = /* @__PURE__ */ new Set(["url", "posterUrl", "width", "height", "mimeType"]);
function plainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function boundedString(value, max) {
  return typeof value === "string" && value.length <= max;
}
function isPublicVideoUrl(value, extension) {
  if (!boundedString(value, VIDEO_BLOCK_LIMITS.url)) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.href === value && isCmsMediaUrl(url) && /^\/cms-media\/video\/[A-Za-z0-9_-]+\/[a-f0-9]{64}\.(mp4|jpg)$/.test(url.pathname) && url.pathname.endsWith(`.${extension}`);
}
function isPublicVideoData(value) {
  if (!plainObject(value) || !Object.keys(value).every((key) => PUBLIC_FIELDS.has(key))) return false;
  return isPublicVideoUrl(value.url, "mp4") && isPublicVideoUrl(value.posterUrl, "jpg") && Number.isSafeInteger(value.width) && value.width > 0 && Number.isSafeInteger(value.height) && value.height > 0 && value.mimeType === "video/mp4";
}
function isVideoBlockData(value, publishable = true) {
  if (!plainObject(value) || !Object.keys(value).every((key) => DATA_FIELDS.has(key))) return false;
  if (value.sourceId !== VIDEO_BLOCK_SOURCE_ID) return false;
  if (!boundedString(value.assetId, VIDEO_BLOCK_LIMITS.assetId)) return false;
  if (!boundedString(value.title, VIDEO_BLOCK_LIMITS.title)) return false;
  if (value.caption !== void 0 && !boundedString(value.caption, VIDEO_BLOCK_LIMITS.caption)) return false;
  if (value.public !== void 0 && !isPublicVideoData(value.public)) return false;
  if (publishable && (!value.assetId.trim() || !value.title.trim())) return false;
  return true;
}
function containsVideo(blocks) {
  return Array.isArray(blocks) && blocks.some((block) => {
    const candidate = block;
    return candidate?.type === "video" && plainObject(candidate.data) && Boolean(candidate.data.public);
  });
}
function withoutPublicVideoData(blocks) {
  if (!Array.isArray(blocks)) return blocks;
  return blocks.map((block) => {
    const candidate = block;
    if (candidate?.type !== "video" || !plainObject(candidate.data) || !("public" in candidate.data)) return block;
    const { public: _ignored, ...data } = candidate.data;
    return { ...block, data };
  });
}
function renderVideoBlock(data, options = {}) {
  const media = data.public;
  const title = escapeHtml(data.title);
  const caption = data.caption?.trim() ? `<figcaption class="cms-video__caption">${escapeHtml(data.caption.trim())}</figcaption>` : "";
  if (!media) {
    if (!options.placeholder) return "";
    return `<figure class="cms-video cms-video--pending"><div class="cms-video__placeholder"><span class="cms-video__placeholder-title">${title}</span><span class="cms-video__placeholder-note">Video appears after publishing</span></div>${caption}</figure>`;
  }
  return `<figure class="cms-video"><video class="cms-video__player" controls preload="none" playsinline poster="${escapeHtml(media.posterUrl)}" width="${media.width}" height="${media.height}" title="${title}" aria-label="${title}"><source src="${escapeHtml(media.url)}" type="video/mp4"></video>${caption}</figure>`;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  VIDEO_BLOCK_LIMITS,
  VIDEO_BLOCK_SOURCE_ID,
  VIDEO_PUBLIC_PREFIX,
  containsVideo,
  isPublicVideoData,
  isPublicVideoUrl,
  isVideoBlockData,
  renderVideoBlock,
  withoutPublicVideoData
});
