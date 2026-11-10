// The Post slug contract, shared by the boundary that MINTS a slug and the
// build that turns one into a route.
//
// These two had drifted, and the drift was load-bearing. The save boundary
// minted post slugs by lowercasing the title and hyphenating the rest, with no
// reserved-word list and no length bound, while the public loader judged the
// stored value against a stricter list and refused anything reserved or over 80
// characters. A post titled "New" was therefore accepted, reserved forever in
// cmsPosts, and then refused by the loader -- and because a strict publish build
// fails on the first invalid document, that one post bricked the whole build.
//
// The loader has since been loosened to accept everything the writer can mint,
// which stops the build from breaking. This module is the other half: it stops
// the bad slug being minted in the first place, and it makes the two rules one
// piece of code instead of two that happen to agree.
//
//   isMintablePostSlug          -- what the writer may CREATE. The strict one:
//                                  shaped, bounded, never a reserved word.
//   isServerMintableSlugShape   -- what the build may ROUTE. Shape only, exactly
//                                  as permissive as the loader already is.
//
// The invariant, pinned by `post-slug-parity.test.ts`: every mintable slug is
// routable. The build may still refuse a genuinely unroutable string (a path
// separator, an uppercase, an empty slug), but it can never refuse a slug the
// writer was allowed to mint. That is what keeps the posture migration-safe:
// slugs already stored under the old, looser mint rule -- a reserved word, or
// 80-plus characters -- keep building and keep their URLs, while nothing new can
// be minted in that shape again.

/** The shape both sides require: lowercase segments joined by single hyphens. */
export const POST_SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * What the public build will route.
 *
 * Shape only, and deliberately so: this is the permissive half. It must accept
 * every slug the writer can legally mint, including anything already stored
 * under the older rule, or a legal save can fail the public build.
 */
export function isServerMintableSlugShape(value: unknown): value is string {
  return typeof value === "string" && POST_SLUG_SHAPE.test(value);
}

/** Longest slug the writer may MINT, matching the author-slug bound. */
export const POST_SLUG_MAX = 80;

/**
 * Slugs no post may be minted with, because each reads as a listing or an
 * action rather than as one story -- `/posts/index/`, `/posts/all/` and
 * `/posts/new/` look like site furniture.
 *
 * Enforced at mint time only. A stored slug that is one of these still routes:
 * refusing it at build time is what bricked the build, and the word is a matter
 * of editorial taste, not of route safety.
 */
export const RESERVED_POST_SLUGS: readonly string[] = [
  "index",
  "all",
  "new",
  "edit",
  "page",
  "feed",
  "rss",
  "search",
  "tag",
  "tags",
];

/**
 * Disambiguating tail for a title that slugifies to a reserved word.
 *
 * "New" becomes "new-post" rather than a numbered "new-2" or an anonymous
 * fallback, so the URL still reads as the story it names.
 */
export const RESERVED_POST_SLUG_TAIL = "-post";

/**
 * Last-resort root for a title with no sluggable characters at all -- a
 * headline written entirely in emoji, or in a script that folds to nothing.
 */
export const POST_SLUG_FALLBACK_ROOT = "njpbs-post";

/**
 * Fold a title into the slug shape: diacritics removed, apostrophes dropped so
 * "state's" reads as "states" rather than "state-s", every other punctuation run
 * collapsed to one hyphen, and the result bounded.
 */
export function slugifyPostTitle(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, POST_SLUG_MAX)
    .replace(/-+$/g, "");
}

/** What the writer may mint: shaped, bounded, and not a reserved word. */
export function isMintablePostSlug(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= POST_SLUG_MAX &&
    POST_SLUG_SHAPE.test(value) &&
    !RESERVED_POST_SLUGS.includes(value)
  );
}

/**
 * The mint root for a display name: always mintable, never empty, never
 * reserved. Every candidate below is derived from it.
 */
export function mintablePostSlugRoot(displayName: unknown): string {
  const slug = slugifyPostTitle(displayName);
  if (slug === "") return POST_SLUG_FALLBACK_ROOT;
  if (RESERVED_POST_SLUGS.includes(slug)) return `${slug}${RESERVED_POST_SLUG_TAIL}`;
  return slug;
}

/**
 * The `attempt`-th candidate for a root: the root itself, then `-2`, `-3`, and
 * so on. The root is truncated to make room for the tail so a long title cannot
 * push a suffixed candidate past POST_SLUG_MAX, which is the other half of the
 * old drift -- an over-length slug was mintable and then unroutable.
 *
 * `attempt` counts from 1. The result is always mintable.
 */
export function postSlugCandidate(root: string, attempt: number): string {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("A post slug attempt counts from 1");
  }
  const base = isMintablePostSlug(root) ? root : POST_SLUG_FALLBACK_ROOT;
  if (attempt === 1) return base;
  const tail = `-${attempt}`;
  const trimmed = base.slice(0, POST_SLUG_MAX - tail.length).replace(/-+$/g, "");
  // A root that trims away entirely (impossible for a shaped root, but the
  // arithmetic should not depend on that) falls back rather than mint "-2".
  return `${trimmed === "" ? POST_SLUG_FALLBACK_ROOT : trimmed}${tail}`;
}
