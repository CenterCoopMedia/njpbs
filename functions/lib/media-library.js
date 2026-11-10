"use strict";

const { MASTER_EXTENSIONS, retainedOriginal } = require("./media-master-contract");

const ORIGINAL_FORMATS = new Set(Object.values(MASTER_EXTENSIONS).map(extension => extension.toUpperCase()));

// Staff see only the original's format. Its key, hash, size and dimensions stay server-side.
function originalDownload(data) {
  if (data.kind !== "image" || data.source !== "upload") return {};
  if (Object.hasOwn(data, "master")) {
    const master = retainedOriginal(data.master);
    return master ? { originalAvailable: true, originalFormat: MASTER_EXTENSIONS[master.mimeType].toUpperCase() } : {};
  }
  if (data.originalAvailable !== true) return {};
  return { originalAvailable: true, ...(ORIGINAL_FORMATS.has(data.originalFormat) ? { originalFormat: data.originalFormat } : {}) };
}

const { projectVoiceoverMedia } = require("./voiceover-media");

// This pure module owns the private media-library response contract. Browser clients never read
// media_assets directly. The HTTP boundary authenticates the caller and filters each record by
// its stored category before this selector derives records, facets, totals, or paging.

const {
  CATEGORY_PATTERN,
  MEDIA_TYPES,
  MediaValidationError,
  normalizeMediaCategoryAssignments,
} = require("./media-contract");

const MEDIA_LIBRARY_PAGE_SIZE = 30;
// Response page limit, independent of the active-library scan ceiling.
// Callers that omit pageSize keep the 30-row library page.
const MAX_MEDIA_LIBRARY_PAGE_SIZE = 500;
const MAX_MEDIA_SEARCH_LENGTH = 200;
const MAX_MEDIA_CATEGORY_FILTERS = 20;
const MAX_MEDIA_ASSET_IDS = 12;
const MEDIA_KINDS = Object.freeze(["image", "document", "audio"]);
// Lists that name no kind show the Images tab's kinds. Audio appears only on request, so
// pickers and the Images tab never receive an audio file.
const DEFAULT_MEDIA_KINDS = Object.freeze(["image", "document"]);
const MEDIA_SORT_FIELDS = Object.freeze([
  "updatedAt",
  "createdAt",
  "name",
  "sizeBytes",
]);
const MEDIA_SORT_DIRECTIONS = Object.freeze(["asc", "desc"]);
const REQUEST_FIELDS = new Set([
  "q",
  "categories",
  "kinds",
  "sort",
  "direction",
  "page",
  "pageSize",
  "assetIds",
  "profilePhotoScope",
  "paging",
  "cursor",
]);

const DEFAULT_MEDIA_QUERY = Object.freeze({
  q: "",
  categories: [],
  kinds: [],
  sort: "updatedAt",
  direction: "desc",
  page: 1,
});

class MediaLibraryValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "MediaLibraryValidationError";
    this.status = status;
  }
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeUnique(values, label, validate, max) {
  if (!Array.isArray(values)) {
    throw new MediaLibraryValidationError(`${label} must be an array`);
  }
  if (values.length > max) {
    throw new MediaLibraryValidationError(`${label} has too many values`);
  }
  const normalized = [];
  const seen = new Set();
  for (const value of values) {
    validate(value);
    if (!seen.has(value)) {
      seen.add(value);
      normalized.push(value);
    }
  }
  return normalized;
}

function validateCategory(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 60 ||
    !CATEGORY_PATTERN.test(value)
  ) {
    throw new MediaLibraryValidationError(
      "Each category must use 60 or fewer lowercase letters, numbers, and single hyphens",
    );
  }
}

function normalizeAssetIds(values) {
  if (!Array.isArray(values)) {
    throw new MediaLibraryValidationError("assetIds must be an array");
  }
  const assetIds = [...new Set(values.map((value) => {
    if (!isMediaAssetId(value)) {
      throw new MediaLibraryValidationError(
        "Each asset id must use 128 or fewer letters, numbers, hyphens, and underscores",
      );
    }
    return value;
  }))];
  if (assetIds.length > MAX_MEDIA_ASSET_IDS) {
    throw new MediaLibraryValidationError("assetIds has too many values");
  }
  return assetIds;
}

function parseMediaListRequest(body) {
  if (!plainObject(body)) {
    throw new MediaLibraryValidationError(
      "The media list request must be an object",
    );
  }
  const unknown = Object.keys(body).find((field) => !REQUEST_FIELDS.has(field));
  if (unknown) {
    throw new MediaLibraryValidationError(
      `Unknown media list field ${unknown}`,
    );
  }

  let q = DEFAULT_MEDIA_QUERY.q;
  if (body.q !== undefined) {
    if (typeof body.q !== "string") {
      throw new MediaLibraryValidationError("q must be a string");
    }
    if (body.q.length > MAX_MEDIA_SEARCH_LENGTH) {
      throw new MediaLibraryValidationError(
        `q must be ${MAX_MEDIA_SEARCH_LENGTH} characters or fewer`,
      );
    }
    q = body.q.trim();
  }

  const categories =
    body.categories === undefined
      ? []
      : normalizeUnique(
          body.categories,
          "categories",
          validateCategory,
          MAX_MEDIA_CATEGORY_FILTERS,
        );
  const kinds =
    body.kinds === undefined
      ? []
      : normalizeUnique(
          body.kinds,
          "kinds",
          (value) => {
            if (!MEDIA_KINDS.includes(value)) {
              throw new MediaLibraryValidationError(
                "Each kind must be image, document, or audio",
              );
            }
          },
          MEDIA_KINDS.length,
        );

  const sort = body.sort ?? DEFAULT_MEDIA_QUERY.sort;
  if (!MEDIA_SORT_FIELDS.includes(sort)) {
    throw new MediaLibraryValidationError("sort is not supported");
  }
  const direction = body.direction ?? DEFAULT_MEDIA_QUERY.direction;
  if (!MEDIA_SORT_DIRECTIONS.includes(direction)) {
    throw new MediaLibraryValidationError("direction must be asc or desc");
  }
  const page = body.page ?? DEFAULT_MEDIA_QUERY.page;
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new MediaLibraryValidationError(
      "page must be a positive safe integer",
    );
  }
  let pageSize;
  if (body.pageSize !== undefined) {
    if (
      !Number.isSafeInteger(body.pageSize) ||
      body.pageSize < 1 ||
      body.pageSize > MAX_MEDIA_LIBRARY_PAGE_SIZE
    ) {
      throw new MediaLibraryValidationError(
        `pageSize must be a whole number from 1 to ${MAX_MEDIA_LIBRARY_PAGE_SIZE}`,
      );
    }
    pageSize = body.pageSize;
  }

  const assetIds = body.assetIds === undefined
    ? undefined
    : normalizeAssetIds(body.assetIds);

  if (body.paging !== undefined && body.paging !== "cursor") {
    throw new MediaLibraryValidationError('paging must be "cursor"');
  }
  if (body.cursor !== undefined && (body.paging !== "cursor" ||
      typeof body.cursor !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(body.cursor))) {
    throw new MediaLibraryValidationError("Invalid media continuation");
  }
  if (body.paging && (assetIds || body.profilePhotoScope)) {
    throw new MediaLibraryValidationError("Cursor browsing cannot be combined with exact IDs or self profile scope");
  }

  if (
    body.profilePhotoScope !== undefined &&
    body.profilePhotoScope !== "self"
  ) {
    throw new MediaLibraryValidationError(
      'profilePhotoScope must be "self"',
    );
  }

  return {
    q,
    categories,
    kinds,
    sort,
    direction,
    page,
    ...(pageSize === undefined ? {} : { pageSize }),
    ...(assetIds === undefined ? {} : { assetIds }),
    ...(body.paging ? { paging: body.paging } : {}),
    ...(body.cursor ? { cursor: body.cursor } : {}),
    ...(body.profilePhotoScope === "self"
      ? { profilePhotoScope: "self" }
      : {}),
  };
}

function isMediaAssetId(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function formatMediaEtag(assetId, version) {
  if (!isMediaAssetId(assetId)) {
    throw new MediaLibraryValidationError("The media asset id is invalid", 500);
  }
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new MediaLibraryValidationError(
      "The media asset version is invalid",
      500,
    );
  }
  const encodedId = Buffer.from(assetId, "utf8").toString("base64url");
  return `"media.${encodedId}.${version}"`;
}

function parseMediaIfMatch(value, assetId) {
  if (
    typeof value !== "string" ||
    value.includes(",") ||
    !isMediaAssetId(assetId)
  ) {
    return null;
  }
  const match = /^"media\.([A-Za-z0-9_-]+)\.([1-9][0-9]*)"$/.exec(value.trim());
  if (!match) return null;
  const version = Number(match[2]);
  if (!Number.isSafeInteger(version)) return null;
  let decodedId;
  try {
    decodedId = Buffer.from(match[1], "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (
    decodedId !== assetId ||
    Buffer.from(decodedId, "utf8").toString("base64url") !== match[1]
  ) {
    return null;
  }
  return formatMediaEtag(assetId, version) === value.trim() ? version : null;
}

function dateString(value) {
  if (typeof value === "string" && Number.isFinite(Date.parse(value)))
    return value;
  if (value && typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }
  return null;
}

function nullableString(value) {
  return typeof value === "string" ? value : null;
}

function assignedCategories(asset) {
  return Array.isArray(asset?.categories) && asset.categories.length > 0
    ? asset.categories
    : [asset.category];
}

function admittedMediaThumbnails(value) {
  if (!Array.isArray(value)) return [];
  const thumbnails = [];
  for (const item of value) {
    if (
      !item ||
      !Number.isSafeInteger(item.width) || item.width < 1 ||
      !Number.isSafeInteger(item.height) || item.height < 1 ||
      typeof item.url !== "string"
    ) continue;
    try {
      const url = new URL(item.url);
      if (url.protocol !== "https:" || url.username || url.password) continue;
    } catch {
      continue;
    }
    thumbnails.push({ url: item.url, width: item.width, height: item.height });
  }
  return thumbnails;
}

// Small admin surfaces use this instead of the original. A missing or unusable
// thumbnail set falls back to the original URL. Animated previews stay on
// mediaPreviewUrl in the admin, which keeps GIFs and other multi-frame files
// on the original.
function mediaDisplayUrl(asset, displayWidth = 480, displayHeight = 0) {
  if (!asset || typeof asset.url !== "string") return null;
  const width = Number.isSafeInteger(displayWidth) && displayWidth > 0
    ? displayWidth
    : 480;
  const height = Number.isSafeInteger(displayHeight) && displayHeight > 0
    ? displayHeight
    : 0;
  const selected = admittedMediaThumbnails(asset.thumbnails)
    .filter((item) => item.width >= width && (height === 0 || item.height >= height))
    .sort((left, right) => left.width - right.width)[0];
  return selected?.url ?? asset.url;
}

function mediaAssetSummary(id, data) {
  if (!isMediaAssetId(id) || !plainObject(data) || data.lifecycle !== "active")
    return null;
  if (!Number.isSafeInteger(data.version) || data.version < 1) return null;
  if (typeof data.name !== "string" || data.name.trim() === "") return null;
  if (typeof data.originalName !== "string" || data.originalName.trim() === "")
    return null;
  if (
    typeof data.category !== "string" ||
    !CATEGORY_PATTERN.test(data.category)
  )
    return null;
  let categories;
  try {
    categories = normalizeMediaCategoryAssignments(
      data.categories,
      data.category,
    );
  } catch (error) {
    if (error instanceof MediaValidationError) return null;
    throw error;
  }
  if (
    !MEDIA_KINDS.includes(data.kind) ||
    !Object.hasOwn(MEDIA_TYPES, data.mimeType) ||
    MEDIA_TYPES[data.mimeType].kind !== data.kind
  ) {
    return null;
  }
  if (
    data.license !== undefined &&
    data.license !== null &&
    typeof data.license !== "string"
  )
    return null;
  if (!Number.isSafeInteger(data.sizeBytes) || data.sizeBytes < 1) return null;
  if (typeof data.url !== "string") return null;
  try {
    const url = new URL(data.url);
    if (url.protocol !== "https:" || url.username || url.password) return null;
  } catch {
    return null;
  }

  const width =
    data.width === null || data.width === undefined
      ? null
      : Number.isSafeInteger(data.width) && data.width > 0
        ? data.width
        : null;
  const height =
    data.height === null || data.height === undefined
      ? null
      : Number.isSafeInteger(data.height) && data.height > 0
        ? data.height
        : null;
  if (data.kind === "image" && (width === null || height === null)) return null;

  const voiceover = data.source === "voiceover" ? projectVoiceoverMedia(data) : null;
  if (data.source === "voiceover" && !voiceover) return null;
  const thumbnails = admittedMediaThumbnails(data.thumbnails);

  return {
    id,
    name: data.name.trim(),
    originalName: data.originalName,
    category: data.category,
    categories,
    tags: Array.isArray(data.tags)
      ? data.tags.filter((tag) => typeof tag === "string")
      : [],
    description: nullableString(data.description),
    altText: nullableString(data.altText),
    altTextGenerated: data.altTextGenerated === true,
    metadataUpdateRequested: data.metadataUpdateRequested === true,
    license: data.license?.trim() ? data.license : null,
    credit: nullableString(data.credit),
    mimeType: data.mimeType,
    kind: data.kind,
    sizeBytes: data.sizeBytes,
    width,
    height,
    url: data.url,
    ...(thumbnails.length ? { thumbnails } : {}),
    ...(typeof data.animated === "boolean" ? { animated: data.animated } : {}),
    // Preserve availability and format when cmsListMedia projects an already-safe summary again.
    ...originalDownload(data),
    ...(voiceover ? { voiceover, voiceoverTakeId: data.voiceoverTakeId } : {}),
    source:
      data.source === "upload" || data.source === "site_seed" || data.source === "voiceover"
        ? data.source
        : null,
    lifecycle: "active",
    version: data.version,
    etag: formatMediaEtag(id, data.version),
    createdAt: dateString(data.createdAt),
    createdBy: nullableString(data.createdBy),
    updatedAt: dateString(data.updatedAt),
    updatedBy: nullableString(data.updatedBy),
  };
}

function mediaSearchText(asset, categoryLabels = {}) {
  const categories = assignedCategories(asset);
  return [
    asset.id,
    asset.name,
    asset.originalName,
    ...asset.tags,
    asset.description,
    asset.voiceover?.performer_name,
    asset.voiceover?.style,
    asset.voiceover?.family,
    asset.voiceover?.text,
    asset.voiceover?.flags?.join(" "),
    asset.altText,
    asset.license,
    asset.credit,
    ...categories,
    ...categories.map((category) => categoryLabels[category]),
    asset.mimeType,
  ]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLocaleLowerCase("en-US");
}

function compareMedia(left, right, query) {
  const leftValue = left[query.sort];
  const rightValue = right[query.sort];
  let result = 0;
  if (query.sort === "sizeBytes") {
    result = leftValue - rightValue;
  } else if (leftValue === null && rightValue !== null) {
    result = 1;
  } else if (leftValue !== null && rightValue === null) {
    result = -1;
  } else if (leftValue !== null && rightValue !== null) {
    result = leftValue.localeCompare(rightValue, undefined, {
      sensitivity: "base",
    });
  }
  if (query.direction === "desc") result *= -1;
  return (
    result ||
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
    left.id.localeCompare(right.id)
  );
}

function countBy(values, keys) {
  return Object.fromEntries(
    keys.map((key) => [key, values.filter((value) => value === key).length]),
  );
}

function selectMediaLibrary(
  records,
  query,
  pageSize = MEDIA_LIBRARY_PAGE_SIZE,
  categoryLabels = {},
) {
  const audioRequested = query.kinds.includes("audio");
  // Exact asset ids name their records, so a duplicate or saved reference still resolves.
  const scoped = audioRequested || query.assetIds
    ? records
    : records.filter((asset) => DEFAULT_MEDIA_KINDS.includes(asset.kind));
  const search = query.q.toLocaleLowerCase("en-US");
  const searched =
    search === ""
      ? scoped
      : scoped.filter((asset) =>
        mediaSearchText(asset, categoryLabels).includes(search));
  const beforeCategory =
    query.kinds.length === 0
      ? searched
      : searched.filter((asset) => query.kinds.includes(asset.kind));
  const beforeKind =
    query.categories.length === 0
      ? searched
      : searched.filter((asset) =>
        assignedCategories(asset).some((category) =>
          query.categories.includes(category)));
  const categories = [
    ...new Set(beforeCategory.flatMap(assignedCategories)),
  ].sort();
  const filtered = beforeKind
    .filter(
      (asset) => query.kinds.length === 0 || query.kinds.includes(asset.kind),
    )
    .sort((left, right) => {
      // An editor resolves a saved asset through the same authorized list boundary.
      // Put an exact id first so paging cannot hide it behind incidental text matches.
      const leftExact = left.id === query.q;
      const rightExact = right.id === query.q;
      if (leftExact !== rightExact) return leftExact ? -1 : 1;
      return compareMedia(left, right, query);
    });
  const safePageSize =
    Number.isSafeInteger(pageSize) && pageSize > 0
      ? pageSize
      : MEDIA_LIBRARY_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(filtered.length / safePageSize));
  const page = Math.min(query.page, pageCount);
  const start = (page - 1) * safePageSize;

  return {
    records: filtered.slice(start, start + safePageSize),
    total: filtered.length,
    allCount: scoped.length,
    page,
    pageCount,
    categoryCounts: countBy(
      beforeCategory.flatMap(assignedCategories),
      categories,
    ),
    kindCounts: countBy(
      beforeKind.map((asset) => asset.kind),
      audioRequested ? MEDIA_KINDS : DEFAULT_MEDIA_KINDS,
    ),
  };
}

module.exports = {
  DEFAULT_MEDIA_KINDS,
  DEFAULT_MEDIA_QUERY,
  MAX_MEDIA_ASSET_IDS,
  MAX_MEDIA_CATEGORY_FILTERS,
  MAX_MEDIA_SEARCH_LENGTH,
  MAX_MEDIA_LIBRARY_PAGE_SIZE,
  MEDIA_KINDS,
  MEDIA_LIBRARY_PAGE_SIZE,
  MEDIA_SORT_DIRECTIONS,
  MEDIA_SORT_FIELDS,
  MediaLibraryValidationError,
  formatMediaEtag,
  admittedMediaThumbnails,
  isMediaAssetId,
  mediaAssetSummary,
  mediaSearchText,
  mediaDisplayUrl,
  parseMediaIfMatch,
  parseMediaListRequest,
  selectMediaLibrary,
};
