import { describe, it, expect } from "vitest";
import {
  blockEditorReducer,
  initialBlockEditorState,
  type BlockEditorState,
} from "../src/lib/block-editor-state";
import { createBlock } from "../src/lib/block-factory";
import { blocksEqual } from "../src/lib/block-equality";
import type { EditorOp } from "../../packages/content-core/src/editor-admin";
import type { AdminBlock } from "../src/lib/block-factory";
import { parseBlocks } from "../../packages/content-core/src/content-model";

const reduce = (state: BlockEditorState, action: Parameters<typeof blockEditorReducer>[2]) =>
  blockEditorReducer("home", state, action);

function insert(block: AdminBlock, index: number): { kind: "apply"; op: EditorOp<AdminBlock> } {
  return { kind: "apply", op: { kind: "insert", block, index } };
}

describe("blockEditorReducer", () => {
  it("undoes a one-cell CSV import separately from prior typing", () => {
    const block = { ...createBlock("data_table", "table"), data: { title: "Totals", csv: "County,Value\nEssex,10", source: "", sourceHref: "" } };
    let state = initialBlockEditorState([block]);
    const change = (csv: string, discrete = false) => {
      state = blockEditorReducer("post", state, { kind: "setData", id: "table", data: { ...block.data, csv }, discrete });
    };
    change("County,Value\nEssex,11");
    change("County,Value\nEssex,12", true);
    expect(state.undo).toHaveLength(2);
    state = blockEditorReducer("post", state, { kind: "undo" });
    expect(state.blocks[0].data.csv).toBe("County,Value\nEssex,11");
    state = blockEditorReducer("post", state, { kind: "undo" });
    expect(state.blocks[0].data.csv).toBe("County,Value\nEssex,10");
  });

  it("keeps table cell edits when undo restores a deleted row", () => {
    const block = { ...createBlock("data_table", "table"), data: { title: "Totals", csv: "County,Value\nEssex,10\nBergen,20", source: "", sourceHref: "" } };
    let state = initialBlockEditorState([block]);
    const change = (csv: string) => { state = blockEditorReducer("post", state, { kind: "setData", id: "table", data: { ...block.data, csv } }); };
    change("County,Value\nEssex,11\nBergen,20");
    change("County,Value\nEssex,12\nBergen,20");
    expect(state.undo).toHaveLength(1);
    change("County,Value\nEssex,12");
    expect(state.undo).toHaveLength(2);
    state = blockEditorReducer("post", state, { kind: "undo" });
    expect(state.blocks[0].data.csv).toBe("County,Value\nEssex,12\nBergen,20");
    change("County,Value\nEssex,12\nBergen,21");
    expect(state.undo).toHaveLength(2);
    state = blockEditorReducer("post", state, { kind: "undo" });
    expect(state.blocks[0].data.csv).toBe("County,Value\nEssex,12\nBergen,20");
  });

  it("keeps a duplicated row's content and history after save assigns canonical IDs", () => {
    const row = createBlock("row", "row");
    const child = { ...createBlock("prose", "child"), layout: { rowId: "row", column: 0 } };
    const postReduce = (state: BlockEditorState, action: Parameters<typeof blockEditorReducer>[2]) => blockEditorReducer("post", state, action);
    let state = initialBlockEditorState([row, child]);
    state = postReduce(state, { kind: "editRows", edit: { kind: "duplicate", id: "row", newIds: { row: "copy-row", child: "copy-child" } } });
    expect(state.error).toBeNull();
    state = postReduce(state, { kind: "reconcileIds", idMap: { "copy-row": "saved-row", "copy-child": "saved-child" } });
    state = postReduce(state, { kind: "undo" });
    expect(state.blocks.map(block => block.id)).toEqual(["row", "child"]);
    state = postReduce(state, { kind: "redo" });
    expect(state.error).toBeNull();
    expect(state.blocks[3]).toMatchObject({ id: "saved-child", layout: { rowId: "saved-row", column: 0 } });
  });

  it("restores a removed row after canonical IDs arrive without losing later text", () => {
    const row = createBlock("row", "tmp-row");
    const child = { ...createBlock("prose", "tmp-child"), layout: { rowId: row.id, column: 1 } };
    let state = initialBlockEditorState([row, child]);
    state = reduce(state, { kind: "editRows", edit: { kind: "remove", id: row.id } });
    expect(state.blocks).toHaveLength(0);
    state = reduce(state, { kind: "reconcileIds", idMap: { "tmp-row": "saved-row", "tmp-child": "saved-child" } });
    state = reduce(state, { kind: "undo" });
    expect(state.error).toBeNull();
    expect(state.blocks.map(block => block.id)).toEqual(["saved-row", "saved-child"]);
    expect(state.blocks[1].layout).toEqual({ rowId: "saved-row", column: 1 });
    const content = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Keep this new writing." }] }] };
    state = reduce(state, { kind: "setData", id: "saved-child", data: { content } });
    expect(state.redo).toHaveLength(0);
    state = reduce(state, { kind: "redo" });
    expect(state.blocks[1].data.content).toEqual(content);
  });

  it("keeps layout redo available after text edits and a save receipt", () => {
    const row = createBlock("row", "tmp-row");
    const child = { ...createBlock("prose", "tmp-child"), layout: { rowId: row.id, column: 1 } };
    let state = initialBlockEditorState([row, child]);
    state = reduce(state, { kind: "editRows", edit: { kind: "split", id: row.id, columns: [12] } });
    state = reduce(state, { kind: "undo" });
    state = reduce(state, { kind: "reconcileIds", idMap: { "tmp-row": "saved-row", "tmp-child": "saved-child" } });
    const content = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Text survives layout history." }] }] };
    state = reduce(state, { kind: "setData", id: "saved-child", data: { content } });
    expect(state.redo).toHaveLength(1);
    state = reduce(state, { kind: "redo" });
    expect(state.error).toBeNull();
    expect(state.blocks[0].data.columns).toEqual([12]);
    expect(state.blocks[1].layout).toEqual({ rowId: "saved-row", column: 0 });
    expect(state.blocks[1].data.content).toEqual(content);
    state = reduce(state, { kind: "undo" });
    expect(state.blocks[1].layout).toEqual({ rowId: "saved-row", column: 1 });
    expect(state.blocks[1].data.content).toEqual(content);
  });

  it("remaps row membership in current content, undo and redo after a save", () => {
    const row = createBlock("row", "tmp-row");
    const child = { ...createBlock("prose", "tmp-child"), layout: { rowId: "tmp-row", column: 0 } };
    let state = initialBlockEditorState([row, child]);
    state = reduce(state, { kind: "apply", op: { kind: "remove", id: child.id } });
    state = reduce(state, { kind: "reconcileIds", idMap: { "tmp-row": "saved-row", "tmp-child": "saved-child" } });
    state = reduce(state, { kind: "undo" });
    expect(state.blocks[1].id).toBe("saved-child");
    expect(state.blocks[1].layout).toEqual({ rowId: "saved-row", column: 0 });
    state = reduce(state, { kind: "redo" });
    expect(state.blocks).toHaveLength(1);
    state = reduce(state, { kind: "undo" });
    // A child inserted while the save was in flight also follows the row receipt.
    const added = { ...createBlock("prose", "new-child"), layout: { rowId: "saved-row", column: 1 } };
    state = reduce(state, insert(added, 2));
    state = reduce(state, { kind: "reconcileIds", idMap: { "saved-row": "final-row" } });
    expect(state.blocks[2].layout?.rowId).toBe("final-row");
    expect(state.blocks[2].id).toBe("new-child");
    expect(state.blocks[1].layout?.rowId).toBe("final-row");
  });

  it("normalizes stored order to array position before a data-only save (#506)", () => {
    const first = { ...createBlock("headline", "first"), order: 7 };
    const second = { ...createBlock("divider", "second"), order: 7 };

    let state = initialBlockEditorState([first, second]);

    expect(state.blocks.map((block) => block.order)).toEqual([0, 1]);
    expect(first.order).toBe(7);
    expect(second.order).toBe(7);

    state = reduce(state, {
      kind: "setData",
      id: "first",
      data: { text: "Edited headline" },
    });
    expect(state.blocks.map((block) => block.order)).toEqual([0, 1]);
  });

  it("normalizes only renderer-valid numeric headline levels when state is initialized", () => {
    const blocks: AdminBlock[] = [
      {
        ...createBlock("headline", "high"),
        data: { text: "High", level: 9 },
      },
      {
        ...createBlock("headline", "fractional"),
        data: { text: "Fractional", level: 2.5 },
      },
      {
        ...createBlock("headline", "valid"),
        data: { text: "Valid", level: 3 },
      },
      {
        ...createBlock("headline", "default"),
        data: { text: "Default" },
      },
      {
        ...createBlock("headline", "type-invalid"),
        data: { text: "Type invalid", level: "two" },
      },
    ].map((block, order) => ({ ...block, order }));

    const state = initialBlockEditorState(blocks);

    expect(state.blocks.map((block) => block.data.level)).toEqual([6, 2, 3, undefined, "two"]);
    expect(blocks[0].data.level).toBe(9);
    expect(blocks[1].data.level).toBe(2.5);
    expect(state.blocks[2]).toBe(blocks[2]);
    expect(state.blocks[3]).toBe(blocks[3]);
    expect(state.blocks[4]).toBe(blocks[4]);

    const alreadyCanonical = blocks.slice(2).map((block, order) => ({ ...block, order }));
    expect(initialBlockEditorState(alreadyCanonical).blocks).toBe(alreadyCanonical);
  });

  it("normalizes legacy collection rows with persisted ids without mutating the payload (#1127)", () => {
    const legacyCards = [
      { title: "Alpha", body: { type: "doc", content: [] }, imageAssetId: "", href: "" },
      { title: "Beta", body: { type: "doc", content: [] }, imageAssetId: "", href: "" },
    ];
    const block = {
      ...createBlock("card_grid", "cards"),
      data: { cards: legacyCards },
    } as AdminBlock;
    const state = initialBlockEditorState([block]);
    const cards = state.blocks[0].data.cards as Record<string, unknown>[];
    expect(cards.map((item) => item.itemId)).toEqual([
      "collection-item:cards:cards:1",
      "collection-item:cards:cards:2",
    ]);
    expect(new Set(cards.map((item) => item.itemId)).size).toBe(2);
    expect(legacyCards.every((item) => !("itemId" in item))).toBe(true);
    expect(initialBlockEditorState(state.blocks).blocks).toBe(state.blocks);
  });

  it("mints stable ids for promotion cards before save (#1272)", () => {
    const promotion = createBlock("promotion_playlist", "promotion");
    let state = initialBlockEditorState([promotion]);
    const cards = ["one", "two", "three"].map((name) => ({
      title: `Program ${name}`,
      summary: `Summary ${name}`,
      imageAssetId: `asset-${name}`,
      alt: `Program ${name}`,
      href: `/watch/${name}/`,
    }));

    state = reduce(state, {
      kind: "setData",
      id: "promotion",
      data: {
        title: "Timely programs",
        placement: "before_featured",
        cards,
      },
    });

    const savedCards = state.blocks[0].data.cards as Record<string, unknown>[];
    const itemIds = savedCards.map((card) => card.itemId);
    expect(itemIds).toEqual([
      expect.stringMatching(/^collection-item-/),
      expect.stringMatching(/^collection-item-/),
      expect.stringMatching(/^collection-item-/),
    ]);
    expect(new Set(itemIds).size).toBe(3);
    expect(parseBlocks(state.blocks).ok).toBe(true);
    expect(cards.every((card) => !("itemId" in card))).toBe(true);
  });

  it("inserts a block, renumbers order, and records the inverse for undo", () => {
    const state = reduce(initialBlockEditorState(), insert(createBlock("headline", "h1"), 0));
    expect(state.blocks.map((b) => b.id)).toEqual(["h1"]);
    expect(state.blocks[0].order).toBe(0);
    expect(state.error).toBeNull();
    expect(state.undo).toEqual([{ kind: "remove", id: "h1" }]);
  });

  it("appends an insertBlock to the end using fresh state, not a caller index", () => {
    // Two appends folded in sequence land at 0 then 1: the reducer resolves the end from
    // its own state each time, so a stale caller index cannot stack them at one position.
    let state = reduce(initialBlockEditorState(), {
      kind: "insertBlock",
      block: createBlock("headline", "h1"),
    });
    state = reduce(state, { kind: "insertBlock", block: createBlock("prose", "p1") });
    expect(state.blocks.map((b) => b.id)).toEqual(["h1", "p1"]);
    expect(state.blocks.map((b) => b.order)).toEqual([0, 1]);
  });

  it("honors an explicit insertBlock index when given one", () => {
    let state = reduce(initialBlockEditorState(), {
      kind: "insertBlock",
      block: createBlock("headline", "h1"),
    });
    state = reduce(state, { kind: "insertBlock", block: createBlock("prose", "p1"), index: 0 });
    expect(state.blocks.map((b) => b.id)).toEqual(["p1", "h1"]);
  });

  it("keeps blocks in array order with order renumbered after each insert", () => {
    let state = reduce(initialBlockEditorState(), insert(createBlock("headline", "h1"), 0));
    state = reduce(state, insert(createBlock("prose", "p1"), 1));
    state = reduce(state, insert(createBlock("image", "i1"), 1));
    expect(state.blocks.map((b) => b.id)).toEqual(["h1", "i1", "p1"]);
    expect(state.blocks.map((b) => b.order)).toEqual([0, 1, 2]);
  });

  it("rejects an over-cap insert, keeps the list, and surfaces an editor-facing reason", () => {
    let state = reduce(initialBlockEditorState(), insert(createBlock("headline", "h1"), 0));
    const before = state.blocks;
    state = reduce(state, insert(createBlock("headline", "h2"), 1));
    // Home allows one heading; the second is refused.
    expect(state.blocks).toBe(before);
    expect(state.undo).toHaveLength(1);
    expect(state.error).toMatch(/heading/);
  });

  it("removes a block and records an insert inverse that restores it", () => {
    let state = reduce(initialBlockEditorState(), insert(createBlock("prose", "p1"), 0));
    state = reduce(state, { kind: "apply", op: { kind: "remove", id: "p1" } });
    expect(state.blocks).toHaveLength(0);
    expect(state.undo[state.undo.length - 1]).toMatchObject({ kind: "insert", index: 0 });
  });

  it("moves a block to a new index", () => {
    let state = reduce(initialBlockEditorState(), insert(createBlock("headline", "h1"), 0));
    state = reduce(state, insert(createBlock("prose", "p1"), 1));
    state = reduce(state, { kind: "apply", op: { kind: "move", id: "h1", toIndex: 1 } });
    expect(state.blocks.map((b) => b.id)).toEqual(["p1", "h1"]);
  });

  it("undoes the last structural op and pops the inverse", () => {
    let state = reduce(initialBlockEditorState(), insert(createBlock("headline", "h1"), 0));
    state = reduce(state, insert(createBlock("prose", "p1"), 1));
    state = reduce(state, { kind: "undo" });
    expect(state.blocks.map((b) => b.id)).toEqual(["h1"]);
    expect(state.undo).toHaveLength(1);
  });

  it("treats undo on an empty stack as a no-op", () => {
    const state = initialBlockEditorState();
    expect(reduce(state, { kind: "undo" })).toBe(state);
  });

  it("edits one block's data and leaves the others and the structure untouched", () => {
    let state = reduce(initialBlockEditorState(), insert(createBlock("headline", "h1"), 0));
    state = reduce(state, insert(createBlock("prose", "p1"), 1));
    const undoBefore = state.undo;
    const proseBefore = state.blocks.find((b) => b.id === "p1");
    state = reduce(state, { kind: "setData", id: "h1", data: { text: "Tonight" } });
    expect(state.blocks.find((b) => b.id === "h1")?.data).toEqual({ text: "Tonight" });
    // The untouched block keeps its exact prior identity, so a keyed render does not churn.
    expect(state.blocks.find((b) => b.id === "p1")).toBe(proseBefore);
    // A plain-field edit now enters the undo model so Undo reverses the last thing the editor
    // did rather than reaching past it to a structural op (#582). It records the field's prior
    // value as the inverse.
    expect(state.undo.length).toBe(undoBefore.length + 1);
    expect(state.undo[state.undo.length - 1]).toEqual({
      kind: "restoreData",
      id: "h1",
      fields: { text: "" },
      // A plain top-level field is not a nested-rich-text list, so nothing is overlay-safe.
      overlaySafe: [],
    });
  });

  it("toggles one block's visibility and leaves the others and the structure untouched", () => {
    let state = reduce(initialBlockEditorState(), insert(createBlock("headline", "h1"), 0));
    state = reduce(state, insert(createBlock("prose", "p1"), 1));
    const undoBefore = state.undo;
    const proseBefore = state.blocks.find((b) => b.id === "p1");
    // A block starts visible; hiding it flips only its own `visible` flag.
    expect(state.blocks.find((b) => b.id === "h1")?.visible).toBe(true);
    state = reduce(state, { kind: "setVisible", id: "h1", visible: false });
    expect(state.blocks.find((b) => b.id === "h1")?.visible).toBe(false);
    // The untouched block keeps its exact prior identity, so a keyed render does not churn.
    expect(state.blocks.find((b) => b.id === "p1")).toBe(proseBefore);
    // A visibility toggle now enters the undo model so Undo reverses it rather than reaching past
    // it to a structural op (#582). It records the prior visibility as the inverse.
    expect(state.undo.length).toBe(undoBefore.length + 1);
    expect(state.undo[state.undo.length - 1]).toEqual({
      kind: "restoreVisible",
      id: "h1",
      visible: true,
    });
  });

  it("shows a hidden block again by setting visible true", () => {
    let state = reduce(initialBlockEditorState(), insert(createBlock("headline", "h1"), 0));
    state = reduce(state, { kind: "setVisible", id: "h1", visible: false });
    state = reduce(state, { kind: "setVisible", id: "h1", visible: true });
    expect(state.blocks[0].visible).toBe(true);
  });

  it("leaves every block's visibility untouched when the id matches nothing", () => {
    let state = reduce(initialBlockEditorState(), insert(createBlock("headline", "h1"), 0));
    const before = state.blocks;
    state = reduce(state, { kind: "setVisible", id: "missing", visible: false });
    expect(state.blocks.map((b) => b.visible)).toEqual(before.map((b) => b.visible));
  });

  it("undoes a field edit before it reaches the last structural op (#582)", () => {
    // Insert two blocks (structural), then type into the heading (a plain-field edit). Undo must
    // reverse the typing, not reach past it to remove the block the earlier insert added.
    let state = reduce(initialBlockEditorState(), insert(createBlock("headline", "h1"), 0));
    state = reduce(state, insert(createBlock("prose", "p1"), 1));
    state = reduce(state, { kind: "setData", id: "h1", data: { text: "Tonight" } });
    const idsBefore = state.blocks.map((b) => b.id);
    state = reduce(state, { kind: "undo" });
    // The heading text is back to its default and every block is still on the page.
    expect(state.blocks.map((b) => b.id)).toEqual(idsBefore);
    expect(state.blocks.find((b) => b.id === "h1")?.data).toEqual({ text: "" });
  });

  it("removes an optional field again when undo restores it to absent", () => {
    // Typing into an optional field that was absent on the loaded block records its prior
    // value as undefined. Writing that back as an own key would leave the block a shape the
    // loaded one never had, so blocksEqual would report unsaved work after a full revert and
    // the workspace would keep the draft instead of re-reading -- hiding whatever someone
    // else saved meanwhile. Undo has to remove the key, not blank it.
    const image = createBlock("image", "i1");
    const loaded = { ...image, data: { assetId: "a1", alt: "A photo" } };
    let state = reduce(initialBlockEditorState(), insert(loaded, 0));
    const baseline = state.blocks.map((block) => ({ ...block, data: { ...block.data } }));

    state = reduce(state, {
      kind: "setData",
      id: "i1",
      data: { assetId: "a1", alt: "A photo", caption: "A caption" },
    });
    expect(state.blocks[0].data).toHaveProperty("caption");

    state = reduce(state, { kind: "undo" });

    expect(Object.hasOwn(state.blocks[0].data, "caption")).toBe(false);
    expect(state.blocks[0].data).toEqual({ assetId: "a1", alt: "A photo" });
    // The whole point: a fully reverted draft reads as equal to what was loaded.
    expect(blocksEqual(state.blocks, baseline)).toBe(true);
  });

  it("undoes a visibility toggle before it reaches the last structural op (#582)", () => {
    let state = reduce(initialBlockEditorState(), insert(createBlock("headline", "h1"), 0));
    state = reduce(state, insert(createBlock("prose", "p1"), 1));
    state = reduce(state, { kind: "setVisible", id: "p1", visible: false });
    state = reduce(state, { kind: "undo" });
    // The toggle is reversed and both blocks remain.
    expect(state.blocks.find((b) => b.id === "p1")?.visible).toBe(true);
    expect(state.blocks.map((b) => b.id)).toEqual(["h1", "p1"]);
  });

  it("coalesces a run of typing in one field into a single undo (#582)", () => {
    let state = reduce(initialBlockEditorState(), insert(createBlock("headline", "h1"), 0));
    const undoAfterInsert = state.undo.length;
    state = reduce(state, { kind: "setData", id: "h1", data: { text: "T" } });
    state = reduce(state, { kind: "setData", id: "h1", data: { text: "To" } });
    state = reduce(state, { kind: "setData", id: "h1", data: { text: "Ton" } });
    // Three keystrokes into the same field add exactly one undo entry, not three.
    expect(state.undo.length).toBe(undoAfterInsert + 1);
    state = reduce(state, { kind: "undo" });
    // Undo restores the field to before the whole typing session, not one character back.
    expect(state.blocks.find((b) => b.id === "h1")?.data).toEqual({ text: "" });
  });

  it("starts a new undo entry when typing moves to a different field (#582)", () => {
    let state = reduce(initialBlockEditorState(), insert(createBlock("image", "i1"), 0));
    const base = state.undo.length;
    state = reduce(state, { kind: "setData", id: "i1", data: { assetId: "", alt: "a", caption: "" } });
    state = reduce(state, { kind: "setData", id: "i1", data: { assetId: "", alt: "a", caption: "c" } });
    // Two different fields edited: two undo entries, each coalesced on its own field.
    expect(state.undo.length).toBe(base + 2);
  });

  it("leaves rich-text edits to the editor's own history, not the outer undo stack (#582)", () => {
    // A prose block's body is a rich-text field with its own TipTap history. Editing it must not
    // push onto the outer stack, or the outer Undo would fight the editor's Undo.
    let state = reduce(initialBlockEditorState(), insert(createBlock("prose", "p1"), 0));
    const base = state.undo.length;
    state = reduce(state, {
      kind: "setData",
      id: "p1",
      data: { content: { type: "doc", content: [{ type: "paragraph" }] } },
    });
    expect(state.undo.length).toBe(base);
  });

  it("undoes a plain-field edit without reverting a later rich-text edit on the same block (#582)", () => {
    // faq_item carries a plain field (question) and a rich-text field (answer). A rich-text edit
    // is excluded from the outer stack by design, so an outer Undo of the plain edit must restore
    // only the plain field and leave the newer rich-text value alone -- reverting the whole payload
    // would silently drop the rich-text edit, the exact data loss the history split exists to
    // prevent.
    const reduceGeneric = (state: BlockEditorState, action: Parameters<typeof blockEditorReducer>[2]) =>
      blockEditorReducer("genericPage", state, action);
    let state = reduceGeneric(initialBlockEditorState(), {
      kind: "apply",
      op: { kind: "insert", block: createBlock("faq_item", "f1"), index: 0 },
    });
    const seeded = state.blocks[0].data;
    // Edit the plain question (enters the outer undo stack).
    state = reduceGeneric(state, { kind: "setData", id: "f1", data: { ...seeded, question: "Why?" } });
    // Then edit the rich-text answer on the same block (excluded from the outer stack).
    const newAnswer = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Because." }] }] };
    state = reduceGeneric(state, {
      kind: "setData",
      id: "f1",
      data: { ...seeded, question: "Why?", answer: newAnswer },
    });

    state = reduceGeneric(state, { kind: "undo" });
    const data = state.blocks.find((b) => b.id === "f1")?.data;
    // The plain field is reverted...
    expect(data?.question).toBe(seeded.question);
    // ...and the newer rich-text edit survives.
    expect(data?.answer).toEqual(newAnswer);
  });

  // A card grid's `cards` is a top-level `list` field, but each card's `body` is a nested rich-text
  // sub-field with its own TipTap history. Editing that nested body replaces the whole `cards`
  // array, so a top-level check would push it onto the outer stack and let the page Undo swallow
  // rich text the card owns (#582). Structural list changes still push; only a change whose sole
  // difference is nested rich text is excluded.
  //
  // The card grid is seeded through initialBlockEditorState so each edit below is the first `cards`
  // change: two consecutive setData calls on one field coalesce into a single undo entry, which
  // would mask whether the second edit pushed at all.
  const emptyDoc = { type: "doc", content: [] };
  const card = (title: string, body: unknown) => ({ title, body, imageAssetId: "", href: "" });
  const cardGrid = (cards: unknown[]): AdminBlock =>
    ({ id: "c1", type: "card_grid", order: 0, visible: true, data: { cards } }) as AdminBlock;

  it("leaves a card's nested rich-text edit to the card's own history, not the outer undo (#582)", () => {
    const state0 = initialBlockEditorState([cardGrid([card("Featured", emptyDoc)])]);
    // Edit ONLY the nested rich-text body of the card.
    const richBody = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Tonight" }] }] };
    const state = reduce(state0, { kind: "setData", id: "c1", data: { cards: [card("Featured", richBody)] } });
    // The only difference is nested rich text, so nothing enters the outer stack.
    expect(state.undo).toHaveLength(0);
    // ...but the edit is still applied to the live block, so the editor holds the new body.
    expect(state.blocks[0].data.cards).toEqual([
      {
        ...card("Featured", richBody),
        itemId: "collection-item:c1:cards:1",
      },
    ]);
  });

  it("pushes a structural card-list change (a card added) onto the outer undo (#582)", () => {
    const state0 = initialBlockEditorState([cardGrid([card("First", emptyDoc)])]);
    // Adding a second card changes the item count -- structural, so the page Undo owns it.
    const state = reduce(state0, {
      kind: "setData",
      id: "c1",
      data: { cards: [card("First", emptyDoc), card("Second", emptyDoc)] },
    });
    expect(state.undo).toHaveLength(1);
  });

  it("pushes a non-rich-text card field edit (a card title) onto the outer undo (#582)", () => {
    const state0 = initialBlockEditorState([cardGrid([card("Before", emptyDoc)])]);
    // Editing a plain sub-field (title) is structural even though the array shape is unchanged.
    let state = reduce(state0, { kind: "setData", id: "c1", data: { cards: [card("After", emptyDoc)] } });
    expect(state.undo).toHaveLength(1);
    // Undo restores the whole prior cards value, so the title reverts.
    state = reduce(state, { kind: "undo" });
    expect((state.blocks[0].data.cards as { title: string }[])[0].title).toBe("Before");
  });

  it("pushes a card reorder onto the outer undo, distinguishing it from a nested rich-text edit (#582)", () => {
    const state0 = initialBlockEditorState([cardGrid([card("One", emptyDoc), card("Two", emptyDoc)])]);
    // Swapping two cards changes each position's non-rich content, so it is structural.
    const state = reduce(state0, {
      kind: "setData",
      id: "c1",
      data: { cards: [card("Two", emptyDoc), card("One", emptyDoc)] },
    });
    expect(state.undo).toHaveLength(1);
  });

  it("pushes an edit that changes both a card title and its nested rich text (#582)", () => {
    // The exclusion is only for a change whose SOLE difference is nested rich text. A title edit
    // bundled with a body edit is structural, so the outer Undo still owns the whole cards value.
    const state0 = initialBlockEditorState([cardGrid([card("Before", emptyDoc)])]);
    const richBody = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "New" }] }] };
    const state = reduce(state0, { kind: "setData", id: "c1", data: { cards: [card("After", richBody)] } });
    expect(state.undo).toHaveLength(1);
  });

  // The restore side of the same split (#582). A structural card edit snapshots the whole cards
  // array, bodies included; a later nested rich-text body edit pushes nothing. Undoing the
  // structural edit must revert only what it owned and leave the newer body alone -- restoring the
  // snapshot wholesale would silently drop the body edit.
  const doc = (text?: string) =>
    text
      ? { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] }
      : { type: "doc", content: [] };

  it("undoes a card's title edit without reverting a later nested rich-text body edit (#582)", () => {
    const state0 = initialBlockEditorState([cardGrid([card("Old title", doc())])]);
    // (1) Edit the title (structural, snapshots the whole cards array including the old body).
    let state = reduce(state0, { kind: "setData", id: "c1", data: { cards: [card("New title", doc())] } });
    // (2) Edit the same card's rich-text body (excluded from the outer stack, pushes nothing).
    state = reduce(state, { kind: "setData", id: "c1", data: { cards: [card("New title", doc("Body"))] } });
    // (3) Undo the title edit.
    state = reduce(state, { kind: "undo" });
    const cards = state.blocks[0].data.cards as { title: string; body: unknown }[];
    // The title reverts...
    expect(cards[0].title).toBe("Old title");
    // ...and the newer body survives.
    expect(cards[0].body).toEqual(doc("Body"));
  });

  it("starts a new title undo session after a nested rich-text body edit (#582)", () => {
    const state0 = initialBlockEditorState([cardGrid([card("Old title", doc())])]);
    let state = reduce(state0, {
      kind: "setData",
      id: "c1",
      data: { cards: [card("First title", doc())] },
    });
    state = reduce(state, {
      kind: "setData",
      id: "c1",
      data: { cards: [card("First title", doc("Body"))] },
    });
    state = reduce(state, {
      kind: "setData",
      id: "c1",
      data: { cards: [card("Second title", doc("Body"))] },
    });

    expect(state.undo).toHaveLength(2);
    state = reduce(state, { kind: "undo" });
    const cards = state.blocks[0].data.cards as { title: string; body: unknown }[];
    expect(cards[0].title).toBe("First title");
    expect(cards[0].body).toEqual(doc("Body"));
  });

  it("preserves the standing body when a re-applied title edit is undone again (#582)", () => {
    // v1 is undo-only, so re-performing the structural edit stands in for redo. The restore reads
    // the rich text current at apply time, so undoing the re-applied title edit must keep whatever
    // body stands then -- the symmetric guarantee to the undo case above.
    const state0 = initialBlockEditorState([cardGrid([card("Old", doc())])]);
    let state = reduce(state0, { kind: "setData", id: "c1", data: { cards: [card("New", doc())] } });
    state = reduce(state, { kind: "setData", id: "c1", data: { cards: [card("New", doc("One"))] } });
    state = reduce(state, { kind: "undo" });
    let cards = state.blocks[0].data.cards as { title: string; body: unknown }[];
    expect(cards[0].title).toBe("Old");
    expect(cards[0].body).toEqual(doc("One"));
    // Re-apply the title edit (redo-equivalent), move the body on again, then undo once more.
    state = reduce(state, { kind: "setData", id: "c1", data: { cards: [card("New", doc("One"))] } });
    state = reduce(state, { kind: "setData", id: "c1", data: { cards: [card("New", doc("Two"))] } });
    state = reduce(state, { kind: "undo" });
    cards = state.blocks[0].data.cards as { title: string; body: unknown }[];
    expect(cards[0].title).toBe("Old");
    expect(cards[0].body).toEqual(doc("Two"));
  });

  it("restores a removed card's nested rich text wholesale when the list length differs (#582, #617)", () => {
    // Removing a card changes the persisted item-id set, so no identity overlay is licensed.
    // The snapshot is restored wholesale, which is what brings the removed card's body back.
    const state0 = initialBlockEditorState([cardGrid([card("Only", doc("Kept"))])]);
    let state = reduce(state0, { kind: "setData", id: "c1", data: { cards: [] } });
    expect(state.undo).toHaveLength(1);
    state = reduce(state, { kind: "undo" });
    const cards = state.blocks[0].data.cards as { title: string; body: unknown }[];
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe("Only");
    expect(cards[0].body).toEqual(doc("Kept"));
  });

  it("keeps each card's body with its card when a reorder is undone (#582)", () => {
    // A reorder is equal-length but moves positions, so a position-indexed rich-text overlay would
    // graft each card's body onto whichever card now sits at that slot. Undoing a reorder must carry
    // every card's body back with its own card, which only a wholesale restore of the snapshot does.
    const state0 = initialBlockEditorState([
      cardGrid([card("Alpha", doc("Body A")), card("Beta", doc("Body B"))]),
    ]);
    // Swap the two cards. Each card object (title and body together) moves to the other position.
    let state = reduce(state0, {
      kind: "setData",
      id: "c1",
      data: { cards: [card("Beta", doc("Body B")), card("Alpha", doc("Body A"))] },
    });
    state = reduce(state, { kind: "undo" });
    const cards = state.blocks[0].data.cards as { title: string; body: unknown }[];
    expect(cards[0].title).toBe("Alpha");
    expect(cards[0].body).toEqual(doc("Body A"));
    expect(cards[1].title).toBe("Beta");
    expect(cards[1].body).toEqual(doc("Body B"));
  });

  // Reorders of cards that differ ONLY in rich text (#617). Stripping the rich-text sub-fields makes
  // such cards indistinguishable position by position, so the swap used to round-trip as "nothing
  // changed" and the editor could not undo it. The counting rule below tells the two cases apart:
  // rich text differing at ONE position is a body edit the card's own history owns; rich text
  // differing at SEVERAL positions cannot come from a single body edit and is a reorder.

  it("pushes a reorder of cards that differ only in rich text onto the outer undo (#617)", () => {
    // Two cards identical in every plain sub-field (title, imageAssetId, href) -- only their bodies
    // tell them apart. Swapping them changes nothing the plain compare can see.
    const state0 = initialBlockEditorState([
      cardGrid([card("", doc("Body A")), card("", doc("Body B"))]),
    ]);
    const state = reduce(state0, {
      kind: "setData",
      id: "c1",
      data: { cards: [card("", doc("Body B")), card("", doc("Body A"))] },
    });
    expect(state.undo).toHaveLength(1);
    // A reorder is never one continuous typing session, so it must not coalesce with anything.
    expect(state.coalesce).toBeNull();
  });

  it("undoes a rich-text-only reorder by persisted item id (#617, #1127)", () => {
    const state0 = initialBlockEditorState([
      cardGrid([card("", doc("Body A")), card("", doc("Body B"))]),
    ]);
    const [first, second] = state0.blocks[0].data.cards as Record<string, unknown>[];
    let state = reduce(state0, {
      kind: "setData",
      id: "c1",
      data: { cards: [second, first] },
    });
    expect(
      (state.blocks[0].data.cards as Record<string, unknown>[]).map(
        (item) => item.itemId,
      ),
    ).toEqual([second.itemId, first.itemId]);
    state = reduce(state, { kind: "undo" });
    const cards = state.blocks[0].data.cards as Record<string, unknown>[];
    expect(cards.map((item) => item.itemId)).toEqual([
      first.itemId,
      second.itemId,
    ]);
    expect(cards[0].body).toEqual(doc("Body A"));
    expect(cards[1].body).toEqual(doc("Body B"));
  });

  it("still leaves a lone card's body edit out of the outer undo when its siblings match (#617)", () => {
    // The counting rule must not turn an ordinary body edit into a structural change: only ONE
    // position differs in rich text, so this is still the card's own TipTap history to undo.
    const state0 = initialBlockEditorState([
      cardGrid([card("", doc("Body A")), card("", doc()), card("", doc())]),
    ]);
    const state = reduce(state0, {
      kind: "setData",
      id: "c1",
      data: { cards: [card("", doc("Body A typed")), card("", doc()), card("", doc())] },
    });
    expect(state.undo).toHaveLength(0);
    expect(state.blocks[0].data.cards).toHaveLength(3);
  });

  it("does not read re-cloned but unchanged bodies as a reorder (#617)", () => {
    // Every card here is rebuilt, so each body is a fresh object holding the same document. Counting
    // by reference would see three "changed" positions and push a phantom reorder onto the stack.
    const state0 = initialBlockEditorState([
      cardGrid([card("", doc("A")), card("", doc("B")), card("", doc("C"))]),
    ]);
    const state = reduce(state0, {
      kind: "setData",
      id: "c1",
      data: { cards: [card("", doc("A")), card("", doc("B")), card("", doc("C"))] },
    });
    expect(state.undo).toHaveLength(0);
  });

  it("redoes a rich-text-only reorder that was undone (#617, #1035)", () => {
    const first = card("", doc("Body A"));
    const second = card("", doc("Body B"));
    const state0 = initialBlockEditorState([cardGrid([first, second])]);
    let state = reduce(state0, { kind: "setData", id: "c1", data: { cards: [second, first] } });
    state = reduce(state, { kind: "undo" });
    expect(state.redo).toHaveLength(1);
    state = reduce(state, { kind: "redo" });
    const cards = state.blocks[0].data.cards as { body: unknown }[];
    expect(cards[0].body).toEqual(doc("Body B"));
    expect(cards[1].body).toEqual(doc("Body A"));
  });

  it("maps a later body edit across redo of an undone reorder (#617, #1035, #1127)", () => {
    const state0 = initialBlockEditorState([
      cardGrid([card("Alpha", doc("Body A")), card("Beta", doc("Body B"))]),
    ]);
    const [alpha, beta] = state0.blocks[0].data.cards as Record<string, unknown>[];
    let state = reduce(state0, {
      kind: "setData",
      id: "c1",
      data: { cards: [beta, alpha] },
    });
    state = reduce(state, { kind: "undo" });
    expect(state.redo).toHaveLength(1);

    const originalOrder = state.blocks[0].data.cards as Record<string, unknown>[];
    state = reduce(state, {
      kind: "setData",
      id: "c1",
      data: {
        cards: [
          { ...originalOrder[0], body: doc("Body A rewritten") },
          originalOrder[1],
        ],
      },
    });
    expect(state.undo).toHaveLength(0);
    expect(state.redo).toHaveLength(1);

    state = reduce(state, { kind: "redo" });
    const redone = state.blocks[0].data.cards as Record<string, unknown>[];
    expect(redone.map((item) => item.itemId)).toEqual([
      beta.itemId,
      alpha.itemId,
    ]);
    expect(redone[0].body).toEqual(doc("Body B"));
    expect(redone[1].body).toEqual(doc("Body A rewritten"));
  });

  // Coalescing granularity for list-backed fields (#582). The coalesce key must distinguish which
  // item and which sub-field an edit touched: a `cards` list keyed only by its top-level field name
  // folds every card's edit into one undo entry, so an undo aimed at the last card's edit silently
  // discards edits to earlier cards -- unrecoverable, since v1 has no redo stack.
  it("keeps an earlier card's edit when a later card's edit is undone (#582)", () => {
    const state0 = initialBlockEditorState([cardGrid([card("Card one", doc()), card("Card two", doc())])]);
    // Edit card 1's title, then card 2's title: two different items, so two undo entries.
    let state = reduce(state0, {
      kind: "setData",
      id: "c1",
      data: { cards: [card("Card one edited", doc()), card("Card two", doc())] },
    });
    state = reduce(state, {
      kind: "setData",
      id: "c1",
      data: { cards: [card("Card one edited", doc()), card("Card two edited", doc())] },
    });
    expect(state.undo).toHaveLength(2);
    // One undo reverts only card 2's edit; card 1's edit stands.
    state = reduce(state, { kind: "undo" });
    const cards = state.blocks[0].data.cards as { title: string }[];
    expect(cards[0].title).toBe("Card one edited");
    expect(cards[1].title).toBe("Card two");
  });

  it("coalesces consecutive keystroke edits to the same card field into one undo entry (#582)", () => {
    const state0 = initialBlockEditorState([cardGrid([card("", doc())])]);
    // Three keystrokes into one card's title are the same continuous action: one undo entry.
    let state = reduce(state0, { kind: "setData", id: "c1", data: { cards: [card("N", doc())] } });
    state = reduce(state, { kind: "setData", id: "c1", data: { cards: [card("Ne", doc())] } });
    state = reduce(state, { kind: "setData", id: "c1", data: { cards: [card("New", doc())] } });
    expect(state.undo).toHaveLength(1);
    // The single entry restores to before the session began.
    state = reduce(state, { kind: "undo" });
    expect((state.blocks[0].data.cards as { title: string }[])[0].title).toBe("");
  });

  it("starts a new undo entry when editing a different sub-field of the same card (#582)", () => {
    const state0 = initialBlockEditorState([cardGrid([card("Title", doc())])]);
    // Edit the title, then the link of the same card: different sub-fields, two continuous actions.
    let state = reduce(state0, {
      kind: "setData",
      id: "c1",
      data: { cards: [{ title: "Title edited", body: doc(), imageAssetId: "", href: "" }] },
    });
    state = reduce(state, {
      kind: "setData",
      id: "c1",
      data: { cards: [{ title: "Title edited", body: doc(), imageAssetId: "", href: "https://example.org" }] },
    });
    expect(state.undo).toHaveLength(2);
  });

  it("remaps a field-restore undo entry onto the reconciled id (#582, #515)", () => {
    // A field edit leaves a restore entry keyed by the block's temporary id. A save reconciles
    // that id, so the entry must follow it or a later undo would target a block that no longer
    // carries the temporary id.
    let state = reduce(initialBlockEditorState(), insert(createBlock("headline", "temp-1"), 0));
    state = reduce(state, { kind: "setData", id: "temp-1", data: { text: "Draft" } });
    state = reduce(state, { kind: "reconcileIds", idMap: { "temp-1": "srv-1" } });
    // Undo the field edit; it must restore the block now carrying the canonical id.
    state = reduce(state, { kind: "undo" });
    expect(state.blocks.find((b) => b.id === "srv-1")?.data).toEqual({ text: "" });
  });

  it("clears a lingering error", () => {
    let state = reduce(initialBlockEditorState(), insert(createBlock("headline", "h1"), 0));
    state = reduce(state, insert(createBlock("headline", "h2"), 1));
    expect(state.error).not.toBeNull();
    state = reduce(state, { kind: "clearError" });
    expect(state.error).toBeNull();
  });

  it("reconciles a block's server id onto the live list, keeping its data (#515)", () => {
    // A block placed with a client-minted id, then a save returns its server-minted id. The
    // reconcile maps the temporary id to the canonical one, so the editor now carries the
    // server id, not the temporary client one.
    let state = reduce(initialBlockEditorState(), insert(createBlock("headline", "temp-1"), 0));
    state = reduce(state, { kind: "reconcileIds", idMap: { "temp-1": "srv-1" } });
    expect(state.blocks.map((b) => b.id)).toEqual(["srv-1"]);
    // The block's type/data are untouched; only its id changed.
    expect(state.blocks[0]).toMatchObject({ id: "srv-1", type: "headline" });
  });

  it("does not reconcile a block id through an inherited map property", () => {
    const state = reduce(
      initialBlockEditorState(),
      insert(createBlock("headline", "constructor"), 0),
    );

    const next = reduce(state, { kind: "reconcileIds", idMap: {} });

    expect(next.blocks[0].id).toBe("constructor");
    expect(typeof next.blocks[0].id).toBe("string");
    expect(next.undo).toEqual([{ kind: "remove", id: "constructor" }]);
  });

  it("keeps an in-flight-added block's temporary id while reconciling the saved one (#515)", () => {
    // The save sent one block (temp-1). While it was pending, a second block (temp-2) was
    // added, so the id map only names temp-1. The reconcile stabilizes temp-1's id and leaves
    // temp-2's temporary id in place, so the in-flight edit survives and is minted next save.
    let state = reduce(initialBlockEditorState(), insert(createBlock("headline", "temp-1"), 0));
    state = reduce(state, insert(createBlock("divider", "temp-2"), 1));
    state = reduce(state, { kind: "reconcileIds", idMap: { "temp-1": "srv-1" } });
    expect(state.blocks.map((b) => b.id)).toEqual(["srv-1", "temp-2"]);
  });

  it("preserves and remaps the undo stack on reconcile so undo stays replayable (#515)", () => {
    // Placing a block leaves an inverse ("remove temp-1") on the stack. Reconciling temp-1's
    // saved id keeps that inverse, remapped to the canonical id so replaying it targets the
    // reconciled block rather than a temporary id that no longer exists.
    let state = reduce(initialBlockEditorState(), insert(createBlock("headline", "temp-1"), 0));
    expect(state.undo).toHaveLength(1);
    state = reduce(state, { kind: "reconcileIds", idMap: { "temp-1": "srv-1" } });
    expect(state.undo).toEqual([{ kind: "remove", id: "srv-1" }]);
    // Undo replays the remapped inverse and removes the reconciled block.
    state = reduce(state, { kind: "undo" });
    expect(state.blocks).toEqual([]);
  });

  it("keeps an in-flight-added block's undo entry when reconcile does not name it (#515)", () => {
    // temp-1 was sent and saved; temp-2 was added while the save was in flight, so the id map
    // names only temp-1. temp-2's inverse must survive the reconcile so the in-flight-added
    // block can still be undone — the old behavior cleared the whole stack and lost it.
    let state = reduce(initialBlockEditorState(), insert(createBlock("headline", "temp-1"), 0));
    state = reduce(state, insert(createBlock("divider", "temp-2"), 1));
    expect(state.undo).toHaveLength(2);
    state = reduce(state, { kind: "reconcileIds", idMap: { "temp-1": "srv-1" } });
    // Both inverses survive: temp-1's is remapped to srv-1, temp-2's is left untouched.
    expect(state.undo).toEqual([
      { kind: "remove", id: "srv-1" },
      { kind: "remove", id: "temp-2" },
    ]);
    // Undo removes the in-flight-added block, whose temp id is minted on the next save.
    state = reduce(state, { kind: "undo" });
    expect(state.blocks.map((b) => b.id)).toEqual(["srv-1"]);
  });

  it("clears a lingering error on reconcile", () => {
    let state = reduce(initialBlockEditorState(), insert(createBlock("headline", "h1"), 0));
    state = reduce(state, insert(createBlock("headline", "h2"), 1));
    expect(state.error).not.toBeNull();
    state = reduce(state, { kind: "reconcileIds", idMap: { h1: "srv-1" } });
    expect(state.error).toBeNull();
  });
});

// Undo alone could take a removal back but never put it forward again, so a person who stepped
// one action too far had to redo the work by hand. Redo replays what undo took back, in the same
// single order the undo stack keeps, across structure, visibility, and plain-field edits (#1035).
describe("blockEditorReducer redo (#1035)", () => {
  it("redoes a removal undo took back", () => {
    let state = reduce(initialBlockEditorState(), insert(createBlock("headline", "h1"), 0));
    state = reduce(state, { kind: "apply", op: { kind: "remove", id: "h1" } });
    expect(state.blocks).toEqual([]);

    state = reduce(state, { kind: "undo" });
    expect(state.blocks.map((block) => block.id)).toEqual(["h1"]);
    expect(state.redo).toHaveLength(1);

    state = reduce(state, { kind: "redo" });
    expect(state.blocks).toEqual([]);
    // The redone step returns to the undo stack, so the history can be walked either way.
    expect(state.redo).toHaveLength(0);
    expect(state.undo).toHaveLength(2);
  });

  it("walks insert, move, visibility, and field changes back and forward in one order", () => {
    let state = reduce(initialBlockEditorState(), insert(createBlock("headline", "h1"), 0));
    state = reduce(state, insert(createBlock("divider", "d1"), 1));
    state = reduce(state, { kind: "setData", id: "h1", data: { text: "Tonight on NJ PBS" } });
    state = reduce(state, { kind: "setVisible", id: "d1", visible: false });
    state = reduce(state, { kind: "apply", op: { kind: "move", id: "h1", toIndex: 1 } });
    expect(state.blocks.map((block) => block.id)).toEqual(["d1", "h1"]);

    // Undo everything, newest first.
    for (let step = 0; step < 5; step++) state = reduce(state, { kind: "undo" });
    expect(state.blocks).toEqual([]);
    expect(state.undo).toHaveLength(0);
    expect(state.redo).toHaveLength(5);

    // Redo everything, oldest first, landing back on the same content in the same order.
    for (let step = 0; step < 5; step++) state = reduce(state, { kind: "redo" });
    expect(state.blocks.map((block) => block.id)).toEqual(["d1", "h1"]);
    expect(state.blocks.find((block) => block.id === "h1")?.data.text).toBe("Tonight on NJ PBS");
    expect(state.blocks.find((block) => block.id === "d1")?.visible).toBe(false);
    expect(state.redo).toHaveLength(0);
  });

  it("drops the redo stack once a new edit is made, so redo never replays a discarded branch", () => {
    let state = reduce(initialBlockEditorState(), insert(createBlock("headline", "h1"), 0));
    state = reduce(state, insert(createBlock("divider", "d1"), 1));
    state = reduce(state, { kind: "undo" });
    expect(state.redo).toHaveLength(1);

    state = reduce(state, { kind: "setData", id: "h1", data: { text: "New direction" } });
    expect(state.redo).toHaveLength(0);
    state = reduce(state, { kind: "redo" });
    expect(state.blocks.map((block) => block.id)).toEqual(["h1"]);
  });

  it("keeps a rich-text edit made after an undo when that undo is redone", () => {
    // The outer stack owns the card's title; the card body owns its own history. Redoing the
    // title change must not carry an older body back over the newer one, exactly as undo must not.
    const card = {
      label: "",
      title: "Passport",
      body: { type: "doc", content: [] },
      imageAssetId: "",
      href: "",
    };
    let state = initialBlockEditorState([
      { ...createBlock("card_grid", "c1"), data: { cards: [card] } },
    ]);
    state = reduce(state, {
      kind: "setData",
      id: "c1",
      data: { cards: [{ ...card, title: "Passport benefits" }] },
    });
    state = reduce(state, { kind: "undo" });
    // A body typed after the undo, through the card's own editor.
    const typedBody = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Member benefits." }] }],
    };
    state = reduce(state, {
      kind: "setData",
      id: "c1",
      data: { cards: [{ ...card, body: typedBody }] },
    });
    state = reduce(state, { kind: "redo" });
    const redone = (state.blocks[0]!.data.cards as Record<string, unknown>[])[0]!;
    expect(redone.title).toBe("Passport benefits");
    expect(redone.body).toEqual(typedBody);
  });

  it("remaps the redo stack onto canonical ids after a save (#515)", () => {
    let state = reduce(initialBlockEditorState(), insert(createBlock("headline", "temp-1"), 0));
    state = reduce(state, { kind: "undo" });
    expect(state.redo).toEqual([
      { kind: "insert", block: expect.objectContaining({ id: "temp-1" }), index: 0 },
    ]);
    state = reduce(state, { kind: "reconcileIds", idMap: { "temp-1": "srv-1" } });
    state = reduce(state, { kind: "redo" });
    expect(state.blocks.map((block) => block.id)).toEqual(["srv-1"]);
  });

  it("does nothing when there is nothing to redo", () => {
    const state = initialBlockEditorState([createBlock("headline", "h1")]);
    expect(reduce(state, { kind: "redo" })).toBe(state);
  });

  // A rich-text edit does not push onto the undo stack, so it does not end the redo branch --
  // which is right for an unrelated step and catastrophic for one that would destroy the very
  // text just typed. Remove a block, take the removal back, write into the restored block, and a
  // waiting redo would delete the block and the new writing with it. Those entries are dropped;
  // entries that cannot touch the edited block stay redoable.
  it("drops a redo that would destroy rich text written after the undo", () => {
    const prose = {
      ...createBlock("prose", "p1"),
      data: { content: { type: "doc", content: [] } },
    };
    let state = initialBlockEditorState([prose]);
    state = reduce(state, { kind: "apply", op: { kind: "remove", id: "p1" } });
    state = reduce(state, { kind: "undo" });
    expect(state.redo).toHaveLength(1);

    const typed = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Newly written." }] }],
    };
    state = reduce(state, { kind: "setData", id: "p1", data: { content: typed } });
    expect(state.redo).toHaveLength(0);

    state = reduce(state, { kind: "redo" });
    expect(state.blocks.map((block) => block.id)).toEqual(["p1"]);
    expect(state.blocks[0]!.data.content).toEqual(typed);
  });

  it("drops a redo that would restore a card list over a body written after the undo", () => {
    const card = {
      label: "",
      title: "Passport",
      body: { type: "doc", content: [] },
      imageAssetId: "",
      href: "",
    };
    const second = { ...card, title: "Watch" };
    let state = initialBlockEditorState([
      { ...createBlock("card_grid", "c1"), data: { cards: [card, second] } },
    ]);
    // A structural list change: the removal of a card, which restores wholesale.
    state = reduce(state, { kind: "setData", id: "c1", data: { cards: [card] } });
    state = reduce(state, { kind: "undo" });
    expect(state.redo).toHaveLength(1);

    const typed = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Member benefits." }] }],
    };
    state = reduce(state, {
      kind: "setData",
      id: "c1",
      data: { cards: [{ ...card, body: typed }, second] },
    });
    expect(state.redo).toHaveLength(0);
  });

  it("keeps a redo that cannot reach the block whose rich text was edited", () => {
    let state = initialBlockEditorState([
      { ...createBlock("prose", "p1"), data: { content: { type: "doc", content: [] } } },
    ]);
    state = reduce(state, insert(createBlock("divider", "d1"), 1));
    state = reduce(state, { kind: "undo" });
    expect(state.redo).toHaveLength(1);

    state = reduce(state, {
      kind: "setData",
      id: "p1",
      data: {
        content: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Body." }] }],
        },
      },
    });
    // Re-inserting the divider takes nothing away from the prose block, so it stays redoable.
    expect(state.redo).toHaveLength(1);
    state = reduce(state, { kind: "redo" });
    expect(state.blocks.map((block) => block.id)).toEqual(["p1", "d1"]);
  });

  // A redo stack is replayed from its end. Dropping one unsafe entry from the middle would leave
  // the entries queued behind it composed against a step that never ran, so the branch is cut at
  // the unsafe entry and only the steps that redo before it survive.
  it("cuts the redo branch at the unsafe entry rather than leaving a hole in it", () => {
    let state = initialBlockEditorState([
      { ...createBlock("prose", "p1"), data: { content: { type: "doc", content: [] } } },
    ]);
    state = reduce(state, insert(createBlock("divider", "d1"), 1));
    state = reduce(state, { kind: "apply", op: { kind: "remove", id: "p1" } });
    // Undo both: redo now holds [re-remove p1 (redone last), re-insert d1 (redone first)].
    state = reduce(state, { kind: "undo" });
    state = reduce(state, { kind: "undo" });
    expect(state.redo).toHaveLength(2);

    state = reduce(state, {
      kind: "setData",
      id: "p1",
      data: {
        content: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Kept." }] }],
        },
      },
    });
    // The divider insert still redoes; the removal behind it does not.
    expect(state.redo).toHaveLength(1);
    state = reduce(state, { kind: "redo" });
    expect(state.blocks.map((block) => block.id)).toEqual(["p1", "d1"]);
    expect(state.redo).toHaveLength(0);
  });

  it("converts a prose block into sibling link cards and undoes it", () => {
    const prose = createBlock("prose", "news");
    let state = initialBlockEditorState([prose]);
    state = blockEditorReducer("genericPage", state, {
      kind: "editRows",
      edit: {
        kind: "replaceMany",
        id: "news",
        blocks: [
          { ...createBlock("link_card", "card-1"), data: { title: "First", url: "https://example.com/first" } },
          { ...createBlock("link_card", "card-2"), data: { title: "Second", url: "https://example.com/second" } },
        ],
      },
    });
    expect(state.blocks.map((block) => block.type)).toEqual(["link_card", "link_card"]);
    expect(state.blocks.map((block) => block.id)).toEqual(["card-1", "card-2"]);
    state = blockEditorReducer("genericPage", state, { kind: "undo" });
    expect(state.blocks).toEqual([prose]);
    state = blockEditorReducer("genericPage", state, { kind: "redo" });
    expect(state.blocks.map((block) => block.id)).toEqual(["card-1", "card-2"]);
  });

  it("coalesces coverage title typing and keeps adding an article as its own undo entry", () => {
    const blank = { title: "", outlet: "", date: "", url: "" };
    const coverage = {
      ...createBlock("coverage_list", "cov"),
      data: { entries: [{ ...blank, title: "" }] },
    };
    let state = initialBlockEditorState([coverage]);
    state = blockEditorReducer("genericPage", state, {
      kind: "setData",
      id: "cov",
      data: { entries: [{ ...blank, title: "S" }] },
    });
    state = blockEditorReducer("genericPage", state, {
      kind: "setData",
      id: "cov",
      data: { entries: [{ ...blank, title: "St" }] },
    });
    expect(state.undo).toHaveLength(1);
    state = blockEditorReducer("genericPage", state, {
      kind: "setData",
      id: "cov",
      data: { entries: [{ ...blank, title: "St" }, { ...blank }] },
    });
    expect(state.undo).toHaveLength(2);
  });
});
