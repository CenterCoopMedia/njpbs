import { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ComponentEditorDialog } from "../src/components/ComponentEditorDialog";
import { ComponentPhonePreview } from "../src/components/ComponentPhonePreview";
import { ContentShelfSources } from "../src/components/ContentShelfPicker";
import type { MediaPickerLoader } from "../src/components/MediaPickerDialog";
import type { ListMediaResponse } from "../src/lib/functions";
import { createBlock } from "../src/lib/block-factory";

vi.mock("../src/components/HomePreviewFrame", () => ({
  HomePreviewFrame: ({ html }: { html: string }) => <div data-testid="phone-render" dangerouslySetInnerHTML={{ __html: html }} />,
}));
afterEach(cleanup);

function Host({ mounted }: { mounted: () => void }) {
  const [open, setOpen] = useState(true);
  function Preview() { useEffect(mounted, []); return <p>Only this component</p>; }
  return <><button onClick={() => setOpen(true)}>Edit fixture</button>
    <ComponentEditorDialog open={open} onClose={() => setOpen(false)} title="Fixture" preview={<Preview />}>
      <input aria-label="Draft field" defaultValue="Retained draft" />
    </ComponentEditorDialog></>;
}

describe("component phone preview", () => {
  it("renders selected sponsors from their saved records", async () => {
    const block = createBlock("sponsor_strip", "sponsors");
    block.data = { sponsorIds: ["s1"], heading: "With thanks", layout: "row" };
    const loadRecord = vi.fn(async () => ({ status: "ready", record: {
      id: "s1", type: "sponsor", name: "NJ supporter", href: "https://example.org/", status: "draft",
    } }));
    render(<ContentShelfSources.Provider value={{ loadRecord: loadRecord as never }}>
      <ComponentPhonePreview block={block} />
    </ContentShelfSources.Provider>);
    expect(await screen.findByText("NJ supporter")).toBeVisible();
    expect(screen.getByRole("link", { name: "NJ supporter" })).toHaveAttribute("href", "https://example.org/");
  });
  it("starts collapsed on a narrow screen and retains the editor through preview and dialog dismissal", () => {
    const mounted = vi.fn();
    render(<Host mounted={mounted} />);
    const field = screen.getByRole("textbox", { name: "Draft field" });
    expect(mounted).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Expand component preview" }));
    expect(screen.getByText("Only this component")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Close component preview" }));
    expect(screen.getByRole("button", { name: "Phone preview" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Phone preview" }));
    expect(screen.getByText("Only this component")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit fixture" }));
    expect(screen.getByRole("textbox", { name: "Draft field" })).toBe(field);
    expect(field).toHaveValue("Retained draft");
  });

  it("renders every current table row and column rather than the cropped canvas summary", () => {
    const block = createBlock("data_table", "table");
    block.data = { ...block.data, title: "Audience", csv: "County,A,B,C,D\nEssex,1,2,3,4\nMercer,5,6,7,8\nUnion,9,10,11,12\nBergen,13,14,15,16" };
    render(<ComponentPhonePreview block={block} />);
    const table = within(screen.getByTestId("phone-render")).getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(5);
    expect(within(table).getAllByRole("columnheader")).toHaveLength(5);
    expect(within(table).getByText("16")).toBeVisible();
  });
  it("renders a hidden component inside a row without requiring the surrounding document", () => {
    const block = { ...createBlock("headline", "heading"), visible: false, order: 4, layout: { rowId: "other-row", column: 1 } };
    block.data = { ...block.data, text: "The current heading" };
    render(<ComponentPhonePreview block={block} />);
    expect(screen.getByRole("heading", { name: "The current heading" })).toBeVisible();
    expect(block.layout.rowId).toBe("other-row");
  });

  it("renders only the selected row's supplied visible children", () => {
    const row = createBlock("row", "row");
    const child = { ...createBlock("headline", "child"), layout: { rowId: "row", column: 0 } };
    child.data = { ...child.data, text: "Selected row heading" };
    const hidden = { ...child, id: "hidden", visible: false, data: { ...child.data, text: "Hidden child" } };
    render(<ComponentPhonePreview block={row} blocks={[row, child, hidden]} />);
    expect(screen.getByRole("heading", { name: "Selected row heading" })).toBeVisible();
    expect(screen.queryByText("Hidden child")).toBeNull();
  });

  it("batches exact asset hydration and stops queued batches after unmount", async () => {
    const block = createBlock("card_grid", "cards");
    const ids = Array.from({ length: 25 }, (_, index) => `asset-${String(index).padStart(2, "0")}`);
    block.data = { cards: ids.map(id => ({ title: id, imageAssetId: id })) };
    let release!: (result: ListMediaResponse) => void;
    const result = (assetIds: string[]) => ({ records: assetIds.map(id => ({ id, url: `https://example.com/${id}.jpg` })) }) as ListMediaResponse;
    const loadMedia = vi.fn<MediaPickerLoader>().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockImplementation(async query => result(query.assetIds!));
    const first = render(<ComponentPhonePreview block={block} loadMedia={loadMedia} />);
    await waitFor(() => expect(loadMedia).toHaveBeenCalledTimes(1));
    expect(loadMedia.mock.calls[0][0].assetIds).toEqual(ids.slice(0, 12));
    await act(async () => release(result(ids.slice(0, 12))));
    await waitFor(() => expect(screen.getByTestId("phone-render").querySelectorAll("img")).toHaveLength(25));
    expect(loadMedia.mock.calls.map(([query]) => query.assetIds)).toEqual([ids.slice(0, 12), ids.slice(12, 24), ids.slice(24)]);
    first.unmount();

    loadMedia.mockClear().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const second = render(<ComponentPhonePreview block={block} loadMedia={loadMedia} />);
    await waitFor(() => expect(loadMedia).toHaveBeenCalledTimes(1));
    second.unmount();
    await act(async () => release(result(ids.slice(0, 12))));
    expect(loadMedia).toHaveBeenCalledTimes(1);
  });

  it("uses each row child's public heading context and preserves the standalone supplied rank", () => {
    const row = createBlock("row", "row");
    const heading = { ...createBlock("headline", "heading"), layout: { rowId: "row", column: 0 } };
    heading.data = { text: "Section", level: 3 };
    const faq = { ...createBlock("faq_item", "faq"), layout: { rowId: "row", column: 0 } };
    faq.data = { ...faq.data, question: "A question" };
    const { rerender } = render(<ComponentPhonePreview block={row} blocks={[row, heading, faq]} />);
    expect(screen.getByRole("heading", { name: "A question", level: 4 })).toBeVisible();
    const priorHeading = { ...heading, id: "prior", layout: undefined, data: { text: "Earlier page section", level: 4 } };
    rerender(<ComponentPhonePreview block={row} blocks={[row, faq]} headingContext={[priorHeading, row, faq]} />);
    expect(screen.getByRole("heading", { name: "A question", level: 5 })).toBeVisible();
    expect(screen.queryByText("Earlier page section")).toBeNull();
    rerender(<ComponentPhonePreview block={faq} generatedHeadingLevel={5} />);
    expect(screen.getByRole("heading", { name: "A question", level: 5 })).toBeVisible();
  });

});
