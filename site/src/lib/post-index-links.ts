export type PostIndexFilter = "by" | "category" | "tag";

/** Link to the public Post index with one exact attribution or topic filter. */
export function postIndexFilterHref(
  filter: PostIndexFilter,
  value: string,
): string {
  return `/posts/?${new URLSearchParams([[filter, value]]).toString()}`;
}

interface PostCreditLink {
  name: string;
  slug?: string;
  authorId?: string;
}

/** Public destination for one frozen credit, or null for a withdrawn author. */
export function postCreditHref(credit: PostCreditLink): string | null {
  if (credit.slug) return `/authors/${credit.slug}/`;
  if (credit.authorId) return null;
  return postIndexFilterHref("by", credit.name);
}
