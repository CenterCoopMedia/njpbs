"use strict";

const { isDeepStrictEqual } = require("node:util");
const { CATEGORY_PATTERN } = require("./media-contract");
const { can } = require("./rbac");

const MEDIA_CATEGORIES_COLLECTION = "mediaCategories";
const MAX_MEDIA_CATEGORY_ID_LENGTH = 60;
const MAX_MEDIA_CATEGORY_LABEL_LENGTH = 80;
const MAX_MEDIA_CATEGORY_DESCRIPTION_LENGTH = 300;
const MAX_MEDIA_CATEGORY_ORDER = 100_000;

const SEEDED_MEDIA_CATEGORIES = Object.freeze([
  Object.freeze({
    id: "general",
    label: "General",
    description: "Station-wide media without a more specific editorial category.",
    order: 10,
  }),
  Object.freeze({
    id: "staff-profile",
    label: "Staff profiles",
    description: "Portraits attached to NJ PBS staff and author profiles.",
    order: 20,
  }),
]);

const RESERVED_MEDIA_CATEGORY_IDS = new Set(
  SEEDED_MEDIA_CATEGORIES.map((category) => category.id),
);

class MediaCategoryValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "MediaCategoryValidationError";
    this.status = status;
  }
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeMediaCategoryId(value, label = "Category id") {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_MEDIA_CATEGORY_ID_LENGTH ||
    value !== value.trim() ||
    !CATEGORY_PATTERN.test(value)
  ) {
    throw new MediaCategoryValidationError(
      `${label} must use ${MAX_MEDIA_CATEGORY_ID_LENGTH} or fewer lowercase letters, numbers, and single hyphens`,
    );
  }
  return value;
}

function normalizedString(value, label, max, { allowEmpty = false } = {}) {
  if (typeof value !== "string") {
    throw new MediaCategoryValidationError(`${label} is required`);
  }
  const normalized = value.trim();
  if (!allowEmpty && normalized.length === 0) {
    throw new MediaCategoryValidationError(`${label} is required`);
  }
  if (normalized.length > max) {
    throw new MediaCategoryValidationError(`${label} must be ${max} characters or fewer`);
  }
  return normalized;
}

function normalizedOrder(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MEDIA_CATEGORY_ORDER) {
    throw new MediaCategoryValidationError(
      `Order must be a whole number from 0 through ${MAX_MEDIA_CATEGORY_ORDER}`,
    );
  }
  return value;
}

function rejectUnknownFields(value, allowed, label) {
  if (!plainObject(value)) {
    throw new MediaCategoryValidationError(`${label} must be an object`);
  }
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  if (unknown) {
    throw new MediaCategoryValidationError(`Unknown ${label.toLowerCase()} field ${unknown}`);
  }
}

function normalizeMediaCategoryCreate(value) {
  rejectUnknownFields(
    value,
    new Set(["id", "label", "description", "order"]),
    "Category",
  );
  return {
    id: normalizeMediaCategoryId(value.id),
    label: normalizedString(
      value.label,
      "Label",
      MAX_MEDIA_CATEGORY_LABEL_LENGTH,
    ),
    description: normalizedString(
      value.description ?? "",
      "Description",
      MAX_MEDIA_CATEGORY_DESCRIPTION_LENGTH,
      { allowEmpty: true },
    ),
    order: normalizedOrder(value.order),
  };
}

function normalizeMediaCategoryChanges(id, value) {
  rejectUnknownFields(
    value,
    new Set(["label", "description", "order"]),
    "Changes",
  );
  const fields = Object.keys(value);
  if (fields.length === 0) {
    throw new MediaCategoryValidationError("Changes must include at least one editable field");
  }
  const changes = {};
  if (value.label !== undefined) {
    changes.label = normalizedString(
      value.label,
      "Label",
      MAX_MEDIA_CATEGORY_LABEL_LENGTH,
    );
  }
  if (value.description !== undefined) {
    changes.description = normalizedString(
      value.description,
      "Description",
      MAX_MEDIA_CATEGORY_DESCRIPTION_LENGTH,
      { allowEmpty: true },
    );
  }
  if (value.order !== undefined) changes.order = normalizedOrder(value.order);
  if (
    RESERVED_MEDIA_CATEGORY_IDS.has(id) &&
    (changes.label !== undefined || changes.description !== undefined)
  ) {
    throw new MediaCategoryValidationError(
      "Reserved media categories cannot be renamed or repurposed",
      409,
    );
  }
  return changes;
}

function parseMediaCategoryDefinition(id, value) {
  try {
    const categoryId = normalizeMediaCategoryId(id);
    if (!plainObject(value) || value.id !== categoryId) return null;
    if (typeof value.active !== "boolean") return null;
    if (!Number.isSafeInteger(value.version) || value.version < 1) return null;
    return {
      id: categoryId,
      label: normalizedString(
        value.label,
        "Label",
        MAX_MEDIA_CATEGORY_LABEL_LENGTH,
      ),
      description: normalizedString(
        value.description ?? "",
        "Description",
        MAX_MEDIA_CATEGORY_DESCRIPTION_LENGTH,
        { allowEmpty: true },
      ),
      order: normalizedOrder(value.order),
      active: value.active,
      version: value.version,
      reserved: RESERVED_MEDIA_CATEGORY_IDS.has(categoryId),
      createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
      createdBy: typeof value.createdBy === "string" ? value.createdBy : null,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
      updatedBy: typeof value.updatedBy === "string" ? value.updatedBy : null,
    };
  } catch (error) {
    if (error instanceof MediaCategoryValidationError) return null;
    throw error;
  }
}

function sortMediaCategories(categories) {
  return [...categories].sort(
    (left, right) =>
      left.order - right.order ||
      left.label.localeCompare(right.label, undefined, { sensitivity: "base" }) ||
      left.id.localeCompare(right.id),
  );
}

function formatMediaCategoryEtag(id, version) {
  normalizeMediaCategoryId(id);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new MediaCategoryValidationError("The category version is invalid", 500);
  }
  const encodedId = Buffer.from(id, "utf8").toString("base64url");
  return `"media-category.${encodedId}.${version}"`;
}

function parseMediaCategoryIfMatch(value, id) {
  if (typeof value !== "string" || value.includes(",")) return null;
  const match = /^"media-category\.([A-Za-z0-9_-]+)\.([1-9][0-9]*)"$/.exec(
    value.trim(),
  );
  if (!match) return null;
  const version = Number(match[2]);
  if (!Number.isSafeInteger(version)) return null;
  let decoded;
  try {
    decoded = Buffer.from(match[1], "base64url").toString("utf8");
  } catch {
    return null;
  }
  return decoded === id && formatMediaCategoryEtag(id, version) === value.trim()
    ? version
    : null;
}

function mediaCategoryForClient(category, principal) {
  return {
    ...category,
    etag: formatMediaCategoryEtag(category.id, category.version),
    canUpload:
      category.active && can(principal, "media.upload"),
    canManage: can(principal, "media.manage"),
  };
}

function sameCategoryValues(left, right) {
  return isDeepStrictEqual(
    {
      label: left.label,
      description: left.description,
      order: left.order,
      active: left.active,
    },
    {
      label: right.label,
      description: right.description,
      order: right.order,
      active: right.active,
    },
  );
}

function mediaCategoryRef(firestore, id) {
  return firestore.collection(MEDIA_CATEGORIES_COLLECTION).doc(
    normalizeMediaCategoryId(id),
  );
}

async function requireActiveMediaCategory(transaction, firestore, id) {
  const categoryId = normalizeMediaCategoryId(id);
  const snapshot = await transaction.get(mediaCategoryRef(firestore, categoryId));
  const category = snapshot.exists
    ? parseMediaCategoryDefinition(snapshot.id, snapshot.data())
    : null;
  if (!category) {
    throw new MediaCategoryValidationError("Choose a managed media category");
  }
  if (!category.active) {
    throw new MediaCategoryValidationError("Choose an active media category");
  }
  return category;
}

async function requireManagedMediaCategories(
  transaction,
  firestore,
  ids,
  { allowInactiveIds = new Set() } = {},
) {
  const categories = [];
  for (const id of ids) {
    const categoryId = normalizeMediaCategoryId(id);
    const snapshot = await transaction.get(mediaCategoryRef(firestore, categoryId));
    const category = snapshot.exists
      ? parseMediaCategoryDefinition(snapshot.id, snapshot.data())
      : null;
    if (!category) {
      throw new MediaCategoryValidationError("Choose managed media categories");
    }
    if (!category.active && !allowInactiveIds.has(categoryId)) {
      throw new MediaCategoryValidationError(
        "New assignments must use active media categories",
      );
    }
    categories.push(category);
  }
  return categories;
}

module.exports = {
  MAX_MEDIA_CATEGORY_DESCRIPTION_LENGTH,
  MAX_MEDIA_CATEGORY_ID_LENGTH,
  MAX_MEDIA_CATEGORY_LABEL_LENGTH,
  MAX_MEDIA_CATEGORY_ORDER,
  MEDIA_CATEGORIES_COLLECTION,
  MediaCategoryValidationError,
  RESERVED_MEDIA_CATEGORY_IDS,
  SEEDED_MEDIA_CATEGORIES,
  formatMediaCategoryEtag,
  mediaCategoryForClient,
  mediaCategoryRef,
  normalizeMediaCategoryChanges,
  normalizeMediaCategoryCreate,
  normalizeMediaCategoryId,
  parseMediaCategoryDefinition,
  parseMediaCategoryIfMatch,
  requireActiveMediaCategory,
  requireManagedMediaCategories,
  sameCategoryValues,
  sortMediaCategories,
};
