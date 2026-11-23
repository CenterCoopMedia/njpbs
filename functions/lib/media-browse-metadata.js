"use strict";

const FIELDS = ["updatedFrom", "updatedTo", "minDuration", "maxDuration", "aspect"];
const ASPECTS = ["landscape", "portrait", "square"];

/**
 * @typedef {object} MediaMetadataBounds
 * @property {string} [updatedFrom]
 * @property {string} [updatedTo]
 * @property {number} [minDuration]
 * @property {number} [maxDuration]
 * @property {"landscape" | "portrait" | "square"} [aspect]
 */

function parseMetadataBounds(value, ErrorClass) {
  /** @type {MediaMetadataBounds} */
  const filters = {};
  for (const field of FIELDS) {
    const bound = value[field];
    if (bound === undefined) continue;
    let valid;
    if (field.startsWith("updated")) {
      const parsed = typeof bound === "string" && /^\d{4}-\d{2}-\d{2}$/.test(bound)
        ? new Date(`${bound}T00:00:00Z`) : null;
      valid = parsed && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === bound;
    } else if (field === "aspect") {
      valid = ASPECTS.includes(bound);
    } else {
      valid = Number.isSafeInteger(bound) && bound >= 0;
    }
    if (!valid) throw new ErrorClass(`${field} is invalid`);
    filters[field] = bound;
  }
  if (filters.updatedFrom > filters.updatedTo) throw new ErrorClass("Start date must be on or before end date");
  if (filters.minDuration > filters.maxDuration) throw new ErrorClass("Minimum duration must be at most maximum duration");
  return filters;
}

function hasMetadataBounds(query) {
  return FIELDS.some(field => query[field] !== undefined);
}

/**
 * @param {MediaMetadataBounds & {metadataUpdateRequested?: boolean}} query
 * @param {{updatedAt?: string | null, duration?: number, width?: number, height?: number, metadataUpdateRequested?: boolean}} record
 */
function matchesMediaMetadata(query, { updatedAt, duration, width, height, metadataUpdateRequested }) {
  if (query.metadataUpdateRequested && metadataUpdateRequested !== true) return false;
  if (query.updatedFrom || query.updatedTo) {
    const timestamp = updatedAt ? Date.parse(updatedAt) : NaN;
    if (!Number.isFinite(timestamp)) return false;
    const day = new Date(timestamp).toISOString().slice(0, 10);
    if ((query.updatedFrom && day < query.updatedFrom) || (query.updatedTo && day > query.updatedTo)) return false;
  }
  if (query.minDuration !== undefined || query.maxDuration !== undefined) {
    if (!Number.isFinite(duration) || duration <= 0 ||
        (query.minDuration !== undefined && duration < query.minDuration) ||
        (query.maxDuration !== undefined && duration > query.maxDuration)) return false;
  }
  if (query.aspect) {
    if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) return false;
    const aspect = width === height ? "square" : width > height ? "landscape" : "portrait";
    if (query.aspect !== aspect) return false;
  }
  return true;
}

module.exports = { METADATA_BOUND_FIELDS: FIELDS, parseMetadataBounds, hasMetadataBounds, matchesMediaMetadata };
