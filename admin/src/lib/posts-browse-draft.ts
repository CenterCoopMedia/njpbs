import type { PostsBrowseConfig } from "../../../packages/content-core/src/posts-browse";

/** Match editor feedback to the values sent by Save draft. */
export function canonicalPostsBrowse(config: PostsBrowseConfig): PostsBrowseConfig {
  return { groups: config.groups.map(group => ({
    ...group, label: group.label.trim(),
    terms: group.terms.map(term => ({ ...term, value: term.value.trim() })),
    ...(group.cover ? { cover: { ...group.cover, value: group.cover.value.trim() } } : {}),
  })) };
}
