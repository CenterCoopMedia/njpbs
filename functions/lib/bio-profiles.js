// Generated from packages/content-core/src/bio-profiles.ts.
// Regenerate with: node scripts/generate-bio-profiles.mjs
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

// packages/content-core/src/bio-profiles.ts
var bio_profiles_exports = {};
__export(bio_profiles_exports, {
  BIO_LIMITS: () => BIO_LIMITS,
  bioPlacementError: () => bioPlacementError,
  containsBio: () => containsBio,
  isBioCardData: () => isBioCardData
});
module.exports = __toCommonJS(bio_profiles_exports);

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

// packages/content-core/src/bio-profiles.ts
var BIO_LIMITS = Object.freeze({
  profileId: 120,
  name: 120,
  role: 180,
  party: 60,
  area: 160,
  summary: 600,
  sourceUrl: 2e3,
  sourceLabel: 120,
  alt: 300,
  caption: 300
});
var IDENTITY_KEYS = ["profileId", "kind", "name", "role", "party", "area"];
var CARD_KEYS = [...IDENTITY_KEYS, "summary", "sourceUrl", "sourceLabel", "asOf", "image"];
function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function closed(value, keys) {
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.includes(key));
}
function text(value, limit, required) {
  return typeof value === "string" && value.length <= limit && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value) && (!required || value.trim().length > 0);
}
function identityFields(value, complete) {
  return typeof value.profileId === "string" && (!complete && value.profileId === "" || /^[A-Za-z0-9_-]{1,120}$/.test(value.profileId)) && (value.kind === "person" || value.kind === "organization") && text(value.name, BIO_LIMITS.name, complete) && text(value.role, BIO_LIMITS.role, complete) && (value.party === void 0 || text(value.party, BIO_LIMITS.party, false)) && (value.area === void 0 || text(value.area, BIO_LIMITS.area, false));
}
function validSource(value, complete) {
  if (!text(value, BIO_LIMITS.sourceUrl, complete)) return false;
  if (!complete && value === "") return true;
  return isExactHttpsUrl(value, BIO_LIMITS.sourceUrl);
}
function validDay(value, complete) {
  if (!complete && value === "") return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = /* @__PURE__ */ new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validImage(value, complete) {
  if (!record(value) || !closed(value, ["assetId", "alt", "altDecorative", "caption"])) return false;
  if (typeof value.assetId !== "string" || !(!complete && value.assetId === "" || /^[A-Za-z0-9_-]{1,128}$/.test(value.assetId))) return false;
  if (value.altDecorative !== void 0 && typeof value.altDecorative !== "boolean") return false;
  if (!text(value.alt, BIO_LIMITS.alt, complete && value.altDecorative !== true)) return false;
  if (value.altDecorative === true && value.alt !== "") return false;
  return value.caption === void 0 || text(value.caption, BIO_LIMITS.caption, false);
}
function isBioCardData(value, complete = false) {
  return record(value) && closed(value, CARD_KEYS) && identityFields(value, complete) && text(value.summary, BIO_LIMITS.summary, complete) && validSource(value.sourceUrl, complete) && text(value.sourceLabel, BIO_LIMITS.sourceLabel, complete) && validDay(value.asOf, complete) && (value.image === void 0 || validImage(value.image, complete));
}
function containsBio(value) {
  if (Array.isArray(value)) return value.some(containsBio);
  if (!record(value)) return false;
  return value.type === "bio" || value.type === "bio_card" || Object.values(value).some(containsBio);
}
function bioPlacementError(kind, document) {
  return kind !== "post" && containsBio(document) ? "Bio cards are available only inside Posts." : null;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BIO_LIMITS,
  bioPlacementError,
  containsBio,
  isBioCardData
});
