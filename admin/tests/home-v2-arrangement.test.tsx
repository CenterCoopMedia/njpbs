import { cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockEditor } from "../src/components/BlockEditor";
import type { AdminBlock } from "../src/lib/block-factory";
import { blockEditorReducer, initialBlockEditorState } from "../src/lib/block-editor-state";
import { editContentRows } from "../src/lib/content-row-editing";
import { homeCompositionError } from "../../packages/content-core/src/home-composition-contract";
import { parseBlocks } from "../../packages/content-core/src/content-model";
import v1 from "../../site/tests/fixtures/home-composition-v1.json";

const fixture = () => structuredClone(v1.blocks) as AdminBlock[];
const names = (blocks: readonly AdminBlock[]) => blocks.map(block => block.section);
const expectedMove = ["home-start", "home-start-action", "home-passport-copy", "home-passport-action", "home-featured", "home-more", "home-spotlight"];
function admitted(blocks: AdminBlock[]) {
  const parsed = parseBlocks(blocks, { complete: false });
  expect(parsed.ok).toBe(true);
  if (parsed.ok) expect(homeCompositionError("home", 2, parsed.blocks, { complete: false })).toBeNull();
}
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

// Independent oracle: the accepted spec requires adjacent Passport copy/action,
// retained source IDs, and one array order. The committed v1 fixture supplies IDs.
describe("Home v2 section arrangement", () => {
  it("moves the complete Passport group, refuses internal boundaries, and undoes as one action", () => {
    const original = fixture();
    const moved = blockEditorReducer("home", initialBlockEditorState(original), { kind: "editRows", edit: { kind: "homeV2Move", id: "new-home-passport-copy", destination: { beforeId: "new-home-featured" } } });
    expect(names(moved.blocks)).toEqual(expectedMove);
    admitted(moved.blocks);
    expect(moved.blocks.find(block => block.section === "home-featured")?.data).toEqual(original[2].data);
    const restored = blockEditorReducer("home", moved, { kind: "undo" });
    expect(names(restored.blocks)).toEqual(names(original));
    expect(names(blockEditorReducer("home", restored, { kind: "redo" }).blocks)).toEqual(expectedMove);
    for (const destination of [{ beforeId: "new-home-passport-action" }, { beforeId: "new-home-start-action" }, { layout: { rowId: "row", column: 0 } }]) {
      expect(() => editContentRows("home", original, { kind: "homeV2Move", id: "new-home-featured", destination })).toThrow();
    }
    expect(() => editContentRows("home", original, { kind: "homeV2Move", id: "new-home-passport-action", destination: {} })).toThrow();
  });

  it("withdraws and restores both Passport IDs with one undo, including after canonical reconciliation", () => {
    const original = fixture();
    const hidden = blockEditorReducer("home", initialBlockEditorState(original), { kind: "setVisible", id: "new-home-passport-copy", visible: false, homeSection: true });
    expect(hidden.blocks.filter(block => block.section?.startsWith("home-passport")).map(block => block.visible)).toEqual([false, false]);
    admitted(hidden.blocks);
    const reconciled = blockEditorReducer("home", hidden, { kind: "reconcileIds", idMap: { "new-home-passport-copy": "passport-copy", "new-home-passport-action": "passport-action" } });
    const restored = blockEditorReducer("home", reconciled, { kind: "undo" });
    expect(restored.blocks.filter(block => block.section?.startsWith("home-passport")).map(block => [block.id, block.visible])).toEqual([["passport-copy", true], ["passport-action", true]]);
    admitted(restored.blocks);
  });

  it("keeps internal section boundaries closed to insertion and moves out of a row", () => {
    const original = fixture();
    const row: AdminBlock = { id: "local-row", type: "row", visible: true, order: 7, data: { columns: [12] } };
    const child: AdminBlock = { id: "local-text", type: "prose", visible: true, order: 8, layout: { rowId: row.id, column: 0 }, data: { content: { type: "doc", content: [] } } };
    const blocks = [...original, row, child];
    const destination = { beforeId: "new-home-passport-action" };
    expect(() => editContentRows("home", blocks, { kind: "homeV2Move", id: child.id, destination })).toThrow("between Home sections");
    expect(() => editContentRows("home", blocks, { kind: "insert", block: { ...child, id: "new-text", layout: undefined }, destination })).toThrow("between Home sections");
    // The legacy v1 content area before Start remains available.
    expect(editContentRows("home", original, { kind: "insert", block: { ...child, id: "new-text", layout: undefined }, destination: { beforeId: "new-home-start" } }).blocks[0].id).toBe("new-text");
    const moved = editContentRows("home", blocks, { kind: "homeV2Move", id: child.id, destination: { beforeId: "new-home-passport-copy" } });
    expect(moved.blocks.find(block => block.id === child.id)?.layout).toBeUndefined();
    expect(moved.blocks.map(block => block.id)).toEqual(["new-home-start", "new-home-start-action", "new-home-featured", "local-text", "new-home-passport-copy", "new-home-passport-action", "new-home-more", "new-home-spotlight", "local-row"]);
  });

  it("arranges named sections using keyboard and pointer controls and retains row insertion in Add", async () => {
    const onDraftChange = vi.fn();
    render(<BlockEditor section="home" pageId="home" homeCompositionVersion={2} initialBlocks={fixture()} onDraftChange={onDraftChange} allowIncomplete commandsInline />);
    const passport = document.querySelector<HTMLElement>('[data-home-section="home-passport-copy"]')!;
    const grip = within(passport).getByRole("button", { name: /^Move:/ });
    fireEvent.keyDown(grip, { key: "ArrowUp" });
    await waitFor(() => expect(names(onDraftChange.mock.calls.at(-1)?.[0] ?? [])).toEqual(expectedMove));
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    await waitFor(() => expect(names(onDraftChange.mock.calls.at(-1)?.[0] ?? [])).toEqual(names(fixture())));
    const transfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
    const featured = document.querySelector<HTMLElement>('[data-home-section="home-featured"]')!;
    fireEvent.dragStart(grip, { dataTransfer: transfer });
    fireEvent.drop(featured, { dataTransfer: transfer, clientY: -1 });
    await waitFor(() => expect(names(onDraftChange.mock.calls.at(-1)?.[0] ?? [])).toEqual(expectedMove));
    expect(document.getElementById("block-card-new-home-start")).toBeNull();
    expect(within(passport).getAllByRole("button", { name: /^Move:/ })).toHaveLength(1);
    expect(within(passport).getByRole("button", { name: /^Move:/ })).toHaveAccessibleName(/^Move: text plank/);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "Add" })).getByRole("menuitem", { name: "Row" }));
    await waitFor(() => expect(onDraftChange.mock.calls.at(-1)?.[0].at(-1)).toMatchObject({ type: "row" }));
    expect(names(onDraftChange.mock.calls.at(-1)![0].slice(0, -1))).toEqual(expectedMove);
  });

  it("retains the public newsletter boundary and lets added content move back above it", async () => {
    const blocks = fixture();
    blocks.splice(2, 0, { id: "local-text", type: "prose", order: 2, visible: true, data: { content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Reviewed introduction" }] }] } } });
    const onDraftChange = vi.fn();
    render(<BlockEditor section="home" pageId="home" homeCompositionVersion={2} initialBlocks={blocks.map((block, order) => ({ ...block, order }))} onDraftChange={onDraftChange} allowIncomplete commandsInline />);
    expect(screen.getByRole("region", { name: "Newsletter signup" })).toBeVisible();
    const introduction = document.getElementById("block-card-local-text")!.closest<HTMLElement>(".content-plank-placement")!;
    const grip = within(introduction).getByRole("button", { name: /^Move:/ });
    fireEvent.keyDown(grip, { key: "ArrowUp" });
    await waitFor(() => expect((onDraftChange.mock.calls.at(-1)?.[0] ?? []).map((block: AdminBlock) => block.id)).toEqual(["local-text", ...fixture().map(block => block.id)]));
    expect(document.getElementById("block-card-new-home-start")).toBeNull();
  });

  it("keeps the saved section identity when an Editor removes and adds it", async () => {
    const onDraftChange = vi.fn();
    render(<BlockEditor section="home" pageId="home" homeCompositionVersion={2} initialBlocks={fixture()} onDraftChange={onDraftChange} allowIncomplete commandsInline />);
    fireEvent.click(screen.getByRole("button", { name: /^Edit Passport$/ }));
    const dialog = screen.getByRole("dialog", { name: /^Passport$/ });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Remove section from page/ }));
    await waitFor(() => expect(onDraftChange).toHaveBeenCalled());
    const hidden = onDraftChange.mock.calls.at(-1)![0] as AdminBlock[];
    expect(hidden.map(block => block.id)).toEqual(fixture().map(block => block.id));
    expect(hidden.filter(block => block.section?.startsWith("home-passport")).map(block => block.visible)).toEqual([false, false]);
    fireEvent.click(within(dialog).getByRole("button", { name: /^Add section to page/ }));
    await waitFor(() => expect((onDraftChange.mock.calls.at(-1)![0] as AdminBlock[]).map(block => block.visible)).toEqual(fixture().map(block => block.visible)));
  });

  it("shows the fixed Newsletter boundary in the outline and crosses it one move at a time", async () => {
    const onDraftChange = vi.fn();
    render(<BlockEditor section="home" pageId="home" homeCompositionVersion={2} initialBlocks={fixture()} onDraftChange={onDraftChange} allowIncomplete commandsInline />);
    if (screen.getByRole("button", { name: "Outline" }).getAttribute("aria-expanded") !== "true") fireEvent.click(screen.getByRole("button", { name: "Outline" }));
    const outline = await screen.findByRole("navigation", { name: "Content outline" });
    expect(within(outline).getByText("Newsletter signup")).toBeVisible();
    const boundary = within(outline).getByRole("button", { name: /Go to newsletter band 1: Newsletter signup/ }).closest("li")!;
    expect(within(boundary).getByRole("button", { name: /^Move:/ })).toBeDisabled();
    expect(within(boundary).getByRole("button", { name: /^Move up:/ })).toBeDisabled();
    expect(within(boundary).getByRole("button", { name: /^Move up:/ }))
      .toHaveAccessibleDescription(/Newsletter band stays in its assigned position/);
    expect(within(boundary).getByRole("button", { name: /^Move down:/ })).toBeDisabled();
    const featured = within(outline).getByRole("button", { name: /Go to content shelf 2:/ }).closest("li")!;
    fireEvent.click(within(featured).getByRole("button", { name: /Move up/ }));
    await waitFor(() => expect(names(onDraftChange.mock.calls.at(-1)?.[0] ?? [])).toEqual(["home-featured", "home-start", "home-start-action", "home-passport-copy", "home-passport-action", "home-more", "home-spotlight"]));
    fireEvent.click(within(featured).getByRole("button", { name: /Move down/ }));
    await waitFor(() => expect(names(onDraftChange.mock.calls.at(-1)?.[0] ?? [])).toEqual(names(fixture())));
    expect(within(boundary).getByRole("button", { name: /^Move:/ })).toHaveAttribute("draggable", "false");
  });
});
