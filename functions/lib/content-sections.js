"use strict";

// Deployment-safe CommonJS mirror of the content section registry in
// packages/content-core/src/content-sections.ts. Firebase uploads functions/ as its own
// bundle and cannot require the TypeScript module, so the seed table is duplicated here
// and compared entry by entry by the parity test.
//
// A "content section" here is the editorial desk a scoped role grant names
// (rbac.ts `RoleGrant.sections` / `Resource.section`). It is not the page-builder
// `SectionId` in editor-admin.ts and not the block check in editor-section-contract.js:
// those describe how a page is composed, this describes who may work on it.

const { contentSectionForPage } = require("./public-page-contract");

const CONTENT_SECTIONS_COLLECTION = "sections";

const SEEDED_CONTENT_SECTIONS = Object.freeze([
  Object.freeze({
    id: "watch",
    label: "Watch",
    description: "Live, on-demand, schedule and kids pages.",
    order: 1,
  }),
  Object.freeze({
    id: "support",
    label: "Support",
    description: "Membership, giving and Passport pages.",
    order: 2,
  }),
  Object.freeze({
    id: "station",
    label: "Station",
    description: "Home, about and contact pages.",
    order: 3,
  }),
  Object.freeze({
    id: "compliance",
    label: "Compliance",
    description: "Public file, accessibility, EEO and policy pages.",
    order: 4,
  }),
  Object.freeze({
    id: "news",
    label: "News",
    description: "Newscast stories, posts and newsroom records.",
    order: 5,
  }),
]);

// A record create must name a registered section (#619). On since the record editor gained
// its create-time section picker (#845): every new record is created into a desk, so a
// scoped grant can reach the work its holder is supposed to do and an unsectioned record is
// no longer something the admin app can produce. Records written before this stay
// unsectioned, and a scoped grant is denied on them -- backfill is what moves them, not a
// later save.
const REQUIRE_SECTION_ON_RECORD_CREATE = true;

function isSectionId(value) {
  return typeof value === "string" && value.trim() !== "" && value.trim() === value;
}

/**
 * The registered section ids, read from Firestore. Accepts either a Firestore instance or
 * an active transaction so a write path can validate inside the same transaction that
 * commits the document, and a grant path can read it directly.
 *
 * Registration is document existence: a row whose id is the section id. The seed writes a
 * label and description alongside it for staff-facing pickers, but a write gate must not
 * depend on those being well formed.
 */
async function readRegisteredSectionIds(firestore, transaction) {
  const query = firestore.collection(CONTENT_SECTIONS_COLLECTION);
  const snapshot = transaction ? await transaction.get(query) : await query.get();
  const ids = new Set();
  for (const doc of snapshot.docs) {
    if (isSectionId(doc.id)) ids.add(doc.id);
  }
  return ids;
}

/**
 * Which of `sections` are not in the runtime registry, in request order and deduplicated.
 * An empty result means every requested section is registered. Callers refuse on a
 * non-empty result: an unregistered desk name in a grant or on a record is a scope nobody
 * can reason about, and silently accepting it would widen the vocabulary by typo.
 */
async function unregisteredSections(firestore, sections, transaction) {
  if (!Array.isArray(sections) || sections.length === 0) return [];
  const registered = await readRegisteredSectionIds(firestore, transaction);
  const unknown = [];
  for (const section of sections) {
    if (!isSectionId(section) || !registered.has(section)) {
      if (!unknown.includes(section)) unknown.push(section);
    }
  }
  return unknown;
}

module.exports = {
  CONTENT_SECTIONS_COLLECTION,
  REQUIRE_SECTION_ON_RECORD_CREATE,
  SEEDED_CONTENT_SECTIONS,
  contentSectionForPage,
  isSectionId,
  readRegisteredSectionIds,
  unregisteredSections,
};
