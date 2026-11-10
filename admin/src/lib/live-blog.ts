import { parseLiveBlogDraft } from "../../../packages/content-core/src/live-blog-draft";
import { richTextIsEmpty } from "../../../packages/content-core/src/content-model";

/** Live blogs retain the existing Post edit, preview and publication permissions. */
export const LIVE_BLOG_CREATION_ENABLED: boolean = true;

export interface LiveBlogPublicationIssue {
  entryId: string;
  field: "headline" | "body" | "byline";
  message: string;
}

/** Explain missing entry content without replacing the strict publication validator. */
export function liveBlogPublicationIssue(value: unknown): LiveBlogPublicationIssue | null {
  let draft;
  try { draft = parseLiveBlogDraft(value); } catch { return null; }
  for (const [index, entry] of draft.updates.entries()) {
    if (entry.withdrawal !== undefined) continue;
    const field = !entry.headline.trim() ? "headline" : richTextIsEmpty(entry.body) ? "body"
      : entry.credits.length === 0 ? "byline" : null;
    if (!field) continue;
    const label = `Entry ${index + 1}${entry.headline.trim() ? ` (headline “${entry.headline.trim()}”)` : ""}`;
    return { entryId: entry.id, field, message: `${label} needs ${field === "body" ? "a readable body" : `a ${field}`}.` };
  }
  return null;
}
