// Frozen Post metadata projected through the existing publication and preview paths.
// Public reads require complete frozen data; unfinished entries stay in private previews.
import { isRichTextDoc, richTextIsEmpty, publicRichText, type RichTextDoc } from "./content-model.ts";
import { isPostLeadMedia, leadMediaAssetIds, leadVideoBlocks, type PostLeadMedia } from "./post-lead-media.ts";
import { isAuthorId } from "./author-profiles.ts";
import { parsePublishInstant } from "./publish-instant.ts";
import { normalizeCustomCreditName, STORY_CREDITS_MAX, type StoryCredit } from "./story-credits.ts";

export const LIVE_BLOG_CONTRACT_VERSION = 3;
export const LIVE_BLOG_MAX_UPDATES = 200;
export const LIVE_BLOG_MAX_FOLLOW_UPS = 20;
export const LIVE_BLOG_FOLLOW_UP_MAX_CHARACTERS = 1000;
export const LIVE_BLOG_MAX_MEDIA = 100;
export const LIVE_BLOG_BRANDING = "nj-decides-2026" as const;
export const LIVE_BLOG_MAX_BYTES = 256 * 1024;
export const LIVE_BLOG_COVERAGE_STATES = ["ongoing", "paused", "ended"] as const;
export type LiveBlogCoverageState = (typeof LIVE_BLOG_COVERAGE_STATES)[number];

/** Per-blog choices; omitted fields keep the public presentation defaults. */
export interface LiveBlogPresentation {
  reporterPhotos?: boolean;
  reporterCards?: boolean;
  playful?: boolean;
}

export function isLiveBlogPresentation(value: unknown): value is LiveBlogPresentation {
  return record(value) && keys(value, ["reporterPhotos", "reporterCards", "playful"])
    && Object.values(value).every(field => typeof field === "boolean");
}

export function resolveLiveBlogPresentation(data: Pick<LiveBlogData, "presentation">): Required<LiveBlogPresentation> {
  return {
    reporterPhotos: data.presentation?.reporterPhotos ?? true,
    reporterCards: data.presentation?.reporterCards ?? true,
    playful: data.presentation?.playful ?? false,
  };
}

export interface LiveBlogFollowUp {
  id: string;
  body: RichTextDoc;
  credits: StoryCredit[];
  publishedAt: string;
  updatedAt: string;
  correction?: string;
  /** Tombstones carry an empty document, never the withdrawn reporting. */
  withdrawal?: string;
}

export interface LiveBlogUpdate {
  /** Server-generated immutable id; editing a headline must not change its link. */
  id: string;
  headline: string;
  body: RichTextDoc;
  /** One attachment uses the same image/video contract as the Post lead. */
  media?: PostLeadMedia;
  /** Ordered credits frozen by the existing story-credit publisher. */
  credits: StoryCredit[];
  publishedAt: string;
  updatedAt: string;
  keyUpdate: boolean;
  followUps?: LiveBlogFollowUp[];
  /** Visible explanation of a correction, retained with the corrected revision. */
  correction?: string;
  /** Visible permanent tombstone; its former body is excluded from public data. */
  withdrawal?: string;
}

export interface LiveBlogData {
  schemaVersion: 1;
  branding?: typeof LIVE_BLOG_BRANDING;
  presentation?: LiveBlogPresentation;
  /** Coverage state is separate from the Post's approval/publication lifecycle. */
  coverageState: LiveBlogCoverageState;
  /** Last published change to blog settings or any entry. */
  updatedAt: string;
  updates: LiveBlogUpdate[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

/** IDs are opaque; the renderer adds its own prefix before using one in HTML. */
export function isLiveBlogId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}

function frozenCredits(value: unknown, complete: boolean): value is StoryCredit[] {
  if (!Array.isArray(value) || (complete && value.length === 0) || value.length > STORY_CREDITS_MAX) return false;
  const authors = new Set<string>();
  return value.every((credit) => {
    if (!record(credit)) return false;
    const name = credit.kind === "custom" ? credit.name : credit.displayName;
    if (!text(name, 120) || normalizeCustomCreditName(name) !== name) return false;
    if (credit.kind === "custom") return keys(credit, ["kind", "name"]);
    if (credit.kind !== "registered" || !isAuthorId(credit.authorId)
      || !keys(credit, ["kind", "authorId", "displayName", "slug"])
      || (credit.slug !== undefined && typeof credit.slug !== "string")
      || authors.has(credit.authorId)) return false;
    authors.add(credit.authorId);
    return true;
  });
}

/**
 * Strict published-data contract, not a draft-save validator or authorization gate.
 * Bounds refuse an oversized blog; they never silently discard older reporting.
 */
export function assertLiveBlogData(value: unknown, { complete = true } = {}): asserts value is LiveBlogData {
  if (!record(value) || !keys(value, ["schemaVersion", "branding", "presentation", "coverageState", "updatedAt", "updates"])
    || value.schemaVersion !== 1 || (value.branding !== undefined && value.branding !== LIVE_BLOG_BRANDING)
    || (value.presentation !== undefined && !isLiveBlogPresentation(value.presentation))
    || !LIVE_BLOG_COVERAGE_STATES.includes(value.coverageState as LiveBlogCoverageState)
    || typeof value.updatedAt !== "string" || parsePublishInstant(value.updatedAt) === null
    || !Array.isArray(value.updates) || value.updates.length > LIVE_BLOG_MAX_UPDATES) {
    throw new Error("Invalid live blog snapshot.");
  }
  // Check before walking the rich-text trees; malformed/cyclic input fails closed.
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).length > LIVE_BLOG_MAX_BYTES) throw new Error();
  } catch {
    throw new Error("Live blog snapshot exceeds the JSON size limit or is not serializable.");
  }
  let mediaCount = 0;
  const seen = new Set<string>();
  const changedAt = parsePublishInstant(value.updatedAt)!;
  for (const entry of value.updates) {
    if (!record(entry) || !keys(entry, ["id", "headline", "body", "credits", "publishedAt", "updatedAt", "keyUpdate", "correction", "withdrawal", "media", "followUps"])
      || !isLiveBlogId(entry.id) || seen.has(entry.id)
      || typeof entry.headline !== "string" || entry.headline.length > 240 || (complete && !entry.headline.trim())
      || !isRichTextDoc(entry.body) || (complete && entry.withdrawal === undefined && richTextIsEmpty(entry.body))
      || (entry.media !== undefined && (!isPostLeadMedia(entry.media, complete) || ++mediaCount > LIVE_BLOG_MAX_MEDIA))
      || !frozenCredits(entry.credits, complete) || typeof entry.keyUpdate !== "boolean"
      || typeof entry.publishedAt !== "string" || typeof entry.updatedAt !== "string"
      || (entry.correction !== undefined && !text(entry.correction, 1000))
      || (entry.withdrawal !== undefined && (!text(entry.withdrawal, 1000) || entry.headline !== "Update withdrawn"
        || entry.body.content.length !== 0 || entry.keyUpdate !== false || entry.media !== undefined || entry.followUps !== undefined))) {
      throw new Error("Invalid live blog update or duplicate update id.");
    }
    const publishedAt = parsePublishInstant(entry.publishedAt);
    const updatedAt = parsePublishInstant(entry.updatedAt);
    if (publishedAt === null || updatedAt === null || updatedAt < publishedAt
      || updatedAt > changedAt || (complete && (entry.correction !== undefined || entry.withdrawal !== undefined) && updatedAt === publishedAt)) {
      throw new Error("Live blog update dates must be real UTC instants in publication order.");
    }
    assertLiveBlogFollowUps(entry.followUps, entry.publishedAt as string, entry.updatedAt as string, complete);
    seen.add(entry.id);
  }
}

/** Latest first; equal instants use immutable IDs, independent of input order. */
export function orderedLiveBlogUpdates(data: LiveBlogData): LiveBlogUpdate[] {
  return [...data.updates].sort((a, b) => {
    const difference = parsePublishInstant(b.publishedAt)! - parsePublishInstant(a.publishedAt)!;
    return difference || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}

/** Project the immutable feed only, removing editor-only rich-text attributes. */
export function publicLiveBlogData(value: unknown, asOf: string): LiveBlogData {
  return projectLiveBlogData(value, asOf, true);
}

/** Explicitly private: unfinished reporting is readable only in a draft preview. */
export function previewLiveBlogData(value: unknown, asOf: string): LiveBlogData {
  return projectLiveBlogData(value, asOf, false);
}

function projectLiveBlogData(value: unknown, asOf: string, complete: boolean): LiveBlogData {
  // Retained private audit threads never cross a public projection boundary.
  value = record(value) && Array.isArray(value.updates) ? { ...value, updates: value.updates.map(entry => {
    if (!record(entry) || entry.withdrawal === undefined) return entry;
    const { followUps: _auditThread, ...tombstone } = entry;
    return tombstone;
  }) } : value;
  assertLiveBlogData(value, { complete });
  const cutoff = parsePublishInstant(asOf);
  if (cutoff === null || parsePublishInstant(value.updatedAt)! > cutoff) {
    throw new Error("Live blog revision is newer than its enclosing published snapshot.");
  }
  return { ...structuredClone(value), updates: value.updates.map(entry => ({
    ...structuredClone(entry), body: publicRichText(entry.body),
    ...(entry.followUps === undefined ? {} : { followUps: entry.followUps.map(followUp => ({
      ...structuredClone(followUp), body: publicRichText(followUp.body),
    })) }),
  })) };
}

/** Adapt entry attachments to existing image usage and library-video owners. */
export function liveBlogMediaAssetIds(value: unknown): string[] {
  if (!record(value) || !Array.isArray(value.updates)) return [];
  return value.updates.flatMap(entry => record(entry) && entry.withdrawal === undefined ? leadMediaAssetIds(entry.media) : []);
}

export function liveBlogVideoBlocks(value: unknown) {
  if (!record(value) || !Array.isArray(value.updates)) return [];
  return value.updates.flatMap((entry, index) => record(entry) && entry.withdrawal === undefined
    ? leadVideoBlocks(entry.media).map(block => ({ ...block, id: `live-blog-video-${index}`, order: index })) : []);
}

/** Follow-ups intentionally have a smaller writing vocabulary than full updates. */
export function isLiveBlogFollowUpBody(value: unknown, complete = true): value is RichTextDoc {
  if (!isRichTextDoc(value) || value.text !== undefined || value.marks?.length) return false;
  let characters = 0;
  if (!value.content.every(paragraph => paragraph.type === "paragraph" && paragraph.text === undefined
    && !paragraph.marks?.length && (paragraph.content ?? []).every(node => {
      if (node.type !== "text" || typeof node.text !== "string" || node.content !== undefined
        || node.marks?.some(mark => !["bold", "italic", "link"].includes(mark.type))) return false;
      characters += Array.from(node.text).length;
      return true;
    }))) return false;
  return characters <= LIVE_BLOG_FOLLOW_UP_MAX_CHARACTERS && (!complete || !richTextIsEmpty(value));
}

function assertLiveBlogFollowUps(value: unknown, parentPublishedAt: string, parentUpdatedAt: string, complete: boolean) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > LIVE_BLOG_MAX_FOLLOW_UPS) throw new Error("Invalid live blog follow-ups.");
  const ids = new Set<string>();
  let oldest = parsePublishInstant(parentPublishedAt)!;
  for (const item of value) {
    if (!record(item) || !keys(item, ["id", "body", "credits", "publishedAt", "updatedAt", "correction", "withdrawal"])
      || !isLiveBlogId(item.id) || ids.has(item.id) || !frozenCredits(item.credits, complete)
      || !isLiveBlogFollowUpBody(item.body, complete && item.withdrawal === undefined)
      || (item.correction !== undefined && !text(item.correction, 1000))
      || (item.withdrawal !== undefined && (!text(item.withdrawal, 1000) || item.body.content.length !== 0))) {
      throw new Error("Invalid live blog follow-up.");
    }
    const published = parsePublishInstant(typeof item.publishedAt === "string" ? item.publishedAt : ""), updated = parsePublishInstant(typeof item.updatedAt === "string" ? item.updatedAt : "");
    if (published === null || updated === null || published < oldest || updated < published
      || updated > parsePublishInstant(parentUpdatedAt)!
      || (complete && (item.correction !== undefined || item.withdrawal !== undefined) && updated === published)) {
      throw new Error("Invalid live blog follow-up dates or order.");
    }
    oldest = published; ids.add(item.id);
  }
}
