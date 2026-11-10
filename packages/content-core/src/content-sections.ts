// The content section registry: the finite vocabulary that section-scoped role grants
// (packages/content-core/src/rbac.ts, `RoleGrant.sections` and `Resource.section`) are
// written against. A section is an editorial desk -- an area of the site a scoped editor
// may work in -- and nothing else.
//
// Deliberately NOT the same concept as `SectionId` in editor-admin.ts, which names a page
// builder's block palette, nor as the `validateSection` block check in
// functions/lib/editor-section-contract.js. Those describe how a page is composed. This
// describes who may touch it.
//
// The runtime source of truth is the Firestore `sections` collection, so adding a desk
// later is a data change rather than a code change (#619). The table below is the seed the
// registry starts from and the fallback the Staff access picker renders before its
// subscription resolves; nothing reads it as an authorization allowlist.

import { PUBLIC_PAGES, type PublicPageArea } from "./public-pages.ts";

/** Firestore collection holding the runtime registry. */
export const CONTENT_SECTIONS_COLLECTION = "sections";

/**
 * News is an editorial area for posts, beside the canonical public-page areas.
 * It does not add a public page or change the site's public navigation. The union
 * retains compile-time coverage of public-page areas while admitting News.
 */
export type ContentSectionId = PublicPageArea | "news";

export interface ContentSectionDefinition {
  id: string;
  /** Sentence-case name shown to staff. */
  label: string;
  /** One line explaining what a grant in this section covers. */
  description: string;
  /** Display order in staff-facing pickers. Ties fall back to label order. */
  order: number;
}

export const SEEDED_CONTENT_SECTIONS: readonly ContentSectionDefinition[] = Object.freeze([
  Object.freeze({
    id: "watch" satisfies ContentSectionId,
    label: "Watch",
    description: "Live, on-demand, schedule and kids pages.",
    order: 1,
  }),
  Object.freeze({
    id: "support" satisfies ContentSectionId,
    label: "Support",
    description: "Membership, giving and Passport pages.",
    order: 2,
  }),
  Object.freeze({
    id: "station" satisfies ContentSectionId,
    label: "Station",
    description: "Home, about and contact pages.",
    order: 3,
  }),
  Object.freeze({
    id: "compliance" satisfies ContentSectionId,
    label: "Compliance",
    description: "Public file, accessibility, EEO and policy pages.",
    order: 4,
  }),
  Object.freeze({
    id: "news" satisfies ContentSectionId,
    label: "News",
    description: "Newscast stories, posts and newsroom records.",
    order: 5,
  }),
]);

const SEEDED_SECTION_IDS: ReadonlySet<string> = new Set(
  SEEDED_CONTENT_SECTIONS.map((section) => section.id),
);

/**
 * Whether an id is one of the seeded desks. This is a seed check, not an authorization
 * check: a section added to the Firestore registry after the seed is registered and this
 * returns false for it. Write paths must consult the runtime registry instead.
 */
export function isSeededContentSectionId(value: unknown): value is ContentSectionId {
  return typeof value === "string" && SEEDED_SECTION_IDS.has(value);
}

/**
 * The server-owned section of a canonical public page, taken from its area in the page
 * registry. A page's desk is a property of the site's information architecture, so it is
 * never client-supplied and never stored as an independent editorial choice.
 */
export function contentSectionForPublicPage(pageId: unknown): ContentSectionId | null {
  if (typeof pageId !== "string") return null;
  const page = PUBLIC_PAGES.find((entry) => entry.id === pageId);
  return page === undefined ? null : page.area;
}

/**
 * Validate one untrusted registry document read straight from Firestore by the browser.
 * A malformed row is dropped rather than rendered, so a bad write can never put an
 * unselectable or unlabelled option in front of staff.
 */
export function parseContentSectionDefinition(
  value: unknown,
): ContentSectionDefinition | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const { id, label, description, order } = candidate;
  if (typeof id !== "string" || id.trim() === "" || id.trim() !== id) return null;
  if (typeof label !== "string" || label.trim() === "") return null;
  if (typeof description !== "string") return null;
  if (!Number.isFinite(order)) return null;
  return { id, label, description, order: order as number };
}

/** Registry display order: explicit `order` first, then label, then id. */
export function sortContentSections(
  sections: readonly ContentSectionDefinition[],
): ContentSectionDefinition[] {
  return [...sections].sort(
    (left, right) =>
      left.order - right.order ||
      left.label.localeCompare(right.label) ||
      left.id.localeCompare(right.id),
  );
}
