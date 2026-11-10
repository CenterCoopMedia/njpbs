// CommonJS mirror of packages/content-core/src/post-slugs.ts.
//
// The Functions bundle cannot import the TypeScript core, so the deployed save
// boundary runs this hand-written copy. site/tests/post-slug-parity.test.ts
// pins the two together: without it the mint rule the server actually runs
// could fork from the route rule the build actually applies, which is exactly
// the drift that let a post titled "New" be saved and then brick the strict
// publish build. Read the canonical module for the reasoning; keep this file a
// literal translation of it.

const POST_SLUG_MAX = 80;
const POST_SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const RESERVED_POST_SLUGS = [
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

const RESERVED_POST_SLUG_TAIL = "-post";
const POST_SLUG_FALLBACK_ROOT = "njpbs-post";

function slugifyPostTitle(value) {
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

function isMintablePostSlug(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= POST_SLUG_MAX &&
    POST_SLUG_SHAPE.test(value) &&
    !RESERVED_POST_SLUGS.includes(value)
  );
}

function isServerMintableSlugShape(value) {
  return typeof value === "string" && POST_SLUG_SHAPE.test(value);
}

function mintablePostSlugRoot(displayName) {
  const slug = slugifyPostTitle(displayName);
  if (slug === "") return POST_SLUG_FALLBACK_ROOT;
  if (RESERVED_POST_SLUGS.includes(slug)) {
    return `${slug}${RESERVED_POST_SLUG_TAIL}`;
  }
  return slug;
}

function postSlugCandidate(root, attempt) {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("A post slug attempt counts from 1");
  }
  const base = isMintablePostSlug(root) ? root : POST_SLUG_FALLBACK_ROOT;
  if (attempt === 1) return base;
  const tail = `-${attempt}`;
  const trimmed = base.slice(0, POST_SLUG_MAX - tail.length).replace(/-+$/g, "");
  return `${trimmed === "" ? POST_SLUG_FALLBACK_ROOT : trimmed}${tail}`;
}

module.exports = {
  POST_SLUG_FALLBACK_ROOT,
  POST_SLUG_MAX,
  POST_SLUG_SHAPE,
  RESERVED_POST_SLUGS,
  RESERVED_POST_SLUG_TAIL,
  isMintablePostSlug,
  isServerMintableSlugShape,
  mintablePostSlugRoot,
  postSlugCandidate,
  slugifyPostTitle,
};
