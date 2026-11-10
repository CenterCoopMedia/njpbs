// Generated from packages/content-core/src/cms-image-variants.ts.
// Regenerate with: node scripts/generate-cms-image-variants.mjs
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

// packages/content-core/src/cms-image-variants.ts
var cms_image_variants_exports = {};
__export(cms_image_variants_exports, {
  cmsImageSourceAttributes: () => cmsImageSourceAttributes,
  cmsImageSources: () => cmsImageSources,
  cmsImageThumbnails: () => cmsImageThumbnails
});
module.exports = __toCommonJS(cms_image_variants_exports);

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

// packages/content-core/src/cms-image-variants.ts
function cmsImageThumbnails(image) {
  if (typeof image.url !== "string" || image.mimeType === "image/gif" || image.animated === true || !Array.isArray(image.thumbnails) || !Number.isSafeInteger(image.width) || Number(image.width) < 1 || !Number.isSafeInteger(image.height) || Number(image.height) < 1) return [];
  let original;
  try {
    original = new URL(image.url);
  } catch {
    return [];
  }
  const match = /^(\/cms-media\/[a-z0-9]+(?:-[a-z0-9]+)*\/[A-Za-z0-9_-]+\/)([a-f0-9]{64})\.(?:jpg|png|webp|avif)$/.exec(original.pathname);
  if (!isCmsMediaUrl(original) || !match) return [];
  const sourceWidth = Number(image.width);
  const widths = sourceWidth < 480 ? [sourceWidth] : [480, 960, 1600].filter((width) => width <= sourceWidth);
  const output = /* @__PURE__ */ new Map();
  for (const item of image.thumbnails.slice(0, 3)) {
    if (!item || typeof item !== "object") continue;
    const { url, width, height } = item;
    if (!Number.isSafeInteger(width) || !widths.includes(width) || !Number.isSafeInteger(height) || height < 1 || Math.abs(height - Number(image.height) * width / Number(image.width)) > 1 || url !== `${original.origin}${match[1]}thumbs/${match[2]}-w${width}.webp`) continue;
    output.set(width, { url, width, height });
  }
  return [...output.values()].sort((a, b) => a.width - b.width);
}
function cmsImageSources(image, sizes) {
  const thumbnails = cmsImageThumbnails(image);
  if (!thumbnails.length) return {};
  const candidates = thumbnails.map((item) => `${item.url} ${item.width}w`);
  const originalWidth = Number(image.width);
  if (originalWidth > thumbnails[thumbnails.length - 1].width) {
    candidates.push(`${image.url} ${originalWidth}w`);
  }
  return { srcset: candidates.join(", "), sizes };
}
function cmsImageSourceAttributes(image, sizes) {
  const sources = cmsImageSources(image, sizes);
  return sources.srcset ? ` srcset="${escapeHtml(sources.srcset)}" sizes="${escapeHtml(sizes)}"` : "";
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  cmsImageSourceAttributes,
  cmsImageSources,
  cmsImageThumbnails
});
