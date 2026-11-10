"use strict";

// Deployment-safe CommonJS mirror of the custom navigation contract. Firebase
// uploads functions/ alone; client/server parity tests pin the shared vocabulary
// and URL decisions to the Admin modules. This write boundary uses exact keys.
const MAX_CUSTOM_NAVIGATION_ITEMS = 10;
const MAX_SHARED_NAVIGATION_ENTRIES = 10;
const MAX_NAVIGATION_LABEL_LENGTH = 60;
const MAX_NAVIGATION_URL_LENGTH = 2048;
const BUILTIN_NAVIGATION_IDS = Object.freeze([
  "home", "pages", "posts", "library", "media", "editorial-queue", "cuez-storydesk", "activity",
  "schedule", "live-production", "resources", "staff-profiles", "staff-access", "analytics", "reports",
  "admin-settings", "around-nj",
]);
const ICON_NAMES = Object.freeze([
  "page", "pen-square", "stack", "history", "book",
  "save", "monitor", "outline", "chart",
  "table-row", "table-column", "upload", "download", "home", "play", "video",
  "heart", "heart-off", "external-link", "info", "help-circle", "search", "activity", "arrow-down",
  "arrow-left", "arrow-right", "arrow-up", "bold", "calendar", "check", "chevron-left",
  "chevron-right", "chevron-down", "chevron-up", "close", "code", "content", "dashboard",
  "file", "folder", "flag", "grip", "image", "italic", "link", "list", "list-ordered",
  "lock", "menu", "media", "microphone", "mail", "pause", "pin", "panel-left", "panel-right",
  "pencil", "plus", "quote", "queue", "redo", "refresh", "remove", "settings", "sign-out", "sliders",
  "trash", "undo", "eye", "eye-off", "users", "grid", "tag", "check-square", "ellipsis",
  "filter", "folder-plus", "columns", "sort", "maximize", "resize",
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, required, optional = []) {
  return isRecord(value) && required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function isSafeNavigationUrl(value) {
  if (typeof value !== "string" || !value || value.length > MAX_NAVIGATION_URL_LENGTH || /[^\x21-\x7e]|\\/.test(value)) return false;
  if (/%(?:2e|2f|5c)/i.test(value) || /(?:^|\/)\.{1,2}(?:\/|[?#]|$)/.test(value)) return false;
  if (value.startsWith("/")) {
    return /^\/(?:[?#].*)?$/.test(value) || /^\/(?:content|media|voiceovers|dashboard|activity|analytics|publish-queue|reports|guide|resources|schedule|staff-access|staff-profiles|admin|account|post-templates|premiere|live-production|cuez-storydesk)(?:[/?#].*)?$/.test(value);
  }
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?(?:[/?#].*)?$/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch { return false; }
}

function validIdentity(item, ids) {
  if (typeof item.id !== "string" || !/^custom:[A-Za-z0-9_-]{1,73}$/.test(item.id) || ids.has(item.id)) return false;
  if (typeof item.label !== "string" || !item.label.trim() || item.label.length > MAX_NAVIGATION_LABEL_LENGTH) return false;
  if (Object.hasOwn(item, "icon") && !ICON_NAMES.includes(item.icon)) return false;
  ids.add(item.id);
  return true;
}

function validDestination(destination) {
  if (!isRecord(destination)) return false;
  if (destination.kind === "url") return hasExactKeys(destination, ["kind", "url"]) && isSafeNavigationUrl(destination.url);
  return hasExactKeys(destination, ["kind", "id"]) &&
    (destination.kind === "post" || destination.kind === "page") &&
    typeof destination.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(destination.id);
}

function validLink(item, ids) {
  return hasExactKeys(item, ["id", "kind", "label", "destination"], ["icon"]) &&
    item.kind === "link" && validIdentity(item, ids) && validDestination(item.destination);
}

function parseCustomNavigation(value) {
  if (!Array.isArray(value) || value.length > MAX_CUSTOM_NAVIGATION_ITEMS) return null;
  const ids = new Set();
  for (const item of value) {
    if (isRecord(item) && item.kind === "section") {
      if (!hasExactKeys(item, ["id", "kind", "label", "links"], ["icon"]) ||
          !validIdentity(item, ids) || !Array.isArray(item.links) ||
          item.links.length >= MAX_CUSTOM_NAVIGATION_ITEMS || !item.links.every((link) => validLink(link, ids))) return null;
    } else if (!validLink(item, ids)) return null;
    if (ids.size > MAX_CUSTOM_NAVIGATION_ITEMS) return null;
  }
  return value;
}

function validArrangementIds(value, allowed) {
  return Array.isArray(value) && value.length <= allowed.size && new Set(value).size === value.length &&
    value.every((id) => typeof id === "string" && allowed.has(id));
}

function parseSharedNavigationIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SHARED_NAVIGATION_ENTRIES) return null;
  const ids = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !/^custom:[A-Za-z0-9_-]{1,73}$/.test(entry) || ids.includes(entry)) return null;
    ids.push(entry);
  }
  return ids;
}

// Which of this caller's own top-level custom items should be active shares.
// Undefined keeps the current share set. Null is a request the server must reject.
function parseOwnedShareIds(value, custom) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_CUSTOM_NAVIGATION_ITEMS) return null;
  const allowed = new Set(Array.isArray(custom) ? custom.map((item) => item && item.id) : []);
  const ids = [];
  for (const id of value) {
    if (typeof id !== "string" || !/^custom:[A-Za-z0-9_-]{1,73}$/.test(id) || ids.includes(id) || !allowed.has(id)) return null;
    ids.push(id);
  }
  return ids;
}

function parseNavigationPreferences(value) {
  if (!hasExactKeys(value, ["version", "order", "hidden", "custom"], ["shared"]) || value.version !== 4) return null;
  const custom = parseCustomNavigation(value.custom);
  const shared = parseSharedNavigationIds(value.shared);
  if (!custom || !shared) return null;
  const allowed = new Set(BUILTIN_NAVIGATION_IDS);
  for (const item of custom) {
    allowed.add(item.id);
    if (item.kind === "section") for (const link of item.links) allowed.add(link.id);
  }
  for (const id of shared) allowed.add(id);
  if (!validArrangementIds(value.order, allowed) || !validArrangementIds(value.hidden, allowed)) return null;
  return value;
}

module.exports = {
  MAX_CUSTOM_NAVIGATION_ITEMS,
  MAX_SHARED_NAVIGATION_ENTRIES,
  MAX_NAVIGATION_LABEL_LENGTH,
  MAX_NAVIGATION_URL_LENGTH,
  BUILTIN_NAVIGATION_IDS,
  ICON_NAMES,
  hasExactKeys,
  isSafeNavigationUrl,
  parseCustomNavigation,
  parseNavigationPreferences,
  parseOwnedShareIds,
};
