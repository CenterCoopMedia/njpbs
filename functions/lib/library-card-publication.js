"use strict";

const { isDeepStrictEqual } = require("node:util");

// Library cards export saved fields until #923 supplies published snapshots.
const PUBLIC_LIBRARY_FIELDS = Object.freeze({
  sponsor: ["name", "href", "logoAssetId", "logoAlt", "logoDecorative", "tier", "description",
    "activeFrom", "activeUntil", "publiclyVisible"],
  newsletter: ["title", "body", "signupUrl", "frequency", "summary", "imageAssetId", "imageAlt",
    "imageDecorative", "publiclyVisible"],
});

// RecordForm adds these empty defaults; revision restore can remove them again.
function publicLibraryValue(document, field) {
  const value = document?.[field];
  if (field === "body") return value ?? { type: "doc", content: [{ type: "paragraph" }] };
  if (field === "publiclyVisible") return value ?? true;
  if (field === "logoDecorative" || field === "imageDecorative") return value ?? false;
  return value ?? "";
}

function changesPublicLibraryFields(before, after) {
  if (!Object.hasOwn(PUBLIC_LIBRARY_FIELDS, after?.type)) return false;
  return PUBLIC_LIBRARY_FIELDS[after.type].some(field =>
    !isDeepStrictEqual(publicLibraryValue(before, field), publicLibraryValue(after, field)));
}

module.exports = { changesPublicLibraryFields };
