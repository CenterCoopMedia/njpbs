"use strict";

// The document-size half of #531.
//
// Firestore refuses a document over 1 MiB, and it refuses it at commit time with
// an opaque INVALID_ARGUMENT that names no field and suggests no remedy. The save
// boundary already caps block COUNT (lib/editor-section-contract.js), but a count
// cap is not a size cap: forty blocks of rich text, or one prose block holding a
// pasted document, clear the count and still exceed the limit.
//
// Publishing is where this actually bites. The publish path composes the snapshot
// into the same document (lib/publish-snapshot.js createPublishedSnapshot), so a
// page roughly DOUBLES in size the moment it goes live. A draft that saved all
// week fails on the one action the editor cares most about, at the least
// recoverable moment, with an error that reads like a bug in the CMS.
//
// The content document is not the binding constraint, though, and checking only
// it leaves the bug in place. Content writes normally commit a cmsVersionHistory
// row carrying the full before and after documents, so that row runs to roughly
// their sum. Re-publishing a large page is the worst case: before and after are
// both the doubled document, and the history row hits the ceiling while the
// content document is still comfortably inside it. Every document a content
// write stores is measured, not just the visible one. A repair that shrinks a
// legacy document already above the safety budget stores a bounded before
// receipt so the editor can shorten it. The save boundary also permits a
// content-preserving scheduled cancellation, unpublish, or archive transition
// for a legacy document that still fits Firestore's hard limit; its bounded
// history row is measured against that hard limit, and no content edit can use
// the exception.
//
// So the size is measured before the write, against Firestore's own accounting
// rather than a JSON.stringify approximation, which overcounts escapes and
// undercounts numbers and field names.

// https://firebase.google.com/docs/firestore/quotas#collections_documents_and_fields
const MAX_DOCUMENT_BYTES = 1048576;

// The estimate follows Firestore's documented storage-size table:
// https://firebase.google.com/docs/firestore/storage-size
//
// With the document-name overhead below included, it was measured exact on every
// shape tried against the emulator on 2026-08-05, so the reserve is not covering
// estimator drift. It covers the fields this module cannot see: a serverTimestamp
// sentinel is charged here as the small object it currently is rather than as the
// 8-byte timestamp it becomes, and a future writer may add a field between the
// check and the commit. A 5% reserve is cheap insurance against reading low,
// which is the only dangerous direction: reading high refuses a page that would
// have fit, while reading low hands the write to the opaque commit failure this
// module exists to replace. A megabyte is on the order of a hundred thousand
// words in a single page, so the capacity given up is not capacity an editor can
// reach.
const SIZE_RESERVE_RATIO = 0.05;
const DOCUMENT_SIZE_BUDGET_BYTES = Math.floor(
  MAX_DOCUMENT_BYTES * (1 - SIZE_RESERVE_RATIO),
);

// Firestore's per-document overhead, charged once on top of the field data: 32
// bytes for the entity plus 16 for the document name. Measured against the
// emulator on 2026-08-05 by binary-searching the real ceiling on four shapes
// (a flat two-field document, a long collection/id path, a composed page with a
// publish snapshot, and one block of 61672 tiny text nodes). All four came out
// 16 bytes short of the limit with only the 32 counted, and the miss did not
// vary with path length, so it is a fixed charge rather than a per-segment one.
const DOCUMENT_OVERHEAD_BYTES = 32;
const DOCUMENT_NAME_OVERHEAD_BYTES = 16;

// A nested map is charged like a document: its keys and values, plus the same 32
// bytes. Leaving it out understates exactly the shape this guard exists to
// catch, since a rich-text block is a tree of small ProseMirror node maps -- at
// roughly 1.6k nested nodes the missing 32 bytes each consume the whole reserve
// and let through a write Firestore still rejects.
const MAP_OVERHEAD_BYTES = DOCUMENT_OVERHEAD_BYTES;

// Fixed-width values, per the storage-size table.
const NUMBER_BYTES = 8;
const TIMESTAMP_BYTES = 8;
const BOOLEAN_BYTES = 1;
const NULL_BYTES = 1;

function utf8Bytes(value) {
  return Buffer.byteLength(String(value), "utf8");
}

// A string field's value costs its UTF-8 length plus one, and so does a map key
// or a document-path segment. The trailing byte is the terminator Firestore
// charges for; leaving it out understates a document with many small fields,
// which is exactly the shape a block array has.
function stringValueBytes(value) {
  return utf8Bytes(value) + 1;
}

function isPlainObject(value) {
  return (
    value !== null && typeof value === "object" && !Array.isArray(value)
  );
}

/**
 * The storage size Firestore charges for one field value.
 *
 * Unsupported values (undefined, functions, symbols) are charged nothing: they
 * never reach the write, because the caller strips them or Firestore rejects
 * them on their own terms with a message that does name the field.
 */
function valueBytes(value) {
  if (value === null) return NULL_BYTES;
  switch (typeof value) {
    case "boolean":
      return BOOLEAN_BYTES;
    case "number":
      return NUMBER_BYTES;
    case "string":
      return stringValueBytes(value);
    case "object":
      break;
    default:
      return 0;
  }
  // A Firestore Timestamp, or the admin SDK sentinel that becomes one. Checked
  // before the map branch because both are objects and a timestamp is 8 bytes,
  // not the size of its internal fields.
  if (typeof value.toDate === "function" || value instanceof Date) {
    return TIMESTAMP_BYTES;
  }
  if (Array.isArray(value)) {
    let total = 0;
    for (const entry of value) total += valueBytes(entry);
    return total;
  }
  if (isPlainObject(value)) {
    let total = MAP_OVERHEAD_BYTES;
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      total += stringValueBytes(key) + valueBytes(entry);
    }
    return total;
  }
  return 0;
}

/**
 * The storage size Firestore charges for a document, including its path and the
 * per-document overhead.
 *
 * @param {object} document the composed document, as it would be written
 * @param {string} [documentPath] collection/id, e.g. "cmsPages/watch"
 * @returns {number} bytes
 */
function firestoreDocumentBytes(document, documentPath = "") {
  let total = DOCUMENT_OVERHEAD_BYTES + DOCUMENT_NAME_OVERHEAD_BYTES;
  // The document name is charged per path segment, each terminated.
  for (const segment of String(documentPath).split("/")) {
    if (segment.length > 0) total += stringValueBytes(segment);
  }
  if (!isPlainObject(document)) return total;
  for (const [key, value] of Object.entries(document)) {
    if (value === undefined) continue;
    total += stringValueBytes(key) + valueBytes(value);
  }
  return total;
}

/**
 * Check a composed document against the limit before it is written.
 *
 * Returns null when it fits. Otherwise returns a `reason` an editor can act on
 * and a `detail` for the server log, matching the shape validateSection returns
 * so the save boundary maps both the same way.
 *
 * @param {object} document
 * @param {string} documentPath
 * @param {{publishing?: boolean}} [context]
 */
function documentSizeError(
  document,
  documentPath,
  { publishing = false, label = "document" } = {},
) {
  const bytes = firestoreDocumentBytes(document, documentPath);
  if (bytes <= DOCUMENT_SIZE_BUDGET_BYTES) return null;
  const over = bytes - DOCUMENT_SIZE_BUDGET_BYTES;
  // Publishing is the case worth explaining, because the editor did not add
  // anything: the snapshot the publish takes is what pushed it over, and the
  // remedy is to shorten the page rather than to retry the publish.
  const reason = publishing
    ? "this page could not be published because it is too large. Publishing keeps a copy of the page as it goes live, which roughly doubles its size, so shorten the longest text blocks or move some into a second page and publish again."
    : "this page could not be saved because it is too large. Shorten the longest text blocks, or move some of them into a second page.";
  return {
    reason,
    detail: `${label} is ${bytes} bytes, ${over} over the ${DOCUMENT_SIZE_BUDGET_BYTES} budget (Firestore's hard limit is ${MAX_DOCUMENT_BYTES})${publishing ? ", with the publish snapshot composed" : ""}`,
  };
}

module.exports = {
  MAX_DOCUMENT_BYTES,
  DOCUMENT_SIZE_BUDGET_BYTES,
  firestoreDocumentBytes,
  documentSizeError,
};
