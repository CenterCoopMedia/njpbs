import { BlockEditor } from "../src/components/BlockEditor";
import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HomeCuratedShelfEditor } from "../src/components/HomeCuratedShelfEditor";
import type { AdminBlock } from "../src/lib/block-factory";
import { readHomeEditorialSourceReceipt } from "../../packages/content-core/src/home-source-catalog";
import type { HomeSourceSnapshot } from "../../packages/content-core/src/home-rail-render";
import fixture from "../../site/tests/fixtures/home-v2-selections.json";

const load = async (): Promise<HomeSourceSnapshot> => ({ schemaVersion: 1, publication: fixture.editorial.receipt,
  editorial: readHomeEditorialSourceReceipt(fixture.editorial),
  pbs: { source: "media-manager", checkedAt: null, featured: [], more: [] },
  spotlight: { source: "spotlight-rss", checkedAt: null, cards: [] } });
function Harness({ selectedIds }: { selectedIds?: string[] }) {
  const [block, setBlock] = useState<AdminBlock>(() => {
    const value = structuredClone(fixture.home.blocks.find(block => block.section === "home-posts")) as AdminBlock;
    value.data.itemLimit = 6;
    if (selectedIds) value.data.selectedIds = selectedIds;
    return value;
  });
  return <><HomeCuratedShelfEditor block={block} blocks={[block]} loadSources={load}
    onChange={data => setBlock({ ...block, data })} /><output data-testid="saved">{JSON.stringify(block.data)}</output></>;
}
describe("curated Home layout authoring", () => {
  it.each(["two_features", "list"])("clears a repaired heading error for %s without another save", async presentation => {
    const blocks = structuredClone(fixture.home.blocks) as AdminBlock[];
    blocks.find(block => block.section === "home-posts")!.data.presentation = presentation;
    const save = vi.fn();
    render(<BlockEditor section="home" pageId="home" homeCompositionVersion={2}
      initialBlocks={blocks} loadHomeSources={load} onSave={save} commandsInline />);
    const editShelf = () => fireEvent.click(within(document.querySelector('[data-home-section="home-posts"]') as HTMLElement).getByRole("button", { name: /^Edit / }));
    editShelf();
    let dialog = within(screen.getByRole("dialog"));
    await dialog.findByText("Published generation 21.");
    fireEvent.change(dialog.getByRole("textbox", { name: /^Heading$/ }), { target: { value: "" } });
    fireEvent.click(dialog.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    expect(save).not.toHaveBeenCalled();
    editShelf();
    dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByRole("alert")).toHaveTextContent("Shelf heading");
    fireEvent.change(dialog.getByRole("textbox", { name: /^Heading$/ }), { target: { value: "From NJ PBS" } });
    await waitFor(() => expect(dialog.queryByRole("alert")).toBeNull());
    expect(save).not.toHaveBeenCalled();
  });
  it.each(["two_features", "list"])("saves %s through the mounted Home editor's field validation", async presentation => {
    const save = vi.fn();
    render(<BlockEditor section="home" pageId="home" homeCompositionVersion={2}
      initialBlocks={structuredClone(fixture.home.blocks) as AdminBlock[]} loadHomeSources={load}
      onSave={save} allowIncomplete commandsInline />);
    fireEvent.click(within(document.querySelector('[data-home-section="home-posts"]') as HTMLElement).getByRole("button", { name: /^Edit / }));
    const dialog = within(screen.getByRole("dialog"));
    await dialog.findByText("Published generation 21.");
    fireEvent.change(dialog.getByRole("combobox", { name: "Layout" }), { target: { value: presentation } });
    fireEvent.click(dialog.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Save page" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0].find((block: AdminBlock) => block.section === "home-posts").data.presentation).toBe(presentation);
  });
  it("offers both layouts, starts a list at three and retains a staff-selected count", async () => {
    render(<Harness />);
    await screen.findByText("Published generation 21.");
    fireEvent.change(screen.getByRole("combobox", { name: "Layout" }), { target: { value: "two_features" } });
    expect(screen.getByTestId("saved")).toHaveTextContent('"presentation":"two_features"');
    fireEvent.change(screen.getByRole("combobox", { name: "Layout" }), { target: { value: "list" } });
    expect(screen.getByRole("combobox", { name: "Number of cards" })).toHaveValue("3");
    fireEvent.change(screen.getByRole("combobox", { name: "Number of cards" }), { target: { value: "6" } });
    expect(screen.getByRole("combobox", { name: "Number of cards" })).toHaveValue("6");
    expect(screen.queryByRole("combobox", { name: "Desktop columns" })).toBeNull();
  });
  it("does not discard a larger saved selection when switching to a list", async () => {
    const selectedIds = ["saved-a", "saved-b", "saved-c", "saved-d"];
    render(<Harness selectedIds={selectedIds} />);
    await screen.findByText("Published generation 21.");
    fireEvent.change(screen.getByRole("combobox", { name: "Layout" }), { target: { value: "list" } });
    const saved = JSON.parse(screen.getByTestId("saved").textContent!);
    expect(saved).toMatchObject({ presentation: "list", selectedIds, itemLimit: 6 });
  });
});
