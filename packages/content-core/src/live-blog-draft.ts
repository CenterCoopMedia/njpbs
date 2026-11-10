import { isRichTextDoc, richTextIsEmpty, type RichTextDoc } from "./content-model.ts";
import { assertLiveBlogData, isLiveBlogPresentation, type LiveBlogPresentation, isLiveBlogId, isLiveBlogFollowUpBody, LIVE_BLOG_MAX_FOLLOW_UPS, type LiveBlogFollowUp, LIVE_BLOG_COVERAGE_STATES, LIVE_BLOG_MAX_BYTES, LIVE_BLOG_MAX_UPDATES, LIVE_BLOG_MAX_MEDIA, LIVE_BLOG_BRANDING, type LiveBlogCoverageState, type LiveBlogData } from "./live-blog.ts";
import { isPostLeadMedia, withoutPublicLeadVideo, type PostLeadMedia } from "./post-lead-media.ts";
import { normalizeStoryCredits, type StoryCredit } from "./story-credits.ts";
import { parsePublishInstant } from "./publish-instant.ts";
import { homeCatalogJson as canonicalJson } from "./home-source-selection.ts";
export { publicRichText } from "./content-model.ts";
export { LIVE_BLOG_CONTRACT_VERSION, assertLiveBlogData, publicLiveBlogData, previewLiveBlogData, liveBlogMediaAssetIds, liveBlogVideoBlocks } from "./live-blog.ts";

export class LiveBlogDraftError extends Error {}

// Bound directory work before any Firestore lookup, across the whole Post.
export const LIVE_BLOG_MAX_REGISTERED_AUTHORS = 64;

/** Working entries have no publication clocks or frozen directory names. */
export interface LiveBlogDraftFollowUp {
  id: string;
  body: RichTextDoc;
  credits: StoryCredit[];
  correction?: string;
  withdrawal?: string;
}

export interface LiveBlogDraftUpdate {
  /** Empty/tmp- ids are replaced by the trusted save boundary. */
  id: string;
  headline: string;
  body: RichTextDoc;
  media?: PostLeadMedia;
  credits: StoryCredit[];
  keyUpdate: boolean;
  followUps?: LiveBlogDraftFollowUp[];
  correction?: string;
  withdrawal?: string;
}

export interface LiveBlogDraft {
  schemaVersion: 1;
  branding?: typeof LIVE_BLOG_BRANDING;
  presentation?: LiveBlogPresentation;
  coverageState: LiveBlogCoverageState;
  updates: LiveBlogDraftUpdate[];
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function only(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).every(key => allowed.includes(key));
}

function budget(value: unknown) {
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).length > LIVE_BLOG_MAX_BYTES) throw new LiveBlogDraftError();
  } catch { throw new LiveBlogDraftError("Live blog exceeds its JSON size limit or is not serializable."); }
}

/** Incomplete drafts are private; publication separately requires readable entries. */
export function parseLiveBlogDraft(value: unknown, { complete = false } = {}): LiveBlogDraft {
  budget(value);
  if (!object(value) || !only(value, ["schemaVersion", "branding", "presentation", "coverageState", "updates"])
    || value.schemaVersion !== 1 || (value.branding !== undefined && value.branding !== LIVE_BLOG_BRANDING) || !LIVE_BLOG_COVERAGE_STATES.includes(value.coverageState as LiveBlogCoverageState)
    || (value.presentation !== undefined && !isLiveBlogPresentation(value.presentation))
    || !Array.isArray(value.updates) || value.updates.length > LIVE_BLOG_MAX_UPDATES) {
    throw new LiveBlogDraftError("Check the live blog presentation, coverage state and entries.");
  }
  let mediaCount = 0;
  const ids = new Set<string>();
  const authors = new Set<string>();
  const updates = value.updates.map(raw => {
    if (!object(raw) || !only(raw, ["id", "headline", "body", "credits", "keyUpdate", "correction", "withdrawal", "media", "followUps"])
      || typeof raw.id !== "string" || (raw.id !== "" && (!isLiveBlogId(raw.id) || ids.has(raw.id)))
      || typeof raw.headline !== "string" || raw.headline.length > 240
      || !isRichTextDoc(raw.body) || typeof raw.keyUpdate !== "boolean") {
      throw new LiveBlogDraftError("Check the live blog entry id, headline and rich text.");
    }
    const media = raw.media == null ? undefined : withoutPublicLeadVideo(raw.media);
    if (media !== undefined && (!isPostLeadMedia(media, complete && raw.withdrawal === undefined)
      || (raw.withdrawal === undefined && ++mediaCount > LIVE_BLOG_MAX_MEDIA))) {
      throw new LiveBlogDraftError("Check entry media selections, alt text and video titles; at most 100 entries may have media.");
    }
    if (raw.id) ids.add(raw.id);
    for (const field of ["correction", "withdrawal"]) {
      if (raw[field] !== undefined && (typeof raw[field] !== "string" || !(raw[field] as string).trim() || (raw[field] as string).length > 1000)) {
        throw new LiveBlogDraftError("A correction or withdrawal needs a visible explanation of at most 1,000 characters.");
      }
    }
    const normalized = normalizeStoryCredits(raw.credits);
    if (!normalized.ok) throw new LiveBlogDraftError(normalized.errors[0]);
    for (const credit of normalized.credits) if (credit.kind === "registered") authors.add(credit.authorId);
    if (authors.size > LIVE_BLOG_MAX_REGISTERED_AUTHORS) {
      throw new LiveBlogDraftError(`A live blog may credit at most ${LIVE_BLOG_MAX_REGISTERED_AUTHORS} distinct registered authors. Use custom credits for other contributors.`);
    }
    if (complete && raw.withdrawal === undefined && (!raw.headline.trim() || richTextIsEmpty(raw.body) || !normalized.credits.length)) {
      throw new LiveBlogDraftError("Each published entry needs a headline, readable body and byline.");
    }
    const followUps = parseFollowUps(raw.followUps, complete && raw.withdrawal === undefined, authors);
    return {
      ...(followUps === undefined ? {} : { followUps }),
      id: raw.id, headline: raw.headline, body: structuredClone(raw.body),
      credits: normalized.credits, keyUpdate: raw.keyUpdate,
      ...(media === undefined ? {} : { media: structuredClone(media) }),
      ...(raw.correction === undefined ? {} : { correction: raw.correction as string }),
      ...(raw.withdrawal === undefined ? {} : { withdrawal: raw.withdrawal as string }),
    };
  });
  return { schemaVersion: 1, ...(value.branding === undefined ? {} : { branding: LIVE_BLOG_BRANDING }), ...(value.presentation === undefined ? {} : { presentation: { ...value.presentation } }), coverageState: value.coverageState as LiveBlogCoverageState, updates };
}

/** Published entry links survive every working edit and historical restore. */
export function assertLiveBlogRetainsPublished(draft: LiveBlogDraft | undefined, published?: LiveBlogData) {
  if (!published) return;
  assertLiveBlogData(published);
  if (!draft && published.updates.length === 0) return;
  if (!draft) throw new LiveBlogDraftError("A published live blog must be retained. Withdraw entries with a visible explanation instead.");
  for (const entry of published.updates) {
    const next = draft.updates.find(item => item.id === entry.id);
    if (!next) throw new LiveBlogDraftError("Published entries cannot be removed. Withdraw the entry with a visible explanation instead.");
    for (const followUp of entry.followUps ?? []) {
      const retained = next.followUps?.find(item => item.id === followUp.id);
      if (!retained) throw new LiveBlogDraftError("Published follow-ups cannot be removed. Withdraw the follow-up instead.");
      if (followUp.withdrawal !== undefined && retained.withdrawal === undefined) throw new LiveBlogDraftError("A withdrawn follow-up cannot be restored.");
    }
    if (entry.withdrawal !== undefined && next.withdrawal === undefined) {
      throw new LiveBlogDraftError("A withdrawn entry cannot be restored to reporting. Add a new entry instead.");
    }
  }
}

/** Only the server may introduce a canonical entry id. */
export function prepareLiveBlogDraft(value: unknown, options: {
  previous?: LiveBlogDraft; published?: LiveBlogData; mintId: () => string;
}): LiveBlogDraft {
  const draft = parseLiveBlogDraft(value);
  assertLiveBlogFollowUpsEditable(draft, options.previous, options.published);
  const known = new Set([...(options.previous?.updates ?? []), ...(options.published?.updates ?? [])].map(entry => entry.id));
  const assigned = new Set(known);
  for (const entry of draft.updates) {
    if (!entry.id || entry.id.startsWith("tmp-")) {
      const id = options.mintId();
      if (!isLiveBlogId(id) || id.startsWith("tmp-") || assigned.has(id)) throw new LiveBlogDraftError("Could not create a unique live blog entry id.");
      entry.id = id;
      assigned.add(id);
    } else if (!known.has(entry.id)) {
      throw new LiveBlogDraftError("New live blog entries need a server-generated id. Reload before saving.");
    }
  }
  for (const entry of draft.updates) {
    const known = new Set([...(options.previous?.updates.find(old => old.id === entry.id)?.followUps ?? []),
      ...(options.published?.updates.find(old => old.id === entry.id)?.followUps ?? [])].map(item => item.id));
    const assigned = new Set(known);
    for (const item of entry.followUps ?? []) {
      if (!item.id || item.id.startsWith("tmp-")) {
        const id = options.mintId();
        if (!isLiveBlogId(id) || id.startsWith("tmp-") || assigned.has(id)) throw new LiveBlogDraftError("Could not create a unique follow-up id.");
        item.id = id; assigned.add(id);
      } else if (!known.has(item.id)) throw new LiveBlogDraftError("New follow-ups need a server-generated id. Reload before saving.");
    }
  }
  assertLiveBlogRetainsPublished(draft, options.published);
  budget(draft);
  return draft;
}

function authored(entry: LiveBlogDraftUpdate) {
  return canonicalJson({ headline: entry.headline, body: entry.body,
    media: entry.media === undefined ? null : withoutPublicLeadVideo(entry.media),
    credits: normalizeStoryCredits(entry.credits).credits, keyUpdate: entry.keyUpdate,
    correction: entry.correction ?? null, withdrawal: entry.withdrawal ?? null });
}

function entryForPublication(entry: LiveBlogDraftUpdate, previous?: LiveBlogData["updates"][number]): LiveBlogDraftUpdate {
  if (entry.withdrawal === undefined) return entry;
  const { media: _media, followUps: _followUps, ...tombstone } = entry;
  return {
    ...tombstone, headline: "Update withdrawn", body: { type: "doc", content: [] }, keyUpdate: false,
    ...(previous ? { credits: previous.credits } : {}),
  };
}

/** Approval and publication enforce the same entry lifecycle before any freezing. */
export function assertLiveBlogReady(value: unknown, previous?: LiveBlogData): LiveBlogDraft {
  const draft = parseLiveBlogDraft(value);
  assertLiveBlogRetainsPublished(draft, previous);
  for (const entry of draft.updates) {
    if (!entry.id || entry.id.startsWith("tmp-")) throw new LiveBlogDraftError("Save live blog entries before publication.");
    if (entry.followUps?.some(item => !item.id || item.id.startsWith("tmp-"))) throw new LiveBlogDraftError("Save follow-ups before publication.");
  }
  parseLiveBlogDraft(draft, { complete: true });
  for (const entry of draft.updates) {
    const before = previous?.updates.find(item => item.id === entry.id);
    if (entry.withdrawal === undefined) assertFollowUpsReady(entry.followUps, before?.followUps);
    if (before && authored(entryForPublication(entry, before)) === authored(before)) continue;
    if (before && !entry.withdrawal && (!entry.correction || entry.correction === before.correction)) {
      throw new LiveBlogDraftError("An edited published entry needs a new visible correction explanation.");
    }
    if (!before && (entry.correction || entry.withdrawal)) throw new LiveBlogDraftError("Only a previously published entry can be corrected or withdrawn.");
  }
  return draft;
}

/** Freeze one whole-Post revision. No per-entry publication lifecycle exists. */
export function freezeLiveBlogData(value: unknown, options: {
  previous?: LiveBlogData; at: string; preview?: boolean; freezeCredits: (credits: StoryCredit[]) => StoryCredit[];
}): LiveBlogData {
  const draft = options.preview ? parseLiveBlogDraft(value) : assertLiveBlogReady(value, options.previous);
  if (options.preview) {
    assertLiveBlogRetainsPublished(draft, options.previous);
    if (draft.updates.some(entry => !entry.id || entry.id.startsWith("tmp-") || entry.followUps?.some(item => !item.id || item.id.startsWith("tmp-")))) throw new LiveBlogDraftError("Save live blog entries before previewing.");
  }
  const instant = parsePublishInstant(options.at);
  if (instant === null || (options.previous && instant < parsePublishInstant(options.previous.updatedAt)!)) throw new LiveBlogDraftError("Invalid live blog publication time.");
  let changed = !options.previous || options.previous.coverageState !== draft.coverageState || options.previous.branding !== draft.branding
    || canonicalJson(options.previous.presentation ?? null) !== canonicalJson(draft.presentation ?? null);
  const updates = draft.updates.map(entry => {
    const previous = options.previous?.updates.find(item => item.id === entry.id);
    // A tombstone never carries the withdrawn body into a public snapshot.
    const publicEntry = entryForPublication(entry, previous);
    const followUps = entry.withdrawal === undefined ? freezeFollowUps(entry.followUps, previous?.followUps, options) : undefined;
    if (options.previous && canonicalJson(followUps ?? []) !== canonicalJson(previous?.followUps ?? [])
      && instant <= parsePublishInstant(options.previous.updatedAt)!) throw new LiveBlogDraftError("A follow-up change needs a later blog publication time.");
    const ownSame = previous && authored(publicEntry) === authored(previous);
    const same = ownSame
      && canonicalJson(followUps ?? []) === canonicalJson(previous.followUps ?? []);
    if (same) return structuredClone(previous);
    if (previous && instant <= parsePublishInstant(previous.updatedAt)!) throw new LiveBlogDraftError("An entry revision needs a later publication time.");
    changed = true;
    // A deleted profile may no longer resolve; keep the last published name as
    // the existing credit freezer's fallback, without trusting client names.
    const creditsWithFallback = entry.credits.map(credit => credit.kind !== "registered" ? credit : {
      ...previous?.credits.find(old => old.kind === "registered" && old.authorId === credit.authorId), ...credit,
    });
    const credits = (ownSame || entry.withdrawal) && previous ? previous.credits : options.freezeCredits(creditsWithFallback);
    if (JSON.stringify(normalizeStoryCredits(credits).credits) !== JSON.stringify(entry.withdrawal && previous ? normalizeStoryCredits(previous.credits).credits : entry.credits)) {
      throw new LiveBlogDraftError("Every entry byline needs a resolved author name. Repair the byline before publication.");
    }
    const { followUps: _draftFollowUps, ...publicReporting } = publicEntry;
    return { ...publicReporting, ...(followUps === undefined ? {} : { followUps }), credits, publishedAt: previous?.publishedAt ?? options.at, updatedAt: options.at };
  });
  const result: LiveBlogData = { schemaVersion: 1, ...(draft.branding === undefined ? {} : { branding: draft.branding }), ...(draft.presentation === undefined ? {} : { presentation: { ...draft.presentation } }), coverageState: draft.coverageState,
    updatedAt: changed ? options.at : options.previous!.updatedAt, updates };
  assertLiveBlogData(result, { complete: !options.preview });
  return result;
}

function parseFollowUps(value: unknown, complete: boolean, authors: Set<string>): LiveBlogDraftFollowUp[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > LIVE_BLOG_MAX_FOLLOW_UPS) throw new LiveBlogDraftError("An update may have at most 20 follow-ups.");
  if (value.length === 0) return;
  const ids = new Set<string>();
  return value.map(raw => {
    if (!object(raw) || !only(raw, ["id", "body", "credits", "correction", "withdrawal"])
      || typeof raw.id !== "string" || (raw.id !== "" && (!isLiveBlogId(raw.id) || ids.has(raw.id)))
      || !isLiveBlogFollowUpBody(raw.body, complete && raw.withdrawal === undefined)) {
      throw new LiveBlogDraftError("Follow-ups need a unique id and up to 1,000 characters in paragraphs, with links, bold or italic only.");
    }
    if (raw.id) ids.add(raw.id);
    for (const field of ["correction", "withdrawal"]) {
      if (raw[field] !== undefined && (typeof raw[field] !== "string" || !(raw[field] as string).trim() || (raw[field] as string).length > 1000)) {
        throw new LiveBlogDraftError("A follow-up correction or withdrawal needs an explanation of at most 1,000 characters.");
      }
    }
    const credits = normalizeStoryCredits(raw.credits);
    if (!credits.ok || (complete && !credits.credits.length)) throw new LiveBlogDraftError("Each follow-up needs a valid byline.");
    for (const credit of credits.credits) if (credit.kind === "registered") authors.add(credit.authorId);
    if (authors.size > LIVE_BLOG_MAX_REGISTERED_AUTHORS) throw new LiveBlogDraftError("A live blog may credit at most 64 distinct registered authors.");
    return { id: raw.id, body: structuredClone(raw.body), credits: credits.credits,
      ...(raw.correction === undefined ? {} : { correction: raw.correction as string }),
      ...(raw.withdrawal === undefined ? {} : { withdrawal: raw.withdrawal as string }) };
  });
}

function followUpForPublication(item: LiveBlogDraftFollowUp, previous?: LiveBlogFollowUp): LiveBlogDraftFollowUp {
  return item.withdrawal === undefined ? item : { ...item, body: { type: "doc", content: [] },
    credits: previous?.credits ?? item.credits };
}
function followUpAuthored(item: LiveBlogDraftFollowUp) {
  return canonicalJson({ body: item.body, credits: normalizeStoryCredits(item.credits).credits,
    correction: item.correction ?? null, withdrawal: item.withdrawal ?? null });
}
function assertFollowUpsReady(items: LiveBlogDraftFollowUp[] = [], previous: LiveBlogFollowUp[] = []) {
  for (const item of items) {
    const before = previous.find(old => old.id === item.id);
    if (before && followUpAuthored(followUpForPublication(item, before)) === followUpAuthored(before)) continue;
    if (before && !item.withdrawal && (!item.correction || item.correction === before.correction)) {
      throw new LiveBlogDraftError("An edited published follow-up needs a new visible correction explanation.");
    }
    if (!before && (item.correction || item.withdrawal)) throw new LiveBlogDraftError("Only a previously published follow-up can be corrected or withdrawn.");
  }
}
function freezeFollowUps(items: LiveBlogDraftFollowUp[] | undefined, previous: LiveBlogFollowUp[] | undefined,
  options: { at: string; freezeCredits: (credits: StoryCredit[]) => StoryCredit[] }): LiveBlogFollowUp[] | undefined {
  if (items === undefined) return;
  return items.map(item => {
    const before = previous?.find(old => old.id === item.id);
    const publicItem = followUpForPublication(item, before);
    if (before && followUpAuthored(publicItem) === followUpAuthored(before)) return structuredClone(before);
    if (before && parsePublishInstant(options.at)! <= parsePublishInstant(before.updatedAt)!) throw new LiveBlogDraftError("A follow-up revision needs a later publication time.");
    const fallback = item.credits.map(credit => credit.kind !== "registered" ? credit : {
      ...before?.credits.find(old => old.kind === "registered" && old.authorId === credit.authorId), ...credit,
    });
    const credits = item.withdrawal && before ? before.credits : options.freezeCredits(fallback);
    if (canonicalJson(normalizeStoryCredits(credits).credits) !== canonicalJson(item.withdrawal && before ? normalizeStoryCredits(before.credits).credits : item.credits)) {
      throw new LiveBlogDraftError("Every follow-up byline needs a resolved author name.");
    }
    return { ...publicItem, credits, publishedAt: before?.publishedAt ?? options.at, updatedAt: options.at };
  }).sort((a, b) => parsePublishInstant(a.publishedAt)! - parsePublishInstant(b.publishedAt)!);
}

/** A parent withdrawal hides the audit thread, without editing its saved reporting. */
export function assertLiveBlogFollowUpsEditable(draft: LiveBlogDraft | undefined, previous?: LiveBlogDraft, published?: LiveBlogData) {
  for (const entry of draft?.updates ?? []) {
    const publishedBefore = published?.updates.find(old => old.id === entry.id);
    const before = previous?.updates.find(old => old.id === entry.id) ?? publishedBefore;
    if (entry.withdrawal === undefined && publishedBefore?.withdrawal === undefined) continue;
    if (!liveBlogFollowUpsEqual(entry.followUps, before?.followUps)) throw new LiveBlogDraftError("Follow-ups are hidden with this withdrawn update and cannot be changed.");
  }
}

/** Compare working thread reporting with its saved baseline, ignoring frozen clocks/names. */
export function liveBlogFollowUpsEqual(left: LiveBlogDraftFollowUp[] = [], right: LiveBlogDraftFollowUp[] = []): boolean {
  const reporting = (items: LiveBlogDraftFollowUp[]) => canonicalJson(items.map(item => ({ id: item.id, authored: followUpAuthored(item) })));
  return reporting(left) === reporting(right);
}
