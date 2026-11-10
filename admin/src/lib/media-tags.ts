import type { Token } from "../components/ui/TokenInput";
import { tagKey } from "../components/ui/tokenInputModel";
import type { MediaTileSurface } from "./media-tile-actions";

// Tag tokens for the media inspector. Tags keep their
// stored spelling and case; nothing here lowercases a tag.
//
// Each surface compares tags the way its server does. Images match in any letter case, as
// normalizeMediaTags and functions/update-media.js remove case duplicates. Video matches the
// exact spelling, as buildBulkMetadataPlan does, so "Interview" and "interview" are two tags.

export type TagMatch = "case-insensitive" | "exact";

export function tagMatchFor(surface: MediaTileSurface): TagMatch {
  return surface === "images" ? "case-insensitive" : "exact";
}

export function tagMatchKey(tag: string, match: TagMatch): string {
  return match === "exact" ? tag : tagKey(tag);
}

export function tagsToTokens(tags: readonly string[]): Token[] {
  return tags.map((value) => ({ value }));
}

export function tokensToTags(tokens: readonly Token[]): string[] {
  return tokens.map((token) => token.value);
}

/**
 * The union of the selected items' tags in first-seen order. A tag is mixed when some item
 * lacks it. With case-insensitive matching, spellings that differ only in case are one token
 * spelled as first seen, and an item holding any spelling counts as holding it.
 */
export function mixedTagTokens(items: readonly { tags: readonly string[] }[], match: TagMatch): Token[] {
  const tokens = new Map<string, { value: string; count: number }>();
  for (const item of items) {
    const held = new Set<string>();
    for (const tag of item.tags) {
      const key = tagMatchKey(tag, match);
      if (held.has(key)) continue;
      held.add(key);
      const token = tokens.get(key);
      if (token) token.count += 1;
      else tokens.set(key, { value: tag, count: 1 });
    }
  }
  return [...tokens.values()].map(({ value, count }) => (count < items.length ? { value, mixed: true } : { value }));
}

/**
 * What an edit of the bulk tokens asks the plan to do. A token removed is removed where present.
 * A new solid token, or a mixed token made solid, is added everywhere. A token still mixed is
 * left as each item has it. The plan applies remove with the same match.
 */
export function tagTokenEdit(original: readonly Token[], next: readonly Token[], match: TagMatch): { add: string[]; remove: string[] } {
  const before = new Map(original.map((token) => [tagMatchKey(token.value, match), token]));
  const after = new Set(next.map((token) => tagMatchKey(token.value, match)));
  const add = next
    .filter((token) => {
      if (token.mixed) return false;
      const previous = before.get(tagMatchKey(token.value, match));
      return !previous || previous.mixed === true;
    })
    .map((token) => token.value);
  const remove = original.filter((token) => !after.has(tagMatchKey(token.value, match))).map((token) => token.value);
  return { add, remove };
}

export interface TagSuggestionInput {
  /** Tags on the selected items. */
  selection: readonly string[];
  /** Tags on the loaded page. */
  page: readonly string[];
  /** Tags saved recently in this browser, newest first. */
  recent: readonly string[];
  /** The field's current tokens. */
  used: readonly string[];
  query: string;
  limit?: number;
}

/**
 * Suggestions from data already in hand, never a request: selection tags, then page tags, then
 * recent tags, by prefix. Both surfaces de-duplicate in any letter case, because TokenInput
 * refuses a new case variant of a tag it already holds.
 */
export function tagSuggestions({ selection, page, recent, used, query, limit = 8 }: TagSuggestionInput): string[] {
  const prefix = tagKey(query.trim());
  if (!prefix) return [];
  const seen = new Set(used.map(tagKey));
  const suggestions: string[] = [];
  for (const tag of [...selection, ...page, ...recent]) {
    const key = tagKey(tag);
    if (seen.has(key) || !key.startsWith(prefix)) continue;
    seen.add(key);
    suggestions.push(tag);
    if (suggestions.length >= limit) break;
  }
  return suggestions;
}
