import {
  postIndexFilterHref,
  type PostIndexFilter,
} from "./post-index-links";

export type HomepageNewsTopicFilter = Extract<
  PostIndexFilter,
  "category" | "tag"
>;

export interface HomepageNewsTopic {
  label: string;
  filter: HomepageNewsTopicFilter;
  value: string;
}

/**
 * Representative topic order for secondary homepage rows in builds with
 * INTERNAL_SURFACES enabled.
 */
export const STAGED_HOMEPAGE_NEWS_TOPICS = Object.freeze([
  { label: "Politics", filter: "category", value: "Politics" },
  { label: "Education", filter: "category", value: "Education" },
  { label: "Health", filter: "category", value: "Health" },
  { label: "Environment", filter: "category", value: "Environment" },
  { label: "Transportation", filter: "category", value: "Transportation" },
  { label: "Business", filter: "category", value: "Business" },
  { label: "Elections", filter: "category", value: "Elections" },
] satisfies readonly HomepageNewsTopic[]);

export function homepageNewsTopicHref(topic: HomepageNewsTopic): string {
  return postIndexFilterHref(topic.filter, topic.value);
}
