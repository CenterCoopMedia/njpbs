import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { BlockEditor } from "../src/components/BlockEditor";
import { PageOutline } from "../src/components/PageOutline";
import { createBlock, type AdminBlock } from "../src/lib/block-factory";
import { pageCompositionSeed } from "../../packages/content-core/src/page-composition-seeds";
import { homeCompositionDefaults } from "../../packages/content-core/src/home-composition";
import { LIVE_BLOG_SIDEBAR } from "../../packages/content-core/src/live-blog-layout";
import { EditorWorkspaceViewProvider } from "../src/context/EditorWorkspaceView";

afterEach(() => { cleanup(); localStorage.clear(); });
function fixture(): AdminBlock[] {
  return [
    { ...createBlock("row", "empty"), data: { columns: [6, 6] } },
    { ...createBlock("row", "filled"), data: { columns: [4, 4, 4] } },
    ...[0, 1, 2].map(column => ({ ...createBlock("prose", `text-${column}`), layout: { rowId: "filled", column } })),
  ].map((block, order) => ({ ...block, order }));
}
function openOutline() { fireEvent.click(screen.getByRole("button", { name: "Outline" })); }

describe("Row → Column → Content navigation", () => {
  it("groups a Home row after Passport without changing stored order or losing its children", () => {
    const blocks: AdminBlock[] = [
      ...homeCompositionDefaults().filter(block => block.section?.startsWith("home-passport-")) as AdminBlock[],
      { ...createBlock("row", "row"), data: { columns: [4, 4, 4] } },
      { ...createBlock("prose", "visible"), layout: { rowId: "row", column: 0 } },
      { ...createBlock("prose", "hidden"), visible: false, layout: { rowId: "row", column: 2 } },
    ].map((block, order) => ({ ...block, order }));
    const snapshot = structuredClone(blocks);
    const onMove = vi.fn();
    render(<EditorWorkspaceViewProvider kind="page"><PageOutline docked navigationOnly pageId="home" includeSectionBoundariesInMoves
      triggerRef={{ current: null }} onClose={vi.fn()} blocks={blocks} blockErrors={{}}
      activeBlockId={null} activeColumn={null} collapsed={false} contentId="test-home-outline" palette={[]}
      readOnly={false} renderKey={id => id} onNavigate={vi.fn()} onMove={onMove} onInsert={() => null} /></EditorWorkspaceViewProvider>);
    const nav = screen.getByRole("navigation", { name: "Content outline" });
    // Fixed hero + paired Passport + row; members and empty columns add no sections.
    expect(screen.getByText("3 sections · reading order")).toBeVisible();
    expect(nav.querySelectorAll(":scope > ol > li")).toHaveLength(2);
    expect(within(nav).getByRole("button", { name: "Go to Row 1, column 2: Empty" })).toBeVisible();
    expect(within(nav).getByText("Hidden")).toBeVisible();
    expect(within(nav).getAllByText("Empty text")).toHaveLength(2);
    expect(blocks).toEqual(snapshot);
    expect(onMove).not.toHaveBeenCalled();
    fireEvent.click(within(nav).getByRole("button", { name: "Move up: Row 1 in content outline" }));
    expect(onMove).toHaveBeenCalledWith("row", 1);
    expect(blocks).toEqual(snapshot);
  });
  it("keeps generic named-section grips fixed while their existing outline move buttons reorder the page", async () => {
    const seed = pageCompositionSeed("watch")!;
    const draft = vi.fn();
    render(<BlockEditor section="programLanding" pageId="watch" initialBlocks={seed.blocks as AdminBlock[]} onDraftChange={draft} commandsInline />);
    openOutline();
    const nav = await screen.findByRole("navigation", { name: "Content outline" });
    const grip = within(nav).getByRole("button", { name: "Move: buttons 1 in content outline" });
    expect(grip).toBeDisabled();
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    expect(draft).not.toHaveBeenCalled();
    fireEvent.click(within(nav).getByRole("button", { name: "Move down: buttons 1 in content outline" }));
    expect(draft.mock.calls.at(-1)?.[0].map((block: AdminBlock) => block.section)).toEqual(["body-copy", "hero-actions", "watch-destinations", "service-note"]);
  });
  it("moves live blog sidebar planks with the outline grip and keeps read-only grips disabled", async () => {
    const blocks = ["first", "second"].map((id, order) => ({ ...createBlock("prose", id), order, section: LIVE_BLOG_SIDEBAR }));
    const draft = vi.fn();
    const { rerender } = render(<BlockEditor section="post" liveBlogSidebar initialBlocks={blocks} onDraftChange={draft} commandsInline />);
    openOutline();
    const nav = await screen.findByRole("navigation", { name: "Content outline" });
    const grip = within(nav).getByRole("button", { name: "Move: text 1 in content outline" });
    expect(grip).toBeEnabled();
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    expect(draft.mock.calls.at(-1)?.[0].map((block: AdminBlock) => block.id)).toEqual(["second", "first"]);
    expect(draft.mock.calls.at(-1)?.[0].every((block: AdminBlock) => block.section === LIVE_BLOG_SIDEBAR)).toBe(true);
    rerender(<BlockEditor section="post" liveBlogSidebar initialBlocks={blocks} onDraftChange={draft} commandsInline readOnly />);
    within(nav).getAllByRole("button", { name: /^Move:/ }).forEach(button => expect(button).toBeDisabled());
  });

  it("nests the exact handoff fixture, locates columns and keeps disclosure state separate from content", () => {
    const onDraftChange = vi.fn();
    const { container } = render(<BlockEditor section="post" initialBlocks={fixture()} onDraftChange={onDraftChange} commandsInline />);
    const editors = [...container.querySelectorAll('[contenteditable="true"]')];
    expect(editors).toHaveLength(3);
    openOutline();
    expect(screen.getByText("2 rows · 3 blocks")).toBeVisible();
    const nav = screen.getByRole("navigation", { name: "Content outline" });
    expect(nav.querySelectorAll(":scope > ol > li")).toHaveLength(2);
    expect(within(nav).getAllByRole("button", { name: /^Go to text/ })).toHaveLength(3);
    fireEvent.click(within(nav).getByRole("button", { name: "Go to Row 2, column 2: 1 block" }));
    expect(document.activeElement).toBe(container.querySelector("#block-column-filled-1"));
    expect(container.querySelector(".content-row-breadcrumb")).toBeVisible();
    expect(container.querySelector(".content-row-breadcrumb")).toHaveTextContent("Content › Row 2 › Column 2");
    fireEvent.click(within(nav).getByRole("button", { name: "Collapse Row 2" }));
    expect(within(nav).queryByRole("button", { name: /^Go to text/ })).toBeNull();
    expect(container.querySelector("#block-column-filled-1")).toHaveAttribute("data-selected", "true");
    expect([...container.querySelectorAll('[contenteditable="true"]')]).toEqual(editors);
    expect(onDraftChange).not.toHaveBeenCalled();
    openOutline();
    expect(container.querySelector(".block-editor-layout")).toHaveAttribute("data-outline-collapsed", "true");
  });

  it("retains canonical selection, column disclosures and editor instances when save remaps IDs", async () => {
    const initial = fixture();
    const { container } = render(<BlockEditor section="post" initialBlocks={initial} allowIncomplete commandsInline onSave={async blocks => ({ blocks: blocks.map(block => ({ ...block, id: `saved-${block.id}`, ...(block.layout ? { layout: { ...block.layout, rowId: `saved-${block.layout.rowId}` } } : {}) })), mintedIds: Object.fromEntries(blocks.map(block => [block.id, `saved-${block.id}`])) })} />);
    const editors = [...container.querySelectorAll('[contenteditable="true"]')];
    openOutline();
    const nav = screen.getByRole("navigation", { name: "Content outline" });
    fireEvent.click(within(nav).getByRole("button", { name: "Go to Row 2, column 2: 1 block" }));
    fireEvent.click(within(nav).getByRole("button", { name: "Collapse Row 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    await screen.findByText("Saved.");
    expect(within(nav).getByRole("button", { name: "Expand Row 1" })).toHaveAttribute("aria-expanded", "false");
    expect(within(nav).getByRole("button", { name: "Go to Row 2, column 2: 1 block" })).toHaveAttribute("aria-current", "location");
    expect([...container.querySelectorAll('[contenteditable="true"]')]).toEqual(editors);
  });

  it("keeps hidden children counted and opens the actual content picker in an empty column", () => {
    const initial = fixture(); initial[1].visible = false; initial[2].visible = false;
    const draft = vi.fn();
    render(<BlockEditor section="post" initialBlocks={initial} onDraftChange={draft} commandsInline />);
    openOutline();
    const nav = screen.getByRole("navigation", { name: "Content outline" });
    expect(within(nav).getAllByText("Hidden by row").length).toBeGreaterThanOrEqual(3);
    fireEvent.click(within(nav).getAllByRole("button", { name: "Add plank to column 1" })[0]);
    const picker = within(nav).getByRole("radiogroup", { name: "Content types" });
    fireEvent.click(within(picker).getByRole("radio", { name: "image" }));
    fireEvent.click(screen.getByRole("button", { name: "Insert block" }));
    expect(draft.mock.calls.at(-1)?.[0].find((block: AdminBlock) => block.type === "image").layout).toEqual({ rowId: "empty", column: 0 });
  });

  it("does not navigate from an empty outline column when insertion fails", () => {
    const navigate = vi.fn();
    render(<PageOutline triggerRef={{ current: null }} onClose={vi.fn()} blocks={[fixture()[0]]} blockErrors={{}}
      activeBlockId={null} activeColumn={null} collapsed={false} contentId="test-outline" palette={["image"]}
      readOnly={false} renderKey={id => id} onNavigate={navigate} onMove={vi.fn()} onInsert={() => null} />);
    const nav = screen.getByRole("navigation", { name: "Content outline" });
    fireEvent.click(within(nav).getAllByRole("button", { name: "Add plank to column 1" })[0]);
    fireEvent.click(screen.getByRole("radio", { name: "image" }));
    fireEvent.click(screen.getByRole("button", { name: "Insert block" }));
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Add content" })).toBeVisible();
  });

  it("announces totals once and includes empty and inherited hidden states in column names", () => {
    const initial = fixture(); initial[1].visible = false;
    render(<BlockEditor section="post" initialBlocks={initial} commandsInline />);
    openOutline();
    expect(screen.getByText("2 rows · 3 blocks")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("2 rows, 3 blocks in outline")).toHaveClass("sr-only");
    expect(screen.getByRole("button", { name: "Go to Row 1, column 1: Empty" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Go to Row 2, column 2: 1 block, hidden by row" })).toBeVisible();
  });

  it("moves a row past its top-level sibling with its children intact and supports undo", () => {
    const initial = fixture();
    const blocks = [initial[1], ...initial.slice(2), createBlock("prose", "loose"), initial[0]].map((block, order) => ({ ...block, order }));
    const draft = vi.fn();
    const { container } = render(<BlockEditor section="post" initialBlocks={blocks} onDraftChange={draft} commandsInline />);
    const editors = [...container.querySelectorAll('[contenteditable="true"]')];
    openOutline();
    const nav = screen.getByRole("navigation", { name: "Content outline" });
    expect(within(nav).getByRole("button", { name: "Move up: Row 1 in content outline" })).toBeDisabled();
    expect(within(nav).getByRole("button", { name: "Move down: Row 2 in content outline" })).toBeDisabled();
    fireEvent.click(within(nav).getByRole("button", { name: "Move down: Row 1 in content outline" }));
    const moved = draft.mock.calls.at(-1)?.[0] as AdminBlock[];
    expect(moved.map(block => block.id)).toEqual(["loose", "filled", "text-0", "text-1", "text-2", "empty"]);
    expect(moved.filter(block => block.layout?.rowId === "filled").map(block => block.layout?.column)).toEqual([0, 1, 2]);
    expect(new Set(container.querySelectorAll('[contenteditable="true"]'))).toEqual(new Set(editors));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(draft.mock.calls.at(-1)?.[0]).toEqual(blocks);
  });

  it("disables row movement in a read-only outline", () => {
    render(<BlockEditor section="post" initialBlocks={fixture()} readOnly commandsInline />);
    openOutline();
    const nav = screen.getByRole("navigation", { name: "Content outline" });
    for (const button of within(nav).getAllByRole("button", { name: /^Move (up|down): Row/ })) {
      expect(button).toBeDisabled();
    }
  });

  it("provides real column focus targets for a legacy Home document containing rows", () => {
    const { container } = render(<BlockEditor section="home" pageId="home" initialBlocks={fixture()} commandsInline />);
    openOutline();
    fireEvent.click(screen.getByRole("button", { name: "Go to Row 1, column 2: Empty" }));
    const column = container.querySelector("#block-column-empty-1");
    expect(column).not.toBeNull();
    expect(column).toHaveFocus();
    expect(container.querySelector(".content-row-breadcrumb")).toBeVisible();
    expect(container.querySelector(".content-row-breadcrumb")).toHaveTextContent("Content › Row 1 › Column 2");
  });
});
