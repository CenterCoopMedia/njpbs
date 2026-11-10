// Build-time slug-uniqueness enforcement.
//
// Firestore puts no unique constraint on the mutable `slug`, and a rename appends
// the old value to `previousSlugs[]`. So two records can end up claiming the same
// route: two current slugs that match, a current slug that matches another
// record's old slug, or two records that kept the same old slug. Each case makes
// the static build emit a duplicate route or a 301 that fights a live page.
//
// This is the dependency-free core the checks the write boundary (a transactional
// slug reservation) and the loader (fail fast before emitting routes) both run.
// It reports every collision deterministically rather than throwing on the first,
// so an operator sees the whole set at once.
//
// Scope: a route is `{collection base}/{locale?}/{slug}`, so a slug only collides
// with another inside the same collection and locale. `findSlugConflicts` is
// therefore called with the records of a single collection (the loader iterates
// Astro content collections separately, so grouping by collection is free) and
// namespaces conflicts by `locale` itself. An English `about` and a Spanish
// `about`, or the same slug in two different collections, are distinct routes and
// are never reported as a conflict.

import type { EditorialBase } from "../../../packages/content-core/src/content-model";

/** The subset of a record `findSlugConflicts` reads. */
export type SluggedRecord = Pick<EditorialBase, "id" | "slug" | "previousSlugs" | "locale">;

/** The subset `routesOf` reads — the routes a record contributes are locale-independent. */
type RecordSlugs = Pick<EditorialBase, "slug" | "previousSlugs">;

/** The routes one record contributes: its live page plus its redirect sources. */
export interface RecordRoutes {
  /** The canonical route: the record's current slug. */
  canonical: string;
  /** Redirect sources: previous slugs that still 301 to the canonical route. */
  redirects: string[];
}

export type SlugConflictKind =
  /** Two records share the same current slug. */
  | "duplicate-canonical"
  /** One record's current slug is another record's previous (redirect) slug. */
  | "canonical-vs-previous"
  /** Two records claim the same previous slug, so a 301 has no single target. */
  | "duplicate-previous";

export interface SlugConflict {
  /** The contested route. */
  slug: string;
  /** The locale the collision is within; slugs never collide across locales. */
  locale: string;
  kind: SlugConflictKind;
  /** The records involved, sorted, so the report is stable. */
  recordIds: string[];
}

/**
 * The routes a record contributes. Previous slugs that equal the current slug
 * (renamed away and back) are dropped, since a page must not 301 its own live
 * route to itself; empty or whitespace-only entries are dropped; and duplicates
 * within the record collapse to one, so a record never collides with itself.
 */
export function routesOf(record: RecordSlugs): RecordRoutes {
  const canonical = record.slug;
  const seen = new Set<string>();
  const redirects: string[] = [];
  for (const previous of record.previousSlugs ?? []) {
    if (previous === canonical) continue;
    if (previous.trim().length === 0) continue;
    if (seen.has(previous)) continue;
    seen.add(previous);
    redirects.push(previous);
  }
  return { canonical, redirects };
}

/** One claimed route within a locale, with the records claiming it. */
interface RouteClaim {
  locale: string;
  slug: string;
  recordIds: Set<string>;
}

// A null byte cannot appear in a locale tag or a slug, so it is a collision-proof
// separator for the `(locale, slug)` index key.
function claimKey(locale: string, slug: string): string {
  return `${locale}\u0000${slug}`;
}

function addClaim(index: Map<string, RouteClaim>, locale: string, slug: string, recordId: string): void {
  const key = claimKey(locale, slug);
  const claim = index.get(key) ?? { locale, slug, recordIds: new Set<string>() };
  claim.recordIds.add(recordId);
  index.set(key, claim);
}

function sortedIds(ids: Iterable<string>): string[] {
  return [...ids].sort();
}

/**
 * Every route collision across `records`, empty when the set is conflict-free.
 * Pass a single collection's records; conflicts are scoped per locale. Because
 * `routesOf` already drops a record's self-referential previous slug, any overlap
 * between the canonical and previous indexes for one `(locale, slug)` key
 * necessarily spans different records, which is exactly the `canonical-vs-previous`
 * conflict. Conflicts are ordered by slug, then locale, then kind for a stable,
 * diffable report.
 */
export function findSlugConflicts(records: readonly SluggedRecord[]): SlugConflict[] {
  const canonicalClaims = new Map<string, RouteClaim>();
  const previousClaims = new Map<string, RouteClaim>();

  for (const record of records) {
    const { canonical, redirects } = routesOf(record);
    addClaim(canonicalClaims, record.locale, canonical, record.id);
    for (const previous of redirects) addClaim(previousClaims, record.locale, previous, record.id);
  }

  const conflicts: SlugConflict[] = [];

  for (const claim of canonicalClaims.values()) {
    if (claim.recordIds.size > 1) {
      conflicts.push({
        slug: claim.slug,
        locale: claim.locale,
        kind: "duplicate-canonical",
        recordIds: sortedIds(claim.recordIds),
      });
    }
  }

  for (const [key, previousClaim] of previousClaims) {
    const canonicalClaim = canonicalClaims.get(key);
    if (canonicalClaim) {
      const involved = new Set<string>([...canonicalClaim.recordIds, ...previousClaim.recordIds]);
      conflicts.push({
        slug: previousClaim.slug,
        locale: previousClaim.locale,
        kind: "canonical-vs-previous",
        recordIds: sortedIds(involved),
      });
    }
    if (previousClaim.recordIds.size > 1) {
      conflicts.push({
        slug: previousClaim.slug,
        locale: previousClaim.locale,
        kind: "duplicate-previous",
        recordIds: sortedIds(previousClaim.recordIds),
      });
    }
  }

  conflicts.sort(
    (a, b) =>
      a.slug.localeCompare(b.slug) ||
      a.locale.localeCompare(b.locale) ||
      a.kind.localeCompare(b.kind),
  );
  return conflicts;
}
