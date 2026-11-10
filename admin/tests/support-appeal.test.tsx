import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BlockEditor } from "../src/components/BlockEditor";
import { BlockPreview } from "../src/components/BlockPreview";
import { createBlock } from "../src/lib/block-factory";
import { imageAsset } from "./media-tile-fixtures";

afterEach(cleanup);

it("keeps the appeal text preview when the optional image cannot be loaded", async () => {
  const block = createBlock("support_appeal", "appeal");
  block.data.backgroundImageAssetId = "unavailable-photo";
  render(<BlockPreview block={block} />);
  expect(await screen.findByTitle("Support appeal preview")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Image preview is loading or unavailable.");
});

it("previews an appeal inside a row with its selected media-library image", async () => {
  const block = { ...createBlock("support_appeal", "row-appeal"), layout: { rowId: "row", column: 0 } };
  block.data.backgroundImageAssetId = "photo";
  render(<BlockPreview block={block} loadMedia={async () => ({ success: true, records: [imageAsset({ id: "photo" })], page: 1,
    pageCount: 1, total: 1, allCount: 1, categoryCounts: {}, kindCounts: { image: 1 } })} />);
  expect(await screen.findByTitle("Support appeal preview")).toBeInTheDocument();
});

it("lets staff add, edit, preview and remove a Post support appeal", async () => {
  const save = vi.fn(async () => {});
  const { container } = render(<BlockEditor section="post" newId={() => "appeal"} onSave={save} />);
  fireEvent.click(screen.getByRole("button", { name: "Add content: position 1" }));
  fireEvent.click(screen.getByRole("radio", { name: "support appeal" }));
  fireEvent.click(screen.getByRole("button", { name: "Insert block" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Heading" }), { target: { value: "" } });
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Done" }));
  fireEvent.click(screen.getByRole("button", { name: "Save page" }));
  const invalidHeading = await screen.findByRole("textbox", { name: "Heading" });
  expect(invalidHeading).toHaveAttribute("aria-invalid", "true");
  expect(invalidHeading).toHaveAccessibleDescription(/Heading is required/);
  expect(document.querySelectorAll(`[id="${invalidHeading.id}"]`)).toHaveLength(1);
  expect(save).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox", { name: "Heading" }), { target: { value: "Keep local stories strong" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Appeal text" }), { target: { value: "Give to support NJ PBS." } });
  fireEvent.change(screen.getByRole("textbox", { name: "Button text" }), { target: { value: "Give today" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Button link" }), { target: { value: "https://example.org/donate" } });
  const styles = screen.getByRole("combobox", { name: "Style" });
  expect(within(styles).getAllByRole("option").map(option => option.textContent)).toEqual(["PBS blue", "Light (lavender)", "Dark with teal accent"]);
  fireEvent.change(styles, { target: { value: "dark" } });
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Done" }));
  await waitFor(() => expect(container.querySelector("iframe[title='Support appeal preview']")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Save page" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith([expect.objectContaining({ type: "support_appeal", data: {
    heading: "Keep local stories strong", copy: "Give to support NJ PBS.", buttonLabel: "Give today", href: "https://example.org/donate", style: "dark",
  } })]));
  fireEvent.click(screen.getByRole("button", { name: "Edit support appeal 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove support appeal 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm removal of support appeal 1" }));
  expect(screen.queryByRole("button", { name: "Edit support appeal 1" })).not.toBeInTheDocument();
});
