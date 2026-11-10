import { LIVE_BLOG_MAX_UPDATES, isLiveBlogId, isLiveBlogPresentation, orderedLiveBlogUpdates, type LiveBlogData } from "./live-blog";
import { parsePublishInstant } from "./publish-instant";

export interface LiveBlogManifest {
  schemaVersion: 1;
  postId: string;
  updatedAt: string;
  coverageState: LiveBlogData["coverageState"];
  presentation?: LiveBlogData["presentation"];
  totalCount: number;
  /** Latest nested revision, including parents outside the bounded polling window. */
  followUpsUpdatedAt?: string;
  updates: { id: string; updatedAt: string }[];
}

/** Public revision metadata only; no reporting, bylines, media or working fields. */
export function liveBlogManifest(postId: string, value: LiveBlogData): LiveBlogManifest {
  const revisions = value.updates.flatMap(entry => entry.withdrawal !== undefined ? [entry.updatedAt] : (entry.followUps ?? []).map(item => item.updatedAt)).sort((a, b) => Date.parse(b) - Date.parse(a));
  return { ...(revisions.length ? { followUpsUpdatedAt: revisions[0] } : {}), schemaVersion: 1, postId, updatedAt: value.updatedAt, coverageState: value.coverageState, ...(value.presentation === undefined ? {} : { presentation: { ...value.presentation } }), totalCount: value.updates.length,
    updates: orderedLiveBlogUpdates(value).map(({ id, updatedAt }) => ({ id, updatedAt })) };
}

export const LIVE_BLOG_FEED_LIMIT = 50;
/** The full HTML owns the archive; polling needs only its newest revisions. */
export function liveBlogFeed(value: LiveBlogManifest): LiveBlogManifest {
  return { ...value, updates: value.updates.slice(0, LIVE_BLOG_FEED_LIMIT) };
}

export function parseLiveBlogManifest(value: unknown): LiveBlogManifest {
  if (!value || typeof value !== "object") throw new Error("Invalid live blog revision");
  const input = value as LiveBlogManifest;
  if (input.schemaVersion !== 1 || !isLiveBlogId(input.postId) || parsePublishInstant(input.updatedAt) === null ||
      (input.presentation !== undefined && !isLiveBlogPresentation(input.presentation)) ||
      !["ongoing", "paused", "ended"].includes(input.coverageState) || !Number.isInteger(input.totalCount) ||
      (input.followUpsUpdatedAt !== undefined && (parsePublishInstant(input.followUpsUpdatedAt) === null || Date.parse(input.followUpsUpdatedAt) > Date.parse(input.updatedAt))) ||
      input.totalCount < 0 || input.totalCount > LIVE_BLOG_MAX_UPDATES || !Array.isArray(input.updates) || input.updates.length > input.totalCount ||
      input.updates.length > LIVE_BLOG_MAX_UPDATES || input.updates.some(entry => !entry ||
        !isLiveBlogId(entry.id) || parsePublishInstant(entry.updatedAt) === null || Date.parse(entry.updatedAt) > Date.parse(input.updatedAt)) ||
      new Set(input.updates.map(entry => entry.id)).size !== input.updates.length) throw new Error("Invalid live blog revision");
  return { ...(input.followUpsUpdatedAt === undefined ? {} : { followUpsUpdatedAt: input.followUpsUpdatedAt }), schemaVersion: 1, postId: input.postId, updatedAt: input.updatedAt, coverageState: input.coverageState, ...(input.presentation === undefined ? {} : { presentation: { ...input.presentation } }), totalCount: input.totalCount,
    updates: input.updates.map(({ id, updatedAt }) => ({ id, updatedAt })) };
}

export function parseLiveBlogFeed(value: unknown): LiveBlogManifest {
  const feed = parseLiveBlogManifest(value);
  if (feed.updates.length !== Math.min(feed.totalCount, LIVE_BLOG_FEED_LIMIT)) throw new Error("Invalid live blog feed");
  return feed;
}

export function manifestFromLiveBlogHtml(html: string): LiveBlogManifest | null {
  const markers = [...html.matchAll(/<script type="application\/json" data-live-blog-manifest>([\s\S]*?)<\/script>/g)];
  if (!markers.length) return null;
  if (markers.length !== 1 || markers[0][1].length > 65_536) throw new Error("Invalid live blog revision");
  const manifest = parseLiveBlogManifest(JSON.parse(markers[0][1]));
  if (manifest.updates.length !== manifest.totalCount) throw new Error("Incomplete live blog revision");
  return manifest;
}
