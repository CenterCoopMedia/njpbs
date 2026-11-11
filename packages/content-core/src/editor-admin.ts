import { DATA_HUB_SECTIONS } from "./data-hub-composition.ts";
import { containsBio } from "./bio-profiles.ts";
// Editor-facing admin core for the NJ PBS CMS (issue #201), on the ADR 0013 block
// catalog.
//
// This is the pure logic the React editorial admin is a thin shell over: the
// per-page block palette that makes off-brand layouts impossible, the block-list
// operations (insert / remove / move) the UI dispatches, and the plain-language
// field descriptors that hide the data model from editors. No React, no Firebase,
// no DOM, so the guarantees a non-technical editor depends on hold in a unit test,
// independent of the interface.
//
// It sits on the content model (issue #200, `content-model.ts`) and imports the
// fixed `BlockType` from it rather than redeclaring it, so the catalog has one
// source of truth. This core owns placement and ordering; `content-model.ts`'s
// `parseBlocks` owns each block's data shape, and the server write boundary owns
// storage policy (asset existence). The renderer checks embed hosts and video IDs.
//
// The block catalog here is ADR 0013's (`headline`, `prose`, `image`,
// `image_gallery`, `cta_row`, `card_grid`, `faq_item`, `embed`, `content_shelf`,
// `divider`). The #201 held-as-spec was written against the earlier flat
// catalog before ADR 0013 fixed the launch set; this landing reconciles to
// ADR 0013 and folds in the six contract gaps from issue #392.

import {
  BLOCK_TYPES,
  NESTED_MEDIA_COLLECTION_MAX,
  type BlockType,
  type ProgramRecord,
  type StaffRecord,
  type EventRecord,
  type SponsorRecord,
  type NewsletterRecord,
  type PostRecord,
  type PageMetadata,
  type SearchMetadata,
  type SocialMetadata,
  type ImageData,
  type PageBlock,
  type CtaRowData,
  type CardGridData,
  type LinkCardData,
  LINK_CARD_LIMITS,
  EMBED_ASPECT_RATIO_LIMITS,
  EMBED_HEIGHT_LIMITS,
  EMBED_WIDTH_LIMITS,
  AP_MAP_MOBILE_HEIGHT_LIMITS,
  type CoverageEntry,
  COVERAGE_LIST_LIMITS,
  type ContentShelfData,
  type PromotionPlaylistData,
  type PromotionPlaylistCard,
  type TopicShelfData,
  type VideoPlaylistData,
  CONTENT_SHELF_ITEM_LIMITS,
  PROMOTION_PLAYLIST_PLACEMENTS,
  SHELF_PRESENTATIONS,
  SHELF_COLUMNS,
} from "./content-model.ts";
import {
  SHELF_ITEM_LIMITS,
  type ShelfPin,
  SHELF_PIN_MAX,
  SHELF_SORTS,
  SHELF_SORT_LABELS,
  SHELF_TOPICS,
  VIDEO_LIBRARIES,
  VIDEO_LIBRARY_LABELS,
} from "./dynamic-shelves.ts";
import { SEEDED_CONTENT_SECTIONS } from "./content-sections.ts";

// ---------------------------------------------------------------------------
// The two surfaces: block pages and structured records
// ---------------------------------------------------------------------------

// Block pages are the marketing and landing surfaces an editor assembles from a
// fixed palette of blocks. Structured records (program, event, sponsor,
// newsletter, below) are typed forms with one continuous prose body, never
// a block layout: modeling a long prose record as blocks is the paragraph-fragmentation
// issue #201 forbids, and would let an editor build one out of blocks the record loader
// could never render. So `SectionId` covers only block pages.
//
// A post (ADR 0013's v1 `/updates/` type) is the one surface that spans both: a block
// body AND record metadata (`date`, `tags`, `author`, ...). Issue #501 fixes its
// deliberately smaller block palette below, while its grouped metadata descriptors
// live with the structured record forms later in this module.
//
// "Section" names the #201 spec's page-template surface; it is distinct from the
// ADR 0013 per-block `section?` grouping (a within-page label), which this core
// does not gate on.
export type SectionId = "home" | "programLanding" | "genericPage" | "post";

// The fixed catalog: each page template maps to the ADR 0013 blocks an editor may
// place there, in palette order. Adding a block to a template is a one-line data
// change -- the only thing a developer is ever needed for (acceptance criterion 3).
// Editors never see or touch this; they see the palette it produces.
//
// Frozen at every level so the off-brand-layout invariant holds at the module
// boundary, not by caller discipline: a consumer that imports the table to render a
// palette still cannot push a block into a template and thereby widen what
// `canPlaceBlock` later trusts. Under ES-module strict mode a mutation attempt throws.
export const SECTION_BLOCK_CATALOG: Readonly<Record<SectionId, readonly BlockType[]>> =
  Object.freeze({
    home: Object.freeze<BlockType[]>([
      "row",
      "headline",
      "prose",
      "image",
      "image_gallery",
      "cta_row",
      "card_grid",
      "embed",
      "html",
      "content_shelf",
      "promotion_playlist",
      "topic_shelf",
      "video_playlist",
      "newsletter_signup",
      "home_newscast",
      "record_card",
      "sponsor_strip",
      "divider",
    ]),
    programLanding: Object.freeze<BlockType[]>([
      "row",
      "headline",
      "prose",
      "image",
      "card_grid",
      "link_card",
      "faq_item",
      "cta_row",
      "embed",
      "county_comparison",
      "town_lookup",
      "html",
      "video_playlist",
      "promotion_playlist",
      "record_card",
      "divider",
      "sponsor_strip",
    ]),
    genericPage: Object.freeze<BlockType[]>([
      "embed",
      "data_hub_section",
      "document_list",
      "data_table",
      "data_figure",
      "election_results",
      "county_comparison",
      "town_lookup",
      "row",
      "headline",
      "prose",
      "image",
      "video",
      "cta_row",
      "faq_item",
      "link_card",
      "coverage_list",
      "html",
      "topic_shelf",
      "video_playlist",
      "promotion_playlist",
      "record_card",
      "newsletter_signup",
      "divider",
      "sponsor_strip",
    ]),
    // A related-story shelf at the foot of a story is the case the request was built
    // from (#1046), so a post gets the topic shelf. It does not get a video playlist:
    // a story that wants one video wants a video block or an embed, not a queried row.
    post: Object.freeze<BlockType[]>([
      "bio_card",
      "data_table",
      "data_figure",
      "election_results",
      "row",
      "prose",
      "image",
      "video",
      "image_gallery",
      "embed",
      "html",
      "cta_row",
      "support_appeal",
      "link_card",
      "topic_shelf",
      "promotion_playlist",
      "record_card",
      "newsletter_signup",
      "divider",
      "sponsor_strip",
    ]),
  });

// Per-template, per-type ceilings (issue #392, gap 2). `allowedBlocks` alone lets an
// editor stack N of one block on a page; a cap keeps the structural blocks from
// piling up, so "off-brand layouts impossible" covers cardinality and not just type.
// A type absent from a template's map is uncapped. The reducer gates `insert` on
// this, and `validateSection` enforces it at the save boundary so a corrupt stored
// list cannot be saved back over the cap.
export const SECTION_BLOCK_MAX: Readonly<
  Record<SectionId, Readonly<Partial<Record<BlockType, number>>>>
> = Object.freeze({
  home: Object.freeze({
    headline: 1,
    image_gallery: 2,
    card_grid: 2,
    cta_row: 3,
    content_shelf: 4,
    promotion_playlist: 8,
    topic_shelf: 2,
    video_playlist: 2,
    home_newscast: 1,
  }),
  programLanding: Object.freeze({ promotion_playlist: 8, headline: 1, cta_row: 2, video_playlist: 1 }),
  genericPage: Object.freeze({ promotion_playlist: 8, headline: 1, cta_row: 2, coverage_list: 1, topic_shelf: 2, video_playlist: 1, video: 4 }),
  post: Object.freeze({ promotion_playlist: 8, image_gallery: 2, cta_row: 2, support_appeal: 1, topic_shelf: 1, video: 4 }),
});

export function allowedBlocksForSection(section: SectionId): BlockType[] {
  // Return a fresh copy the caller owns: the catalog is the single source of truth,
  // so a caller that sorts or splices its palette must not silently widen it for
  // everyone else.
  return (SECTION_BLOCK_CATALOG[section] ?? []).slice();
}

/** Blocks editors can add now. Legacy coverage lists stay valid and editable. */
export function insertableBlocksForSection(section: SectionId): BlockType[] {
  return allowedBlocksForSection(section).filter((type) => type !== "coverage_list");
}

export function canPlaceBlock(section: SectionId, type: BlockType): boolean {
  return allowedBlocksForSection(section).includes(type);
}

// Catalog membership plus the remaining per-type cap. Replacement uses this too:
// turning a text block into a coverage list still adds that type, so a post or a
// page that already has its one coverage list must not offer the conversion.
export function canPlaceAnotherBlock(
  section: SectionId,
  blocks: readonly EditorBlock[],
  type: BlockType,
): boolean {
  if (!canPlaceBlock(section, type)) return false;
  return blocks.filter((block) => block.type === type && countsTowardTypeLimit(section, block)).length < maxOf(section, type);
}

// A retained, unique Home giving identity has its own slot. Withdrawing it must
// not permanently consume the ordinary card-set allowance. Total limits apply.
function countsTowardTypeLimit(section: SectionId, block: EditorBlock): boolean {
  return !(section === "home" && block.type === "card_grid" && block.section === "home-donor");
}

function maxOf(section: SectionId, type: BlockType): number {
  const cap = SECTION_BLOCK_MAX[section]?.[type];
  return cap ?? Number.POSITIVE_INFINITY;
}

// Bound editor work independently of content size. Posts allow 200 blocks,
// including structural rows, matching the existing build-free Page count ceiling.
// Other templates retain their 40-block reference workload. The save boundary
// measures the composed document and version history against Firestore's byte
// budget; a block count alone cannot keep rich text under that budget.
export const SECTION_BLOCK_TOTAL_MAX: Readonly<Record<SectionId, number>> = Object.freeze({
  home: 40,
  programLanding: 40,
  genericPage: 40,
  post: 200,
});

function totalMaxOf(section: SectionId): number {
  return SECTION_BLOCK_TOTAL_MAX[section] ?? Number.POSITIVE_INFINITY;
}

// Human names for templates and blocks. The core never shows an editor a raw
// identifier (acceptance criterion 1), so these are the names the palette renders
// and the editor-facing error copy uses. Frozen for the same module-boundary reason
// as the catalog.
export const SECTION_LABELS: Readonly<Record<SectionId, string>> = Object.freeze({
  home: "the home page",
  programLanding: "a program landing page",
  genericPage: "a content page",
  post: "a post",
});

export const BLOCK_LABELS: Readonly<Record<BlockType, string>> = Object.freeze({
  bio_card: "bio card",
  row: "row",
  headline: "heading",
  prose: "text",
  image: "image",
  video: "uploaded video",
  image_gallery: "image gallery",
  cta_row: "buttons",
  support_appeal: "support appeal",
  card_grid: "card set",
  link_card: "link card",
  document_list: "PDF notices",
  faq_item: "FAQ item",
  coverage_list: "coverage list",
  town_lookup: "town election lookup",
  data_table: "data table",
  data_hub_section: "Data Hub section",
  data_figure: "data figure",
  election_results: "election results",
  county_comparison: "county comparison",
  embed: "video or embed",
  html: "custom HTML",
  content_shelf: "content shelf",
  promotion_playlist: "manual content shelf",
  newsletter_signup: "newsletter signup",
  home_newscast: "Newscast",
  topic_shelf: "related stories",
  video_playlist: "video content shelf",
  record_card: "Program, event, sponsor, or newsletter",
  sponsor_strip: "sponsor strip",
  divider: "divider",
});

// ---------------------------------------------------------------------------
// Block-list operations
// ---------------------------------------------------------------------------

// A placed block. `id` is stable for the block's lifetime, so reorder and remove
// address it by identity -- never by array position, which shifts, or by content,
// which changes as the editor types. `order` is the block's persisted position in
// the page (ADR 0013): the live editing order is the array, so the reducer renumbers
// `order` to the array index on every op, and a saved list never disagrees with
// itself when a renderer sorts by `order`. The reducer is generic over any block
// that carries at least `{ id, type, order }`, so the shell passes a full ADR 0013
// `PageBlock` (with `visible`, `data`) and gets it back with positions renumbered and
// everything else preserved.
export interface EditorBlock {
  // `readonly` to match the model's `BlockEnvelope.id`: move, remove, undo, and
  // version history all address a block by its id, so a caller reassigning it would
  // silently break that addressing. The invariant is documented above; this puts it
  // in the compiler instead of trusting callers to pick the stricter `PageBlock`.
  readonly id: string;
  type: BlockType;
  order: number;
  section?: string;
}

// Reconcile each block's persisted `order` with its array index. `order` is ADR 0013's
// positional field and the array is the live order during editing, so after any op that
// can shift positions the two must agree or a saved page contradicts itself. A block
// already at its index keeps its identity, so the shell's keyed render and memoization
// are not churned into a full remount on every op.
function renumberOrder<B extends EditorBlock>(blocks: B[]): B[] {
  return blocks.map((b, i) => (b.order === i ? b : ({ ...b, order: i } as B)));
}

// The operations the editor UI dispatches. Each is data, so the same reducer runs
// in the browser and in a test. `insert` carries the whole block so a successful op
// can hand back its exact inverse, which is what an undo stack replays (issue #392,
// gap 6).
export type EditorOp<B extends EditorBlock = EditorBlock> =
  | { kind: "insert"; block: B; index: number }
  | { kind: "remove"; id: string }
  | { kind: "move"; id: string; toIndex: number };

export interface OpError {
  op: EditorOp["kind"];
  // Editor-facing, always: plain words an editor can act on, never a raw id, block
  // type, or template name (acceptance criterion 1). Machine identifiers live in
  // `detail` instead, for logs and debugging.
  reason: string;
  // The raw, machine-readable cause -- a colliding id, an off-catalog block type --
  // for logs and bug reports. Present only when there is one; never shown to editors.
  detail?: string;
}

// A successful op returns the new list and the inverse op that undoes it, so an undo
// stack is a list of these inverses replayed through the same reducer (issue #392,
// gap 6). A rejected op returns a located error and the bad state never lands.
export type OpResult<B extends EditorBlock = EditorBlock> =
  | { blocks: B[]; inverse: EditorOp<B> }
  | { error: OpError };

function clampIndex(i: number, max: number): number {
  if (Number.isNaN(i)) return 0;
  return Math.max(0, Math.min(Math.trunc(i), max));
}

// A section's block list is valid when every block is allowed in that section, every
// id is present and unique, and no type or the page as a whole exceeds its cap. This
// is the save invariant, and it is the SAVE BOUNDARY's gate: a load/save boundary
// MUST call `validateSection` before persisting a page, because a stored list can
// arrive corrupt (an import, a stale client, an older bug) and the reducer no longer
// rejects every corrupt state. The reducer's own guarantee is narrower but always
// true: no op returns a list less valid than its input (`insert` is revalidated in
// full; `remove` and `move` are monotonic), so an editor can walk a corrupt page back
// to valid one remove at a time. The reason is editor-facing; the detail carries the
// machine cause for logs.
export function validateSection(
  section: SectionId,
  blocks: readonly EditorBlock[],
): { reason: string; detail: string } | null {
  if (blocks.length > totalMaxOf(section)) {
    return {
      reason:
        "this page could not be saved because it has too many blocks. Remove some, and let the team know if it keeps happening.",
      detail: `page has ${blocks.length} blocks, over the ${totalMaxOf(section)} cap in ${section}`,
    };
  }
  if (section !== "post" && containsBio(blocks)) return {
    reason: "Bio cards are available only inside Posts.",
    detail: `Bios are not allowed in ${section}`,
  };
  const seen = new Set<string>();
  const counts = new Map<BlockType, number>();
  for (const [i, b] of blocks.entries()) {
    if (b.id.length === 0) {
      // The persistence boundary (`parseBlocks`) rejects an empty id, so the reducer
      // must too: without this, a block with a blank id would pass here yet fail the
      // save, breaking the promise that a validated list is a saveable one. The editor
      // never types an id, so this is an internal condition -- generic recovery copy,
      // the position in `detail`.
      return {
        reason:
          "this page could not be saved because a block is missing its identifier. Reload the page, and let the team know if it keeps happening.",
        detail: `block at index ${i} has an empty id`,
      };
    }
    if (seen.has(b.id)) {
      return {
        reason:
          "this page could not be saved because a block is repeated. Reload the page, and let the team know if it keeps happening.",
        detail: `duplicate block id "${b.id}"`,
      };
    }
    seen.add(b.id);
    if (!canPlaceBlock(section, b.type)) {
      return {
        reason:
          "this page could not be saved because it has a block that does not belong here. Reload the page, and let the team know if it keeps happening.",
        detail: `block type "${b.type}" is not in the ${section} catalog`,
      };
    }
    const n = (counts.get(b.type) ?? 0) + (countsTowardTypeLimit(section, b) ? 1 : 0);
    counts.set(b.type, n);
    if (n > maxOf(section, b.type)) {
      return {
        reason:
          "this page could not be saved because it has too many of one kind of block. Remove one, and let the team know if it keeps happening.",
        detail: `block type "${b.type}" exceeds the cap of ${maxOf(section, b.type)} in ${section}`,
      };
    }
  }
  return null;
}

// Apply one editor operation to a section's block list. Returns a NEW list plus its
// inverse, or an OpError the UI surfaces and drops -- the bad state never lands. The
// input array is never mutated, so a rejected op leaves the editor exactly as it
// was. An insert is gated on the section catalog and its cap, so an off-brand or
// over-cap block cannot enter the page even if the palette is bypassed; move and
// remove resolve by id, so a reorder or edit elsewhere cannot mis-target them.
export function applyEditorOp<B extends EditorBlock>(
  section: SectionId,
  blocks: readonly B[],
  op: EditorOp<B>,
): OpResult<B> {
  let next: B[];
  let inverse: EditorOp<B>;
  switch (op.kind) {
    case "insert": {
      if (!canPlaceBlock(section, op.block.type)) {
        // Editor-facing copy, so it names the block and template in plain words --
        // the one place the core speaks to an editor, and it must not leak the
        // machine identifiers the field descriptors hide everywhere else.
        return {
          error: {
            op: "insert",
            reason: `the ${BLOCK_LABELS[op.block.type]} block cannot be added to ${SECTION_LABELS[section]}`,
          },
        };
      }
      const cap = maxOf(section, op.block.type);
      if (countsTowardTypeLimit(section, op.block) && blocks.filter((b) => b.type === op.block.type && countsTowardTypeLimit(section, b)).length >= cap) {
        return {
          error: {
            op: "insert",
            reason: `${SECTION_LABELS[section]} already has as many ${BLOCK_LABELS[op.block.type]} blocks as it allows`,
          },
        };
      }
      // The page-wide ceiling. A type with no per-type cap (prose, divider) is bounded
      // only here, so this is what stops an editor building a page the server's 1 MB
      // limit would later reject (ADR 0013).
      if (blocks.length >= totalMaxOf(section)) {
        return {
          error: {
            op: "insert",
            reason: `${SECTION_LABELS[section]} already has as many blocks as one page can hold`,
          },
        };
      }
      // Reject a colliding id so the by-id addressing invariant can never be broken:
      // two blocks sharing an id would make a later move or remove target only the
      // first, leaving the duplicate unreachable. A retry or a weak client id
      // generator is how that slips in. The editor never types an id, so this is an
      // internal condition: a generic recovery message, id in detail.
      if (blocks.some((b) => b.id === op.block.id)) {
        return {
          error: {
            op: "insert",
            reason: "that block is already on the page",
            detail: `a block with id "${op.block.id}" already exists`,
          },
        };
      }
      next = blocks.slice();
      const at = clampIndex(op.index, next.length);
      next.splice(at, 0, op.block);
      inverse = { kind: "remove", id: op.block.id };
      break;
    }
    case "remove": {
      const at = blocks.findIndex((b) => b.id === op.id);
      if (at === -1) {
        return {
          error: {
            op: "remove",
            reason: "that block could not be found -- refresh and try again",
            detail: `no block with id "${op.id}"`,
          },
        };
      }
      next = blocks.slice();
      const [removed] = next.splice(at, 1);
      // Carry the removed block and its index so undo re-inserts the exact block, not
      // a fresh empty one (issue #392, gap 6).
      inverse = { kind: "insert", block: removed, index: at };
      break;
    }
    case "move": {
      const from = blocks.findIndex((b) => b.id === op.id);
      if (from === -1) {
        return {
          error: {
            op: "move",
            reason: "that block could not be found -- refresh and try again",
            detail: `no block with id "${op.id}"`,
          },
        };
      }
      next = blocks.slice();
      const [moved] = next.splice(from, 1);
      const to = clampIndex(op.toIndex, next.length);
      next.splice(to, 0, moved);
      // Undo returns the block to where it started (issue #392, gap 6).
      inverse = { kind: "move", id: op.id, toIndex: from };
      break;
    }
  }

  // Renumber `order` to match the new array positions before anything else sees the
  // result, so the list this op hands back (and a caller may save) is internally
  // consistent. Undo replays its inverse through this same reducer, so order stays
  // consistent across undo and redo.
  const renumbered = renumberOrder(next);

  // Revalidate the whole result for `insert` only. `insert` is the one op that can
  // introduce a violation, so this backstops its pre-gates -- and is what rejects an
  // inserted empty id, which no pre-gate checks. `remove` and `move` are monotonic:
  // they cannot add an off-catalog block, duplicate an id, or raise any count, so
  // their result is never less valid than their input. Gating them on full validity
  // would trap the editor -- a stored list corrupt by more than one (three headlines
  // under a cap of one, an imported 42-block page) could never be walked back to
  // valid, because every intermediate remove would be rejected. So removing blocks
  // one at a time is how an editor repairs such a page. Validity at save time is the
  // save boundary's job: it MUST call `validateSection` before persisting.
  if (op.kind === "insert") {
    const invalid = validateSection(section, renumbered);
    if (invalid) {
      return { error: { op: op.kind, reason: invalid.reason, detail: invalid.detail } };
    }
  }
  return { blocks: renumbered, inverse };
}

// ---------------------------------------------------------------------------
// Field descriptors: what an editor sees in place of the data model
// ---------------------------------------------------------------------------

// What an editor sees for one field: a human label and helper text, a widget kind,
// and whether it is required -- never the machine field name from the data model.
// Hiding the schema is acceptance criterion 1. `key` is the non-displayed content-
// model field the shell binds a value back to, so a copy edit to a label never
// becomes a data migration (issue #392, gap 5). `target` names the collection a
// `recordList` picks from, so the shell can populate the picker without a second
// hardcoded mapping.
export interface EditorFieldOption {
  value: string | number;
  label: string;
}

export interface EditorField {
  key: string;
  /** Use a textarea for plain text that can contain line breaks. */
  multiline?: boolean;
  /**
   * The most items a `list` field may hold. Declared so the control can stop offering Add
   * at the limit and validation can name the number, rather than letting an editor build
   * a payload that only the final parser refuses with a message naming nothing (#1046).
   */
  maxItems?: number;
  /** The fewest items a complete `list` field may hold. */
  minItems?: number;
  /** The most characters a `text` or `url` field may hold. */
  maxLength?: number;
  /** Require an absolute HTTPS URL without credentials or raw whitespace. */
  requireHttps?: boolean;
  /** Inclusive limits for a numeric field. */
  min?: number;
  max?: number;
  /** Optional sibling numeric field used to validate width-to-height ratios. */
  aspectRatioWith?: string;
  minAspectRatio?: number;
  maxAspectRatio?: number;
  // Optional object path for grouped metadata. A search title is `{ path: ["seo"],
  // key: "title" }`, which keeps it distinct from the visible root `title` while the
  // form still renders both through the same FieldRenderer. Paths contain data keys,
  // never array indexes; repeatable item fields remain relative to their own item.
  path?: readonly string[];
  label: string;
  help: string;
  // `date` is a calendar day with no time (a post's editorial date). `datetime` is
  // an absolute instant stored as UTC and edited in station time, which the
  // scheduling fields need: a day alone cannot say when an event starts, and the
  // publish gate refuses a value that carries no instant.
  kind:
    | "text"
    | "richText"
    | "url"
    | "number"
    | "asset"
    | "list"
    | "recordList"
    | "toggle"
    | "date"
    | "datetime"
    | "select"
    // An ordered story byline (#1040): registered credits naming CMS author
    // identities, plus custom credits that are display text only. It is its own
    // kind rather than a `list` of item fields because the two credit types are
    // different shapes with different controls -- a person picker and a text
    // entry -- and a generic repeatable sub-form cannot express that a row's
    // control depends on which kind of credit the row is.
    | "storyCredits";
  required: boolean;
  /**
   * Key of a sibling `toggle` field on the same record that releases this
   * field's requirement or recommendation while it is on. Declarative rather
   * than a predicate so a descriptor stays serializable data the shell renders
   * without importing logic.
   *
   * The case it exists for: alt text is recommended, but WCAG 1.1.1 wants a
   * decorative image to carry alt="". While the toggle is on, the field must
   * stay empty and no warning is shown.
   */
  requiredUnless?: string;
  /**
   * Key of a sibling field that activates this requirement. This keeps
   * contextual image text absent when there is no image, but mandatory once an
   * asset is selected.
   */
  requiredWhen?: string;
  /**
   * For a `url` field: sibling text fields that give the link its accessible name. A
   * filled link needs at least one of them before it can publish, because a linked image
   * with no alt text or caption is a link a screen reader cannot name.
   */
  namedBy?: readonly string[];
  /**
   * An empty value warns instead of refusing a save or publish. It uses the
   * same `requiredWhen` and `requiredUnless` gates as `required`. Alt text uses
   * it: staff are asked to describe an image, and a nightly sweep fills the
   * gaps (#242), but a missing description never stops the page.
   */
  recommended?: boolean;
  target?: RecordKind;
  // Finite choices for a `select`. Values may be strings or numbers; the renderer
  // maps the browser's string value back to the exact typed option value before
  // saving, and validation rejects anything outside this list.
  options?: readonly EditorFieldOption[];
  // For a `list` field only: the fields of ONE item, so the shell renders a repeatable
  // sub-form (add / remove / reorder items) without importing the block's data shape or
  // showing an editor a machine field name (acceptance criterion 1). Absent means the
  // list holds plain strings (a post's `tags`). The object-item lists -- an image
  // gallery, a button row, a card set -- declare them, typed against the item's model
  // shape so a phantom sub-key fails `tsc`, the same guarantee record keys already have.
  itemFields?: readonly EditorField[];
}

// A small editorial collection of related fields. The id is stable UI vocabulary for tests,
// analytics, and deep-linking later; label/help are the editor-facing copy. Groups are returned
// as fresh copies by the public accessor, like every descriptor catalog in this module.
export interface EditorFieldGroup {
  id: "content-link" | "home-hero" | "details" | "basics" | "excerpt" | "dates" | "organization" | "hero-image" | "search" | "social";
  label: string;
  help: string;
  fields: readonly EditorField[];
}

// A form field whose `key` must name a real field on type `R`. This makes issue #392
// gap 5's binding contract a compile-time guarantee: a descriptor key that does not
// exist on the content-model type (a phantom key the shell would silently drop) fails
// `tsc`/`astro check`, not just review. Used for both the typed record forms and the
// object-item sub-fields of a `list` block (below), which bind to an item's model
// shape. Top-level block `data` keys get the same guarantee through
// `BlockFieldFor` below.
type RecordFieldFor<R> = Omit<EditorField, "key"> & { key: Extract<keyof R, string> };

// The `data` shape `parseBlocks` enforces for one block type, read off the block
// union itself rather than restated as a hand-written map, so a new block type or a
// renamed data field cannot leave a second catalog behind to drift (issue #666).
type BlockDataFor<T extends BlockType> = Extract<PageBlock, { type: T }>["data"];

// A top-level block field whose `key` must name a real field on that block's own
// data shape. Same idiom as `RecordFieldFor`, applied per block type: `BLOCK_FIELDS`
// is one table over `BlockType` while each entry binds to a different data
// interface, so the check has to be a mapped type rather than a single generic.
// Optional data fields (`altDecorative`, a gallery `presentation`, a shelf's
// `pinned`) are in `keyof`, so a descriptor may name them or leave them out; a
// grouped-path field types against the nested shape, the way `SEARCH_FIELDS` does.
// Exported so the compile-time guarantee is asserted by a test rather than only by
// the descriptor table happening to compile: the spec declares a good and a bad key
// against this type, and the bad one is held to failing under `@ts-expect-error`.
export type BlockFieldFor<T extends BlockType> = Omit<EditorField, "key"> & {
  key: Extract<keyof BlockDataFor<T>, string>;
};

// The sub-fields of one item in each object-item `list` block, typed against the item's
// content-model shape so a wrong sub-key fails `tsc`. These are what let the shell build
// a gallery / button-row / card-set sub-form without knowing the data model.
const IMAGE_ITEM_FIELDS: readonly RecordFieldFor<ImageData>[] = [
  { key: "assetId", label: "Image", help: "Choose an image from the media library.", kind: "asset", required: true },
  { key: "alt", label: "Alt text", help: "Describe the image for screen readers and when it cannot load.", kind: "text", required: false, recommended: true, requiredWhen: "assetId", requiredUnless: "altDecorative" },
  { key: "altDecorative", label: "Mark as decorative", help: "Turn this on for an image that carries no information, such as a background pattern. Leave the alt text empty.", kind: "toggle", required: false },
  { key: "caption", label: "Caption", help: "An optional caption shown under the image.", kind: "text", required: false },
];
const CTA_ITEM_FIELDS: readonly RecordFieldFor<CtaRowData["ctas"][number]>[] = [
  { key: "label", label: "Button label", help: "The words on the button, for example Watch now.", kind: "text", required: true },
  { key: "href", label: "Button link", help: "Where the button goes when clicked.", kind: "url", required: true },
];
const CARD_ITEM_FIELDS: readonly RecordFieldFor<CardGridData["cards"][number]>[] = [
  { key: "label", label: "Card label", help: "An optional short category shown above the title.", kind: "text", required: false },
  { key: "title", label: "Card title", help: "The card's heading.", kind: "text", required: true },
  { key: "body", label: "Card text", help: "An optional short description, in one continuous editor.", kind: "richText", required: false },
  { key: "imageAssetId", label: "Card image", help: "An optional image from the media library.", kind: "asset", required: false },
  { key: "href", label: "Card link", help: "An optional link the card opens.", kind: "url", required: false },
];
const LINK_CARD_FIELDS: readonly RecordFieldFor<LinkCardData>[] = [
  {
    key: "title",
    label: "Card title",
    help: "The linked page or article title.",
    kind: "text",
    required: true,
    maxLength: LINK_CARD_LIMITS.title,
  },
  {
    key: "url",
    label: "Card link",
    help: "The public page this card opens.",
    kind: "url",
    required: true,
    maxLength: LINK_CARD_LIMITS.url,
  },
  {
    key: "source",
    label: "Source",
    help: "Optional. The publication, organization, or site name.",
    kind: "text",
    required: false,
    maxLength: LINK_CARD_LIMITS.source,
  },
  {
    key: "date",
    label: "Date",
    help: "Optional. The day the linked item was published.",
    kind: "date",
    required: false,
  },
  {
    key: "summary",
    label: "Summary",
    help: "Optional. A short description shown on the card.",
    kind: "text",
    required: false,
    maxLength: LINK_CARD_LIMITS.summary,
  },
];
const COVERAGE_ITEM_FIELDS: readonly RecordFieldFor<CoverageEntry>[] = [
  {
    key: "title",
    label: "Article title",
    help: "The headline of the outside article.",
    kind: "text",
    required: true,
    maxLength: COVERAGE_LIST_LIMITS.title,
  },
  {
    key: "outlet",
    label: "Outlet",
    help: "The publication that ran the article.",
    kind: "text",
    required: false,
    maxLength: COVERAGE_LIST_LIMITS.outlet,
  },
  { key: "date", label: "Article date", help: "The day the article ran.", kind: "date", required: false },
  {
    key: "url",
    label: "Article link",
    help: "The public link to the article.",
    kind: "url",
    required: false,
    maxLength: COVERAGE_LIST_LIMITS.url,
  },
];
const CONTENT_SHELF_FIELDS: readonly RecordFieldFor<ContentShelfData>[] = [
  {
    key: "title",
    label: "Shelf heading",
    help: "The heading shown above this content shelf.",
    kind: "text",
    required: true,
  },
  {
    key: "source",
    label: "Content source",
    help: "Choose the service that supplies the cards. Cards refresh from that service and are not copied into this page.",
    kind: "select",
    required: true,
    options: [
      { value: "pbs_featured", label: "PBS featured programs" },
      { value: "pbs_more", label: "PBS more to watch" },
      { value: "spotlight_news", label: "NJ Spotlight News" },
      { value: "station_posts", label: "Published NJ PBS Posts" },
    ],
  },
  {
    key: "presentation",
    label: "Shelf layout",
    help: "Keep a horizontal row or show a wrapping grid. Both use the same source cards.",
    kind: "select",
    required: false,
    options: [
      { value: "rail", label: "Horizontal row" },
      { value: "grid", label: "Wrapping grid" },
    ],
  },
  {
    key: "columns",
    label: "Grid columns",
    help: "The desktop column count. The grid uses two columns on phones.",
    kind: "select",
    required: false,
    options: [2, 3, 4].map(value => ({ value, label: value + " columns" })),
  },
  {
    key: "itemLimit",
    label: "Number of items",
    help: "The most cards this shelf requests from its source.",
    kind: "select",
    required: true,
    options: CONTENT_SHELF_ITEM_LIMITS.map((value) => ({
      value,
      label: `${value} items`,
    })),
  },
  {
    key: "moreLabel",
    label: "More link label",
    help: "The words on the link beside the shelf heading.",
    kind: "text",
    required: true,
  },
  {
    key: "moreHref",
    label: "More link",
    help: "Where the link beside the shelf heading goes.",
    kind: "url",
    required: true,
  },
];
const PROMOTION_CARD_FIELDS: readonly RecordFieldFor<PromotionPlaylistCard>[] = [
  { key: "title", label: "Content title", help: "The content name shown below the image.", kind: "text", required: true },
  { key: "summary", label: "Content summary", help: "A short description of the selected content.", kind: "text", required: true },
  { key: "imageAssetId", label: "Content image", help: "Choose an image from the media library.", kind: "asset", required: true },
  { key: "alt", label: "Alt text", help: "Describe the image for screen readers and when it cannot load.", kind: "text", required: false, recommended: true, requiredWhen: "imageAssetId", requiredUnless: "altDecorative" },
  { key: "altDecorative", label: "Mark as decorative", help: "Turn this on only when the image adds no information. Leave the alt text empty.", kind: "toggle", required: false },
  { key: "href", label: "Content link", help: "Paste the approved NJ PBS or PBS page for this content.", kind: "url", required: true },
];
const PROMOTION_PLACEMENT_LABELS: Readonly<Record<PromotionPlaylistData["placement"], string>> = {
  before_start: "Before the newsletter signup",
  before_featured: "Before Featured on NJ PBS",
  before_passport: "Before PBS Passport",
  before_more: "Before More to watch",
  before_spotlight: "Before NJ Spotlight News",
};
const SHELF_PRESENTATION_LABELS = { rail: "Horizontal row", grid: "Card grid", list: "List" };
const PROMOTION_PLAYLIST_FIELDS: readonly RecordFieldFor<PromotionPlaylistData>[] = [
  {
    key: "title",
    label: "Shelf heading",
    help: "The heading shown above this manual content shelf.",
    kind: "text",
    required: true,
  },
  {
    key: "presentation",
    label: "Shelf layout",
    help: "Choose how the cards appear.",
    kind: "select",
    required: false,
    options: SHELF_PRESENTATIONS.map(value => ({ value, label: SHELF_PRESENTATION_LABELS[value] })),
  },
  {
    key: "columns",
    label: "Grid columns",
    help: "Columns stack on small screens.",
    kind: "select",
    required: false,
    options: SHELF_COLUMNS.map(value => ({ value, label: `${value} columns` })),
  },
  {
    key: "placement",
    label: "Home page position",
    help: "Choose which existing Home page section this manual content shelf appears before.",
    kind: "select",
    required: true,
    options: PROMOTION_PLAYLIST_PLACEMENTS.map((value) => ({
      value,
      label: PROMOTION_PLACEMENT_LABELS[value],
    })),
  },
  {
    key: "cards",
    label: "Shelf items",
    help: "Add up to twelve items and put them in display order.",
    kind: "list",
    required: true,
    minItems: 1,
    maxItems: 12,
    itemFields: PROMOTION_CARD_FIELDS,
  },
];

// The two dynamic blocks (#1046). Every choice an editor makes is a pick from a closed
// list, so there is no box to type a query into: the topic, the source or library, the
// cap, and the order are all selects, and the manual order is a pick list of items the
// approved catalog actually holds. That is the acceptance criterion "an editor selects
// only bounded approved tags, categories, sources, item counts, and sort modes", read as
// a UI contract rather than only a validation one.
const TOPIC_OPTIONS = SHELF_TOPICS.map((topic) => ({
  value: topic.id,
  label: topic.label,
}));
const SORT_OPTIONS = SHELF_SORTS.map((sort) => ({
  value: sort,
  label: SHELF_SORT_LABELS[sort],
}));
const SHELF_COUNT_OPTIONS = SHELF_ITEM_LIMITS.map((value) => ({
  value,
  label: `Up to ${value} items`,
}));

// The pin pickers deliberately declare NO options.
//
// Two reasons, and both matter. First, the right choices depend on the block: a playlist
// pointed at the national library must not offer a station video the resolver would then
// refuse to place, and a descriptor evaluated once at module load cannot know which
// library this block chose. Second, reading the committed catalog here would fuse several
// kilobytes of story and video data to this module, which is in the admin's entry chunk --
// so every signed-in editor would download the catalog before any route mounts, including
// the editors who never place a shelf.
//
// So the block's own editing surface supplies the choices, filtered to the source or
// library the block currently names. An ABSENT option list means exactly that ("the
// surface supplies these"), which is why field validation skips the membership check for
// it; an empty list would instead mean "no choice is valid", which is a different claim.
const TOPIC_SHELF_PIN_FIELDS: readonly RecordFieldFor<ShelfPin>[] = [
  {
    key: "id",
    label: "Pinned story",
    help: "Choose a story from the approved list. Pinned stories appear first, in this order.",
    kind: "select",
    required: true,
  },
];

const VIDEO_PLAYLIST_PIN_FIELDS: readonly RecordFieldFor<ShelfPin>[] = [
  {
    key: "id",
    label: "Pinned video",
    help: "Choose a video from the approved library. Pinned videos appear first, in this order.",
    kind: "select",
    required: true,
  },
];

const TOPIC_SHELF_FIELDS: readonly RecordFieldFor<TopicShelfData>[] = [
  {
    key: "title",
    label: "Shelf heading",
    help: "The heading shown above the related stories.",
    kind: "text",
    required: true,
  },
  {
    key: "topic",
    label: "Topic",
    help: "The shelf fills itself with approved stories carrying this topic.",
    kind: "select",
    required: true,
    options: TOPIC_OPTIONS,
  },
  {
    key: "source",
    label: "Where the stories come from",
    help: "Only approved story sources can fill this shelf.",
    kind: "select",
    required: true,
    options: [{ value: "njpbs_related_index", label: "Approved NJ PBS related-story list" }],
  },
  {
    key: "itemLimit",
    label: "How many stories",
    help: "The most stories this shelf will show.",
    kind: "select",
    required: true,
    options: SHELF_COUNT_OPTIONS,
  },
  {
    key: "sort",
    label: "Order",
    help: "How the stories that are not pinned are ordered.",
    kind: "select",
    required: true,
    options: SORT_OPTIONS,
  },
  {
    key: "pinned",
    label: "Pinned stories",
    help: `Optional. Pinned stories come first, in this order, ahead of everything the topic finds. Up to ${SHELF_PIN_MAX}.`,
    kind: "list",
    required: false,
    maxItems: SHELF_PIN_MAX,
    itemFields: TOPIC_SHELF_PIN_FIELDS,
  },
];

const VIDEO_PLAYLIST_FIELDS: readonly RecordFieldFor<VideoPlaylistData>[] = [
  {
    key: "title",
    label: "Shelf heading",
    help: "The heading shown above the videos.",
    kind: "text",
    required: true,
  },
  {
    key: "topic",
    label: "Topic",
    help: "The playlist fills itself with approved videos carrying this topic.",
    kind: "select",
    required: true,
    options: TOPIC_OPTIONS,
  },
  {
    key: "library",
    label: "Video library",
    help: "Only NJ PBS and PBS libraries can fill a playlist. A video with no confirmed captions, runtime, or rights window is never shown.",
    kind: "select",
    required: true,
    options: VIDEO_LIBRARIES.map((library) => ({
      value: library,
      label: VIDEO_LIBRARY_LABELS[library],
    })),
  },
  {
    key: "itemLimit",
    label: "How many videos",
    help: "The most videos this playlist will show.",
    kind: "select",
    required: true,
    options: SHELF_COUNT_OPTIONS,
  },
  {
    key: "sort",
    label: "Order",
    help: "How the videos that are not pinned are ordered.",
    kind: "select",
    required: true,
    options: SORT_OPTIONS,
  },
  {
    key: "pinned",
    label: "Pinned videos",
    help: `Optional. Pinned videos come first, in this order, ahead of everything the topic finds. Up to ${SHELF_PIN_MAX}.`,
    kind: "list",
    required: false,
    maxItems: SHELF_PIN_MAX,
    itemFields: VIDEO_PLAYLIST_PIN_FIELDS,
  },
];

// Plain-language fields per ADR 0013 block, expressed for a non-technical editor. A
// prose body is ONE richText field, so a paragraph is never fragmented into separate
// components (which is what makes continuous typing possible). A `divider` carries no
// content and so has no fields.
// Every descriptor key is compile-checked against the block's own data shape (see
// `BlockFieldFor`), so a typo or a field renamed in the content model fails `tsc`
// instead of binding an editor's input to a key `parseBlocks` silently drops.
const BLOCK_FIELDS: { readonly [T in BlockType]: readonly BlockFieldFor<T>[] } = {
  home_newscast: [
    { key: "heading", label: "Heading", help: "The heading above the latest newscast.", kind: "text", required: true, maxLength: 120 },
    { key: "summary", label: "Summary", help: "An optional plain-text introduction.", kind: "text", multiline: true, required: false, maxLength: 2000 },
    { key: "layout", label: "Layout", help: "Choose the approved poster presentation.", kind: "select", required: true,
      options: [{ value: "feature", label: "Poster beside copy" }, { value: "compact", label: "Compact stacked card" }] },
    { key: "watchLabel", label: "Watch button text", help: "The action opens the approved episode.", kind: "text", required: true, maxLength: 120 },
    { key: "pastLabel", label: "Past newscasts text", help: "The action opens this program's past episodes.", kind: "text", required: true, maxLength: 120 },
    { key: "liveLabel", label: "Watch live text", help: "The action opens the station livestream.", kind: "text", required: true, maxLength: 120 },
  ],
  newsletter_signup: [
    { key: "heading", label: "Heading", help: "Optional heading above the newsletters.", kind: "text", required: false },
    { key: "intro", label: "Introduction", help: "Optional short introduction.", kind: "text", required: false, multiline: true },
    { key: "newsletterIds", label: "Newsletters", help: "Choose one to four newsletters. Only records with a secure signup link appear publicly.", kind: "list", required: true, minItems: 1, maxItems: 4 },
  ],
  headline: [
    { key: "text", label: "Heading", help: "The heading text for this section.", kind: "text", required: true },
  ],
  bio_card: [
    { key: "name", label: "Name", help: "The person or organization readers will see.", kind: "text", required: true, maxLength: 120 },
    { key: "role", label: "Role", help: "Current job or the role relevant to this story.", kind: "text", required: true, maxLength: 180 },
    { key: "party", label: "Party", help: "Include only a verified political affiliation when relevant.", kind: "text", required: false, maxLength: 60 },
    { key: "area", label: "Area served", help: "Use Statewide for statewide roles, or a specific district, town, county or region. Leave blank when unnecessary.", kind: "text", required: false, maxLength: 160 },
    { key: "summary", label: "Short biography", help: "A few sourced sentences that help explain this story. Leave out internal research notes.", kind: "text", multiline: true, required: true, maxLength: 600 },
    { key: "sourceUrl", label: "Source link", help: "The HTTPS source supporting these public facts.", kind: "url", required: true, maxLength: 2000, requireHttps: true },
    { key: "sourceLabel", label: "Source name", help: "A readable name for the source.", kind: "text", required: true, maxLength: 120 },
    { key: "asOf", label: "Facts checked", help: "The date these facts were verified. Recheck roles before publishing.", kind: "date", required: true },
  ],
  prose: [
    { key: "content", label: "Body", help: "Write freely: paragraphs, headings, links, and lists in one continuous editor.", kind: "richText", required: true },
  ],
  image: [
    { key: "assetId", label: "Image", help: "Choose an image from the media library.", kind: "asset", required: true },
    { key: "alt", label: "Alt text", help: "Describe the image for screen readers and when it cannot load.", kind: "text", required: false, recommended: true, requiredWhen: "assetId", requiredUnless: "altDecorative" },
    { key: "altDecorative", label: "Mark as decorative", help: "Turn this on for an image that carries no information, such as a background pattern. Leave the alt text empty.", kind: "toggle", required: false },
    { key: "caption", label: "Caption", help: "An optional caption shown under the image.", kind: "text", required: false },
    { key: "href", label: "Image link", help: "Optional. Where the image goes when clicked, such as the full video. Say where it goes in the alt text. A decorative image cannot have a link.", kind: "url", required: false, requiredUnless: "altDecorative", namedBy: ["alt", "caption"] },
    { key: "newTab", label: "Open link in a new tab", help: "Turn this on to open the link in a new browser tab.", kind: "toggle", required: false },
  ],
  video: [
    { key: "assetId", label: "Video", help: "Choose a video from the media library. Only videos with a ready viewing copy can be picked.", kind: "text", required: true },
    { key: "title", label: "Video title", help: "Names the video for screen readers. Readers do not see it on the page.", kind: "text", required: true, maxLength: 200 },
    { key: "caption", label: "Caption", help: "An optional caption shown under the video.", kind: "text", required: false, maxLength: 600 },
  ],
  image_gallery: [
    { key: "images", label: "Images", help: "Add images to the gallery, each with its own alt text.", kind: "list", required: true, maxItems: NESTED_MEDIA_COLLECTION_MAX, itemFields: IMAGE_ITEM_FIELDS },
  ],
  cta_row: [
    { key: "ctas", label: "Buttons", help: "Add one or more buttons, each with a label and a link.", kind: "list", required: true, itemFields: CTA_ITEM_FIELDS },
  ],
  support_appeal: [
    { key: "heading", label: "Heading", help: "A short invitation to support NJ PBS. Place this block at the end of the story.", kind: "text", required: true, maxLength: 120 },
    { key: "copy", label: "Appeal text", help: "Explain why readers should give. Separate paragraphs with a blank line.", kind: "text", multiline: true, required: true, maxLength: 2000 },
    { key: "buttonLabel", label: "Button text", help: "A short action such as Donate.", kind: "text", required: true, maxLength: 60 },
    { key: "href", label: "Button link", help: "The Support page or a secure donation link.", kind: "url", required: true, maxLength: 2000 },
    { key: "backgroundImageAssetId", label: "Decorative image", help: "Optional image from the media library. It fills the right third on wide screens and is hidden on phones. Keep all information in the text.", kind: "asset", required: false },
    { key: "style", label: "Style", help: "Choose a coordinated background, text and button palette with accessible contrast.", kind: "select", required: true,
      options: [{ value: "blue", label: "PBS blue" }, { value: "light", label: "Light (lavender)" }, { value: "dark", label: "Dark with teal accent" }] },
  ],
  card_grid: [
    { key: "cards", label: "Cards", help: "Add cards, each with a title and an optional image, text, and link.", kind: "list", required: true, maxItems: NESTED_MEDIA_COLLECTION_MAX, itemFields: CARD_ITEM_FIELDS },
  ],
  link_card: LINK_CARD_FIELDS,
  document_list: [{ key: "documents", label: "PDF notices", help: "Upload PDFs and give each a readable title. Newest additions appear first.", kind: "list", required: false, maxItems: 100,
    itemFields: [
      { key: "title", label: "Notice title", help: "A readable title for this PDF.", kind: "text", required: true, maxLength: 300 },
      { key: "assetId", label: "PDF", help: "Choose a PDF from the media library.", kind: "asset", required: true },
    ] }],
  faq_item: [
    { key: "question", label: "Question", help: "The question a viewer would ask.", kind: "text", required: true },
    { key: "answer", label: "Answer", help: "The answer, in the same continuous editor as other prose.", kind: "richText", required: true },
  ],
  coverage_list: [
    {
      key: "entries",
      label: "Articles",
      help: "Add, edit, reorder, or remove each outside article. Put newer items first, or keep the current order.",
      kind: "list",
      required: true,
      minItems: 1,
      maxItems: COVERAGE_LIST_LIMITS.entries,
      itemFields: COVERAGE_ITEM_FIELDS,
    },
  ],
  data_hub_section: [
    { key: "sectionId", label: "Compiled section", help: "Choose a reviewed Data Hub section. Values, sources and dates stay compiled.", kind: "select", required: true, options: Object.entries(DATA_HUB_SECTIONS).map(([value, label]) => ({ value, label })) },
    { key: "heading", label: "Heading", help: "Leave blank to use the reviewed heading.", kind: "text", required: false, maxLength: 300 },
    { key: "introduction", label: "Introduction", help: "Leave blank to use the reviewed introduction.", kind: "text", multiline: true, required: false, maxLength: 4000 },
  ],
  data_figure: [
    { key: "datasetId", label: "Data figure", help: "Choose an approved shared dataset.", kind: "text", required: true, maxLength: 128 },
    { key: "display", label: "Display", help: "Show the chart or keep it in a disclosure.", kind: "select", required: true, options: [{ value: "compact", label: "Compact" }, { value: "expanded", label: "Expanded" }] },
  ],
  town_lookup: [
    { key: "heading", label: "Heading", help: "Name the town lookup section.", kind: "text", required: true, maxLength: 200 },
    { key: "introduction", label: "Introduction", help: "Introduce the past results readers can find.", kind: "text", multiline: true, required: false, maxLength: 4000 },
    { key: "sourceLine", label: "Source line", help: "Add context about the sources. Election source links always appear with the figures.", kind: "text", multiline: true, required: false, maxLength: 500 },
  ],
  election_results: [],
  county_comparison: [
    { key: "heading", label: "Heading", help: "Leave blank to use the reviewed heading.", kind: "text", required: false, maxLength: 300 },
    { key: "intro", label: "Introduction", help: "Leave blank to use the reviewed introduction.", kind: "text", multiline: true, required: false, maxLength: 4000 },
    { key: "source", label: "Source line", help: "Leave blank to use the reviewed source credit. Official source links always appear.", kind: "text", multiline: true, required: false, maxLength: 1000 },
  ],
  data_table: [
    { key: "title", label: "Table title", help: "Name what the data shows.", kind: "text", required: true },
    { key: "csv", label: "CSV data", help: "Paste a header row and 1–100 data rows, with at most 12 columns.", kind: "text", required: true },
    { key: "source", label: "Data source", help: "Name the source and date of the data.", kind: "text", required: false },
    { key: "sourceHref", label: "Source link", help: "An optional link to the source.", kind: "url", required: false },
  ],
  embed: [
    { key: "url", label: "Video or embed link", help: "Paste a video player link or iframe code, or an AP published results layout link. AP results use a direct embed; put the link here instead of in Custom HTML. X/Twitter videos show as cards. Other links show as links.", kind: "url", required: true },
    { key: "caption", label: "Caption", help: "Optional text below an AP map, or a heading above a video player. Enter LIVE to add a red live light to a video player.", kind: "text", required: false },
    { key: "width", label: "Player width", help: "Optional width in pixels. Video players stay responsive on smaller screens. AP results always use the available width; leave this blank for AP.", kind: "number", required: false, ...EMBED_WIDTH_LIMITS, aspectRatioWith: "height", minAspectRatio: EMBED_ASPECT_RATIO_LIMITS.min, maxAspectRatio: EMBED_ASPECT_RATIO_LIMITS.max },
    { key: "height", label: "Player height", help: "Optional video height in pixels. Video players use the pasted ratio or provider default when both size fields are blank. AP layouts have separate map size and mobile height controls.", kind: "number", required: false, ...EMBED_HEIGHT_LIMITS },
  ],
  html: [
    { key: "html", label: "HTML", help: "Paste HTML, CSS, and scripts. They run in a sealed frame that cannot change the rest of the page.", kind: "text", multiline: true, required: true, maxLength: 50_000 },
    { key: "title", label: "Frame title", help: "Describe the content for screen reader users, such as \"Election results map\".", kind: "text", required: false, maxLength: 200 },
  ],
  content_shelf: CONTENT_SHELF_FIELDS,
  promotion_playlist: PROMOTION_PLAYLIST_FIELDS,
  topic_shelf: TOPIC_SHELF_FIELDS,
  video_playlist: VIDEO_PLAYLIST_FIELDS,
  record_card: [
    { key: "recordKind", label: "Record type", help: "Choose the kind of record.", kind: "text", required: true },
    { key: "recordId", label: "Record", help: "Choose a saved record.", kind: "text", required: true },
  ],
  sponsor_strip: [
    { key: "heading", label: "Heading", help: "An optional heading above the sponsors.", kind: "text", required: false, maxLength: 120 },
    { key: "sponsorIds", label: "Sponsors", help: "Choose one to 12 sponsors and arrange their order.", kind: "list", required: true, minItems: 1, maxItems: 12 },
    { key: "layout", label: "Layout", help: "Show logos in one row or a wrapping grid.", kind: "select", required: true, options: [{ value: "row", label: "Row" }, { value: "grid", label: "Grid" }] },
  ],
  // Row split controls belong to the layout surface, not a payload text field.
  row: [],
  divider: [],
};

// Copy a field the caller owns, deeply enough that editing the returned list -- or a
// list field's `itemFields` -- never mutates the frozen catalog the descriptors come
// from. `itemFields` is copied recursively for the same reason `allowedBlocksForSection`
// hands back a fresh array: the descriptor tables are the single source of truth.
function cloneField(f: EditorField): EditorField {
  const path = f.path ? [...f.path] : undefined;
  const options = f.options?.map((option) => ({ ...option }));
  return f.itemFields
    ? { ...f, path, options, itemFields: f.itemFields.map(cloneField) }
    : { ...f, path, options };
}

export function editorFieldsForBlock(type: BlockType): EditorField[] {
  // Widen to the shared descriptor shape before mapping: indexing the mapped table
  // with a `BlockType` union yields a union of per-block arrays, and every member is
  // an `EditorField` list, but `.map` needs the one settled element type.
  const fields: readonly EditorField[] = BLOCK_FIELDS[type];
  return fields.map(cloneField);
}

/** Extra controls for the AP URL branch of the existing Embed plank. */
export function apResultsEditorFields(): EditorField[] {
  return [
    { key: "heading", label: "Map heading", help: "An optional heading above the map. Leave blank for New Jersey election results.", kind: "text", required: false },
    { key: "mapSize", label: "Map size", help: "Fallback height before AP reports its size: Small 600, Medium 900, or Large 1200 pixels. AP then fits the frame to its content. Longer layouts scroll inside the fallback frame only if AP does not report a height.", kind: "select", required: false, options: [{ value: "small", label: "Small" }, { value: "medium", label: "Medium" }, { value: "large", label: "Large" }] },
    { key: "mobileHeight", label: "Mobile height", help: "Optional fallback height in pixels on screens up to 640 pixels wide, until AP reports its size. Leave blank to use Map size.", kind: "number", required: false, ...AP_MAP_MOBILE_HEIGHT_LIMITS },
    { key: "mapWidth", label: "Map width", help: "Content fits the reading column. Wide fills the available page span.", kind: "select", required: false, options: [{ value: "content", label: "Content" }, { value: "wide", label: "Wide" }] },
  ];
}

// The typed record collections represented by the shared form contract. Generic
// Staff records remain here only so stored legacy rows and server parity can be
// read safely; active routing and every write boundary retire them below.
// long-form record carries one continuous rich-text body, so a paragraph is never
// fragmented and typing a long story does not lag (issue #201). `program` is
// included per issue #392 gap 1, so routine show metadata edits need no developer.
//
// Article has no contract. Staff retains a legacy read descriptor, but is also in
// RETIRED_RECORD_KINDS: callers must exclude retired kinds before offering a route
// or mutation. New staff identities live only in cmsAuthorProfiles (#1227).
export type RecordKind =
  | "program"
  | "staff"
  | "event"
  | "sponsor"
  | "newsletter"
  | "post";

export type EditorDocumentKind = "page" | RecordKind;

// Kinds that existed in a shipped model and may still be stored, but that no
// boundary accepts a write for. Staff remains a RecordKind only for legacy shape
// compatibility; active route vocabularies exclude every member of this list.
export const RETIRED_RECORD_KINDS = ["article", "staff"] as const;

export type RetiredRecordKind = (typeof RETIRED_RECORD_KINDS)[number];

/** A stored kind that predates a retirement decision (Article, issue #1039). */
export function isRetiredRecordKind(value: string): value is RetiredRecordKind {
  return (RETIRED_RECORD_KINDS as readonly string[]).includes(value);
}

const RETIRED_RECORD_LABELS: Record<RetiredRecordKind, string> = {
  article: "Article (retired)",
  staff: "Staff record (retired — use Staff profiles)",
};

/**
 * The staff-facing name for a stored record of a retired kind. The label says the
 * kind is retired so an editor who finds one knows why it opens nowhere, rather
 * than reading it as a type they could make another of.
 */
export function retiredRecordLabel(kind: RetiredRecordKind): string {
  return RETIRED_RECORD_LABELS[kind];
}

const CONTENT_LINK_FIELDS: readonly EditorField[] = [
  { key: "contentLinkMode", label: "Point this content to", help: "Choose where readers go when they click this item. Publish to apply the change. Your body stays saved.", kind: "select", required: false, options: [{ value: "normal", label: "Its normal NJ PBS address" }, { value: "custom", label: "A custom URL" }] },
  { key: "contentLinkUrl", label: "Custom URL", help: "Use a full https:// address without a username or password. Up to 2,048 characters.", kind: "url", required: false, requireHttps: true, maxLength: 2048 },
  { key: "contentLinkNewTab", label: "Open in a new tab", help: "Readers keep their place on NJ PBS.", kind: "toggle", required: false },
];
const CONTENT_LINK_GROUP: EditorFieldGroup = { id: "content-link", label: "Content link", help: "Send readers to another website while keeping this content.", fields: CONTENT_LINK_FIELDS };

const PAGE_BASIC_FIELDS: readonly RecordFieldFor<PageMetadata>[] = [
  { key: "title", label: "Page title", help: "Used for the Page heading, browser tab and shared links. NJ Decides shows the logo as its visible heading.", kind: "text", required: true },
  { key: "description", label: "Page summary", help: "This summary appears with the page.", kind: "text", required: false },
  { key: "pageTheme", label: "Page theme", help: "Use the shared election heading. Rows and planks stay in their saved order.", kind: "select", required: false, options: [{ value: "default", label: "NJ PBS default" }, { value: "nj-decides", label: "NJ Decides 2026" }] },
  { key: "slug", label: "URL slug", help: "The part after njpbs.org/. Use lowercase letters, numbers and hyphens. A URL change takes effect when you publish; old links redirect to the new address.", kind: "text", required: false },
];

const SEARCH_FIELDS: readonly RecordFieldFor<SearchMetadata>[] = [
  { key: "title", path: ["seo"], label: "Search title", help: "Leave this blank to use the page or post title.", kind: "text", required: false },
  { key: "description", path: ["seo"], label: "Search description", help: "Optional search-only override. Leave blank to use the page summary or a Post's summary, then Excerpt.", kind: "text", required: false },
  { key: "noindex", path: ["seo"], label: "Hide from search engines", help: "Ask search engines not to index this page or post.", kind: "toggle", required: false },
];

const SOCIAL_FIELDS: readonly RecordFieldFor<SocialMetadata>[] = [
  { key: "title", path: ["social"], label: "Social title", help: "This title appears when people share the link.", kind: "text", required: false },
  { key: "description", path: ["social"], label: "Social description", help: "Optional shared-link override. Leave blank to use the page summary or a Post's summary, then Excerpt.", kind: "text", required: false },
  { key: "imageAssetId", path: ["social"], label: "Social image", help: "Choose the image used in social link cards.", kind: "asset", required: false },
];

// Posts expose their title fallbacks as live post title inheritance in the form (#1399),
// so their copy describes the deliberate override rather than an unexplained blank.
// Pages keep the shared copy above because their editor still presents optional values.
const POST_SEARCH_FIELDS: readonly RecordFieldFor<SearchMetadata>[] = SEARCH_FIELDS.map(
  (field) =>
    field.key === "title"
      ? {
          ...field,
          help: "Uses the post title by default. Customize only when a search result needs different wording.",
        }
      : field,
);

const POST_SOCIAL_FIELDS: readonly RecordFieldFor<SocialMetadata>[] = SOCIAL_FIELDS.map(
  (field) =>
    field.key === "title"
      ? {
          ...field,
          help: "Uses the post title by default. Customize only when a shared link needs different wording.",
        }
      : field,
);

const POST_BASIC_FIELDS: readonly RecordFieldFor<PostRecord>[] = [
  { key: "title", label: "Post title", help: "The title people see on the post and in listings.", kind: "text", required: true },
  { key: "summary", label: "Summary", help: "Optional text below the title. Also used in listings, search, and social sharing.", kind: "text", required: false },
];

const POST_EXCERPT_FIELDS: readonly RecordFieldFor<PostRecord>[] = [
  { key: "excerpt", label: "Excerpt", help: "Optional fallback for listing cards and default Search and Social descriptions when summary is empty. It does not appear beneath the post title.", kind: "text", required: false },
];

// The dates a story carries, separated per issue #1041. `date` is no longer a
// required field an editor fills in to save a draft: doing that made the day
// somebody started writing the day the post claimed to have published. It is now
// the deliberate override, blank by default, and the server derives the displayed
// date from the moment publication actually completed. The two update fields are a
// decision an editor makes, not a side effect of saving: an ordinary save and a typo
// fix leave them alone.
//
// When the post goes live is deliberately not a field here. Scheduling is a lifecycle
// action taken on an approved record: the save boundary accepts a publication time
// only as a request-level `scheduleAt` over an empty document overlay, and the
// lifecycle panel collects it at that moment. A `publishAt` typed into this form
// would persist an inert value on the draft and schedule nothing, promising the
// editor something no part of the pipeline honours.
const POST_DATE_FIELDS: readonly RecordFieldFor<PostRecord>[] = [
  { key: "date", label: "Editorial date shown with the post", help: "Leave blank to use the date the post first published. Set a date only to run an older story under the day it originally appeared.", kind: "date", required: false },
  { key: "recordMeaningfulUpdate", label: "Record a meaningful update", help: "Turn this on when this save changes the substance of the story. Leave it off for a typo or a small fix. It turns itself back off once the update is recorded.", kind: "toggle", required: false },
  { key: "showUpdatedDate", label: "Show the update date on the post", help: "Turn this on to show readers when the story was last meaningfully updated.", kind: "toggle", required: false },
];

const POST_ORGANIZATION_FIELDS: readonly RecordFieldFor<PostRecord>[] = [
  { key: "coverageLabelId", label: "Coverage label", help: "Choose a published series or special coverage label. Save and publish to update it on the public site.", kind: "text", required: false },
  { key: "showInHomeHero", label: "Show in Home hero", help: "Includes this Post when Home selects by tags. Keeps the current order and limit.", kind: "toggle", required: false },
  { key: "spotlightNews", label: "Spotlight News", help: "Show NJ Spotlight News above this headline and on post listings. Leave off for other posts. Save and publish to update the public label.", kind: "toggle", required: false },
  { key: "slug", label: "URL slug", help: "The part after njpbs.org/posts/. Leave blank for a new draft to use its title. Use lowercase letters, numbers and hyphens. Publish a URL change to redirect old links.", kind: "text", required: false },
  // One free-text name became an ordered credit list in #1040: a story can have
  // two reporters, a staff credit, and a guest contributor, and the order is
  // editorial meaning. A registered credit stores the person, not the spelling of
  // their name, so a rename fixes every draft at once.
  { key: "credits", label: "Byline", help: "Credit the people who made this. Add staff by name, or add a custom credit such as NJ PBS staff.", kind: "storyCredits", required: false },
  { key: "categories", label: "Categories", help: "Add public topics that help readers find related posts. The first category is the main topic shown above the headline.", kind: "list", required: false },
  { key: "tags", label: "Tags", help: "Add topics that group this post with related work. The first tag appears beside the main category above the headline.", kind: "list", required: false },
];

const HERO_BACKGROUND_FIELDS: readonly EditorField[] = [
  { key: "heroBackgroundImage", label: "Hero background image", help: "Choose a decorative image behind the heading. Keep important information in the page text. Remove the image to restore the default background.", kind: "asset", required: false },
  { key: "heroBackgroundPosition", label: "Background crop position", help: "Choose which part of the image stays visible when it fills the hero.", kind: "select", required: false, options: [
    { value: "center", label: "Center" },
    { value: "top", label: "Top" },
    { value: "bottom", label: "Bottom" },
  ] },
];

const POST_HERO_IMAGE_FIELDS: readonly EditorField[] = [
  ...HERO_BACKGROUND_FIELDS,
  { key: "heroImage", label: "Lead image", help: "The image shown at the top and in listings.", kind: "asset", required: false },
  { key: "heroImageAlt", label: "Lead image alt text", help: "Describe what this image adds in this post.", kind: "text", required: false, recommended: true, requiredWhen: "heroImage", requiredUnless: "heroImageDecorative" },
  { key: "heroImageDecorative", label: "Mark lead image as decorative", help: "Turn this on only when the image adds no information. Leave the alt text empty.", kind: "toggle", required: false },
  { key: "heroImageCaption", label: "Lead image caption", help: "Add a description or photo credit beneath the lead image. This optional caption is separate from alt text.", kind: "text", multiline: true, required: false },
];

// Each record kind's fields are typed against its content-model record, so every
// `key` is checked to name a real field at compile time (see `RecordFieldFor`).
const RECORD_FIELDS: {
  program: readonly RecordFieldFor<ProgramRecord>[];
  staff: readonly RecordFieldFor<StaffRecord>[];
  event: readonly RecordFieldFor<EventRecord>[];
  sponsor: readonly RecordFieldFor<SponsorRecord>[];
  newsletter: readonly RecordFieldFor<NewsletterRecord>[];
  post: readonly EditorField[];
} = {
  program: [
    { key: "title", label: "Title", help: "The program or show name.", kind: "text", required: true },
    { key: "genre", label: "Genre", help: "The kind of program, for example news or nature.", kind: "text", required: false },
    { key: "description", label: "Synopsis", help: "A short description of the program, in one continuous editor.", kind: "richText", required: true },
    { key: "slug", label: "URL slug", help: "The part after njpbs.org/programs/. Leave blank for a new program to use its title. Publish a URL change to redirect old links.", kind: "text", required: false },
    { key: "keyArtAssetId", label: "Key art", help: "Choose an image from the media library.", kind: "asset", required: false },
    { key: "keyArtAlt", label: "Key art alt text", help: "Describe what the image adds to this program.", kind: "text", required: false, recommended: true, requiredWhen: "keyArtAssetId", requiredUnless: "keyArtDecorative" },
    { key: "keyArtDecorative", label: "Mark key art as decorative", help: "Use only when the image adds no information. Leave the alt text empty.", kind: "toggle", required: false },
    { key: "watchUrl", label: "Watch URL", help: "Link to this program on watch.njpbs.org.", kind: "url", required: false },
    { key: "memberOnly", label: "Members only", help: "Turn on if this program is for Passport members.", kind: "toggle", required: false },
  ],
  staff: [
    { key: "name", label: "Name", help: "The staff member's full name.", kind: "text", required: true },
    { key: "role", label: "Role", help: "Their title or role at NJ PBS.", kind: "text", required: true },
    { key: "bio", label: "Bio", help: "A short biography, written in one continuous editor.", kind: "richText", required: true },
  ],
  event: [
    { key: "title", label: "Title", help: "The event name.", kind: "text", required: true },
    { key: "slug", label: "URL slug", help: "The part after njpbs.org/events/. Leave blank on a new record to use its title. Published URL changes redirect old links.", kind: "text", required: false },
    { key: "startsAt", label: "Starts", help: "When the event begins, in New Jersey time.", kind: "datetime", required: true },
    { key: "endsAt", label: "Ends", help: "When the event ends, in New Jersey time, if it has a set end.", kind: "datetime", required: false },
    { key: "location", label: "Location", help: "Where the event takes place.", kind: "text", required: false },
    { key: "venueAddress", label: "Venue address", help: "Optional street address for an in-person event.", kind: "text", required: false },
    { key: "onlineUrl", label: "Online event URL", help: "Optional HTTPS link for joining online.", kind: "url", required: false },
    { key: "imageAssetId", label: "Event image", help: "Choose an image from the media library.", kind: "asset", required: false },
    { key: "imageAlt", label: "Event image alt text", help: "Describe what the image adds.", kind: "text", required: false, recommended: true, requiredWhen: "imageAssetId", requiredUnless: "imageDecorative" },
    { key: "imageDecorative", label: "Mark event image as decorative", help: "Use only when the image adds no information. Leave alt text empty.", kind: "toggle", required: false },
    { key: "registrationUrl", label: "Registration URL", help: "Use an HTTPS registration or ticket link.", kind: "url", required: false },
    { key: "registrationLabel", label: "Registration button label", help: "Defaults to Register.", kind: "text", required: false },
    { key: "isFree", label: "Free event", help: "Show this event as free.", kind: "toggle", required: false },
    { key: "priceText", label: "Price", help: "Optional ticket price or admission details.", kind: "text", required: false },
    { key: "description", label: "Details", help: "What to expect, in one continuous editor.", kind: "richText", required: true },
  ],
  sponsor: [
    { key: "name", label: "Name", help: "The sponsor's name, as it should appear on air and on the site.", kind: "text", required: true },
    { key: "href", label: "Website", help: "The sponsor's link.", kind: "url", required: true },
    { key: "logoAssetId", label: "Logo", help: "The sponsor's logo, shown with the on-air and on-site acknowledgment.", kind: "asset", required: false },
    { key: "logoAlt", label: "Logo alt text", help: "Name or describe the logo for this placement.", kind: "text", required: false, recommended: true, requiredWhen: "logoAssetId", requiredUnless: "logoDecorative" },
    { key: "logoDecorative", label: "Mark logo as decorative", help: "Use only when the visible sponsor name is beside the logo. Leave the alt text empty.", kind: "toggle", required: false },
    { key: "tier", label: "Tier", help: "A short label, such as Presenting sponsor.", kind: "text", required: false, maxLength: 80 },
    { key: "description", label: "Description", help: "A short plain-text description, up to 280 characters.", kind: "text", multiline: true, required: false, maxLength: 280 },
    { key: "activeFrom", label: "Active from", help: "The first day this sponsor may appear on the site.", kind: "date", required: false },
    { key: "activeUntil", label: "Active until", help: "The last day this sponsor may appear on the site.", kind: "date", required: false },
  ],
  newsletter: [
    { key: "title", label: "Name", help: "The newsletter's name, as a reader sees it.", kind: "text", required: true },
    { key: "summary", label: "Summary", help: "A short plain-text description shown in signup cards.", kind: "text", required: false, maxLength: 300 },
    { key: "frequency", label: "Frequency", help: "How often readers can expect it, for example Weekly.", kind: "text", required: false, maxLength: 60 },
    { key: "signupUrl", label: "Signup link", help: "A secure provider signup page. A newsletter without this link stays out of signup blocks.", kind: "url", required: false },
    { key: "imageAssetId", label: "Image", help: "Optional image from the media library.", kind: "asset", required: false },
    { key: "imageAlt", label: "Image alt text", help: "Describe the image unless it adds no information beside the newsletter title.", kind: "text", required: false, recommended: true, requiredWhen: "imageAssetId", requiredUnless: "imageDecorative" },
    { key: "imageDecorative", label: "Mark image as decorative", help: "Use when the visible newsletter title conveys the same information. Leave alt text empty.", kind: "toggle", required: false },
    { key: "body", label: "Description", help: "What the newsletter is and what a subscriber gets, in one continuous editor.", kind: "richText", required: true },
  ],
  post: [
    ...POST_BASIC_FIELDS,
    ...CONTENT_LINK_FIELDS,
    ...POST_EXCERPT_FIELDS,
    ...POST_DATE_FIELDS,
    ...POST_ORGANIZATION_FIELDS,
    ...POST_HERO_IMAGE_FIELDS,
    ...POST_SEARCH_FIELDS,
    ...POST_SOCIAL_FIELDS,
  ],
};

const PAGE_FIELD_GROUPS: readonly EditorFieldGroup[] = [
  CONTENT_LINK_GROUP,
  {
    id: "hero-image",
    label: "Hero background",
    help: "Choose the image behind the page heading.",
    fields: HERO_BACKGROUND_FIELDS,
  },
  {
    id: "basics",
    label: "Basics",
    help: "Edit the page title and summary.",
    fields: PAGE_BASIC_FIELDS,
  },
  {
    id: "search",
    label: "Search",
    help: "Search results use the page title and summary by default.",
    fields: SEARCH_FIELDS,
  },
  {
    id: "social",
    label: "Social sharing",
    help: "Shared links use the page title and summary by default.",
    fields: SOCIAL_FIELDS,
  },
];

const POST_FIELD_GROUPS: readonly EditorFieldGroup[] = [
  CONTENT_LINK_GROUP,
  {
    id: "basics",
    label: "Basics",
    help: "Write the post title and optional summary.",
    fields: POST_BASIC_FIELDS,
  },
  {
    id: "excerpt",
    label: "Listing fallback",
    help: "Use Excerpt only when this Post has no summary.",
    fields: POST_EXCERPT_FIELDS,
  },
  {
    id: "dates",
    label: "Dates",
    help: "Decide which dates readers see with this post.",
    fields: POST_DATE_FIELDS,
  },
  {
    id: "organization",
    label: "Metadata",
    help: "Set the byline, categories, and tags.",
    fields: POST_ORGANIZATION_FIELDS,
  },
  {
    id: "hero-image",
    label: "Hero image",
    help: "Set the image shown at the top of the post and in listings.",
    fields: POST_HERO_IMAGE_FIELDS,
  },
  {
    id: "search",
    label: "Search",
    help: "Search results use the post title and summary, then Excerpt, by default.",
    fields: POST_SEARCH_FIELDS,
  },
  {
    id: "social",
    label: "Social sharing",
    help: "Shared links use the post title and summary, then Excerpt, by default.",
    fields: POST_SOCIAL_FIELDS,
  },
];

function cloneGroup(group: EditorFieldGroup): EditorFieldGroup {
  return { ...group, fields: group.fields.map(cloneField) };
}

export function editorFieldGroupsFor(kind: EditorDocumentKind, pageId?: string): EditorFieldGroup[] {
  if (kind === "page") return [
    ...(pageId === "home" ? [{
      id: "home-hero" as const, label: "Home hero", help: "Edit the heading and subtitle at the top of Home.",
      fields: [
        { key: "homeHeroTitle", label: "Hero heading", help: "The large heading above the watch buttons.", kind: "text" as const, required: true },
        { key: "homeHeroSubtitle", label: "Hero subtitle", help: "The introduction below the hero heading.", kind: "text" as const, multiline: true, required: true },
      ],
    }] : []),
    ...PAGE_FIELD_GROUPS.map(group => {
      if (["home", "contact", "data-hub", "staff", "schedule"].includes(pageId ?? "")) {
        group = { ...group, fields: group.fields.filter(field => field.key !== "pageTheme") };
      }
      if (pageId === "data-hub" && group.id === "basics") return { ...group,
        help: "Edit the Page title and summary for browser and link metadata. Edit the visible opening text in the Page introduction section.",
        fields: group.fields.map(field => field.key === "title"
          ? { ...field, help: "The browser and link title. Edit the visible heading in the Page introduction section." }
          : field.key === "description"
            ? { ...field, help: "The browser and link summary. Edit the visible opening text in the Page introduction section." }
            : field) };
      if (pageId === "home") {
        return { ...group, fields: group.fields.filter(field => field.key !== "slug") };
      }
      if (pageId !== "staff") return group;
      if (group.id === "hero-image") {
        return { ...group, help: "Choose the image behind the Staff heading." };
      }
      if (group.id !== "basics") return group;
      return {
        ...group,
        help: "Edit the Staff hero heading and summary.",
        fields: group.fields.map(field => field.key === "title"
          ? { ...field, label: "Staff hero title", help: "The heading at the top of the public Staff page." }
          : field.key === "description"
            ? { ...field, label: "Staff hero summary", help: "The introduction under the Staff heading." }
            : field),
      };
    }),
  ].map(cloneGroup);
  if (kind === "post") return POST_FIELD_GROUPS.map(cloneGroup);
  return [
    {
      id: "details",
      label: "Details",
      help: "The editable fields for this record.",
      fields: RECORD_FIELDS[kind].map(cloneField),
    },
  ];
}

// ---------------------------------------------------------------------------
// The create-time content section control (#845)
// ---------------------------------------------------------------------------

// The record create form asks which editorial desk the record belongs to, because a
// record's desk is fixed by the write that creates it and section-scoped grants are
// decided against it. This is the desk in `content-sections.ts`, NOT the page-builder
// `SectionId` above: the two share a word and nothing else.
//
// It is a descriptor rather than a member of `RECORD_FIELDS` on purpose. The desk is a
// server-managed field: it rides the save request's envelope, is stripped out of the
// document overlay, and cannot be changed after the create. A form that rendered it
// beside the ordinary content fields would imply an editor can revise it later, and a
// binding into the document would be silently dropped by the write boundary.
export const CONTENT_SECTION_FIELD_KEY = "section";

/**
 * The finite section picker for a record create, built from the runtime registry the
 * caller read. The options are whatever is registered now, so a desk added to Firestore
 * appears without a redeploy; an empty or unusable registry falls back to the seeded
 * desks so the form still offers a valid choice rather than an empty required select.
 *
 * Required by design: the save boundary refuses a record create with no registered
 * section, so an optional control here would only move that refusal from an inline
 * message to a failed request.
 */
export function contentSectionField(
  sections: readonly { id: string; label: string }[] = [],
): EditorField {
  const usable = sections.filter(
    (section) =>
      typeof section?.id === "string" &&
      section.id !== "" &&
      typeof section.label === "string" &&
      section.label !== "",
  );
  const source = usable.length > 0 ? usable : SEEDED_CONTENT_SECTIONS;
  return {
    key: CONTENT_SECTION_FIELD_KEY,
    label: "Area",
    help: "Groups this content for staff. Existing area grants can limit access. It does not change the public URL, navigation, categories or tags.",
    kind: "select",
    required: true,
    options: source.map((section) => ({ value: section.id, label: section.label })),
  };
}

export function recordFieldsFor(kind: RecordKind): EditorField[] {
  return editorFieldGroupsFor(kind).flatMap((group) => group.fields.map(cloneField));
}

// The block types with no editor-facing content (a `divider` is pure structure). The
// "every content block has a required field" invariant exempts these.
export const CONTENT_FREE_BLOCKS: readonly BlockType[] = Object.freeze(
  BLOCK_TYPES.filter((t) => BLOCK_FIELDS[t].length === 0),
);
