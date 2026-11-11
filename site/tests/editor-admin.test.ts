import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SHELF_PIN_MAX } from "../../packages/content-core/src/dynamic-shelves";
import { BLOCK_TYPES, COVERAGE_LIST_LIMITS, type BlockType } from "../../packages/content-core/src/content-model";
import {
  allowedBlocksForSection,
  applyEditorOp,
  BLOCK_LABELS,
  canPlaceAnotherBlock,
  canPlaceBlock,
  CONTENT_FREE_BLOCKS,
  editorFieldGroupsFor,
  editorFieldsForBlock,
  isRetiredRecordKind,
  insertableBlocksForSection,
  recordFieldsFor,
  retiredRecordLabel,
  RETIRED_RECORD_KINDS,
  SECTION_BLOCK_CATALOG,
  SECTION_BLOCK_TOTAL_MAX,
  SECTION_LABELS,
  validateSection,
  type BlockFieldFor,
  type EditorBlock,
  type EditorField,
  type RecordKind,
  type SectionId,
} from "../../packages/content-core/src/editor-admin";

// A placed block carrying the full ADR 0013 envelope shape the shell threads
// through, so the tests prove the reducer preserves data, order, and visibility --
// not just id and type.
type PageBlock = EditorBlock & { order: number; visible: boolean; data: Record<string, unknown> };
const block = (id: string, type: BlockType, data: Record<string, unknown> = {}): PageBlock => ({
  id,
  type,
  order: 0,
  visible: true,
  data,
});

// A list with each block's `order` set to its position. `block()` stamps every block
// order 0, so a hand-built `start` is intentionally inconsistent; the reducer normalizes
// `order` to the array index on every op, so a round-trip restores identity and position
// with order reconciled -- this expresses that expected end state.
const seq = (blocks: PageBlock[]): PageBlock[] => blocks.map((b, i) => ({ ...b, order: i }));

const SECTIONS: SectionId[] = ["home", "programLanding", "genericPage", "post"];
const RECORD_KINDS: RecordKind[] = ["program", "event", "sponsor", "newsletter", "post"];

// Machine identifiers an editor must never see. The whole point of the descriptor
// layer is that a non-technical editor reads plain labels, never the data model, so
// no field label or help text may contain one of these. Keys may (they bind to the
// model on purpose); only label + help are scanned.
const MACHINE_TOKENS = [
  "assetid",
  "href",
  "slug",
  "richtext",
  "recordlist",
  "previousslugs",
  "publishat",
];

// A read-counting wrapper around a block list: every indexed read and every
// `length` read bumps the counter. A quadratic rescan of the list shows up as reads
// growing with n squared instead of n, so this pins the O(n) claim the sub-second
// budget rests on without a flaky wall-clock timer.
function countingReads<T>(items: T[]): { proxy: T[]; reads: () => number } {
  let reads = 0;
  const proxy = new Proxy(items, {
    get(target, prop, receiver) {
      if (prop === "length" || (typeof prop === "string" && /^\d+$/.test(prop))) {
        reads += 1;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { proxy, reads: () => reads };
}

describe("SECTION_BLOCK_CATALOG", () => {
  it("offers only real ADR 0013 block types in every template palette", () => {
    for (const section of SECTIONS) {
      for (const type of allowedBlocksForSection(section)) {
        expect(BLOCK_TYPES).toContain(type);
      }
    }
  });

  it("returns a fresh palette array so a caller cannot widen the shared catalog", () => {
    const palette = allowedBlocksForSection("genericPage");
    palette.push("image_gallery");
    expect(allowedBlocksForSection("genericPage")).not.toContain("image_gallery");
  });

  it("keeps legacy coverage lists valid without offering new ones", () => {
    expect(allowedBlocksForSection("genericPage")).toContain("coverage_list");
    expect(insertableBlocksForSection("genericPage")).not.toContain("coverage_list");
    expect(insertableBlocksForSection("genericPage")).toContain("link_card");
  });

  it("is frozen at the row level so a block cannot be pushed into a template", () => {
    expect(() => {
      // @ts-expect-error -- the point is that the runtime freeze rejects this
      SECTION_BLOCK_CATALOG.home.push("faq_item");
    }).toThrow();
  });

  it("gates placement per template", () => {
    // image_gallery is a home block, not a generic-page one.
    expect(canPlaceBlock("home", "image_gallery")).toBe(true);
    expect(canPlaceBlock("genericPage", "image_gallery")).toBe(false);
    // Row, prose, and divider are universal.
    for (const section of SECTIONS) {
      expect(canPlaceBlock(section, "row")).toBe(true);
      expect(canPlaceBlock(section, "prose")).toBe(true);
      expect(canPlaceBlock(section, "divider")).toBe(true);
    }
  });

  it("gives posts the restrained hybrid-body palette from #501, plus the related-story shelf and custom HTML", () => {
    expect(allowedBlocksForSection("post")).toEqual([
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
    ]);
    expect(canPlaceBlock("post", "headline")).toBe(false);
    expect(canPlaceBlock("post", "card_grid")).toBe(false);
    // A story takes related stories, not a queried row of videos (#1046).
    expect(canPlaceBlock("post", "video_playlist")).toBe(false);
  });

  it("offers the finite derived-content shelf only on Home", () => {
    expect(allowedBlocksForSection("home")).toEqual([
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
    ]);
    for (const section of ["programLanding", "genericPage", "post"] as const) {
      expect(canPlaceBlock(section, "content_shelf")).toBe(false);
      expect(canPlaceBlock(section, "promotion_playlist")).toBe(true);
    }
  });

  // The two dynamic blocks (#1046) are placed where their editorial job exists, and
  // nowhere else: a topic shelf belongs on the home page, a content page, and a story;
  // a playlist belongs on the home page, a content page, and a program landing page.
  it("places the dynamic shelves only where they have an editorial job", () => {
    expect(canPlaceBlock("home", "topic_shelf")).toBe(true);
    expect(canPlaceBlock("genericPage", "topic_shelf")).toBe(true);
    expect(canPlaceBlock("post", "topic_shelf")).toBe(true);
    expect(canPlaceBlock("programLanding", "topic_shelf")).toBe(false);

    expect(canPlaceBlock("home", "video_playlist")).toBe(true);
    expect(canPlaceBlock("genericPage", "video_playlist")).toBe(true);
    expect(canPlaceBlock("programLanding", "video_playlist")).toBe(true);
    expect(canPlaceBlock("post", "video_playlist")).toBe(false);
  });

  it("places a coverage list only on a content page", () => {
    expect(canPlaceBlock("genericPage", "coverage_list")).toBe(true);
    expect(canPlaceBlock("home", "coverage_list")).toBe(false);
    expect(canPlaceBlock("programLanding", "coverage_list")).toBe(false);
    expect(canPlaceBlock("post", "coverage_list")).toBe(false);
  });

  it("offers another coverage list only on a content page that still has room", () => {
    expect(canPlaceAnotherBlock("genericPage", [block("copy", "prose")], "coverage_list")).toBe(true);
    expect(canPlaceAnotherBlock("post", [block("copy", "prose")], "coverage_list")).toBe(false);
    expect(canPlaceAnotherBlock(
      "genericPage",
      seq([block("news", "coverage_list"), block("copy", "prose")]),
      "coverage_list",
    )).toBe(false);
  });
});

// The pin control's choices come from the committed shelf catalog, which is several
// kilobytes of story data. Reading it here would fuse it to the descriptor module, and the
// descriptor module is in the admin's entry chunk -- so the catalog would be downloaded by
// every signed-in editor before any route mounts, including the ones who never place a
// shelf. The choices are supplied by the block's own editing surface instead, which also
// lets them be filtered to the library the block actually points at.
describe("the dynamic shelf descriptors stay free of the catalog", () => {
  it("declares the pin field with a limit and no baked-in choices", () => {
    for (const type of ["topic_shelf", "video_playlist"] as const) {
      const pinned = editorFieldsForBlock(type).find((field) => field.key === "pinned");
      expect(pinned, `${type} has no pin field`).toBeDefined();
      expect(pinned?.kind).toBe("list");
      expect(pinned?.maxItems).toBe(SHELF_PIN_MAX);
      const choice = pinned?.itemFields?.[0];
      expect(choice?.kind).toBe("select");
      // Absent, not empty: an empty list would read as "no choice is valid".
      expect(choice?.options).toBeUndefined();
    }
  });

  it("names no story or video title in the descriptor module", () => {
    // Read from the workspace rather than through import.meta.url: this suite runs in a
    // jsdom environment where that is not a file URL.
    const source = readFileSync(
      join(process.cwd(), "../packages/content-core/src/editor-admin.ts"),
      "utf8",
    );
    expect(source).not.toContain("shelf-catalog");
    expect(source).not.toContain("RELATED_STORY_INDEX");
    expect(source).not.toContain("APPROVED_VIDEO_LIBRARY");
  });
});

describe("labels", () => {
  it("names every block type in plain words", () => {
    for (const type of BLOCK_TYPES) {
      expect(BLOCK_LABELS[type]).toBeTruthy();
      // A label is editor-facing, so it must never carry the snake_case machine
      // form (an underscore is the tell): image_gallery reads as "image gallery".
      expect(BLOCK_LABELS[type]).not.toContain("_");
    }
  });

  it("names every template in plain words", () => {
    for (const section of SECTIONS) {
      expect(SECTION_LABELS[section]).toBeTruthy();
      expect(SECTION_LABELS[section]).not.toBe(section);
    }
  });
});

describe("applyEditorOp insert", () => {
  it("inserts a block at the requested index and returns a new list", () => {
    const start = [block("a", "prose"), block("b", "divider")];
    const result = applyEditorOp("home", start, { kind: "insert", block: block("c", "headline"), index: 1 });
    if ("error" in result) throw new Error(result.error.reason);
    expect(result.blocks.map((b) => b.id)).toEqual(["a", "c", "b"]);
    // The input is never mutated, so a rejected op leaves the editor untouched.
    expect(start.map((b) => b.id)).toEqual(["a", "b"]);
  });

  it("preserves the whole inserted block, not just id and type", () => {
    const rich = block("c", "prose", { content: { type: "doc", content: [] } });
    const result = applyEditorOp("home", [], { kind: "insert", block: rich, index: 0 });
    if ("error" in result) throw new Error(result.error.reason);
    expect(result.blocks[0]).toEqual(rich);
  });

  it("clamps an out-of-range index to the ends of the list", () => {
    const start = [block("a", "prose")];
    const high = applyEditorOp("home", start, { kind: "insert", block: block("b", "divider"), index: 99 });
    const low = applyEditorOp("home", start, { kind: "insert", block: block("c", "divider"), index: -5 });
    if ("error" in high || "error" in low) throw new Error("clamped insert should succeed");
    expect(high.blocks.map((b) => b.id)).toEqual(["a", "b"]);
    expect(low.blocks.map((b) => b.id)).toEqual(["c", "a"]);
  });

  it("rejects a block the template does not allow, in plain words", () => {
    const result = applyEditorOp("genericPage", [], { kind: "insert", block: block("g", "image_gallery"), index: 0 });
    if (!("error" in result)) throw new Error("off-catalog insert should be rejected");
    expect(result.error.op).toBe("insert");
    // The one editor-facing message must not leak the machine identifiers.
    expect(result.error.reason).not.toContain("image_gallery");
    expect(result.error.reason).not.toContain("genericPage");
    expect(result.error.reason).toContain(BLOCK_LABELS.image_gallery);
  });

  it("rejects an insert that would exceed the block's per-template cap", () => {
    // home allows at most one headline.
    const start = [block("h1", "headline")];
    const result = applyEditorOp("home", start, { kind: "insert", block: block("h2", "headline"), index: 1 });
    if (!("error" in result)) throw new Error("over-cap insert should be rejected");
    expect(result.error.op).toBe("insert");
    expect(result.error.reason).toContain(BLOCK_LABELS.headline);
    expect(result.error.reason).not.toContain("headline\"");
  });

  it("allows the optional published Post shelf and caps Home at four derived shelves", () => {
    const start = [
      block("s1", "content_shelf"),
      block("s2", "content_shelf"),
      block("s3", "content_shelf"),
    ];
    const fourth = applyEditorOp("home", start, {
      kind: "insert",
      block: block("s4", "content_shelf"),
      index: 3,
    });
    if ("error" in fourth) throw new Error("the optional Post shelf should fit");
    expect(fourth.blocks).toHaveLength(4);
    const result = applyEditorOp("home", fourth.blocks, { kind: "insert", block: block("s5", "content_shelf"), index: 4 });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error.reason).toContain("content shelf");
  });

  it("rejects a colliding id with an id-free message and the id in detail", () => {
    const start = [block("dup", "prose")];
    const result = applyEditorOp("home", start, { kind: "insert", block: block("dup", "divider"), index: 1 });
    if (!("error" in result)) throw new Error("duplicate-id insert should be rejected");
    expect(result.error.reason).not.toContain("dup");
    expect(result.error.detail).toContain("dup");
  });

  it("returns the inverse remove op for undo", () => {
    const result = applyEditorOp("home", [], { kind: "insert", block: block("c", "headline"), index: 0 });
    if ("error" in result) throw new Error(result.error.reason);
    expect(result.inverse).toEqual({ kind: "remove", id: "c" });
  });
});

describe("applyEditorOp remove", () => {
  it("removes the addressed block by id", () => {
    const start = [block("a", "prose"), block("b", "divider"), block("c", "headline")];
    const result = applyEditorOp("home", start, { kind: "remove", id: "b" });
    if ("error" in result) throw new Error(result.error.reason);
    expect(result.blocks.map((b) => b.id)).toEqual(["a", "c"]);
  });

  it("rejects an unknown id with an id-free message and the id in detail", () => {
    const result = applyEditorOp("home", [block("a", "prose")], { kind: "remove", id: "ghost" });
    if (!("error" in result)) throw new Error("removing a missing block should be rejected");
    expect(result.error.op).toBe("remove");
    expect(result.error.reason).not.toContain("ghost");
    expect(result.error.detail).toContain("ghost");
  });

  it("returns an inverse insert carrying the exact removed block at its index", () => {
    const removed = block("b", "divider", { note: "keep me" });
    const start = [block("a", "prose"), removed, block("c", "headline")];
    const result = applyEditorOp("home", start, { kind: "remove", id: "b" });
    if ("error" in result) throw new Error(result.error.reason);
    expect(result.inverse).toEqual({ kind: "insert", block: removed, index: 1 });
  });
});

describe("applyEditorOp move", () => {
  it("moves the addressed block to the target index", () => {
    const start = [block("a", "prose"), block("b", "divider"), block("c", "headline")];
    const result = applyEditorOp("home", start, { kind: "move", id: "a", toIndex: 2 });
    if ("error" in result) throw new Error(result.error.reason);
    expect(result.blocks.map((b) => b.id)).toEqual(["b", "c", "a"]);
  });

  it("rejects moving an unknown id", () => {
    const result = applyEditorOp("home", [block("a", "prose")], { kind: "move", id: "ghost", toIndex: 0 });
    if (!("error" in result)) throw new Error("moving a missing block should be rejected");
    expect(result.error.op).toBe("move");
    expect(result.error.detail).toContain("ghost");
  });

  it("returns an inverse move back to the original index", () => {
    const start = [block("a", "prose"), block("b", "divider"), block("c", "headline")];
    const result = applyEditorOp("home", start, { kind: "move", id: "a", toIndex: 2 });
    if ("error" in result) throw new Error(result.error.reason);
    expect(result.inverse).toEqual({ kind: "move", id: "a", toIndex: 0 });
  });
});

describe("undo round-trips through the inverse op", () => {
  it("insert then its inverse returns the original list", () => {
    const start = [block("a", "prose")];
    const forward = applyEditorOp("home", start, { kind: "insert", block: block("b", "divider"), index: 0 });
    if ("error" in forward) throw new Error(forward.error.reason);
    const back = applyEditorOp("home", forward.blocks, forward.inverse);
    if ("error" in back) throw new Error(back.error.reason);
    expect(back.blocks).toEqual(seq(start));
  });

  it("remove then its inverse restores the exact block at its place", () => {
    const start = [block("a", "prose"), block("b", "divider", { note: "keep" }), block("c", "headline")];
    const forward = applyEditorOp("home", start, { kind: "remove", id: "b" });
    if ("error" in forward) throw new Error(forward.error.reason);
    const back = applyEditorOp("home", forward.blocks, forward.inverse);
    if ("error" in back) throw new Error(back.error.reason);
    // Identity, position, and the block's data (`{ note: "keep" }`) are all restored;
    // `order` comes back reconciled to position.
    expect(back.blocks).toEqual(seq(start));
  });

  it("move then its inverse returns every block to its place", () => {
    const start = [block("a", "prose"), block("b", "divider"), block("c", "headline")];
    const forward = applyEditorOp("home", start, { kind: "move", id: "c", toIndex: 0 });
    if ("error" in forward) throw new Error(forward.error.reason);
    const back = applyEditorOp("home", forward.blocks, forward.inverse);
    if ("error" in back) throw new Error(back.error.reason);
    expect(back.blocks).toEqual(seq(start));
  });
});

describe("op-level validity: insert revalidates, remove and move are monotonic", () => {
  it("repairs an over-cap list by removing the offending block", () => {
    // Two headlines on home (cap 1) is a corrupt stored list; removing one is the
    // op that makes it valid, so it must succeed.
    const corrupt = [block("h1", "headline"), block("h2", "headline")];
    const result = applyEditorOp("home", corrupt, { kind: "remove", id: "h2" });
    if ("error" in result) throw new Error("removing an over-cap block should repair the list");
    expect(result.blocks.map((b) => b.id)).toEqual(["h1"]);
  });

  it("refuses an otherwise-valid insert that leaves a pre-existing violation standing", () => {
    const corrupt = [block("h1", "headline"), block("h2", "headline")];
    const result = applyEditorOp("home", corrupt, { kind: "insert", block: block("p", "prose"), index: 0 });
    // The inserted prose is fine, but the list still holds two headlines, so the
    // op cannot hand back a still-invalid list.
    expect("error" in result).toBe(true);
  });

  it("allows a move on a corrupt list, because a move cannot make it worse", () => {
    // image_gallery is off-catalog for genericPage, so this stored list is corrupt.
    // A move is monotonic -- it neither fixes nor worsens the violation -- so it must
    // succeed rather than trap the editor mid-edit. Save-time validity is the save
    // boundary's job, and validateSection still flags the off-catalog block there.
    const corrupt = [block("a", "headline"), block("g", "image_gallery")];
    const result = applyEditorOp("genericPage", corrupt, { kind: "move", id: "a", toIndex: 1 });
    if ("error" in result) throw new Error("a move on a corrupt list should succeed");
    expect(result.blocks.map((b) => b.id)).toEqual(["g", "a"]);
    expect(validateSection("genericPage", result.blocks)).not.toBeNull();
  });

  it("repairs a duplicate-id list by removing one copy", () => {
    const corrupt = [block("a", "prose"), block("a", "divider")];
    const result = applyEditorOp("home", corrupt, { kind: "remove", id: "a" });
    if ("error" in result) throw new Error("removing a duplicate should repair the list");
    expect(result.blocks).toHaveLength(1);
  });

  it("walks a per-type over-cap list (3 headlines, cap 1) back to valid one remove at a time", () => {
    // The multi-item corruption the old whole-result gate deadlocked on: each
    // intermediate remove leaves the list invalid, but a monotonic remove still
    // succeeds, so the editor reaches a valid state.
    const corrupt = [block("h1", "headline"), block("h2", "headline"), block("h3", "headline")];
    const first = applyEditorOp("home", corrupt, { kind: "remove", id: "h3" });
    if ("error" in first) throw new Error("first cleanup remove should succeed");
    expect(validateSection("home", first.blocks)).not.toBeNull(); // still 2 headlines
    const second = applyEditorOp("home", first.blocks, { kind: "remove", id: "h2" });
    if ("error" in second) throw new Error("second cleanup remove should succeed");
    expect(validateSection("home", second.blocks)).toBeNull(); // now valid
  });

  it("walks a page over the total cap back down to the cap", () => {
    const over = Array.from({ length: SECTION_BLOCK_TOTAL_MAX.home + 2 }, (_, i) => block(`b${i}`, "prose"));
    const first = applyEditorOp("home", over, { kind: "remove", id: "b0" });
    if ("error" in first) throw new Error("removing from an over-cap page should succeed");
    expect(validateSection("home", first.blocks)).not.toBeNull(); // still one over
    const second = applyEditorOp("home", first.blocks, { kind: "remove", id: "b1" });
    if ("error" in second) throw new Error("second remove should succeed");
    expect(second.blocks).toHaveLength(SECTION_BLOCK_TOTAL_MAX.home);
    expect(validateSection("home", second.blocks)).toBeNull();
  });

  it("still rejects an insert that leaves an inserted empty id (the retained backstop)", () => {
    const result = applyEditorOp("home", [block("a", "prose")], {
      kind: "insert",
      block: block("", "divider"),
      index: 1,
    });
    expect("error" in result).toBe(true);
  });

  it("correctly rejects undoing a cleanup remove, because it would re-breach the cap", () => {
    // Removing an over-cap headline succeeds; its inverse re-inserts that headline,
    // which the insert cap pre-gate rejects. The asymmetry is intended: you cannot
    // undo your way back into a corrupt page. It surfaces as a clean OpError, not a
    // thrown error.
    const corrupt = [block("h1", "headline"), block("h2", "headline")];
    const removed = applyEditorOp("home", corrupt, { kind: "remove", id: "h2" });
    if ("error" in removed) throw new Error("the cleanup remove should succeed");
    const undo = applyEditorOp("home", removed.blocks, removed.inverse);
    expect("error" in undo).toBe(true);
    if ("error" in undo) {
      expect(undo.error.op).toBe("insert");
    }
  });
});

describe("validateSection", () => {
  it("passes a clean list", () => {
    expect(validateSection("home", [block("a", "prose"), block("b", "headline")])).toBeNull();
  });

  it("flags an off-catalog block with the machine cause in detail, not the reason", () => {
    const invalid = validateSection("genericPage", [block("g", "image_gallery")]);
    expect(invalid).not.toBeNull();
    expect(invalid?.reason).not.toContain("image_gallery");
    expect(invalid?.detail).toContain("image_gallery");
  });

  it("flags a duplicate id", () => {
    const invalid = validateSection("home", [block("x", "prose"), block("x", "divider")]);
    expect(invalid).not.toBeNull();
    expect(invalid?.detail).toContain("x");
  });

  it("flags an over-cap pile", () => {
    const invalid = validateSection("home", [block("a", "headline"), block("b", "headline")]);
    expect(invalid).not.toBeNull();
    expect(invalid?.detail).toContain("headline");
  });

  it("flags an empty id, which the save boundary (parseBlocks) also rejects", () => {
    // parseBlocks refuses a blank id; validateSection must agree, or the reducer
    // would call a list saveable that the persistence layer then rejects.
    const invalid = validateSection("home", [block("", "prose")]);
    expect(invalid).not.toBeNull();
    expect(invalid?.reason).toContain("missing its identifier");
    expect(invalid?.detail).toContain("index 0");
  });

  it("refuses to insert a block with an empty id, so the reducer never yields an unsaveable list", () => {
    const result = applyEditorOp("home", [block("a", "prose")], {
      kind: "insert",
      block: block("", "divider"),
      index: 1,
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.reason).toContain("missing its identifier");
    }
  });
});

describe("editor field descriptors", () => {
  it("returns fresh field arrays so a caller cannot mutate the shared descriptors", () => {
    const fields = editorFieldsForBlock("image");
    fields.pop();
    expect(editorFieldsForBlock("image").length).toBeGreaterThan(fields.length);
  });

  it("gives every content-bearing block at least one required field", () => {
    for (const type of BLOCK_TYPES) {
      if (CONTENT_FREE_BLOCKS.includes(type)) continue;
      if (type === "county_comparison") {
        // Reviewed copy is inherited; staff can override each of the three text fields.
        expect(editorFieldsForBlock(type).map(field => field.key)).toEqual(["heading", "intro", "source"]);
        expect(editorFieldsForBlock(type).every(field => !field.required)).toBe(true);
        continue;
      }
      if (type === "document_list") {
        // Empty notice lists are valid; entries still need both a title and a PDF.
        const [documents] = editorFieldsForBlock(type);
        expect(documents.required).toBe(false);
        expect(documents.minItems).toBeUndefined();
        expect(documents.itemFields?.filter(field => field.required).map(field => field.key))
          .toEqual(["title", "assetId"]);
        continue;
      }
      expect(editorFieldsForBlock(type).some((f) => f.required)).toBe(true);
    }
  });

  it("keeps custom election, row and divider editors out of generic content fields", () => {
    expect(CONTENT_FREE_BLOCKS).toEqual(["election_results", "row", "divider"]);
    expect(editorFieldsForBlock("election_results")).toEqual([]);
    expect(editorFieldsForBlock("row")).toEqual([]);
    expect(editorFieldsForBlock("divider")).toEqual([]);
  });

  it("never shows a machine identifier in a block field label or help", () => {
    // Flatten a field and any list item sub-fields, so the scan covers the item forms
    // an editor sees inside a gallery, button row, or card set too.
    const withItems = (f: EditorField): EditorField[] => [f, ...(f.itemFields ?? [])];
    for (const type of BLOCK_TYPES) {
      for (const field of editorFieldsForBlock(type).flatMap(withItems)) {
        const shown = `${field.label} ${field.help}`.toLowerCase();
        for (const token of MACHINE_TOKENS) {
          expect(shown).not.toContain(token);
        }
      }
    }
  });

  it("gives every block field a stable, non-displayed key (#392)", () => {
    for (const type of BLOCK_TYPES) {
      for (const field of editorFieldsForBlock(type)) {
        expect(field.key).toBeTruthy();
      }
    }
  });

  it("carries exactly one continuous rich-text body for prose and faq answers", () => {
    expect(editorFieldsForBlock("prose").filter((f) => f.kind === "richText")).toHaveLength(1);
    expect(editorFieldsForBlock("faq_item").filter((f) => f.kind === "richText")).toHaveLength(1);
  });

  it("describes the item shape of every object-item list so the shell needs no model knowledge", () => {
    // A `list` field for a composite block must carry the item's sub-fields, or the
    // shell would have to hardcode the block's data shape to render the item form.
    const itemKeys = (type: BlockType, listKey: string) =>
      editorFieldsForBlock(type).find((f) => f.key === listKey)?.itemFields?.map((f) => f.key);
    expect(itemKeys("image_gallery", "images")).toEqual([
      "assetId",
      "alt",
      "altDecorative",
      "caption",
    ]);
    expect(itemKeys("cta_row", "ctas")).toEqual(["label", "href"]);
    expect(itemKeys("card_grid", "cards")).toEqual(["label", "title", "body", "imageAssetId", "href"]);
    expect(itemKeys("promotion_playlist", "cards")).toEqual([
      "title",
      "summary",
      "imageAssetId",
      "alt",
      "altDecorative",
      "href",
    ]);
    expect(itemKeys("coverage_list", "entries")).toEqual([
      "title",
      "outlet",
      "date",
      "url",
    ]);
    const coverageItems = editorFieldsForBlock("coverage_list").find((field) => field.key === "entries")
      ?.itemFields ?? [];
    expect(coverageItems.find((field) => field.key === "title")?.maxLength).toBe(COVERAGE_LIST_LIMITS.title);
    expect(coverageItems.find((field) => field.key === "outlet")?.maxLength).toBe(COVERAGE_LIST_LIMITS.outlet);
    expect(coverageItems.find((field) => field.key === "url")?.maxLength).toBe(COVERAGE_LIST_LIMITS.url);
  });

  it("defines the bounded manual content shelf editor", () => {
    expect(BLOCK_LABELS.promotion_playlist).toBe("manual content shelf");
    const fields = editorFieldsForBlock("promotion_playlist");
    expect(fields.map((field) => [field.key, field.kind])).toEqual([
      ["title", "text"],
      ["presentation", "select"],
      ["columns", "select"],
      ["placement", "select"],
      ["cards", "list"],
    ]);
    const placement = fields.find((field) => field.key === "placement");
    expect(fields.find((field) => field.key === "title")).toMatchObject({
      label: "Shelf heading",
      help: "The heading shown above this manual content shelf.",
    });
    expect(placement).toMatchObject({
      label: "Home page position",
      help: "Choose which existing Home page section this manual content shelf appears before.",
    });
    expect(placement?.options?.map((option) => option.value)).toEqual([
      "before_start",
      "before_featured",
      "before_passport",
      "before_more",
      "before_spotlight",
    ]);
    const cards = fields.find((field) => field.key === "cards");
    expect(cards).toMatchObject({
      label: "Shelf items",
      help: "Add up to twelve items and put them in display order.",
    });
    expect(cards?.itemFields?.map((field) => field.label)).toEqual([
      "Content title",
      "Content summary",
      "Content image",
      "Alt text",
      "Mark as decorative",
      "Content link",
    ]);
    expect(cards?.minItems).toBe(1);
    expect(cards?.maxItems).toBe(12);
  });

  it("names the dynamic video block as a video content shelf", () => {
    expect(BLOCK_LABELS.video_playlist).toBe("video content shelf");
    expect(editorFieldsForBlock("video_playlist").find((field) => field.key === "title"))
      .toMatchObject({ label: "Shelf heading" });
  });

  it("marks the required sub-fields of a list item required", () => {
    const gallery = editorFieldsForBlock("image_gallery").find((f) => f.key === "images");
    const byKey = Object.fromEntries((gallery?.itemFields ?? []).map((f) => [f.key, f.required]));
    // An image without a source is not a valid gallery item. Empty alt text warns and
    // never blocks (#242). The decorative toggle is optional because leaving it off is
    // the ordinary case, and it releases the alt warning rather than adding one.
    expect(byKey.assetId).toBe(true);
    expect(byKey.alt).toBe(false);
    expect(gallery?.itemFields?.find((f) => f.key === "alt")?.recommended).toBe(true);
    expect(byKey.altDecorative).toBe(false);
    expect(byKey.caption).toBe(false);
  });

  it("deep-copies item fields so a caller cannot mutate the shared descriptors", () => {
    const first = editorFieldsForBlock("cta_row").find((f) => f.key === "ctas");
    first?.itemFields && (first.itemFields as EditorField[]).pop();
    const second = editorFieldsForBlock("cta_row").find((f) => f.key === "ctas");
    expect(second?.itemFields).toHaveLength(2);
  });

  it("declares and deep-copies the finite content-shelf choices", () => {
    const first = editorFieldsForBlock("content_shelf");
    expect(first.map((field) => [field.key, field.kind])).toEqual([
      ["title", "text"],
      ["source", "select"],
      ["presentation", "select"],
      ["columns", "select"],
      ["itemLimit", "select"],
      ["moreLabel", "text"],
      ["moreHref", "url"],
    ]);
    const source = first.find((field) => field.key === "source");
    expect(source?.options?.map((option) => option.value)).toEqual([
      "pbs_featured",
      "pbs_more",
      "spotlight_news",
      "station_posts",
    ]);
    (source?.options as Array<{ value: string | number; label: string }> | undefined)?.pop();
    expect(
      editorFieldsForBlock("content_shelf")
        .find((field) => field.key === "source")
        ?.options,
    ).toHaveLength(4);
  });
});

describe("record field descriptors", () => {
  it("covers every record kind, including program (#392)", () => {
    for (const kind of RECORD_KINDS) {
      expect(recordFieldsFor(kind).length).toBeGreaterThan(0);
    }
  });

  it("gives a program its show metadata as editor fields (#392)", () => {
    const fields = recordFieldsFor("program");
    const keys = fields.map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(["genre", "description", "memberOnly"]));
    const members = fields.find((f) => f.key === "memberOnly");
    expect(members?.kind).toBe("toggle");
    const art = fields.find((f) => f.key === "keyArtAssetId");
    expect(art?.kind).toBe("asset");
    expect(fields.find((f) => f.key === "keyArt")).toBeUndefined();
    expect(fields.find((f) => f.key === "slug")?.kind).toBe("text");
  });

  it("lets an editor choose a sponsor logo from the station media library", () => {
    // `SponsorRecord.logoAssetId` is an editable model field; without a descriptor an
    // editor could set a sponsor's name and link but never its logo. Unlike PBS Media
    // Manager identifiers retained on older programs, this is a station-managed asset.
    const logo = recordFieldsFor("sponsor").find((f) => f.key === "logoAssetId");
    expect(logo).toBeDefined();
    expect(logo?.kind).toBe("asset");
    expect(logo?.required).toBe(false);
    const alt = recordFieldsFor("sponsor").find((f) => f.key === "logoAlt");
    expect(alt).toMatchObject({
      required: false,
      recommended: true,
      requiredWhen: "logoAssetId",
      requiredUnless: "logoDecorative",
    });
    const fields = recordFieldsFor("sponsor");
    expect(fields.find(field => field.key === "tier")).toMatchObject({ kind: "text", maxLength: 80 });
    expect(fields.find(field => field.key === "description")).toMatchObject({ kind: "text", maxLength: 280 });
    expect(fields.find(field => field.key === "activeFrom")?.kind).toBe("date");
    expect(fields.find(field => field.key === "activeUntil")?.kind).toBe("date");
  });

  it("keeps post lead images in the station media library", () => {
    const fields = recordFieldsFor("post");
    const heroImage = fields.find((f) => f.key === "heroImage");
    expect(heroImage?.kind).toBe("asset");
    expect(fields.find((f) => f.key === "heroImageAlt")).toMatchObject({
      required: false,
      recommended: true,
      requiredWhen: "heroImage",
      requiredUnless: "heroImageDecorative",
    });
  });

  it("edits newsletter signup details and one continuous description", () => {
    // NewsletterRecord is in the model's editorial union; without a descriptor the
    // collection would be uneditable through this core, unlike post, which has a
    // tracked surface (#501). Its body is one continuous rich-text field, per the
    // one-body rule the other long-form records follow.
    const fields = recordFieldsFor("newsletter");
    expect(fields.map((f) => f.key)).toEqual(["title", "summary", "frequency", "signupUrl", "imageAssetId", "imageAlt", "imageDecorative", "body"]);
    expect(fields.find((f) => f.key === "body")?.kind).toBe("richText");
    expect(fields.filter(f => f.required).map(f => f.key)).toEqual(["title", "body"]);
    expect(fields.find((f) => f.key === "imageAssetId")?.kind).toBe("asset");
  });

  it("writes each long-form record body as a single continuous rich-text field", () => {
    for (const kind of RECORD_KINDS) {
      const richFields = recordFieldsFor(kind).filter((f) => f.kind === "richText");
      // At most one continuous body per record, never two fragments.
      expect(richFields.length).toBeLessThanOrEqual(1);
    }
  });

  it("never shows a machine identifier in a record field label or help", () => {
    for (const kind of RECORD_KINDS) {
      for (const field of recordFieldsFor(kind)) {
        const shown = `${field.label} ${field.help}`.toLowerCase();
        for (const token of MACHINE_TOKENS) {
          // URL slugs are now an explicit editor control.
          if (field.key === "slug" && token === "slug") continue;
          expect(shown).not.toContain(token);
        }
      }
    }
  });

  it("gives every record field a stable, non-displayed key (#392)", () => {
    for (const kind of RECORD_KINDS) {
      for (const field of recordFieldsFor(kind)) {
        expect(field.key).toBeTruthy();
      }
    }
  });

  it("marks a model-required field required, so the shell cannot save an incomplete record", () => {
    // Each of these fields is required (no `?`) on its content-model record, so the
    // editor form must demand it -- otherwise a saved record violates the model.
    const requiredByModel: Array<[RecordKind, string]> = [
      ["program", "description"],
      ["event", "description"],
      ["sponsor", "href"],
      ["newsletter", "title"],
      ["newsletter", "body"],
    ];
    for (const [kind, key] of requiredByModel) {
      const field = recordFieldsFor(kind).find((f) => f.key === key);
      expect(field, `${kind}.${key} descriptor`).toBeDefined();
      expect(field?.required, `${kind}.${key} must be required`).toBe(true);
    }
  });

  it("groups page metadata into content link, hero, basics, search, and social collections", () => {
    const groups = editorFieldGroupsFor("page");
    expect(groups.map((group) => group.id)).toEqual(["content-link", "hero-image", "basics", "search", "social"]);
    expect(groups.find((group) => group.id === "basics")?.fields.map((field) => field.key))
      .toEqual(["title", "description", "pageTheme", "slug"]);

    const search = groups.find((group) => group.id === "search")!;
    expect(search.fields.map((field) => [field.path, field.key])).toEqual([
      [["seo"], "title"],
      [["seo"], "description"],
      [["seo"], "noindex"],
    ]);
    const social = groups.find((group) => group.id === "social")!;
    expect(social.fields.map((field) => [field.path, field.key])).toEqual([
      [["social"], "title"],
      [["social"], "description"],
      [["social"], "imageAssetId"],
    ]);
  });

  it("names the Staff hero fields without adding a separate schema", () => {
    const groups = editorFieldGroupsFor("page", "staff");
    const basics = Object.fromEntries(
      (groups.find((group) => group.id === "basics")?.fields ?? []).map((field) => [
        field.key,
        field,
      ]),
    );

    expect(groups.find((group) => group.id === "hero-image")?.help).toBe(
      "Choose the image behind the Staff heading.",
    );
    expect(basics.title?.label).toBe("Staff hero title");
    expect(basics.description?.label).toBe("Staff hero summary");
    expect(basics.slug?.key).toBe("slug");
    expect(groups.map((group) => group.id)).toEqual([
      "content-link",
      "hero-image",
      "basics",
      "search",
      "social",
    ]);
  });

  // The four dates a story carries are four separate decisions (#1041), so the
  // editorial date an editor may set is not the field that decides when the post
  // goes live, and neither of them is touched by an ordinary save.
  it("stops requiring an editorial date to save a post", () => {
    const dates = editorFieldGroupsFor("post").find((group) => group.id === "dates")!;
    const byKey = Object.fromEntries(dates.fields.map((field) => [field.key, field]));
    expect(dates.fields.every((field) => field.required)).toBe(false);
    expect(byKey.date.required).toBe(false);
    expect(byKey.date.kind).toBe("date");
    // Scheduling is a lifecycle action, not a field here: the save boundary takes a
    // publication time only as a request-level scheduleAt, so a form field would
    // persist an inert value and schedule nothing.
    expect(byKey.publishAt).toBeUndefined();
    expect(byKey.recordMeaningfulUpdate.kind).toBe("toggle");
    expect(byKey.showUpdatedDate.kind).toBe("toggle");
  });

  // A post's byline is an ordered credit list, not a name someone types (#1040).
  // The descriptor has to say so, because the shell picks the control from `kind`
  // and a text kind would put the free-text box straight back.
  it("gives a post an ordered byline control rather than a free-text author", () => {
    const organization = editorFieldGroupsFor("post").find(
      (group) => group.id === "organization",
    )!;
    const byKey = Object.fromEntries(
      organization.fields.map((field) => [field.key, field]),
    );
    expect(byKey.author).toBeUndefined();
    expect(byKey.credits.kind).toBe("storyCredits");
    expect(byKey.credits.required).toBe(false);
    expect(byKey.credits.label).toBe("Byline");
  });

  it("separates the Post writing fields from the Excerpt fallback metadata", () => {
    const groups = editorFieldGroupsFor("post");
    expect(groups.map((group) => group.id)).toEqual([
      "content-link",
      "basics",
      "excerpt",
      "dates",
      "organization",
      "hero-image",
      "search",
      "social",
    ]);
    expect(
      groups.find((group) => group.id === "basics")?.fields.map((field) => field.key),
    ).toEqual(["title", "summary"]);
    expect(
      groups.find((group) => group.id === "excerpt")?.fields.map((field) => field.key),
    ).toEqual(["excerpt"]);
    expect(
      groups.find((group) => group.id === "basics")?.fields.find(
        (field) => field.key === "summary",
      )?.help,
    ).toBe(
      "Optional text below the title. Also used in listings, search, and social sharing.",
    );
    expect(
      groups.find((group) => group.id === "excerpt")?.fields[0]?.help,
    ).toBe(
      "Optional fallback for listing cards and default Search and Social descriptions when summary is empty. It does not appear beneath the post title.",
    );
    expect(
      groups.find((group) => group.id === "search")?.fields.find(
        (field) => field.key === "title",
      )?.help,
    ).toBe(
      "Uses the post title by default. Customize only when a search result needs different wording.",
    );
    expect(
      groups.find((group) => group.id === "social")?.fields.find(
        (field) => field.key === "title",
      )?.help,
    ).toBe(
      "Uses the post title by default. Customize only when a shared link needs different wording.",
    );
    expect(recordFieldsFor("post").map((field) => field.key)).toEqual([
      "contentLinkMode",
      "contentLinkUrl",
      "contentLinkNewTab",
      "title",
      "summary",
      "excerpt",
      "date",
      "recordMeaningfulUpdate",
      "showUpdatedDate",
      "coverageLabelId",
      "showInHomeHero",
      "spotlightNews",
      "slug",
      // The single free-text byline became an ordered credit list (#1040).
      "credits",
      "categories",
      "tags",
      "heroBackgroundImage",
      "heroBackgroundPosition",
      "heroImage",
      "heroImageAlt",
      "heroImageDecorative",
      "heroImageCaption",
      "title",
      "description",
      "noindex",
      "title",
      "description",
      "imageAssetId",
    ]);
  });
});

describe("order stays consistent with position (ADR 0013)", () => {
  // `order` is the persisted position; the array is the live order. After any op the
  // reducer reconciles the two, so a saved page never disagrees with itself when a
  // renderer sorts by `order`.
  const orders = (blocks: readonly { order: number }[]) => blocks.map((b) => b.order);

  it("renumbers order to match position after a move", () => {
    const start = [block("a", "prose"), block("b", "divider"), block("c", "headline")];
    const result = applyEditorOp("home", start, { kind: "move", id: "c", toIndex: 0 });
    if ("error" in result) throw new Error(result.error.reason);
    expect(result.blocks.map((b) => b.id)).toEqual(["c", "a", "b"]);
    expect(orders(result.blocks)).toEqual([0, 1, 2]);
  });

  it("renumbers order after an insert and a remove", () => {
    const start = [block("a", "prose"), block("b", "divider")];
    const inserted = applyEditorOp("home", start, { kind: "insert", block: block("c", "headline"), index: 1 });
    if ("error" in inserted) throw new Error(inserted.error.reason);
    expect(orders(inserted.blocks)).toEqual([0, 1, 2]);
    const removed = applyEditorOp("home", inserted.blocks, { kind: "remove", id: "a" });
    if ("error" in removed) throw new Error(removed.error.reason);
    expect(orders(removed.blocks)).toEqual([0, 1]);
  });

  it("does not mutate the caller's blocks while renumbering", () => {
    const start = [block("a", "prose"), block("b", "divider")];
    applyEditorOp("home", start, { kind: "move", id: "b", toIndex: 0 });
    // The input keeps its original stamped order (0), untouched by the op's renumber.
    expect(orders(start)).toEqual([0, 0]);
  });

  it("keeps the identity of a block already at its position (no needless remount)", () => {
    // A list loaded from storage already has order === index; `seq` builds that state.
    // Moving the last block to where it already is reorders nothing, so renumberOrder
    // finds every order already correct and hands back the same objects -- the shell's
    // keyed render does not remount rows that did not change.
    const start = seq([block("a", "prose"), block("b", "divider"), block("c", "headline")]);
    const result = applyEditorOp("home", start, { kind: "move", id: "c", toIndex: 2 });
    if ("error" in result) throw new Error(result.error.reason);
    expect(result.blocks[0]).toBe(start[0]);
    expect(result.blocks[1]).toBe(start[1]);
    expect(result.blocks[2]).toBe(start[2]);
  });
});

describe("the page-wide block cap (ADR 0013's per-page maxBlocks)", () => {
  // Fill a section to its total cap with uncapped blocks (prose), then probe the edge.
  const fill = (section: SectionId) =>
    Array.from({ length: SECTION_BLOCK_TOTAL_MAX[section] }, (_, i) => block(`b${i}`, "prose"));

  it("refuses an insert that would exceed the page cap, even for an uncapped type", () => {
    const full = fill("home");
    const result = applyEditorOp("home", full, { kind: "insert", block: block("x", "prose"), index: 0 });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error.reason).toContain("as many blocks as one page can hold");
    }
  });

  it("allows an insert one below the cap", () => {
    const nearFull = fill("home").slice(0, SECTION_BLOCK_TOTAL_MAX.home - 1);
    const result = applyEditorOp("home", nearFull, { kind: "insert", block: block("x", "prose"), index: 0 });
    expect("error" in result).toBe(false);
  });

  it("rejects a stored list over the page cap on the way out", () => {
    const over = Array.from({ length: SECTION_BLOCK_TOTAL_MAX.home + 1 }, (_, i) => block(`b${i}`, "prose"));
    const invalid = validateSection("home", over);
    expect(invalid?.reason).toContain("too many blocks");
  });
});

describe("stays linear on a full page (the sub-second budget's one algorithmic claim)", () => {
  // A full page is the cap: SECTION_BLOCK_TOTAL_MAX blocks (40), one headline (home's
  // per-type cap is 1) plus prose so the list is valid and the ops run to completion.
  // 40 is also the reference workload the budget is promised for, so this is the
  // largest page the ops ever legitimately see. A quadratic rescan would show up as
  // reads growing with the square of the block count; linear is a small multiple of N.
  const N = 40;
  const full = Array.from({ length: N }, (_, i) => block(`b${i}`, i === 0 ? "headline" : "prose"));

  it("moves a block through a linear number of list reads", () => {
    const { proxy, reads } = countingReads(full);
    const result = applyEditorOp("home", proxy, { kind: "move", id: `b${N - 1}`, toIndex: 0 });
    if ("error" in result) throw new Error(result.error.reason);
    expect(result.blocks[0].id).toBe(`b${N - 1}`);
    expect(reads()).toBeLessThan(N * 20);
  });

  it("validates a full page through a linear number of list reads", () => {
    const { proxy, reads } = countingReads(full);
    expect(validateSection("home", proxy)).toBeNull();
    expect(reads()).toBeLessThan(N * 20);
  });

  it("rejects an over-cap imported list in constant time, without a full scan", () => {
    // A corrupt or imported list far past the cap is rejected by the length check
    // before the per-block scan, so a huge list can never trigger a quadratic pass on
    // the way to being refused. The reads stay flat no matter how long the list is.
    const huge = Array.from({ length: 2000 }, (_, i) => block(`b${i}`, i === 0 ? "headline" : "prose"));
    const { proxy, reads } = countingReads(huge);
    const invalid = validateSection("home", proxy);
    expect(invalid?.detail).toContain("over the 40 cap");
    expect(reads()).toBeLessThan(50);
  });
});

// Article and the old generic Staff content record are retired. Staff profiles
// now use cmsAuthorProfiles, so neither retired kind may regain a create surface.
describe("retired record kinds", () => {
  it("offers no retired kind among the kinds an editor can fill in", () => {
    expect(RECORD_KINDS).not.toContain("article");
    expect(RECORD_KINDS).not.toContain("staff");
    // The type-level guarantee is what actually blocks a caller, so assert it in a
    // form the compiler checks too: this line stops compiling if `article` returns
    // to RecordKind.
    const kinds: RecordKind[] = [...RECORD_KINDS];
    // @ts-expect-error -- article is not a RecordKind; the model no longer has one.
    kinds.push("article");
  });

  it("keeps only the legacy Staff read descriptor", () => {
    expect(() => recordFieldsFor("article" as unknown as RecordKind)).toThrow();
    expect(recordFieldsFor("staff").map((field) => field.key)).toEqual([
      "name",
      "role",
      "bio",
    ]);
  });

  it("names a stored record of a retired kind as retired", () => {
    expect(isRetiredRecordKind("article")).toBe(true);
    expect(isRetiredRecordKind("staff")).toBe(true);
    expect(isRetiredRecordKind("post")).toBe(false);
    expect(retiredRecordLabel("article")).toBe("Article (retired)");
    expect(retiredRecordLabel("staff")).toBe(
      "Staff record (retired — use Staff profiles)",
    );
  });
});

// Issue #666: a block descriptor's `key` is the binding between what an editor types
// and the field `parseBlocks` stores. Before this, only record and list-item keys were
// checked, so a typo on a top-level block key compiled, saved nothing, and reported
// nothing. `BlockFieldFor<T>` checks each key against that block's own data shape; the
// `@ts-expect-error` lines below are the assertion -- each one FAILS the typecheck if
// the key stops being rejected, which is what would happen if the guarantee regressed.
describe("block field keys are checked against the block's data shape", () => {
  const base = { label: "Field", help: "Help text.", kind: "text", required: true } as const;

  it("accepts a key the block's data really has", () => {
    const assetId: BlockFieldFor<"image"> = { ...base, key: "assetId", kind: "asset" };
    const content: BlockFieldFor<"prose"> = { ...base, key: "content", kind: "richText" };
    const question: BlockFieldFor<"faq_item"> = { ...base, key: "question" };
    expect([assetId.key, content.key, question.key]).toEqual(["assetId", "content", "question"]);
  });

  it("accepts an optional data field, which an editor may or may not be offered", () => {
    // `altDecorative` (WCAG decorative escape) and a gallery `presentation` (#1111) are
    // optional in the model; optional keys are still keys, so naming one is legal.
    const decorative: BlockFieldFor<"image"> = { ...base, key: "altDecorative", kind: "toggle" };
    const presentation: BlockFieldFor<"image_gallery"> = { ...base, key: "presentation", kind: "select" };
    const pinned: BlockFieldFor<"topic_shelf"> = { ...base, key: "pinned", kind: "list" };
    expect([decorative.key, presentation.key, pinned.key]).toEqual([
      "altDecorative",
      "presentation",
      "pinned",
    ]);
  });

  it("rejects a key the block's data does not have", () => {
    // @ts-expect-error -- the model field is `assetId`; a capitalized typo binds nowhere.
    const typo: BlockFieldFor<"image"> = { ...base, key: "assetID", kind: "asset" };
    // @ts-expect-error -- `text` is the headline's field, not prose's.
    const wrongBlock: BlockFieldFor<"prose"> = { ...base, key: "text" };
    // @ts-expect-error -- the gallery holds `images`; the singular drops on save.
    const singular: BlockFieldFor<"image_gallery"> = { ...base, key: "image", kind: "list" };
    // @ts-expect-error -- the shelf's manual order is `pinned`.
    const pins: BlockFieldFor<"topic_shelf"> = { ...base, key: "pins", kind: "list" };
    expect([typo.key, wrongBlock.key, singular.key, pins.key].length).toBe(4);
  });

  it("keeps every shipped descriptor key on its block's data shape", () => {
    // The table itself is the real proof: it compiles only because each key is real.
    // This walks it so the catalog is exercised at runtime too, and so a block type
    // added without descriptors is visible here rather than only at `tsc`.
    for (const type of BLOCK_TYPES) {
      for (const field of editorFieldsForBlock(type)) {
        expect(field.key).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
      }
    }
    // Row split controls and a divider carry no generic content fields.
    expect(editorFieldsForBlock("row")).toEqual([]);
    expect(editorFieldsForBlock("divider")).toEqual([]);
  });
});
