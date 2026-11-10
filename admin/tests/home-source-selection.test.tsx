import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeCuratedShelfEditor } from "../src/components/HomeCuratedShelfEditor";
import { EditorWorkspaceViewProvider } from "../src/context/EditorWorkspaceView";
import { BlockEditor } from "../src/components/BlockEditor";
import type { AdminBlock } from "../src/lib/block-factory";
import type { HomeSourceSnapshot } from "../../packages/content-core/src/home-rail-render";
import { readHomeEditorialSourceReceipt } from "../../packages/content-core/src/home-source-catalog";
import currentCatalog from "../../site/tests/fixtures/home-v2-current-catalog.json";
import fixture from "../../site/tests/fixtures/home-v2-selections.json";
const postIds = ["57298ff3b0d0917f9e653f80bada063d", "1208e81a5470be941e3fb392eac674ae"];
const source = (): HomeSourceSnapshot => ({ schemaVersion: 1, publication: { ...fixture.editorial.receipt },
  editorial: readHomeEditorialSourceReceipt(fixture.editorial), pbs: { source: "media-manager", checkedAt: null, featured: [], more: [] },
  spotlight: { source: "spotlight-rss", checkedAt: null, cards: [] } });
afterEach(() => cleanup());
describe("Editor Home card selection", () => {
  it("keeps keyboard focus in the picker after a selected card is removed or added", async () => {
    const load = async () => source();
    render(<BlockEditor section="home" pageId="home" homeCompositionVersion={2} initialBlocks={structuredClone(fixture.home.blocks) as AdminBlock[]}
      loadHomeSources={load} allowIncomplete commandsInline />);
    fireEvent.click(screen.getByRole("button", { name: /Edit.*From NJ PBS|Edit.*content shelf 7|Edit.*content shelf 8/i }));
    const dialog = within(screen.getByRole("dialog"));
    await dialog.findByText("Published generation 21.");
    const search = dialog.getByRole("textbox", { name: "Find published cards" });
    const remove = dialog.getByRole("button", { name: "Remove card 1" });
    act(() => remove.focus()); fireEvent.click(remove);
    expect(search).toHaveFocus();
    const add = within(dialog.getByRole("list", { name: "Available source cards" })).getAllByRole("button")[0];
    act(() => add.focus()); fireEvent.click(add);
    expect(search).toHaveFocus();
  });
  it("switches automatic source rules and hand-picked IDs without a second mode/order array", async () => {
    const draft = vi.fn();
    const load = async () => source();
    render(<BlockEditor section="home" pageId="home" homeCompositionVersion={2} initialBlocks={structuredClone(fixture.home.blocks) as AdminBlock[]}
      loadHomeSources={load} onDraftChange={draft} allowIncomplete commandsInline />);
    fireEvent.click(screen.getByRole("button", { name: /Edit.*From NJ PBS|Edit.*content shelf 7|Edit.*content shelf 8/i }));
    const dialog = screen.getByRole("dialog");
    await within(dialog).findByText("Published generation 21.");
    const mode = within(dialog).getByRole("combobox", { name: "Card selection" });
    fireEvent.change(mode, { target: { value: "automatic" } });
    const automatic = draft.mock.calls.at(-1)![0].find((block: AdminBlock) => block.section === "home-posts").data;
    expect(automatic).not.toHaveProperty("selectedIds");
    expect(automatic).not.toHaveProperty("selectionReceipt");
    expect(within(dialog).getByRole("list", { name: "Automatic source cards" })).toHaveTextContent("NJ PBS announces six staff appointments");
    fireEvent.change(mode, { target: { value: "picked" } });
    const picked = draft.mock.calls.at(-1)![0].find((block: AdminBlock) => block.section === "home-posts").data;
    expect(picked).toMatchObject({ selectedIds: ["1208e81a5470be941e3fb392eac674ae", "57298ff3b0d0917f9e653f80bada063d"], selectionReceipt: fixture.editorial.receipt });
    expect(picked).not.toHaveProperty("mode");
  });
  it("keeps a withdrawn selected ID, moves cards by keyboard and pointer, and saves the exact selection receipt", async () => {
    const current = source();
    const pool = current.editorial!.catalog.sources["home-posts"];
    if (pool.status !== "ready") throw new Error("fixture");
    pool.cards = [pool.cards[0]];
    const load = async () => current;
    const save = vi.fn();
    const draft = vi.fn();
    render(<BlockEditor section="home" pageId="home" homeCompositionVersion={2} initialBlocks={structuredClone(fixture.home.blocks) as AdminBlock[]}
      loadHomeSources={load} onDraftChange={draft} onSave={save} allowIncomplete commandsInline />);
    fireEvent.click(screen.getByRole("button", { name: /Edit.*From NJ PBS|Edit.*content shelf 7|Edit.*content shelf 8/i }));
    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByText(/1 selected card is withdrawn/)).toBeVisible();
    const selected = within(dialog).getByRole("list", { name: "Selected source cards" });
    const grips = within(selected).getAllByRole("button", { name: /^Move selected card:/ });
    fireEvent.keyDown(grips[1], { key: "ArrowUp" });
    await waitFor(() => expect(draft.mock.calls.at(-1)![0].find((block: AdminBlock) => block.section === "home-posts").data.selectedIds).toEqual([...postIds].reverse()));
    fireEvent.click(within(selected).getByRole("button", { name: "Move card 1 down" }));
    await waitFor(() => expect(draft.mock.calls.at(-1)![0].find((block: AdminBlock) => block.section === "home-posts").data.selectedIds).toEqual(postIds));
    fireEvent.click(within(dialog).getByRole("button", { name: /Done|Close editor/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0].find((block: AdminBlock) => block.section === "home-posts").data).toMatchObject({ selectedIds: postIds, selectionReceipt: fixture.editorial.receipt });
  });
  it("refreshes a rejected selection receipt without changing saved IDs, order or missing selections", async () => {
    const current = { ...source(), publication: currentCatalog.receipt, editorial: readHomeEditorialSourceReceipt(currentCatalog) };
    const load = async () => current;
    const draft = vi.fn();
    render(<BlockEditor section="home" pageId="home" homeCompositionVersion={2} initialBlocks={structuredClone(fixture.home.blocks) as AdminBlock[]}
      loadHomeSources={load} onDraftChange={draft} allowIncomplete commandsInline />);
    fireEvent.click(screen.getByRole("button", { name: /Edit.*From NJ PBS|Edit.*content shelf 7|Edit.*content shelf 8/i }));
    const dialog = within(screen.getByRole("dialog"));
    await dialog.findByText("Published generation 22.");
    fireEvent.click(dialog.getByRole("button", { name: "Use current published cards" }));
    const updated = draft.mock.calls.at(-1)![0].find((block: AdminBlock) => block.section === "home-posts");
    expect(updated.data.selectedIds).toEqual(postIds);
    expect(updated.data.selectionReceipt).toEqual(currentCatalog.receipt);
    expect(dialog.getByText(/1 selected card is withdrawn/)).toBeInTheDocument();
  });
  it("adds the optional Post section and restores its existing identity after withdrawal", async () => {
    const draft = vi.fn();
    const load = async () => source();
    render(<BlockEditor section="home" pageId="home" homeCompositionVersion={2} initialBlocks={structuredClone(fixture.home.blocks.slice(0, 7)) as AdminBlock[]}
      newId={() => "new-post-section"} loadHomeSources={load} onDraftChange={draft} allowIncomplete commandsInline />);
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const add = screen.getByRole("menuitem", { name: "NJ PBS Post section" });
    act(() => add.focus()); fireEvent.click(add);
    await waitFor(() => expect(draft).toHaveBeenCalled());
    const added = draft.mock.calls.at(-1)![0].find((block: AdminBlock) => block.section === "home-posts");
    expect(added).toMatchObject({ id: "new-post-section", type: "content_shelf", visible: true, data: { source: "station_posts", selectedIds: [], selectionReceipt: fixture.editorial.receipt } });
    await waitFor(() => expect(document.getElementById("block-card-new-post-section")).toHaveFocus());
    fireEvent.click(within(document.getElementById("block-card-new-post-section")!).getByRole("button", { name: /^Edit / }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /^Remove section from page/ }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    const restore = screen.getByRole("menuitem", { name: "NJ PBS Post section Restore hidden section" });
    act(() => restore.focus()); fireEvent.click(restore);
    await waitFor(() => expect(draft.mock.calls.at(-1)![0].find((block: AdminBlock) => block.section === "home-posts")).toEqual(added));
    await waitFor(() => expect(document.getElementById("block-card-new-post-section")).toHaveFocus());
  });
});


describe("shared shelf source warnings", () => {
  it.each(["error", "missing"] as const)("keeps %s source warnings visible with technical controls closed and IDs untouched", async state => {
    const snapshot = source();
    const block = structuredClone(fixture.home.blocks.find(block => block.section === "home-posts")!) as AdminBlock;
    if (state === "error") snapshot.editorial!.catalog.sources["home-posts"] = { status: "error" };
    else {
      const pool = snapshot.editorial!.catalog.sources["home-posts"];
      if (pool.status !== "ready") throw new Error("fixture");
      pool.cards = [pool.cards[0]];
    }
    const original = structuredClone(block.data);
    const change = vi.fn();
    render(<EditorWorkspaceViewProvider kind="page"><HomeCuratedShelfEditor block={block} blocks={[block]} onChange={change} loadSources={async () => snapshot} /></EditorWorkspaceViewProvider>);
    expect(await screen.findByText(state === "error" ? "This source is unavailable. No replacement cards appear." : /1 selected card is withdrawn/)).toBeVisible();
    expect(screen.getByText("Technical details").closest("details")).not.toHaveAttribute("open");
    expect(block.data).toEqual(original);
    expect(change).not.toHaveBeenCalled();
  });
});
