import type { ContentLinkMetadata } from "./content-link.ts";
import { isTownLookupData, type TownLookupData } from "./town-lookup.ts";
import { isDataHubSectionData, dataHubCompositionError, type DataHubSectionData } from "./data-hub-composition.ts";
// The editorial content model for the CMS (issue #200): the typed record shapes,
// the fixed page-builder block set, and the rich-text renderer that bakes stored
// content to static HTML at build.
//
// This is the dependency-free core of the model. It deliberately does not import
// `astro:content` or a Firestore client, so it is unit-testable in isolation and
// reusable by both the Astro Content Layer loader (the remaining, Firebase-backed
// half of #200) and the page components that render a record's blocks.
//
// Two invariants from the issue are load-bearing and are enforced here rather than
// left to convention:
//   1. Rich text is stored as structured TipTap JSON, never as an HTML string, and
//      the only HTML the site emits for it comes from `renderRichText` with
//      escaping and an href allow-list. A stored record therefore cannot smuggle
//      markup or a `javascript:` link into a page.
//   2. Every record is keyed on an immutable `id`, never its slug, so renaming a
//      slug for SEO never breaks a reference; `keyOf` centralizes that key.
//   3. A page or post body is an ordered array of typed blocks (ADR 0013). Each
//      block is a `{ id, type, section?, order, visible, data }` envelope with a
//      server-generated immutable `id`, so version history and media-usage
//      tracking key on the block id, never on the array position or a mutable
//      field.

import { contentLayoutError, visibleLayoutBlocks, isRowData, type BlockLayout, type RowData } from "./content-layout.ts";
import { isHomeSelectedIds, isHomeSelectionReceipt } from "./home-source-selection.ts";
export type { BlockLayout, RowData } from "./content-layout";

import {
  SHELF_ITEM_LIMITS,
  SHELF_PIN_MAX,
  SHELF_SORTS,
  TOPIC_SHELF_SOURCES,
  VIDEO_LIBRARIES,
  isShelfTopicId,
  type ShelfItemLimit,
  type ShelfPin,
  type ShelfSort,
  type ShelfTopicId,
  type TopicShelfSource,
  type VideoLibraryId,
} from "./dynamic-shelves.ts";
import { isCalendarDay, type EditorialDateFields } from "./editorial-dates.ts";
import type { StoryCredit } from "./story-credits";
import { isDataFigureData, type DataFigureData } from "./data-figure.ts";
import { isCountyComparisonData, type CountyComparisonData } from "./county-comparison.ts";
import { isElectionResultsData, type ElectionResultsData } from "./election-results.ts";
import { isBioCardData, type BioCardData } from "./bio-profiles.ts";
import { isHomeNewscastData, type HomeNewscastData } from "./home-newscast-data.ts";
import { isVideoBlockData, type VideoBlockData } from "./video-block.ts";
import type { PostLeadMedia } from "./post-lead-media.ts";
export type { PublicVideoData, VideoBlockData } from "./video-block.ts";
export type { BioIdentity, BioCardData } from "./bio-profiles.ts";

export type {
  EditorialDateFields,
  EditorialDateSource,
} from "./editorial-dates.ts";

export type {
  CustomStoryCredit,
  RegisteredStoryCredit,
  StoryCredit,
} from "./story-credits";

// ---------------------------------------------------------------------------
// Rich text (TipTap JSON)
// ---------------------------------------------------------------------------

/** A TipTap mark on an inline text node (bold, a link, etc.). */
export interface RichTextMark {
  type: string;
  attrs?: Record<string, unknown>;
}

/** A TipTap document node. `doc` is the root; text nodes carry `text` + `marks`. */
export interface RichTextNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: RichTextNode[];
  marks?: RichTextMark[];
  text?: string;
}

/** The root of a stored rich-text value. */
export interface RichTextDoc extends RichTextNode {
  type: "doc";
  content: RichTextNode[];
}

// An editor must opt in on the exact link that needs a WNET-era destination.
// The stored TipTap mark uses allowLegacyHost; the renderer turns an exact true
// value into this emitted attribute for the post-build guardrail.
export const LEGACY_HOST_LINK_OPT_IN_ATTRIBUTE = "data-allow-legacy-host";

/**
 * True only for a well-formed TipTap node: an object with a string `type`, an optional
 * string `text`, an optional `content` array of nodes (validated recursively), and
 * optional `marks` each carrying a string `type`. A structurally-unknown but well-formed
 * node still passes (the renderer renders its children); only a malformed node fails.
 */
function isRichTextNode(value: unknown): value is RichTextNode {
  if (typeof value !== "object" || value === null) return false;
  const node = value as { type?: unknown; attrs?: unknown; text?: unknown; content?: unknown; marks?: unknown };
  if (typeof node.type !== "string" || node.type === "bio") return false;
  if (node.attrs !== undefined && !isRecord(node.attrs)) return false;
  if (node.text !== undefined && typeof node.text !== "string") return false;
  if (node.content !== undefined) {
    if (!Array.isArray(node.content)) return false;
    for (const child of node.content) if (!isRichTextNode(child)) return false;
  }
  if (node.marks !== undefined) {
    if (!Array.isArray(node.marks)) return false;
    for (const mark of node.marks) {
      if (typeof mark !== "object" || mark === null) return false;
      const candidate = mark as { type?: unknown; attrs?: unknown };
      if (typeof candidate.type !== "string"
        || (candidate.attrs !== undefined && !isRecord(candidate.attrs))) {
        return false;
      }
      // Inline biographies are not a supported authoring format.
      if (candidate.type === "bio") return false;
    }
  }
  return true;
}

/**
 * True only for a real, well-formed TipTap document object: a `doc` root whose entire
 * node tree validates (see `isRichTextNode`). A plain string (an HTML blob, the exact
 * shape the model forbids) is rejected, and so is a structurally broken tree such as
 * `{ type: "doc", content: [null] }` -- which would otherwise pass a root-only check and
 * then crash `renderNode` on a null dereference. The loader uses this to fail fast on a
 * malformed or legacy-HTML record instead of baking it verbatim.
 */
export function isRichTextDoc(value: unknown): value is RichTextDoc {
  return isRichTextNode(value) && value.type === "doc" && Array.isArray(value.content);
}

/** Only attributes consumed by the public renderer leave the trusted boundary. */
export function publicRichText(node: RichTextDoc): RichTextDoc;
export function publicRichText(node: RichTextNode): RichTextNode;
export function publicRichText(node: RichTextNode): RichTextNode {
  const attrs = (value: Record<string, unknown> | undefined, fields: string[]) =>
    Object.fromEntries(fields.filter(key => value?.[key] !== undefined)
      .map(key => [key, structuredClone(value![key])]));
  return {
    type: node.type,
    ...(node.text === undefined ? {} : { text: node.text }),
    ...(node.type === "heading" && node.attrs?.level !== undefined ? { attrs: attrs(node.attrs, ["level"]) } : {}),
    ...(node.content ? { content: node.content.map(child => publicRichText(child)) } : {}),
    ...(node.marks ? { marks: node.marks.map(mark => ({ type: mark.type,
      ...(mark.type === "link" ? { attrs: attrs(mark.attrs, ["href", "allowLegacyHost"]) } : {}),
    })) } : {}),
  };
}

// The escaping and link-safety primitives live in safe-href.ts, a leaf module the
// dynamic-shelf contract can also import without a cycle. Re-exported here because
// content-model.ts has always been where the renderer, the editor, and the loader
// reach for them.
export { escapeHtml, isSafeHref, safeHref } from "./safe-href.ts";

import { escapeHtml, safeHref } from "./safe-href.ts";

// Inline marks, applied outermost-last so a link wraps the outside and its escaped
// href is never split by a formatting tag.
function wrapMarks(
  inner: string,
  marks: RichTextMark[] | undefined,
  options: RenderRichTextOptions,
): string {
  if (!marks || marks.length === 0) return inner;
  let html = inner;
  for (const mark of marks) {
    switch (mark.type) {
      case "bold":
        html = `<strong>${html}</strong>`;
        break;
      case "italic":
        html = `<em>${html}</em>`;
        break;
      case "code":
        html = `<code>${html}</code>`;
        break;
      case "link": {
        const href = safeHref(mark.attrs?.href);
        const legacyHostOptIn =
          mark.attrs?.allowLegacyHost === true
            ? ` ${LEGACY_HOST_LINK_OPT_IN_ATTRIBUTE}="true"`
            : "";
        const external = options.externalLinksNewTab === true &&
          href !== null && /^https?:\/\//i.test(href);
        const externalAttributes = external ? ' target="_blank" rel="noopener"' : "";
        const externalNotice = external ? '<span class="sr-only"> (opens in new tab)</span>' : "";
        html = href
          ? `<a href="${escapeHtml(href)}"${legacyHostOptIn}${externalAttributes}>${html}${externalNotice}</a>`
          : html;
        break;
      }
      // An unknown mark leaves the text unwrapped rather than emitting a guessed tag.
    }
  }
  return html;
}

export interface RenderRichTextOptions {
  /** Preserve a page frame's external-link behavior; ordinary prose stays same-tab. */
  externalLinksNewTab?: boolean;
  /** Style paragraphs made entirely of links without changing inline-link prose. */
  standaloneLinkClass?: string;
  /** Add this many levels to authored headings before clamping them to h1..h6. */
  headingLevelOffset?: number;
  /** Never render an authored heading above this level. */
  minimumHeadingLevel?: number;
  /** Return an id for an authored heading, or undefined to leave it unanchored. */
  headingId?: (text: string, level: number) => string | undefined;
}

/** Resolve one stored rich-text heading to the rank emitted in its current context. */
export function resolvedRichTextHeadingLevel(
  raw: unknown,
  options: RenderRichTextOptions = {},
): number {
  const numeric = Number(raw ?? 2);
  const authoredLevel = Number.isInteger(numeric)
    ? Math.min(6, Math.max(1, numeric))
    : 2;
  const rawOffset = options.headingLevelOffset ?? 0;
  const offset = Number.isInteger(rawOffset) ? rawOffset : 0;
  const rawMinimum = options.minimumHeadingLevel ?? 1;
  const minimum = Number.isInteger(rawMinimum)
    ? Math.min(6, Math.max(1, rawMinimum))
    : 1;
  return Math.min(6, Math.max(minimum, authoredLevel + offset));
}

function renderChildren(
  nodes: RichTextNode[] | undefined,
  options: RenderRichTextOptions,
): string {
  return (nodes ?? []).map((node) => renderNode(node, options)).join("");
}

function plainText(nodes: RichTextNode[] | undefined): string {
  return (nodes ?? [])
    .map((node) => node.text ?? plainText(node.content))
    .join("");
}

function renderNode(node: RichTextNode, options: RenderRichTextOptions): string {
  switch (node.type) {
    case "text":
      return wrapMarks(escapeHtml(node.text ?? ""), node.marks, options);
    case "paragraph": {
      const linkClass = options.standaloneLinkClass;
      const linksOnly = node.content?.length &&
        node.content.every((child) => child.type === "text" &&
          child.marks?.some((mark) => mark.type === "link" && safeHref(mark.attrs?.href) !== null));
      const classAttribute = linkClass && linksOnly
        ? ` class="${escapeHtml(linkClass)}"`
        : "";
      return `<p${classAttribute}>${renderChildren(node.content, options)}</p>`;
    }
    case "heading": {
      // Clamp to h1..h6 so a malformed level can never emit an invalid tag.
      const level = resolvedRichTextHeadingLevel(node.attrs?.level, options);
      const rawId = options.headingId?.(plainText(node.content), level);
      const id = rawId?.trim();
      const idAttribute = id ? ` id="${escapeHtml(id)}"` : "";
      return `<h${level}${idAttribute}>${renderChildren(node.content, options)}</h${level}>`;
    }
    case "bulletList":
      return `<ul>${renderChildren(node.content, options)}</ul>`;
    case "orderedList":
      return `<ol>${renderChildren(node.content, options)}</ol>`;
    case "listItem":
      return `<li>${renderChildren(node.content, options)}</li>`;
    case "blockquote":
      return `<blockquote>${renderChildren(node.content, options)}</blockquote>`;
    case "codeBlock":
      return `<pre><code>${renderChildren(node.content, options)}</code></pre>`;
    case "hardBreak":
      return "<br>";
    case "horizontalRule":
      return "<hr>";
    case "doc":
      return renderChildren(node.content, options);
    default:
      // An unrecognized node still yields its children, so text survives a schema
      // the renderer has not caught up to; only the unknown wrapper is dropped.
      return renderChildren(node.content, options);
  }
}

/**
 * Render a stored rich-text document to escaped, static HTML. Pure and
 * side-effect free, so the loader can call it at build time. All text and href
 * values are escaped; unsafe link schemes are dropped (see `safeHref`). A block
 * renderer may offset or floor heading levels when the document is nested beneath
 * a generated heading; ordinary prose keeps the authored levels unchanged.
 */
export function renderRichText(
  doc: RichTextDoc,
  options: RenderRichTextOptions = {},
): string {
  return renderChildren(doc.content, options);
}

/**
 * True when a rich-text document carries no visible text: an untouched editor holding
 * only an empty paragraph, the shape `emptyRichTextDoc` (rich-text.ts) produces.
 * `isRichTextDoc` is true for such a doc -- it is structurally valid -- so a required
 * rich-text field (a FAQ answer, a card body an author must fill) uses this to tell "the
 * editor was filled in" from "structurally valid but blank". Text-only on purpose: a bare
 * horizontal rule is not an answer, so it must not satisfy a required field. The
 * renderer's looser omit-an-optional-body test is `richTextRendersEmpty`.
 */
export function richTextIsEmpty(doc: RichTextDoc): boolean {
  const hasText = (node: RichTextNode): boolean =>
    (typeof node.text === "string" && node.text.trim().length > 0) ||
    (node.content?.some(hasText) ?? false);
  return !doc.content.some(hasText);
}

// Nodes that render a visible element with no text of their own: a horizontal rule
// (`<hr>`) and a hard break (`<br>`). A body built only from these still renders
// something, so the renderer must not treat it as empty.
const VISIBLE_VOID_NODES: ReadonlySet<string> = new Set(["horizontalRule", "hardBreak"]);

/**
 * True when a document would render to nothing visible: no non-whitespace text and no
 * visible void node (`<hr>`, `<br>`). The block renderer uses this to drop an optional
 * body the editor seeded as an empty paragraph -- which would otherwise bake an empty
 * `<p></p>` and its spacing -- without dropping a body that carries a rule or break the
 * author added. Looser than `richTextIsEmpty`: content the renderer must keep is not
 * always content that satisfies a required field.
 */
export function richTextRendersEmpty(doc: RichTextDoc): boolean {
  const hasVisible = (node: RichTextNode): boolean =>
    (typeof node.text === "string" && node.text.trim().length > 0) ||
    VISIBLE_VOID_NODES.has(node.type) ||
    (node.content?.some(hasVisible) ?? false);
  return !doc.content.some(hasVisible);
}

// ---------------------------------------------------------------------------
// Editorial records
// ---------------------------------------------------------------------------

// Publication lifecycle of an editorial record. `in_review` is the review queue;
// `approved` is the reviewed, content-frozen resting state from which publishing or
// scheduling can start. Editing approved content requires an explicit reopen to draft,
// so a later content save cannot silently keep stale approval. The transitions between these
// states, and who may make them, live in editorial-workflow.ts. This const is the
// single source of truth (matching EDITORIAL_TYPES and BLOCK_TYPES): the type derives
// from it, and the workflow imports it for its runtime stage-membership check, so a
// new status is added here once and cannot silently split the two definitions.
export const CONTENT_STATUSES = [
  "draft",
  "in_review",
  "approved",
  "scheduled",
  "published",
  "archived",
] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];
export type AssignableContentStatus = Exclude<ContentStatus, "published" | "archived">;

const NON_ASSIGNABLE_CONTENT_STATUSES: ReadonlySet<ContentStatus> = new Set([
  "published",
  "archived",
]);

// Assignment represents active editorial work. Derive its accepted vocabulary from the
// canonical lifecycle list so the editor and workflow reducer cannot grow independent copies.
export const ASSIGNABLE_CONTENT_STATUSES: readonly AssignableContentStatus[] = Object.freeze(
  CONTENT_STATUSES.filter(
    (status): status is AssignableContentStatus =>
      !NON_ASSIGNABLE_CONTENT_STATUSES.has(status),
  ),
);

export function isAssignableContentStatus(
  value: unknown,
): value is AssignableContentStatus {
  return (
    typeof value === "string" &&
    (ASSIGNABLE_CONTENT_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Fields every editorial record carries. `id` is the immutable key; `slug` is a
 * routing convenience and is never used to reference the record. Renames retain
 * the old route in `previousSlugs` for redirect generation. `locale` and
 * `publishAt` are present up front for later i18n and scheduling.
 */
export interface EditorialBase {
  id: string;
  slug: string;
  previousSlugs: string[];
  locale: string;
  status: ContentStatus;
  /**
   * True while the immutable `published` snapshot remains on the public site.
   * A published record written before this field existed is also public. The
   * flag lets a new draft or review version coexist with the last live version.
   */
  publiclyVisible?: boolean;
  /** Last source version confirmed on the public site. Server-managed. */
  publicSourceVersion?: number;
  /** True while a newer immutable snapshot waits for public deployment. */
  publishBuildPending?: boolean;
  /** Build queue that owns the pending snapshot, or null before recovery claims it. */
  publishBuildQueueId?: string | null;
  /**
   * Stable users/{uid} assignment for resume-work queues. Separate from
   * `updatedBy`: saving somebody else's piece does not silently assign it to the
   * last editor. Legacy and unassigned records omit the field or store null.
   */
  assignee?: string | null;
  /**
   * The editorial desk this document belongs to, for section-scoped role grants
   * (rbac.ts `Resource.section`). Server-managed: a canonical page takes it from its
   * public-page area, and a record fixes it at create and cannot move it through an
   * ordinary save. Not the page-builder `SectionId` in editor-admin.ts.
   *
   * Optional because it cannot be retrofitted onto every stored document: records
   * written before the registry existed, and the legacy template singletons, stay
   * unsectioned. A scoped grant denies an unsectioned resource, so absence is the
   * closed state, not a hole (#619).
   */
  section?: string;
  /** ISO-8601 instant the record becomes public; may be in the future. */
  publishAt: string;
  /**
   * Soft-delete marker (blueprint §A.4), distinct from `status: "archived"`. A
   * deleted record keeps its `published` snapshot so a delete stays recoverable,
   * so the build gate must exclude it explicitly (#465): status alone still reads
   * as published and would keep shipping the page. Absent on an active record.
   */
  deleted?: boolean;
  deletedAt?: string;
  deletedBy?: string;
  /**
   * Last scheduled-publish failure recorded by the minute scheduler, kept on the
   * approved record so an editor sees why the run did not publish. Cleared when
   * the content moves on from approved.
   */
  scheduledPublishFailure?: ScheduledPublishFailure;
  /** Server-owned future transport; admission changes cannot select a build at fire. */
  scheduledPublicationTransport?: "post-no-build-v1" | "page-no-build-v1";
}

/**
 * A scheduled publication that the minute scheduler could not complete. Written
 * by the server; every field is a non-empty string.
 */
export interface ScheduledPublishFailure {
  failedAt: string;
  failedBy: string;
  reason: string;
}

/**
 * Validate an untrusted value as a {@link ScheduledPublishFailure}. `failedAt`,
 * `failedBy`, and `reason` must all be non-empty strings; any other shape returns
 * undefined so a malformed stored value never reaches the UI.
 */
export function parseScheduledPublishFailure(
  value: unknown,
): ScheduledPublishFailure | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const { failedAt, failedBy, reason } = value as Record<string, unknown>;
  if (
    typeof failedAt !== "string" ||
    failedAt.trim().length === 0 ||
    typeof failedBy !== "string" ||
    failedBy.trim().length === 0 ||
    typeof reason !== "string" ||
    reason.trim().length === 0
  ) {
    return undefined;
  }
  return { failedAt, failedBy, reason };
}

export interface ProgramRecord extends EditorialBase {
  type: "program";
  title: string;
  description: RichTextDoc;
  genre?: string;
  /** Retained only for reading existing records; never rendered. */
  keyArt?: string;
  keyArtAssetId?: string;
  keyArtAlt?: string;
  keyArtDecorative?: boolean;
  watchUrl?: string;
  /** True if the program is restricted to Passport members (issue #392 gap 1). */
  memberOnly?: boolean;
}
export interface StaffRecord extends EditorialBase {
  type: "staff";
  name: string;
  role: string;
  bio: RichTextDoc;
}
export interface EventRecord extends EditorialBase {
  type: "event";
  title: string;
  startsAt: string;
  endsAt?: string;
  location?: string;
  venueAddress?: string;
  onlineUrl?: string;
  imageAssetId?: string;
  imageAlt?: string;
  imageDecorative?: boolean;
  registrationUrl?: string;
  registrationLabel?: string;
  isFree?: boolean;
  priceText?: string;
  description: RichTextDoc;
}
export interface SponsorRecord extends EditorialBase {
  type: "sponsor";
  name: string;
  href: string;
  logoAssetId?: string;
  /** Contextual text for this logo placement. */
  logoAlt?: string;
  /** True only when the adjacent visible sponsor name carries the same meaning. */
  logoDecorative?: boolean;
  tier?: string;
  description?: string;
  activeFrom?: string;
  activeUntil?: string;
}
export interface NewsletterRecord extends EditorialBase {
  type: "newsletter";
  title: string;
  body: RichTextDoc;
  signupUrl?: string;
  frequency?: string;
  summary?: string;
  imageAssetId?: string;
  imageAlt?: string;
  imageDecorative?: boolean;
}
/** Search-engine metadata shared by CMS-authored pages and posts. */
export interface SearchMetadata {
  /** Optional search-result title override; the visible title is the fallback. */
  title?: string;
  /** Optional search-result description override; the visible summary is the fallback. */
  description?: string;
  /** Keep a draft or utility page out of search indexes without changing its route. */
  noindex?: boolean;
}

/** Social-card overrides shared by CMS-authored pages and posts. */
export interface SocialMetadata {
  title?: string;
  description?: string;
  /** Media-library asset id for the social card image. */
  imageAssetId?: string;
}

export interface DiscoverabilityMetadata {
  seo?: SearchMetadata;
  social?: SocialMetadata;
}

/** The editable non-block fields on one canonical public-page document. */
export interface HeroBackgroundMetadata {
  /** Decorative station-media image behind the page or Post heading. */
  heroBackgroundImage?: string;
  heroBackgroundPosition?: "center" | "top" | "bottom";
}

export const PAGE_THEMES = ["default", "nj-decides"] as const;
export type PageTheme = (typeof PAGE_THEMES)[number];

export function isPageTheme(value: unknown): value is PageTheme {
  return typeof value === "string" && PAGE_THEMES.includes(value as PageTheme);
}

export interface PageMetadata extends DiscoverabilityMetadata, HeroBackgroundMetadata, ContentLinkMetadata {
  title: string;
  /** Exclude child-directed content from all site analytics, at every URL. */
  childDirected?: boolean;
  /** Optional presentation theme. Absence retains the standard page design. */
  pageTheme?: PageTheme;
  slug?: string;
  previousSlugs?: string[];
  description?: string;
  dataHubCompositionVersion?: 1;
  dataHubReporting?: import("./data-hub-reporting").DataHubReporting;
  homeHero?: import("./home-hero").HomeHeroConfig;
  homeHeroTitle?: string;
  homeHeroSubtitle?: string;
  homeCompositionVersion?: 1 | 2;
  /** Render service-page blocks in CMS order instead of named template slots. */
  serviceCompositionVersion?: 1;
}

/**
 * Viewer-visible non-block fields frozen with a post's published body.
 *
 * The date fields come in through {@link EditorialDateFields} so the snapshot, the
 * working record, and the server mirror all state the same contract (#1041). A
 * public renderer, the structured data, and the listing sort read them from here
 * through `resolveDisplayDate` / `resolveUpdateDisplay` / `editorialSortInstant`
 * rather than reading `date` directly, and never from `publishedAt`, which is when
 * this particular revision went out and not when the story first ran.
 */
export interface PostPublishedMetadata
  extends DiscoverabilityMetadata,
    ContentLinkMetadata,
    HeroBackgroundMetadata,
    EditorialDateFields {
  type: "post";
  liveBlog?: import("./live-blog").LiveBlogData;
  /** Explicit publication attribution, frozen with this revision; absent means off. */
  spotlightNews?: boolean;
  /** Stable reference resolved against the current published coverage registry. */
  coverageLabelId?: string;
  /** Include this published Post in Home hero tag selections without a public tag. */
  showInHomeHero?: boolean;
  title: string;
  /** Ordered editorial sections. The first non-empty value is the main category. */
  categories?: string[];
  tags: string[];
  summary?: string;
  excerpt?: string;
  /**
   * The byline frozen with this revision (#1040). Registered credits carry the
   * author's stable `authorId` AND the display name as it read at this publish,
   * so a later rename, deactivation, or withdrawn profile leaves the published
   * page reading correctly while the id still links the story to the person.
   * Every reader-facing surface -- the page, the listing, the structured data,
   * the search document -- reads this one ordered list.
   */
  credits?: StoryCredit[];
  /**
   * The pre-#1040 single free-text byline, retained only so snapshots published
   * before the credits contract keep rendering. Read a byline through
   * `resolveStoryCredits`, never from this field directly.
   *
   * @deprecated Superseded by {@link credits}.
   */
  author?: string;
  leadMedia?: PostLeadMedia | null;
  heroImage?: string;
  heroImageAlt?: string;
  heroImageDecorative?: boolean;
  /** Optional visible caption or credit for this post's lead image. */
  heroImageCaption?: string;
  slug: string;
  previousSlugs: string[];
  locale: string;
}

/**
 * One immutable public revision. Metadata is part of the snapshot rather than
 * read from the mutable working document, so a draft title/SEO edit cannot leak
 * into the live page while its blocks still come from an older publish.
 */
export interface PublishedSnapshot<TMetadata extends object = DiscoverabilityMetadata> {
  blocks: PageBlock[];
  metadata: TMetadata;
  publishedAt: string;
  publishedBy: string;
  /** The working-document version copied into this snapshot. */
  sourceVersion: number;
}

export interface PostRecord
  extends EditorialBase,
    ContentLinkMetadata,
    HeroBackgroundMetadata,
    DiscoverabilityMetadata,
    EditorialDateFields {
  type: "post";
  liveBlog?: import("./live-blog-draft").LiveBlogDraft;
  /** Show the NJ Spotlight News publication label. Defaults off. */
  spotlightNews?: boolean;
  /** Stable reference resolved against the current published coverage registry. */
  coverageLabelId?: string | null;
  /** Include this published Post in Home hero tag selections without a public tag. */
  showInHomeHero?: boolean;
  title: string;
  /** Ordered editorial sections. The first non-empty value is the main category. */
  categories?: string[];
  tags: string[];
  summary?: string;
  excerpt?: string;
  /**
   * The ordered byline (#1040). Each entry is either a REGISTERED credit holding
   * the stable `authorId` of a CMS author identity (#1044) or a CUSTOM credit
   * holding bounded display text -- "NJ PBS staff", a wire service, a guest
   * contributor -- that creates no account and no profile.
   *
   * A registered credit on a WORKING document stores the id and nothing else, so
   * renaming a staff member fixes every unpublished draft at once. Names are
   * frozen only into {@link PostPublishedMetadata.credits} at publish time.
   */
  credits?: StoryCredit[];
  /**
   * The pre-#1040 single free-text byline. Still readable on records saved before
   * the credits contract; `resolveStoryCredits` converts it to one custom credit
   * deterministically, and the first byline edit rewrites the record to
   * {@link credits}. Never write this field.
   *
   * @deprecated Superseded by {@link credits}.
   */
  author?: string;
  leadMedia?: PostLeadMedia | null;
  heroImage?: string;
  /** Contextual alternative text for the station-managed lead image. */
  heroImageAlt?: string;
  /** True when the lead image carries no information and must render with alt="". */
  heroImageDecorative?: boolean;
  /** Optional visible caption or credit, separate from the alternative text. */
  heroImageCaption?: string;
  blocks: PageBlock[];
  published?: PublishedSnapshot<PostPublishedMetadata>;
}

// Article is not here. Issue #1039 retired it as a stored model: Post is the only
// story type, and nothing may create or write an article record. A document stored
// before that decision is read through the library's retired-kind path, never
// through this union.
export type EditorialRecord =
  | ProgramRecord
  | StaffRecord
  | EventRecord
  | SponsorRecord
  | NewsletterRecord
  | PostRecord;

/** The editorial record types a loader can iterate and map to storage collections. */
export const EDITORIAL_TYPES = [
  "program",
  "staff",
  "event",
  "sponsor",
  "newsletter",
  "post",
] as const;

/**
 * The stable key of a record. Centralized so no call site is tempted to key on
 * the slug: change this and every reference follows, which is exactly the
 * property the id-not-slug rule guarantees.
 */
export function keyOf(record: EditorialBase): string {
  return record.id;
}

/** A page singleton (home, contact, ...) is an ordered list of blocks, no record body. */
export interface PageSingleton extends EditorialBase, ContentLinkMetadata {
  title: string;
  pageTheme?: PageTheme;
  blocks: PageBlock[];
  homeCompositionVersion?: 1 | 2;
  serviceCompositionVersion?: 1;
  published?: PublishedSnapshot<PageMetadata>;
}

// ---------------------------------------------------------------------------
// Revisions (whole-doc version history, issue #200)
// ---------------------------------------------------------------------------

// Versioning and restore are the content model's job (issue #200), not the editorial
// workflow's: the workflow moves a piece between stages, while a revision is a whole
// record captured at one point in its history. Snapshots are whole-doc so a restore is
// a copy, not a per-field merge, which is what keeps a restored record from sharing
// mutable structure with the stored history.

/** A record captured whole at one point in its history. */
export interface ContentRevision<T = EditorialRecord | PageSingleton> {
  /** Monotonic version number in the piece's history. */
  seq: number;
  snapshot: T;
  takenAt: string;
  takenBy?: string;
}

/**
 * Freeze a record as a revision. The snapshot is a deep copy, so later edits to the
 * live record never reach back and change history. Records are plain JSON-shaped data
 * (blocks, TipTap docs, asset ids), which structuredClone copies faithfully.
 */
export function snapshotRevision<T>(record: T, opts: { seq: number; at: string; by?: string }): ContentRevision<T> {
  return {
    seq: opts.seq,
    snapshot: structuredClone(record),
    takenAt: opts.at,
    ...(opts.by !== undefined ? { takenBy: opts.by } : {}),
  };
}

/**
 * Rebuild a record from a revision. Returns a deep copy of the snapshot, so the
 * restored record is independent of the stored revision and editing it cannot corrupt
 * history. Any write-boundary policy (keep the live slug or status rather than the
 * snapshot's) belongs at the persistence boundary, not in this pure restore.
 */
export function restoreRevision<T>(revision: ContentRevision<T>): T {
  return structuredClone(revision.snapshot);
}

// ---------------------------------------------------------------------------
// Page-builder blocks (ADR 0013)
// ---------------------------------------------------------------------------

// ADR 0013 fixes the block model: a page or post is one document holding an
// ordered array of self-contained blocks, each a `{ id, type, section?, order,
// visible, data }` envelope. `id` is server-generated and immutable, so version
// history and media-usage tracking key on it and never on the array position or a
// mutable field; `type` is a launch-catalog key; `data` holds every field of that
// type, so a composite block (a card, an FAQ item) is one object with one save,
// one reorder unit, one visibility toggle. `parseBlocks` validates the envelope
// and every declared payload shape before returning the typed union. Storage
// policy checks such as asset existence stay at the server write boundary.
// The renderer validates embed hosts and IDs before rebuilding player URLs.

/** The launch block catalog (ADR 0013). It grows one type at a time. */
export { type DataTableData } from "./data-table.ts";
import { isDataTableData, type DataTableData } from "./data-table.ts";
import { isDocumentListData, type DocumentListData } from "./document-list.ts";

export const BLOCK_TYPES = [
  "bio_card",
  "town_lookup",
  "data_table",
  "data_figure",
  "election_results",
  "county_comparison",
  "data_hub_section",
  "row",
  "headline",
  "prose",
  "image",
  "video",
  "image_gallery",
  "cta_row",
  "card_grid",
  "link_card",
  "document_list",
  "faq_item",
  "coverage_list",
  "embed",
  "html",
  "content_shelf",
  "promotion_playlist",
  "newsletter_signup",
  "home_newscast",
  "topic_shelf",
  "video_playlist",
  "record_card",
  "sponsor_strip",
  "divider",
] as const;

export type BlockType = (typeof BLOCK_TYPES)[number];

const BLOCK_TYPE_SET: ReadonlySet<string> = new Set(BLOCK_TYPES);
export const NESTED_MEDIA_COLLECTION_MAX = 12;

/**
 * The envelope every catalog block shares. `id` is the immutable, server-generated
 * key nothing may key around -- it is `readonly` so a caller cannot reassign it
 * after a block is parsed; `order` positions the block in the page; `visible`
 * toggles it without deleting it; `section` optionally groups blocks; `data`
 * carries the type-specific fields.
 */
export interface BlockEnvelope<T extends BlockType, D> {
  readonly id: string;
  type: T;
  section?: string;
  layout?: BlockLayout;
  order: number;
  visible: boolean;
  data: D;
}

// Per-type `data` payloads. The fields are the ones ADR 0013 names and their
// runtime shapes are enforced by `parseBlocks` below.
export interface HeadlineData {
  text: string;
  level?: number;
}
export interface ProseData {
  /** Decorative Home band override. Empty restores the existing default. */
  backgroundImageAssetId?: string;
  content: RichTextDoc;
}
export interface ImageData {
  itemId?: string;
  assetId: string;
  alt: string;
  /**
   * The editor's deliberate answer that this image is decorative, so `alt` is an
   * intentional empty string rather than an unfilled field. WCAG 1.1.1 wants
   * exactly that for an image carrying no information, but the alt field is
   * required, and a required text field rejects "", so before this bit there was
   * no way to save a decorative image at all: the only reachable states were a
   * description or an incomplete block.
   *
   * Optional so every page stored before this existed still parses.
   */
  altDecorative?: boolean;
  caption?: string;
}
/**
 * A standalone image block can link somewhere, such as a video thumbnail that opens
 * the full video. Gallery images stay unlinked. A decorative image cannot carry a
 * link, because its empty alt text would leave the link with no name.
 */
export interface ImageBlockData extends ImageData {
  href?: string;
  newTab?: boolean;
}
/**
 * How a gallery is laid out on the published page (#1034). Both modes are presentations the
 * public site already has: `grid` is the wrapping grid every stored gallery renders as today,
 * and `carousel` is the horizontally scrolling, scroll-snapped rail the home page ships for its
 * program rows, applied to a gallery. Nothing here adds a click action -- the site has no
 * lightbox, and a gallery image carries no link -- so the mode changes the arrangement only.
 */
export const GALLERY_PRESENTATIONS = ["grid", "carousel"] as const;
export type GalleryPresentation = (typeof GALLERY_PRESENTATIONS)[number];

/**
 * What each mode does on the public page, in the words the editor reads. It lives beside the
 * renderer's own switch rather than in the admin so the promise the editing UI makes and the
 * markup the site emits come from one place; the renderer tests hold `clickBehavior` to the
 * markup, so the UI cannot start promising a lightbox nobody built.
 */
export interface GalleryPresentationSpec {
  value: GalleryPresentation;
  label: string;
  layout: string;
  clickBehavior: string;
}

// One sentence, shared: the click result is a property of the gallery renderer, not of a mode,
// and writing it twice is how the two would drift apart.
const GALLERY_CLICK_BEHAVIOR =
  "Clicking an image does nothing. Gallery images are not links, and the public site has no lightbox or full-screen viewer.";

export const GALLERY_PRESENTATION_SPECS: readonly GalleryPresentationSpec[] = Object.freeze([
  Object.freeze({
    value: "grid" as const,
    label: "Grid",
    layout:
      "Every image is visible at once in a grid that wraps to fit the screen: several across on a desktop, one under another on a phone.",
    clickBehavior: GALLERY_CLICK_BEHAVIOR,
  }),
  Object.freeze({
    value: "carousel" as const,
    label: "Carousel",
    layout:
      "The images sit in one row people scroll sideways, the same row the home page uses for programs. It can be scrolled by touch, trackpad, or the arrow keys once it has focus.",
    clickBehavior: GALLERY_CLICK_BEHAVIOR,
  }),
]);

const GALLERY_PRESENTATION_SET: ReadonlySet<string> = new Set(GALLERY_PRESENTATIONS);

export interface ImageGalleryData {
  images: ImageData[];
  /**
   * Optional so every gallery stored before the choice existed still parses. Absent means the
   * grid those galleries already render as, resolved by `galleryPresentation` rather than by
   * rewriting stored content.
   */
  presentation?: GalleryPresentation;
}

/** The mode to render, resolving an absent choice to today's behavior. */
export function galleryPresentation(data: ImageGalleryData): GalleryPresentation {
  return data.presentation ?? "grid";
}
export interface CtaRowData {
  ctas: Array<{ label: string; href: string; variant?: "primary" | "secondary" }>;
}
export interface CardGridData {
  /** Decorative Home band override. Empty restores the existing default. */
  backgroundImageAssetId?: string;
  cards: Array<{
    itemId?: string;
    label?: string;
    title: string;
    body?: RichTextDoc;
    imageAssetId?: string;
    href?: string;
  }>;
}
export interface LinkCardData {
  title: string;
  url: string;
  source?: string;
  date?: string;
  summary?: string;
}
export const LINK_CARD_LIMITS = Object.freeze({
  title: 250,
  source: 120,
  summary: 500,
  url: 2000,
} as const);
const LINK_CARD_DATA_KEY_SET: ReadonlySet<string> = new Set([
  "title",
  "url",
  "source",
  "date",
  "summary",
]);
export interface FaqItemData {
  question: string;
  answer: RichTextDoc;
}
export interface CoverageEntry {
  title: string;
  outlet: string;
  date: string;
  url: string;
}
export interface CoverageListData {
  entries: CoverageEntry[];
}
export const COVERAGE_LIST_LIMITS = Object.freeze({
  title: 250,
  outlet: 120,
  url: 2000,
  entries: 100,
} as const);
const COVERAGE_LIST_DATA_KEY_SET: ReadonlySet<string> = new Set(["entries"]);
const COVERAGE_ENTRY_KEY_SET: ReadonlySet<string> = new Set([
  "title",
  "outlet",
  "date",
  "url",
]);
export interface EmbedData {
  url: string;
  host?: string;
  caption?: string;
  /** Optional responsive player size in CSS pixels. */
  width?: number;
  height?: number;
  /** AP published-layout presentation; ordinary video embeds ignore these fields. */
  heading?: string;
  mapSize?: "small" | "medium" | "large";
  mobileHeight?: number;
  mapWidth?: "content" | "wide";
}
export const AP_MAP_HEIGHTS = Object.freeze({ small: 600, medium: 900, large: 1200 });
export const AP_MAP_MOBILE_HEIGHT_LIMITS = Object.freeze({ min: 320, max: 4096 });
export const EMBED_WIDTH_LIMITS = Object.freeze({ min: 160, max: 4096 });
export const EMBED_HEIGHT_LIMITS = Object.freeze({ min: 90, max: 4096 });
export const EMBED_ASPECT_RATIO_LIMITS = Object.freeze({ min: 9 / 16, max: 21 / 9 });
/** Custom HTML runs only inside a sandboxed frame; it never joins the page itself. */
export interface HtmlData {
  html: string;
  title?: string;
}
export const HTML_BLOCK_LIMITS = Object.freeze({ html: 50_000, title: 200 });
const HTML_DATA_KEY_SET: ReadonlySet<string> = new Set(["html", "title"]);
export const CONTENT_SHELF_SOURCES = [
  "pbs_featured",
  "pbs_more",
  "spotlight_news",
  "station_posts",
] as const;
export type ContentShelfSource = (typeof CONTENT_SHELF_SOURCES)[number];
export const CONTENT_SHELF_ITEM_LIMITS = [3, 4, 6, 8, 12, 16, 24] as const;
export type ContentShelfItemLimit = (typeof CONTENT_SHELF_ITEM_LIMITS)[number];
export const CONTENT_SHELF_PRESENTATIONS = ["rail", "grid", "two_features", "list"] as const;
export type ContentShelfPresentation = (typeof CONTENT_SHELF_PRESENTATIONS)[number];
export interface ContentShelfData {
  title: string;
  source: ContentShelfSource;
  itemLimit: ContentShelfItemLimit;
  moreLabel: string;
  moreHref: string;
  /** Omission retains the current horizontal shelf and its existing source slice. */
  presentation?: ContentShelfPresentation;
  /** Grid columns on desktop; retained when switching back to a rail. */
  columns?: (typeof SHELF_COLUMNS)[number];
  selectedIds?: string[];
  selectionReceipt?: import("./home-source-selection.ts").HomeSelectionReceipt;
}
export const PROMOTION_PLAYLIST_PLACEMENTS = [
  "before_start",
  "before_featured",
  "before_passport",
  "before_more",
  "before_spotlight",
] as const;
export type PromotionPlaylistPlacement = (typeof PROMOTION_PLAYLIST_PLACEMENTS)[number];
export interface PromotionPlaylistCard {
  itemId: string;
  title: string;
  summary: string;
  imageAssetId: string;
  alt: string;
  altDecorative?: boolean;
  href: string;
}
export const SHELF_PRESENTATIONS = ["rail", "grid", "list"] as const;
export type ShelfPresentation = (typeof SHELF_PRESENTATIONS)[number];
export const SHELF_COLUMNS = [2, 3, 4] as const;
export interface PromotionPlaylistData {
  title: string;
  placement: PromotionPlaylistPlacement;
  presentation?: ShelfPresentation;
  columns?: (typeof SHELF_COLUMNS)[number];
  cards: PromotionPlaylistCard[];
}
export interface NewsletterSignupData {
  /** Decorative Home band override. Empty restores the existing default. */
  backgroundImageAssetId?: string;
  actionLabel?: string;
  selectionReceipt?: import("./home-source-selection.ts").HomeSelectionReceipt;
  newsletterIds: string[];
  heading?: string;
  intro?: string;
}
/**
 * A related-story shelf (#1046). The block stores the QUERY, never the stories: an
 * approved topic, an approved source, a finite cap, a sort mode, and an optional manual
 * order. `dynamic-shelves.ts` resolves it against the committed index at build time, so
 * a page never holds a stale copy of a headline and a published page never runs a query
 * of its own.
 */
export interface TopicShelfData {
  title: string;
  topic: ShelfTopicId;
  source: TopicShelfSource;
  itemLimit: ShelfItemLimit;
  sort: ShelfSort;
  /** Manual order, resolved ahead of the query. Absent means a purely dynamic shelf. */
  pinned?: ShelfPin[];
}

/**
 * An editorial video playlist (#1046). The same finite query contract as the topic
 * shelf, over an approved NJ PBS or PBS video library instead of the story index. A
 * library entry carries the rights, caption, runtime, thumbnail, and access metadata,
 * and an entry missing any of it never resolves into a page.
 */
export interface VideoPlaylistData {
  title: string;
  topic: ShelfTopicId;
  library: VideoLibraryId;
  itemLimit: ShelfItemLimit;
  sort: ShelfSort;
  pinned?: ShelfPin[];
}
export interface SponsorStripData {
  heading?: string;
  sponsorIds: string[];
  layout: "row" | "grid";
}

export const RECORD_CARD_KINDS = ["program", "event", "sponsor", "newsletter"] as const;
export type RecordCardKind = (typeof RECORD_CARD_KINDS)[number];
export interface RecordCardData {
  recordKind: RecordCardKind;
  recordId: string;
  variant?: "card" | "compact";
}
export function isRecordCardData(data: unknown, publishable = true): data is RecordCardData {
  if (!isRecord(data)) return false;
  return Reflect.ownKeys(data).every(key =>
    typeof key === "string" && ["recordKind", "recordId", "variant"].includes(key))
    && RECORD_CARD_KINDS.includes(data.recordKind as RecordCardKind)
    && typeof data.recordId === "string"
    && (!publishable && data.recordId === "" || /^[A-Za-z0-9_-]{1,128}$/.test(data.recordId))
    && (data.variant === undefined || data.variant === "card" || data.variant === "compact");
}

export type DividerData = Record<string, never>;

export type BioCardBlock = BlockEnvelope<"bio_card", BioCardData>;
export type HeadlineBlock = BlockEnvelope<"headline", HeadlineData>;
export type ProseBlock = BlockEnvelope<"prose", ProseData>;
export type ImageBlock = BlockEnvelope<"image", ImageBlockData>;
export type VideoBlock = BlockEnvelope<"video", VideoBlockData>;
export type ImageGalleryBlock = BlockEnvelope<"image_gallery", ImageGalleryData>;
export type CtaRowBlock = BlockEnvelope<"cta_row", CtaRowData>;
export type CardGridBlock = BlockEnvelope<"card_grid", CardGridData>;
export type LinkCardBlock = BlockEnvelope<"link_card", LinkCardData>;
export type DocumentListBlock = BlockEnvelope<"document_list", DocumentListData>;
export type FaqItemBlock = BlockEnvelope<"faq_item", FaqItemData>;
export type CoverageListBlock = BlockEnvelope<"coverage_list", CoverageListData>;
export type EmbedBlock = BlockEnvelope<"embed", EmbedData>;
export type HtmlBlock = BlockEnvelope<"html", HtmlData>;
export type ContentShelfBlock = BlockEnvelope<"content_shelf", ContentShelfData>;
export type PromotionPlaylistBlock = BlockEnvelope<"promotion_playlist", PromotionPlaylistData>;
export type HomeNewscastBlock = BlockEnvelope<"home_newscast", HomeNewscastData>;
export type NewsletterSignupBlock = BlockEnvelope<"newsletter_signup", NewsletterSignupData>;
export type TopicShelfBlock = BlockEnvelope<"topic_shelf", TopicShelfData>;
export type VideoPlaylistBlock = BlockEnvelope<"video_playlist", VideoPlaylistData>;
export type RecordCardBlock = BlockEnvelope<"record_card", RecordCardData>;
export type SponsorStripBlock = BlockEnvelope<"sponsor_strip", SponsorStripData>;
export type DividerBlock = BlockEnvelope<"divider", DividerData>;
export type RowBlock = BlockEnvelope<"row", RowData>;

export type TownLookupBlock = BlockEnvelope<"town_lookup", TownLookupData>;
export type DataTableBlock = BlockEnvelope<"data_table", DataTableData>;
export type DataFigureBlock = BlockEnvelope<"data_figure", DataFigureData>;
export type CountyComparisonBlock = BlockEnvelope<"county_comparison", CountyComparisonData>;
export type ElectionResultsBlock = BlockEnvelope<"election_results", ElectionResultsData>;

export type DataHubSectionBlock = BlockEnvelope<"data_hub_section", DataHubSectionData>;

export type PageBlock =
  | DataHubSectionBlock
  | BioCardBlock
  | DataFigureBlock
  | ElectionResultsBlock
  | CountyComparisonBlock
  | TownLookupBlock
  | DataTableBlock
  | RowBlock
  | HeadlineBlock
  | ProseBlock
  | ImageBlock
  | VideoBlock
  | ImageGalleryBlock
  | CtaRowBlock
  | CardGridBlock
  | LinkCardBlock
  | DocumentListBlock
  | FaqItemBlock
  | CoverageListBlock
  | EmbedBlock
  | HtmlBlock
  | ContentShelfBlock
  | PromotionPlaylistBlock
  | NewsletterSignupBlock
  | HomeNewscastBlock
  | TopicShelfBlock
  | VideoPlaylistBlock
  | RecordCardBlock
  | SponsorStripBlock
  | DividerBlock;

const CONTENT_SHELF_SOURCE_SET: ReadonlySet<string> = new Set(CONTENT_SHELF_SOURCES);
const CONTENT_SHELF_ITEM_LIMIT_SET: ReadonlySet<number> = new Set(CONTENT_SHELF_ITEM_LIMITS);
const PROMOTION_PLAYLIST_PLACEMENT_SET: ReadonlySet<string> = new Set(
  PROMOTION_PLAYLIST_PLACEMENTS,
);
const PROMOTION_PLAYLIST_DATA_KEY_SET: ReadonlySet<string> = new Set([
  "title",
  "placement",
  "presentation",
  "columns",
  "cards",
]);
const PROMOTION_PLAYLIST_CARD_KEY_SET: ReadonlySet<string> = new Set([
  "itemId",
  "title",
  "summary",
  "imageAssetId",
  "alt",
  "altDecorative",
  "href",
]);
const SHELF_SORT_SET: ReadonlySet<string> = new Set(SHELF_SORTS);
const SHELF_ITEM_LIMIT_SET: ReadonlySet<number> = new Set(SHELF_ITEM_LIMITS);
const TOPIC_SHELF_SOURCE_SET: ReadonlySet<string> = new Set(TOPIC_SHELF_SOURCES);
const VIDEO_LIBRARY_SET: ReadonlySet<string> = new Set(VIDEO_LIBRARIES);
const TOPIC_SHELF_DATA_KEY_SET: ReadonlySet<string> = new Set([
  "title",
  "topic",
  "source",
  "itemLimit",
  "sort",
  "pinned",
]);
const VIDEO_PLAYLIST_DATA_KEY_SET: ReadonlySet<string> = new Set([
  "title",
  "topic",
  "library",
  "itemLimit",
  "sort",
  "pinned",
]);
const CONTENT_SHELF_DATA_KEY_SET: ReadonlySet<string> = new Set([
  "title",
  "source",
  "itemLimit",
  "moreLabel",
  "moreHref",
  "presentation",
  "columns",
  "selectedIds",
  "selectionReceipt",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalEmbedDimension(
  value: unknown,
  limits: { readonly min: number; readonly max: number },
): boolean {
  return value === undefined || (
    Number.isInteger(value)
    && Number(value) >= limits.min
    && Number(value) <= limits.max
  );
}

function hasValidEmbedAspectRatio(width: unknown, height: unknown): boolean {
  if (width === undefined || height === undefined) return true;
  if (typeof width !== "number" || typeof height !== "number") return false;
  const ratio = width / height;
  return ratio >= EMBED_ASPECT_RATIO_LIMITS.min
    && ratio <= EMBED_ASPECT_RATIO_LIMITS.max;
}

function isOptionalCollectionItemId(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.trim().length > 0);
}

function isCoverageEntry(value: unknown): value is CoverageEntry {
  if (!isRecord(value)) return false;
  if (!Reflect.ownKeys(value).every(
    (key) => typeof key === "string" && COVERAGE_ENTRY_KEY_SET.has(key),
  )) {
    return false;
  }
  return typeof value.title === "string"
    && value.title.length <= COVERAGE_LIST_LIMITS.title
    && typeof value.outlet === "string"
    && value.outlet.length <= COVERAGE_LIST_LIMITS.outlet
    && typeof value.date === "string"
    && (value.date.length === 0 || isCalendarDay(value.date))
    && typeof value.url === "string"
    && value.url.length <= COVERAGE_LIST_LIMITS.url;
}

function isCoverageListData(data: Record<string, unknown>): boolean {
  return Reflect.ownKeys(data).every(
    (key) => typeof key === "string" && COVERAGE_LIST_DATA_KEY_SET.has(key),
  )
    && Array.isArray(data.entries)
    && data.entries.length <= COVERAGE_LIST_LIMITS.entries
    && data.entries.every(isCoverageEntry);
}

function hasUniqueCollectionItemIds(items: readonly unknown[]): boolean {
  const seen = new Set<string>();
  for (const item of items) {
    if (!isRecord(item)) return false;
    const itemId = item.itemId;
    if (itemId === undefined) continue;
    if (typeof itemId !== "string" || itemId.trim().length === 0) return false;
    if (seen.has(itemId)) return false;
    seen.add(itemId);
  }
  return true;
}

export function isImageData(value: unknown): value is ImageData {
  if (!isRecord(value)) return false;
  if (!(value.altDecorative === undefined || typeof value.altDecorative === "boolean")) {
    return false;
  }
  // Decorative and described are opposite claims, so the pair is refused here rather
  // than at the editor, which is the only writer that would honour a refusal. Imports,
  // scripts and direct Firestore writes all come through this parser, and silently
  // preferring one of the two claims would publish an image whose markup contradicts
  // what the record says about it. Safe to refuse at the parse boundary precisely
  // because the flag is new: no stored page can already hold the contradiction.
  //
  // The other half of the rule, that an image must be described or marked decorative,
  // deliberately stays out of here. Many stored pages hold an image with an empty alt
  // and no flag, and refusing those would take published content offline to enforce a
  // rule about what may be saved next. The admin save boundary enforces that half.
  if (value.altDecorative === true && value.alt !== "") return false;
  return isOptionalCollectionItemId(value.itemId)
    && typeof value.assetId === "string"
    && typeof value.alt === "string"
    && isOptionalString(value.caption);
}

function isImageBlockData(value: unknown): value is ImageBlockData {
  if (!isImageData(value)) return false;
  const { href, newTab } = value as ImageBlockData;
  if (!isOptionalString(href) || !(newTab === undefined || typeof newTab === "boolean")) return false;
  return !(value.altDecorative === true && href !== undefined && href.trim().length > 0);
}

/**
 * The manual pin list of a dynamic block: at most SHELF_PIN_MAX distinct `{ id }`
 * objects. Pins outrank the query, so an unbounded or repeating pin list would be a
 * hand-built shelf wearing a dynamic block's name, and is refused here rather than
 * quietly trimmed at render.
 */
function isValidShelfPins(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > SHELF_PIN_MAX) return false;
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) return false;
    if (Reflect.ownKeys(entry).some((key) => key !== "id")) return false;
    if (typeof entry.id !== "string" || entry.id.trim().length === 0) return false;
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
  }
  return true;
}

/**
 * The half of a dynamic shelf query both block types share. The closed key set is what
 * makes "no arbitrary client queries" structural: a stored `query`, `filter`, or `items`
 * key fails the parse rather than being ignored, so nobody can smuggle a free-text query
 * or a baked copy of today's cards into the block.
 */
function hasValidShelfQuery(
  data: Record<string, unknown>,
  keys: ReadonlySet<string>,
): boolean {
  return (
    Reflect.ownKeys(data).every((key) => typeof key === "string" && keys.has(key)) &&
    typeof data.title === "string" &&
    isShelfTopicId(data.topic) &&
    typeof data.itemLimit === "number" &&
    SHELF_ITEM_LIMIT_SET.has(data.itemLimit) &&
    typeof data.sort === "string" &&
    SHELF_SORT_SET.has(data.sort) &&
    isValidShelfPins(data.pinned)
  );
}

function hasValidPromotionPlaylistCard(card: unknown, publishable: boolean): boolean {
  if (!isRecord(card)) return false;
  const decorative = card.altDecorative === true;
  return Reflect.ownKeys(card).every(
    (key) => typeof key === "string" && PROMOTION_PLAYLIST_CARD_KEY_SET.has(key),
  )
    && typeof card.itemId === "string"
    && card.itemId.trim().length > 0
    && typeof card.title === "string"
    && typeof card.summary === "string"
    && typeof card.imageAssetId === "string"
    && typeof card.alt === "string"
    && (card.altDecorative === undefined || typeof card.altDecorative === "boolean")
    && (!decorative || card.alt === "")
    && typeof card.href === "string"
    && (!publishable || (
      card.title.trim().length > 0
      && card.summary.trim().length > 0
      && card.imageAssetId.trim().length > 0
      && safeHref(card.href) !== null
    ));
}

function hasValidBlockData(
  type: BlockType,
  data: Record<string, unknown>,
  publishable: boolean,
  homeNewsletter = false,
): boolean {
  switch (type) {
    case "document_list":
      return isDocumentListData(data, publishable);
    case "bio_card":
      return isBioCardData(data, publishable);
    case "data_hub_section":
      return isDataHubSectionData(data);
    case "data_figure":
      return isDataFigureData(data, publishable);
    case "county_comparison":
      return isCountyComparisonData(data);
    case "town_lookup":
      return isTownLookupData(data, publishable);
    case "election_results":
      return isElectionResultsData(data, publishable);
    case "headline":
      return typeof data.text === "string"
        && (data.level === undefined || (typeof data.level === "number" && Number.isFinite(data.level)));
    case "prose":
      return isRichTextDoc(data.content);
    case "image":
      return isImageBlockData(data);
    case "video":
      return isVideoBlockData(data, publishable);
    case "image_gallery":
      // The mode is refused when it is not one the renderer has. Safe to refuse, on the same
      // reasoning as the decorative flag above: the field is new, so no stored gallery can
      // already hold a bad one, and accepting an unknown mode would publish a row wearing a
      // class no stylesheet defines.
      return Array.isArray(data.images)
        && data.images.every(isImageData)
        && hasUniqueCollectionItemIds(data.images)
        && (data.presentation === undefined
          || (typeof data.presentation === "string"
            && GALLERY_PRESENTATION_SET.has(data.presentation)));
    case "cta_row":
      return Array.isArray(data.ctas) && data.ctas.every((cta) => {
        if (!isRecord(cta)) return false;
        return typeof cta.label === "string"
          && typeof cta.href === "string"
          && (cta.variant === undefined || cta.variant === "primary" || cta.variant === "secondary");
      });
    case "card_grid":
      return Array.isArray(data.cards)
        && data.cards.every((card) => {
          if (!isRecord(card)) return false;
          return typeof card.title === "string"
            && isOptionalCollectionItemId(card.itemId)
            && isOptionalString(card.label)
            && (card.body === undefined || isRichTextDoc(card.body))
            && isOptionalString(card.imageAssetId)
            && isOptionalString(card.href);
        })
        && hasUniqueCollectionItemIds(data.cards);
    case "link_card":
      return Reflect.ownKeys(data).every(
        (key) => typeof key === "string" && LINK_CARD_DATA_KEY_SET.has(key),
      )
        && typeof data.title === "string"
        && data.title.length <= LINK_CARD_LIMITS.title
        && typeof data.url === "string"
        && data.url.length <= LINK_CARD_LIMITS.url
        && isOptionalString(data.source)
        && (typeof data.source !== "string" || data.source.length <= LINK_CARD_LIMITS.source)
        && isOptionalString(data.date)
        && (typeof data.date !== "string" || data.date.length === 0 || isCalendarDay(data.date))
        && isOptionalString(data.summary)
        && (typeof data.summary !== "string" || data.summary.length <= LINK_CARD_LIMITS.summary)
        && (!publishable || (
          data.title.trim().length > 0
          && safeHref(data.url) !== null
        ));
    case "faq_item":
      return typeof data.question === "string" && isRichTextDoc(data.answer);
    case "coverage_list":
      return isCoverageListData(data);
    case "data_table":
      return isDataTableData(data, publishable);
    case "embed":
      return typeof data.url === "string"
        && isOptionalString(data.host)
        && isOptionalString(data.caption)
        && isOptionalString(data.heading)
        && (data.mapSize === undefined || (typeof data.mapSize === "string" && ["small", "medium", "large"].includes(data.mapSize)))
        && (data.mapWidth === undefined || (typeof data.mapWidth === "string" && ["content", "wide"].includes(data.mapWidth)))
        && isOptionalEmbedDimension(data.mobileHeight, AP_MAP_MOBILE_HEIGHT_LIMITS)
        && isOptionalEmbedDimension(data.width, EMBED_WIDTH_LIMITS)
        && isOptionalEmbedDimension(data.height, EMBED_HEIGHT_LIMITS)
        && hasValidEmbedAspectRatio(data.width, data.height);
    case "html":
      return Reflect.ownKeys(data).every(
        (key) => typeof key === "string" && HTML_DATA_KEY_SET.has(key),
      )
        && typeof data.html === "string"
        && data.html.length <= HTML_BLOCK_LIMITS.html
        && (data.title === undefined || (typeof data.title === "string" && data.title.length <= HTML_BLOCK_LIMITS.title))
        && (!publishable || data.html.trim().length > 0);
    case "content_shelf":
      return Reflect.ownKeys(data).every(
        (key) => typeof key === "string" && CONTENT_SHELF_DATA_KEY_SET.has(key),
      )
        && typeof data.title === "string"
        && typeof data.source === "string"
        && CONTENT_SHELF_SOURCE_SET.has(data.source)
        && typeof data.itemLimit === "number"
        && CONTENT_SHELF_ITEM_LIMIT_SET.has(data.itemLimit)
        && typeof data.moreLabel === "string"
        && typeof data.moreHref === "string"
        && (data.presentation === undefined || CONTENT_SHELF_PRESENTATIONS.includes(data.presentation as ContentShelfPresentation))
        && (data.columns === undefined || SHELF_COLUMNS.includes(data.columns as 2 | 3 | 4))
        && (data.selectedIds === undefined && data.selectionReceipt === undefined ||
          isHomeSelectedIds(data.selectedIds, Number(data.itemLimit)) && isHomeSelectionReceipt(data.selectionReceipt));
    case "promotion_playlist":
      return Reflect.ownKeys(data).every(
        (key) => typeof key === "string" && PROMOTION_PLAYLIST_DATA_KEY_SET.has(key),
      )
        && typeof data.title === "string"
        && typeof data.placement === "string"
        && PROMOTION_PLAYLIST_PLACEMENT_SET.has(data.placement)
        && (data.presentation === undefined || SHELF_PRESENTATIONS.includes(data.presentation as ShelfPresentation))
        && (data.columns === undefined || SHELF_COLUMNS.includes(data.columns as 2 | 3 | 4))
        && Array.isArray(data.cards)
        && hasUniqueCollectionItemIds(data.cards)
        && data.cards.every((card) => hasValidPromotionPlaylistCard(card, publishable))
        && (!publishable || (
          data.title.trim().length > 0
          && data.cards.length >= 1
          && data.cards.length <= 12
        ));
    case "home_newscast":
      return isHomeNewscastData(data, false);
    case "newsletter_signup":
      return Reflect.ownKeys(data).every(key => typeof key === "string" && ["newsletterIds", "heading", "intro", "actionLabel", "selectionReceipt", "backgroundImageAssetId"].includes(key))
        && Array.isArray(data.newsletterIds)
        && data.newsletterIds.length <= 4
        && data.newsletterIds.every(id => typeof id === "string" && id.trim().length > 0)
        && new Set(data.newsletterIds).size === data.newsletterIds.length
        && (data.heading === undefined || typeof data.heading === "string")
        && (data.intro === undefined || typeof data.intro === "string")
        && (data.actionLabel === undefined || typeof data.actionLabel === "string")
        && (data.selectionReceipt === undefined || isHomeSelectionReceipt(data.selectionReceipt))
        && (!publishable || homeNewsletter || data.newsletterIds.length >= 1);
    case "topic_shelf":
      return (
        hasValidShelfQuery(data, TOPIC_SHELF_DATA_KEY_SET) &&
        typeof data.source === "string" &&
        TOPIC_SHELF_SOURCE_SET.has(data.source)
      );
    case "video_playlist":
      return (
        hasValidShelfQuery(data, VIDEO_PLAYLIST_DATA_KEY_SET) &&
        typeof data.library === "string" &&
        VIDEO_LIBRARY_SET.has(data.library)
      );
    case "record_card":
      return isRecordCardData(data, publishable);
    case "sponsor_strip":
      return Reflect.ownKeys(data).every((key) => typeof key === "string" && ["heading", "sponsorIds", "layout"].includes(key))
        && (data.heading === undefined || (typeof data.heading === "string" && data.heading.length <= 120))
        && (data.layout === "row" || data.layout === "grid")
        && Array.isArray(data.sponsorIds)
        && data.sponsorIds.length >= (publishable ? 1 : 0)
        && data.sponsorIds.length <= 12
        && data.sponsorIds.every((id) => typeof id === "string" && id.trim().length > 0)
        && new Set(data.sponsorIds).size === data.sponsorIds.length;
    case "row":
      return isRowData(data);
    case "divider":
      return Reflect.ownKeys(data).length === 0;
  }
}

export type ParseBlocksResult =
  | { ok: true; blocks: PageBlock[] }
  | { ok: false; error: string };

/**
 * Validate a stored `blocks` value against the ADR 0013 envelope: an ordered array
 * whose every entry is an object carrying an immutable string `id`, a known catalog
 * `type`, a numeric `order`, a boolean `visible`, an optional string `section`, and
 * a `data` object. Ids must be unique across the array -- version history and
 * media-usage tracking key on the block id, so a repeated id would conflate two
 * blocks. Order is preserved as-is. Each known type's data must also match its
 * declared payload before the result is exposed as `PageBlock[]`, so renderers never
 * receive an incomplete discriminated-union member.
 */
export function parseBlocks(input: unknown, { complete = true, pageId }: { complete?: boolean; pageId?: string } = {}): ParseBlocksResult {
  if (!Array.isArray(input)) {
    return { ok: false, error: "blocks must be an array" };
  }
  const seenIds = new Set<string>();
  for (let i = 0; i < input.length; i++) {
    const entry = input[i];
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, error: `blocks[${i}] is not an object` };
    }
    const block = entry as Record<string, unknown>;
    if (typeof block.type !== "string" || !BLOCK_TYPE_SET.has(block.type)) {
      return { ok: false, error: `blocks[${i}] has unknown type ${String(block.type)}` };
    }
    if (typeof block.id !== "string" || block.id.length === 0) {
      return { ok: false, error: `blocks[${i}] is missing a string id` };
    }
    if (seenIds.has(block.id)) {
      return { ok: false, error: `blocks[${i}] repeats id ${block.id}` };
    }
    seenIds.add(block.id);
    if (typeof block.order !== "number" || !Number.isFinite(block.order)) {
      return { ok: false, error: `blocks[${i}] is missing a numeric order` };
    }
    if (typeof block.visible !== "boolean") {
      return { ok: false, error: `blocks[${i}] is missing a boolean visible flag` };
    }
    if (block.section !== undefined && typeof block.section !== "string") {
      return { ok: false, error: `blocks[${i}] has a non-string section` };
    }
    if (!isRecord(block.data)) {
      return { ok: false, error: `blocks[${i}] is missing a data object` };
    }
    if (Object.hasOwn(block.data, "backgroundImageAssetId")) {
      const band = block.section === "home-newsletter" && block.type === "newsletter_signup" ||
        block.section === "home-passport-copy" && block.type === "prose" ||
        block.section === "home-donor" && block.type === "card_grid";
      if (!band || pageId !== undefined && pageId !== "home" ||
          typeof block.data.backgroundImageAssetId !== "string" ||
          !/^[A-Za-z0-9_-]{0,128}$/.test(block.data.backgroundImageAssetId)) {
        return { ok: false, error: "Home band background requires a media asset id on its named Home section." };
      }
    }
    if (block.section === "home-newsletter" && pageId !== undefined && pageId !== "home") {
      return { ok: false, error: "The Home Newsletter bar belongs only on Home." };
    }
    if (block.type === "home_newscast" && block.section !== "home-newscast") {
      return { ok: false, error: "Newscast requires its named Home section." };
    }
    if (block.type === "newsletter_signup" && block.section !== "home-newsletter" &&
        (block.data.actionLabel !== undefined || block.data.selectionReceipt !== undefined)) {
      return { ok: false, error: "Home Newsletter fields require the named Home bar." };
    }
    if (!hasValidBlockData(block.type as BlockType, block.data, block.type === "data_table" ? false : complete && block.visible, block.section === "home-newsletter")) {
      return { ok: false, error: `blocks[${i}] has invalid data for ${block.type}` };
    }
  }
  if (pageId === "kids" && input.some(block => block.type === "record_card" && block.data.recordKind === "newsletter")) {
    return { ok: false, error: "Newsletter record cards are not allowed on the Kids page" };
  }
  const hubError = dataHubCompositionError(input as PageBlock[], pageId);
  if (hubError) return { ok: false, error: hubError };
  const layoutError = contentLayoutError(input as PageBlock[]);
  if (layoutError) return { ok: false, error: layoutError };
  // Completeness follows row visibility after the row grammar is validated.
  for (const block of visibleLayoutBlocks(input as PageBlock[])) {
    if (complete && block.type === "data_table" && !isDataTableData({ ...block.data }, true)) {
      return { ok: false, error: `blocks[${input.findIndex((entry) => entry.id === block.id)}] has invalid data for data_table` };
    }
  }
  return { ok: true, blocks: input as PageBlock[] };
}
