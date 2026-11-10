import type { PageBlock } from "./content-model";
import { postChapters } from "./post-chapters";
import { assertMultimediaInventory, postMediaInventory } from "./post-media";
import { assertInteractiveInventory, interactivePostInventory } from "./post-interactive";
export const POST_FORMAT_TAG_PREFIX = "format:";

export const BRANDED_POST_FORMAT_TAGS = Object.freeze({
  "format:special-report": "special-report",
  "format:multimedia": "multimedia",
  "format:interactive": "interactive",
} as const);

export type BrandedPostFormat =
  (typeof BRANDED_POST_FORMAT_TAGS)[keyof typeof BRANDED_POST_FORMAT_TAGS];
export type PostPresentation = "standard" | BrandedPostFormat;

function normalizedTag(tag: string): string {
  return tag.trim().toLocaleLowerCase("en-US");
}

/**
 * Resolve the one deliberate branded format carried by a published Post.
 *
 * Ordinary topical tags remain ordinary topics. A `format:` tag is reserved UI
 * metadata: an unknown marker or more than one marker is a build error rather
 * than an arbitrary visual choice. The immutable snapshot therefore has one
 * unambiguous public presentation while every record remains the same Post type.
 */
export function resolvePostPresentation(
  tags: readonly string[],
): PostPresentation {
  const markers = tags
    .map(normalizedTag)
    .filter((tag) => tag.startsWith(POST_FORMAT_TAG_PREFIX));

  if (markers.length === 0) return "standard";
  if (markers.length !== 1) {
    throw new Error(
      `A Post may use one branded format tag; found ${markers.join(", ")}.`,
    );
  }

  const marker = markers[0] as keyof typeof BRANDED_POST_FORMAT_TAGS;
  const format = BRANDED_POST_FORMAT_TAGS[marker];
  if (!format) {
    throw new Error(`Unsupported Post format tag: ${markers[0]}.`);
  }
  return format;
}

/** Reader-facing topics, excluding every reserved presentation marker. */
export function publicPostTopics(tags: readonly string[]): string[] {
  return tags
    .map((tag) => tag.trim())
    .filter(Boolean)
    .filter(
      (tag) =>
        !tag.toLocaleLowerCase("en-US").startsWith(POST_FORMAT_TAG_PREFIX),
    );
}

/** Reader-facing categories in the editor's chosen order. */
export function publicPostCategories(categories: readonly string[]): string[] {
  return categories.map((category) => category.trim()).filter(Boolean);
}

/** The first public topic, used only where a format needs a subject label. */
export function primaryPostTopic(tags: readonly string[]): string {
  return publicPostTopics(tags)[0] ?? "New Jersey";
}


export const POST_PRESENTATIONS = [
  { value: "standard", label: "Standard post", requirements: "Write the post with the content blocks it needs." },
  { value: "special-report", label: "Special report", requirements: "Add at least two named level-two headings in visible text to create report chapters." },
  { value: "multimedia", label: "Multimedia feature", requirements: "Add a lead image, visible image, gallery image, or media link." },
  { value: "interactive", label: "Interactive/Data Lab", requirements: "Add a visible data figure or table, custom HTML block, or interactive/media link. Give each link a caption, and each custom HTML block a frame title, that names the experience." },
] as const;

export function postPresentationTagError(tags: readonly string[]): string | null {
  try { resolvePostPresentation(tags); return null; }
  catch (error) { return error instanceof Error ? error.message : "Choose a valid Post presentation."; }
}

export function tagsWithPostPresentation(tags: readonly string[], presentation: PostPresentation): string[] {
  return [...publicPostTopics(tags), ...(presentation === "standard" ? [] : [`format:${presentation}`])];
}

export interface PostFormatSource {
  tags: readonly string[];
  blocks: readonly PageBlock[];
  heroImage?: unknown;
  leadMedia?: unknown;
}

/** Drafts may be incomplete. Approval and publication require the selected presentation. */
export function postPresentationError(post: PostFormatSource): string | null {
  try {
    const presentation = resolvePostPresentation(post.tags);
    if (presentation === "special-report" && postChapters(post.blocks).length < 2) {
      return "A Special report needs at least two named level-two headings in visible text.";
    }
    if (presentation === "multimedia") {
      assertMultimediaInventory(postMediaInventory({ blocks: post.blocks, heroImage: post.heroImage ?? null, leadMedia: post.leadMedia }));
    }
    if (presentation === "interactive") assertInteractiveInventory(interactivePostInventory(post.blocks));
    return null;
  } catch (error) { return error instanceof Error ? error.message : "Check this Post presentation."; }
}
