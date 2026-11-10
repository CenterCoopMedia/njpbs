import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaBulkInspector, type MediaBulkInspectorProps } from "../src/components/media/MediaBulkInspector";
import type { MediaAssetSummary } from "../src/lib/functions";
import type { BulkMetadataDraft } from "../src/lib/source-media-bulk";
import type { SourceMediaAssetSummary } from "../src/lib/source-media";

const { cachedPoster } = vi.hoisted(() => ({ cachedPoster: vi.fn() }));
vi.mock("../src/lib/media-session-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/media-session-cache")>()),
  cachedPoster,
}));

const image = (values: Partial<MediaAssetSummary> & Pick<MediaAssetSummary, "id" | "name" | "tags">): MediaAssetSummary => ({
  originalName: `${values.id}.jpg`,
  category: "news",
  categories: ["news"],
  description: null,
  altText: null,
  license: null,
  credit: null,
  mimeType: "image/jpeg",
  kind: "image",
  sizeBytes: 1_024,
  width: 1_200,
  height: 800,
  url: `https://original.example/${values.id}.jpg`,
  source: "upload",
  lifecycle: "active",
  version: 1,
  etag: `etag-${values.id}`,
  createdAt: null,
  createdBy: null,
  updatedAt: null,
  updatedBy: null,
  ...values,
});

const video = (values: Partial<SourceMediaAssetSummary> & Pick<SourceMediaAssetSummary, "id" | "name" | "tags">): SourceMediaAssetSummary => ({
  sourceId: "video-library",
  description: null,
  originalName: `${values.id}.mp4`,
  mimeType: "video/mp4",
  kind: "video",
  sizeBytes: 10_240,
  preview: "browser",
  license: null,
  credit: null,
  rightsStatus: "pending",
  version: 1,
  createdAt: null,
  updatedAt: null,
  ...values,
});

function choose(triggerName: string, itemName: string) {
  fireEvent.click(screen.getByRole("button", { name: triggerName }));
  fireEvent.click(screen.getByRole("menuitem", { name: itemName }));
}

beforeEach(() => {
  localStorage.clear();
  cachedPoster.mockReset();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, media: "", addEventListener: () => {}, removeEventListener: () => {} }),
  });
});

describe("MediaBulkInspector", () => {
  it("edits image mixed tokens and fields, preserves its draft through review, and returns a frozen draft", async () => {
    const assets = [
      image({ id: "one", name: "One", tags: ["Newark", "Shared"], description: "First", thumbnails: [{ url: "https://thumb.example/one.jpg", width: 480, height: 320 }] }),
      image({ id: "two", name: "Two", tags: ["newark", "Other"], description: "Second" }),
    ];
    const onDirtyChange = vi.fn();
    const onReview = vi.fn<(draft: BulkMetadataDraft) => void>();
    const base = {
      assets,
      offPageCount: 1,
      onCancel: vi.fn(),
      onDirtyChange,
      onReview,
      pageTags: ["Page tag"],
      recentTags: ["Recent tag"],
      surface: "images" as const,
    };
    const { rerender } = render(<MediaBulkInspector {...base} open />);

    expect(screen.getByRole("complementary", { name: "Edit selected" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "2 items" })).toHaveFocus();
    expect(screen.getByText("2 images · 1 not on this page")).toBeInTheDocument();
    const previews = screen.getByRole("group", { name: "Selected item previews" });
    expect(previews.querySelector("img")).toHaveAttribute("src", "https://thumb.example/one.jpg");
    expect(previews.querySelector('img[src^="https://original.example/"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Remove tag Newark" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove tag Shared, on some items" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove tag Shared, on some items" }));
    const tags = screen.getByRole("combobox", { name: "Tags" });
    fireEvent.change(tags, { target: { value: "Housing," } });
    choose("Description: Leave unchanged", "Set the same value");
    fireEvent.change(screen.getByRole("textbox", { name: "Description for all selected images" }), { target: { value: "Shared description" } });
    choose("Credit: Leave unchanged", "Clear this field");
    expect(await screen.findByText("This field will be cleared.")).toBeInTheDocument();
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true));

    fireEvent.click(screen.getByRole("button", { name: "Review 2 changes" }));
    expect(onReview).toHaveBeenCalledOnce();
    const reviewed = onReview.mock.calls[0][0];
    expect(reviewed).toMatchObject({
      tags: { mode: "edit", add: ["Housing"], remove: ["Shared"] },
      description: { mode: "set", value: "Shared description" },
      credit: { mode: "clear", value: "" },
    });
    expect(Object.isFrozen(reviewed)).toBe(true);
    expect(Object.isFrozen(reviewed.tags)).toBe(true);
    expect(Object.isFrozen(reviewed.tags.add)).toBe(true);

    rerender(<MediaBulkInspector {...base} open={false} />);
    expect(screen.queryByRole("complementary", { name: "Edit selected" })).toBeNull();
    rerender(<MediaBulkInspector {...base} focusRequest={1} open />);
    expect(screen.getByRole("button", { name: "Remove tag Housing" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Description: Set the same value" })).toHaveFocus());
  });

  it("makes replace and clear explicit and refuses a blank replacement", () => {
    const onReview = vi.fn<(draft: BulkMetadataDraft) => void>();
    render(<MediaBulkInspector assets={[
      image({ id: "one", name: "One", tags: ["Newark"] }),
      image({ id: "two", name: "Two", tags: ["Trenton"] }),
    ]} onCancel={vi.fn()} onDirtyChange={vi.fn()} onReview={onReview} open surface="images" />);

    choose("Replace all tags or clear all tags", "Replace all tags");
    expect(screen.getByText("This removes the selected images' existing tags. Check the before-and-after review before applying.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review 2 changes" })).toBeDisabled();
    expect(screen.getByText("Add at least one tag before reviewing a replacement.")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Tags" }), { target: { value: "Archive," } });
    fireEvent.click(screen.getByRole("button", { name: "Review 2 changes" }));
    expect(onReview).toHaveBeenLastCalledWith(expect.objectContaining({ tags: expect.objectContaining({ mode: "replace", value: "Archive" }) }));

    choose("Replace all tags or clear all tags", "Clear all tags");
    expect(screen.getByText("This removes the selected images' existing tags. Check the before-and-after review before applying.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review 2 changes" }));
    expect(onReview).toHaveBeenLastCalledWith(expect.objectContaining({ tags: expect.objectContaining({ mode: "clear" }) }));
  });

  it("matches video tags exactly, uses cached posters only, and guards a dirty cancel", async () => {
    cachedPoster.mockImplementation((sourceId: string, id: string) =>
      sourceId === "video-library" && id === "one" ? "https://poster.example/one.jpg" : undefined);
    const onCancel = vi.fn();
    const onReview = vi.fn<(draft: BulkMetadataDraft) => void>();
    render(<MediaBulkInspector assets={[
      video({ id: "one", name: "One", fileVersion: "one-file", tags: ["Interview"], rightsStatus: "pending" }),
      video({ id: "two", name: "Two", fileVersion: "two-file", tags: ["interview"], rightsStatus: "complete" }),
    ]} onCancel={onCancel} onDirtyChange={vi.fn()} onReview={onReview} open surface="video" />);

    expect(cachedPoster).toHaveBeenCalledTimes(2);
    expect(cachedPoster).toHaveBeenCalledWith("video-library", "one", "one-file");
    expect(cachedPoster).toHaveBeenCalledWith("video-library", "two", "two-file");
    expect(screen.getByRole("group", { name: "Selected item previews" }).querySelector("img")).toHaveAttribute("src", "https://poster.example/one.jpg");
    expect(screen.getByRole("button", { name: "Remove tag Interview, on some items" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove tag interview, on some items" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Rights review for all selected videos" }), { target: { value: "complete" } });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByText("Discard batch changes?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep editing" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("combobox", { name: "Rights review for all selected videos" })).toHaveValue("complete");

    fireEvent.keyDown(screen.getByRole("combobox", { name: "Rights review for all selected videos" }), { key: "Escape" });
    expect(screen.getByText("Discard batch changes?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));

    fireEvent.click(screen.getByRole("button", { name: "Review 2 changes" }));
    expect(onReview).toHaveBeenLastCalledWith(expect.objectContaining({ rightsStatus: "complete" }));
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard batch changes" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
