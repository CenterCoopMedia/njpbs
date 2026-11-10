import { postCardImage } from "../../../packages/content-core/src/post-card-image.ts";
import { contentLink } from "../../../packages/content-core/src/content-link.ts";
// What one author page lists, and in what order.
//
// Pure: it takes the projected posts and one projected author and returns the
// list to render. No clock, no Firestore, no rendering. The listing rules
// live here so each can be tested independently of a component:
//
// - Group by the stable registered `authorId`, never by display name. Two
//   people can share a name; one person can be renamed. The id is the join key
//   the credits contract froze into every published snapshot for exactly this.
// - Only PUBLISHED posts. The list is built from the post collection, which
//   only ever contains admitted published snapshots, so this is a property of
//   the input rather than a filter here.
// - Noindex Posts stay out of public listings, including pinned entries.
// - Sort by the trusted first-publish time, newest first. `editorialSortInstant`
//   is the resolver that decides what that instant is for a backdated or legacy
//   post, so listings can never contradict the dates printed in them.
// - One optional pinned post comes first and is marked as pinned.
// - The hidden list removes a post from THIS page only. Nothing here can
//   unpublish anything: the post keeps its own route and stays on every
//   coauthor's page, because each author's hidden list is read only for their
//   own page.

import type { CmsAuthorBuildData } from "./cms-authors-loader";
import type { CmsPostBuildData } from "./cms-posts-loader";

/** One row on an author page. */
export interface AuthorPostListing {
  postId: string;
  path: string;
  contentLinkMode?: "normal" | "custom";
  contentLinkUrl?: string;
  contentLinkNewTab?: boolean;
  title: string;
  spotlightNews?: boolean;
  coverageLabelId?: string;
  summary: string;
  displayDate: string | null;
  thumbnail: { url: string; width: number; height: number; alt: string } | null;
  /** True for the single pinned row, which renders first and says so. */
  pinned: boolean;
}

/**
 * What the author page needs beyond the profile itself.
 *
 * Just the list. The page deliberately cannot tell a reader whether an author
 * has published nothing or has left everything off this page: which of those it
 * is, is the author's own curation choice, and reporting it would undo the very
 * choice it reports.
 */
export interface AuthorPageContent {
  listings: AuthorPostListing[];
}

/**
 * Newest first by the resolved editorial instant.
 *
 * A post with no resolvable instant sorts last rather than first. Null means the
 * date could not be resolved, and an unknown date is not evidence of recency;
 * putting it at the top would front the least trustworthy row on the page.
 * Ties break on the post id so the emitted HTML is byte-stable across builds.
 */
export function compareEditorialRecency(
  left: Pick<CmsPostBuildData, "sortInstant" | "postId">,
  right: Pick<CmsPostBuildData, "sortInstant" | "postId">,
): number {
  const a = left.sortInstant;
  const b = right.sortInstant;
  if (a === null && b === null) return left.postId.localeCompare(right.postId);
  if (a === null) return 1;
  if (b === null) return -1;
  if (a !== b) return b - a;
  return left.postId.localeCompare(right.postId);
}

function listingFor(post: CmsPostBuildData, pinned: boolean): AuthorPostListing {
  const selectedImage = postCardImage(post);
  const hero = selectedImage?.image;
  return {
    postId: post.postId,
    path: contentLink(post, post.path).href,
    contentLinkMode: post.contentLinkMode, contentLinkUrl: post.contentLinkUrl, contentLinkNewTab: post.contentLinkNewTab,
    title: post.title,
    spotlightNews: post.spotlightNews === true,
    ...(post.coverageLabelId ? { coverageLabelId: post.coverageLabelId } : {}),
    // The summary is what an editor wrote for a listing. The excerpt is the
    // fallback, and an empty string is a legitimate third answer -- a card with
    // a headline and a date is a complete card, and inventing a summary by
    // truncating the body would put unreviewed text on a public page.
    summary: post.summary || post.excerpt,
    displayDate: post.displayDate,
    thumbnail: hero
      ? {
          url: hero.url,
          width: hero.width,
          height: hero.height,
          // A decorative lead image carries no information, and repeating the
          // headline as alt text on a card whose own link text is that headline
          // is noise for a screen reader. Both cases render alt="".
          alt: selectedImage!.alt,
        }
      : null,
    pinned,
  };
}

/**
 * The posts one author page lists, pinned row first and the rest newest first.
 *
 * `hiddenPostIds` and `pinnedPostId` come from THIS author's snapshot and are
 * applied only to this page. A post hidden here is untouched everywhere else,
 * which is what makes hiding safe to hand to every author.
 */
export function authorPageContent(
  author: Pick<CmsAuthorBuildData, "authorId" | "pinnedPostId" | "hiddenPostIds">,
  posts: readonly CmsPostBuildData[],
): AuthorPageContent {
  const credited = posts.filter((post) => !post.noindex && post.authorIds.includes(author.authorId));
  const hidden = new Set(author.hiddenPostIds);
  const visible = credited.filter((post) => !hidden.has(post.postId));

  // A pin only means anything for a post this author is actually credited on and
  // has not hidden. A stale pin -- the post was unpublished, deleted, or the
  // byline changed -- is ignored rather than emitted as an empty first row.
  const pinned = visible.find((post) => post.postId === author.pinnedPostId) ?? null;
  const rest = visible
    .filter((post) => post !== pinned)
    .sort(compareEditorialRecency);

  return {
    listings: [
      ...(pinned ? [listingFor(pinned, true)] : []),
      ...rest.map((post) => listingFor(post, false)),
    ],
  };
}
