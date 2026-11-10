// Which cmsPosts record kinds have a public route, and where that route lives.
//
// One question, three boundaries (#923):
//
//   - The Admin lifecycle panel shows Publish now and Schedule only for a kind
//     whose server action can succeed. A button whose transport refuses by design
//     is worse than no button.
//   - The publish snapshot writer in Functions refuses to freeze a kind no build
//     can render, so an approved library record cannot become a live snapshot
//     pointing at a route that does not exist.
//   - The public build turns an admitted snapshot into a route under the base
//     this module names.
//
// Before this existed each of those asked `type === "post"` in its own words, so
// opening a second kind meant finding all three. Joe's 2026-08-22 decision on
// #923 is that Program and Event records get public routes. Staff profiles now
// use the separate author-profile route and are not a generic content kind.
//
// Deliberately dependency-free: the Functions bundle carries a hand-written
// CommonJS mirror at `functions/lib/public-record-kinds.js`, pinned by
// `site/tests/public-record-kinds.test.ts`, the same arrangement the status
// vocabulary and the block model use.

/** Record kinds a published snapshot can be frozen for and a build can route. */
export const PUBLICLY_ROUTED_RECORD_KINDS = ["post", "program", "event"] as const;

export type PubliclyRoutedRecordKind =
  (typeof PUBLICLY_ROUTED_RECORD_KINDS)[number];

/**
 * Record kinds that stay in the content library with no public route.
 *
 * Retired generic Staff records remain library-only so old drafts can be safely
 * archived; public staff identities use /authors/. Sponsor and Newsletter have
 * no public page in scope at all. The Admin explains the difference in its own
 * copy — this list only records that
 * today, nothing here can be published.
 */
export const LIBRARY_ONLY_RECORD_KINDS = [
  "staff",
  "sponsor",
  "newsletter",
] as const;

// A Map rather than an object literal so a lookup of `constructor` or
// `__proto__` answers "not a routed kind" instead of returning something
// inherited from Object.prototype.
const ROUTE_BASES = new Map<string, string>([
  ["post", "/posts/"],
  ["program", "/programs/"],
  ["event", "/events/"],
]);

/** True only for a record kind that has a reviewed public route today. */
export function recordKindHasPublicRoute(
  value: unknown,
): value is PubliclyRoutedRecordKind {
  return typeof value === "string" && ROUTE_BASES.has(value);
}

/**
 * The public route base for a routed kind, or null for every other value.
 *
 * Null is the honest answer for a library-only kind, a retired kind, a page, and
 * anything malformed: there is no route to hand back, and inventing one would
 * promise an address the build never emits.
 */
export function publicRouteBaseForRecordKind(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return ROUTE_BASES.get(value) ?? null;
}
