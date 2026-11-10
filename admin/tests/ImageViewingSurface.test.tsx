import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ImageViewingSurface } from "../src/components/media/ImageViewingSurface";
import type { MediaAssetSummary } from "../src/lib/functions";

const image = (id: string, version = 1): MediaAssetSummary => ({
  id, name: `Image ${id}`, originalName: `${id}.png`, kind: "image", mimeType: "image/png",
  url: `https://media.example.test/${id}-${version}.png`, width: 1600, height: 900,
  category: "news", categories: ["news"], tags: [], sizeBytes: 2048, source: "upload",
  lifecycle: "active", version, etag: `"${id}.${version}"`, altText: `Description ${id}`,
  description: null, license: null, credit: null,
  createdAt: null, createdBy: null, updatedAt: null, updatedBy: null,
});
const first = image("one"), second = image("two", 7), third = image("three");
const candidates = [first, second, third, { ...image("pdf"), kind: "document" as const, mimeType: "application/pdf" }];

describe("image comparison", () => {
  it("loads only a chosen second image, labels both versions, and retains the metadata draft", () => {
    render(<ImageViewingSurface asset={first} comparisonAssets={candidates} inspector={<label>Name<input defaultValue="Saved name" /></label>} />);
    const primary = screen.getByRole("img", { name: "Description one" });
    const name = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Unsaved name" } });
    expect(screen.getAllByRole("img")).toHaveLength(1);
    const chooser = screen.getByRole("combobox", { name: "Compare with" });
    const shared = screen.getByRole("group", { name: "Image workspace controls" });
    expect(within(shared).getByRole("combobox", { name: "Compare with" })).toBe(chooser);
    expect(within(shared).getByRole("button", { name: "Details" })).toBeInTheDocument();
    expect(screen.getAllByText("Viewing controls keep the file unchanged. 100% shows the preview at its pixel size.")).toHaveLength(1);
    expect(within(chooser).queryByRole("option", { name: /Image one|Image pdf/ })).toBeNull();
    fireEvent.change(chooser, { target: { value: "two" } });
    expect(screen.getAllByRole("img")).toHaveLength(2);
    expect(screen.getAllByText("Viewing controls keep the file unchanged. 100% shows the preview at its pixel size.")).toHaveLength(1);
    expect(screen.getByText("Image one · one · v1")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Comparison image" })).getByText("Image two · two · v7")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Description two" })).toHaveAttribute("src", second.url);
    expect(screen.getByRole("img", { name: "Description one" })).toBe(primary);
    expect(name).toHaveValue("Unsaved name");
    fireEvent.change(chooser, { target: { value: "" } });
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(name).toHaveValue("Unsaved name");
  });

  it("releases the previous comparison and starts each replacement with fresh viewing state", () => {
    const { rerender } = render(<ImageViewingSurface asset={first} comparisonAssets={candidates} inspector={<p>Details</p>} />);
    const chooser = screen.getByRole("combobox", { name: "Compare with" });
    fireEvent.change(chooser, { target: { value: "two" } });
    const oldImage = screen.getByRole("img", { name: "Description two" });
    fireEvent.load(oldImage);
    const controls = screen.getByRole("group", { name: "Comparison image view controls" });
    fireEvent.click(within(controls).getByRole("button", { name: "View at 100%" }));
    expect(within(controls).getByRole("status", { name: "Image zoom" })).toHaveTextContent("100%");
    fireEvent.change(chooser, { target: { value: "three" } });
    expect(oldImage.isConnected).toBe(false);
    expect(screen.getByRole("img", { name: "Description three" })).toHaveAttribute("src", third.url);
    expect(within(screen.getByRole("group", { name: "Comparison image view controls" })).getByRole("button", { name: "Fit" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(chooser, { target: { value: "two" } });
    const replacement = image("two", 8);
    rerender(<ImageViewingSurface asset={first} comparisonAssets={[first, replacement]} inspector={<p>Details</p>} />);
    expect(screen.getByRole("img", { name: "Description two" })).toHaveAttribute("src", replacement.url);
    expect(within(screen.getByRole("region", { name: "Comparison image" })).getByText("Image two · two · v8")).toBeInTheDocument();
    rerender(<ImageViewingSurface asset={first} comparisonAssets={[first]} inspector={<p>Details</p>} />);
    expect(screen.queryByRole("img", { name: "Description two" })).toBeNull();
    const previousPrimary = screen.getByRole("img", { name: "Description one" });
    const updatedPrimary = image("one", 2);
    rerender(<ImageViewingSurface asset={updatedPrimary} comparisonAssets={[updatedPrimary]} inspector={<p>Details</p>} />);
    expect(previousPrimary.isConnected).toBe(false);
    expect(screen.getByRole("img", { name: "Description one" })).toHaveAttribute("src", updatedPrimary.url);
    expect(screen.getByRole("status", { name: "Image zoom" })).toHaveTextContent("--");
  });

  it("keeps failed comparison feedback local and never replaces the primary image", () => {
    render(<ImageViewingSurface asset={first} comparisonAssets={candidates} inspector={<p>Details</p>} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Compare with" }), { target: { value: "two" } });
    fireEvent.error(screen.getByRole("img", { name: "Description two" }));
    expect(screen.getByRole("link", { name: "Open original" })).toHaveAttribute("href", second.url);
    expect(screen.getByRole("img", { name: "Description one" })).toHaveAttribute("src", first.url);
    expect(within(screen.getByRole("group", { name: "Comparison image view controls" })).getByRole("button", { name: "Zoom in" })).toBeDisabled();
  });
});
