import { DEFAULT_POSTS_BROWSE, postsBrowseTermKey, validatePostsBrowse, type PostsBrowseConfig, type PostsBrowseTerm, type PostsBrowseIcon } from "../../../packages/content-core/src/posts-browse";
import { postIndexFilterHref } from "./post-index-links";
export interface BrowsePost {
  categories: readonly string[];
  tags: readonly string[];
  image?: { url: string; width?: number; height?: number };
}
export interface BrowseSubject extends PostsBrowseTerm { count: number; href: string }
export interface BrowseCollection { id: string; label: string; icon: PostsBrowseIcon; items: BrowseSubject[]; image?: BrowsePost["image"] }
const normalized = (value: string) => value.trim().toLocaleLowerCase("en-US");
export function postMatchesSubject(post: BrowsePost, term: PostsBrowseTerm): boolean {
  return (term.filter === "category" ? post.categories : post.tags).some(value => normalized(value) === normalized(term.value));
}
/** Preserve each exact URL; counts reflect the reader's case-insensitive filter. */
export function postsBrowseCollections(posts: readonly BrowsePost[], configured?: PostsBrowseConfig): { collections: BrowseCollection[]; subjects: BrowseSubject[] } {
  const terms = new Map<string, PostsBrowseTerm>();
  for (const post of posts) for (const filter of ["category", "tag"] as const) {
    for (const value of filter === "category" ? post.categories : post.tags) {
      const term = { filter, value };
      terms.set(postsBrowseTermKey(term), term);
    }
  }
  const subjects = [...terms.values()].map(term => ({ ...term, count: posts.filter(post => postMatchesSubject(post, term)).length, href: postIndexFilterHref(term.filter, term.value) }));
  const byKey = new Map(subjects.map(term => [postsBrowseTermKey(term), term]));
  const config = configured && validatePostsBrowse(configured) === null ? configured : DEFAULT_POSTS_BROWSE;
  const assigned = new Set<string>();
  const collections: BrowseCollection[] = config.groups.flatMap(group => {
    const items = group.terms.flatMap(term => {
      const key = postsBrowseTermKey(term), subject = byKey.get(key);
      if (!subject || assigned.has(key)) return [];
      assigned.add(key); return [subject];
    });
    if (!items.length) return [];
    const coverPost = posts.find(post => post.image && (group.cover ? postMatchesSubject(post, group.cover) : items.some(term => postMatchesSubject(post, term))));
    return [{ id: group.id, label: group.label, icon: group.icon, items, ...(coverPost?.image ? { image: coverPost.image } : {}) }];
  });
  const other = subjects.filter(term => !assigned.has(postsBrowseTermKey(term))).sort((a, b) => a.value.localeCompare(b.value, "en-US") || a.filter.localeCompare(b.filter));
  if (other.length) collections.push({ id: "unassigned-subjects", label: "More topics & categories", icon: "pin", items: other });
  return { collections, subjects };
}
