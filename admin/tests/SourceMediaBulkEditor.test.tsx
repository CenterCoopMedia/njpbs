import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";
import { useRef } from "react";
import { SourceMediaBulkEditor, classifyBulkSaveFailure, useSourceMediaBulkEditing } from "../src/components/SourceMediaBulkEditor";
import { MediaGrid, restoreMediaFocus, type MediaGridHandle } from "../src/components/media/MediaGrid";
import { MediaTile } from "../src/components/media/MediaTile";
import { SourceMediaLibrary } from "../src/routes/SourceMediaLibrary";
import { SuccessNoticeProvider } from "../src/components/ui/SuccessNoticeRegion";
import { BULK_SAVE_INTERVAL_MS, emptyBulkMetadataDraft, type BulkMetadataDraft } from "../src/lib/source-media-bulk";
import { cmsUpdateMediaMetadata, HttpError, type MediaAssetSummary } from "../src/lib/functions";
import { createSourceMediaRead, listSourceMedia, updateSourceMediaMetadata, type MediaSourceSummary, type SourceMediaAssetSummary } from "../src/lib/source-media";

const collectionMocks = vi.hoisted(() => ({ list: vi.fn(), setItems: vi.fn() }));

vi.mock("../src/lib/functions", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/lib/functions")>()),
  cmsUpdateMediaMetadata: vi.fn(),
}));
vi.mock("../src/lib/source-media", () => ({ createSourceMediaRead: vi.fn(), listSourceMedia: vi.fn(), updateSourceMediaMetadata: vi.fn(), deleteSourceMedia: vi.fn() }));
vi.mock("../src/components/VideoUploadPanel", () => ({ VideoUploadPanel: () => null }));
vi.mock("../src/components/VideoMeaningSearch", () => ({ VideoMeaningSearch: () => null }));
vi.mock("../src/components/VideoProductionTools", () => ({ useVideoProductionTools: () => ({ content: null, actions: null, onTimeUpdate: vi.fn(), editorExportsItem: { key: "editor-export-settings", label: "Broadcast & editing exports…", onSelect: vi.fn() }, downloadItems: [], }) }));
vi.mock("../src/lib/media-collections", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/lib/media-collections")>()),
  listMediaCollections: (...args: unknown[]) => collectionMocks.list(...args),
  setMediaCollectionItems: (...args: unknown[]) => collectionMocks.setItems(...args),
}));

const source: MediaSourceSummary = { id: "video-library", label: "Videos", description: "Private staff videos", mediaKind: "video", canBrowse: true, canUpload: true, canEditMetadata: true, canRequestProduction: true };
const first: SourceMediaAssetSummary = { id: "a", sourceId: source.id, name: "Interview", originalName: "interview.mp4", description: "Original description", credit: "Camera crew", license: "Editorial", tags: ["Interview"], rightsStatus: "pending", version: 4, kind: "video", mimeType: "video/mp4", sizeBytes: 1024, preview: "download_only", createdAt: null, updatedAt: null };
const second: SourceMediaAssetSummary = { ...first, id: "b", name: "B-roll", originalName: "b-roll.mov", tags: ["B-roll"], credit: "Different crew", version: 9 };
const firstImage: MediaAssetSummary = {
  id: "image-a", name: "Capitol", originalName: "capitol.jpg", category: "news", categories: ["news"],
  tags: ["Trenton"], description: "State House", altText: "", license: "Editorial", credit: "NJ PBS",
  mimeType: "image/jpeg", kind: "image", sizeBytes: 2048, width: 1200, height: 800, url: "/capitol.jpg",
  lifecycle: "active", version: 3, etag: "etag-image-a-v3", createdAt: null, createdBy: "staff",
  updatedAt: null, updatedBy: "staff",
};
const secondImage: MediaAssetSummary = {
  ...firstImage, id: "image-b", name: "Studio", originalName: "studio.jpg", tags: ["Studio"],
  version: 7, etag: "etag-image-b-v7", url: "/studio.jpg",
};
const getIdToken = vi.fn().mockResolvedValue("token");
const onRefresh = vi.fn();
const onTagsSaved = vi.fn();
const onClose = vi.fn();
const onDirtyChange = vi.fn();
const onSavingChange = vi.fn();
const navigation = { navigationBlocked: false, onKeepNavigation: vi.fn(), onDiscardNavigation: vi.fn() };

function editor(assets = [first, second]) {
  return render(<SourceMediaBulkEditor sourceId={source.id} assets={assets} getIdToken={getIdToken} onClose={onClose} onDirtyChange={onDirtyChange} onSavingChange={onSavingChange} {...navigation} />);
}
function imageDraft(): BulkMetadataDraft {
  const draft = emptyBulkMetadataDraft();
  return Object.freeze({
    ...draft,
    tags: Object.freeze({ mode: "edit" as const, value: "", add: Object.freeze(["Newark"]), remove: Object.freeze([]) }),
    description: Object.freeze(draft.description),
    credit: Object.freeze(draft.credit),
    license: Object.freeze(draft.license),
  });
}
function imageEditor({
  assets = [firstImage, secondImage],
  canEdit = () => true,
  draft = imageDraft(),
  onBackToEditing = vi.fn(),
}: {
  assets?: MediaAssetSummary[];
  canEdit?: (asset: MediaAssetSummary) => boolean;
  draft?: BulkMetadataDraft;
  onBackToEditing?: () => void;
} = {}) {
  return render(<SourceMediaBulkEditor surface="images" assets={assets} canEdit={canEdit}
    getIdToken={getIdToken} initialDraft={draft} onBackToEditing={onBackToEditing}
    onClose={onClose} onDirtyChange={onDirtyChange} onSavingChange={onSavingChange} {...navigation} />);
}
// The library's wiring in small: the shared grid and tiles select, and the hook owns the bar.
function HarnessContent({ records = [first, second], mediaSource = source, userId = "staff" }: { records?: SourceMediaAssetSummary[]; mediaSource?: MediaSourceSummary; userId?: string }) {
  const grid = useRef<MediaGridHandle>(null);
  const bulk = useSourceMediaBulkEditing({
    source: mediaSource, userId, records, favorites: { retryDisabled: false, reconcile: () => undefined }, getIdToken, disabled: false, onRefresh, onTagsSaved,
    returnFocus: () => restoreMediaFocus(grid.current, () => document.getElementById("video-search")?.focus()),
  });
  return <><input id="video-search" aria-label="Search" />{bulk.notice}
    <MediaGrid handleRef={grid} items={records} label="Videos" onOpen={() => undefined} onSelectionChange={bulk.changeSelection} rules={bulk.rules} selection={bulk.selection}
      renderItem={(asset, context) => <MediaTile asset={asset} canDelete={false} favorite={false} onAction={() => undefined} onOpen={() => undefined}
        onSelectChange={context.onSelectChange} selected={context.selected} selectionMode={context.selectionMode} surface="video" tabbable={context.tabbable} thumbnail={null} />} />
    {bulk.bar}{bulk.inspector}{bulk.editor(navigation)}</>;
}
function bar() { return screen.getByRole("group", { name: "Video selection" }); }
function cardName(name: string) { return screen.getByRole("button", { name: new RegExp(`^${name}, video`) }); }
function Harness(props: { records?: SourceMediaAssetSummary[]; mediaSource?: MediaSourceSummary; userId?: string }) {
  return <MemoryRouter><HarnessContent {...props} /></MemoryRouter>;
}
function setTagAction(mode = "add", value = "Newark") {
  fireEvent.change(screen.getByLabelText("Tag action"), { target: { value: mode } });
  if (!["keep", "clear"].includes(mode)) fireEvent.change(screen.getByLabelText(mode === "replace" ? "Tags to use" : `Tags to ${mode}`), { target: { value } });
}
function review() { fireEvent.click(screen.getByRole("button", { name: "Review changes" })); }
function setInspectorTagAndReview(value = "Newark") {
  const input = screen.getByRole("combobox", { name: "Tags" });
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.click(screen.getByRole("button", { name: /Review \d+ changes/ }));
}
async function settle() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }

beforeEach(() => {
  vi.clearAllMocks();
  getIdToken.mockReset().mockResolvedValue("token");
  vi.mocked(updateSourceMediaMetadata).mockReset().mockImplementation(async (_token, _sourceId, id, expectedVersion, changes) => ({ success: true, asset: { ...(id === first.id ? first : second), ...changes, version: expectedVersion + 1 } }));
  vi.mocked(cmsUpdateMediaMetadata).mockReset().mockImplementation(async (_token, asset, changes) => ({
    success: true, changed: true, asset: { ...asset, ...changes, version: asset.version + 1, etag: `${asset.etag}-next` },
  }));
  vi.mocked(listSourceMedia).mockResolvedValue({ success: true, records: [first, second], total: 2, nextCursor: null, hasMore: false });
  collectionMocks.list.mockImplementation(async (_token: string, query: { scope: string }) => ({
    success: true,
    collections: query.scope === "all_staff" ? [{ id: "c".repeat(64), scope: "all_staff", name: "Shared package", description: "", lifecycle: "active", version: 1, membershipVersion: 2, cover: null, canEdit: true, createdAt: null, updatedAt: null, itemCount: 0 }] : [],
    nextCursor: null,
    hasMore: false,
  }));
  collectionMocks.setItems.mockResolvedValue({ success: true, collectionId: "c".repeat(64), changed: true, replayed: false, version: 1, membershipVersion: 3 });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("batch metadata editor", () => {
  it("starts with keep defaults, focuses the first control and disables an empty apply", () => {
    editor();
    expect(screen.getByLabelText("Tag action")).toHaveValue("keep");
    expect(screen.getByLabelText("Tag action")).toHaveFocus();
    review();
    expect(screen.getByRole("button", { name: "Apply to 0 videos" })).toBeDisabled();
    expect(screen.getByRole("heading", { name: "Review changes" })).toHaveFocus();
    expect(updateSourceMediaMetadata).not.toHaveBeenCalled();
  });
  it("requires review then explicit apply, preserves per-file tags and uses exact versions", async () => {
    vi.useFakeTimers();
    editor(); setTagAction(); review();
    fireEvent.click(screen.getByText("Changes for Interview"));
    expect(screen.getByText("Before: Interview")).toBeInTheDocument();
    expect(screen.getByText("After: Interview, Newark")).toBeInTheDocument();
    expect(updateSourceMediaMetadata).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply to 2 videos" }));
    await settle();
    expect(updateSourceMediaMetadata).toHaveBeenCalledWith("token", "video-library", "a", 4, { tags: ["Interview", "Newark"] });
    expect(updateSourceMediaMetadata).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(BULK_SAVE_INTERVAL_MS); });
    expect(updateSourceMediaMetadata).toHaveBeenLastCalledWith("token", "video-library", "b", 9, { tags: ["B-roll", "Newark"] });
    expect(screen.getByText("2 saved · 0 already matched · 0 not confirmed saved.")).toBeInTheDocument();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(onSavingChange).toHaveBeenLastCalledWith(false);
  });
  it("warns before tag replacement and refuses a blank replacement", () => {
    editor(); setTagAction("replace", " "); review();
    expect(screen.getByText(/This removes the selected videos' existing tags/)).toBeInTheDocument();
    expect(screen.getByText("Fix these changes before reviewing")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Apply to/ })).not.toBeInTheDocument();
    expect(updateSourceMediaMetadata).not.toHaveBeenCalled();
  });
  it("prevents partial execution when one resulting tag set exceeds the server limit", () => {
    editor([{ ...first, tags: Array.from({ length: 30 }, (_, i) => `Tag ${i}`) }, second]);
    setTagAction(); review();
    expect(screen.getByText(/Interview: this change would exceed 30 tags/)).toBeInTheDocument();
    expect(updateSourceMediaMetadata).not.toHaveBeenCalled();
  });
  it("preserves literal text values that happen to match rights-status codes", () => {
    editor([{ ...first, description: "pending" }]);
    fireEvent.click(screen.getByText("Other metadata"));
    fireEvent.change(screen.getByLabelText("Description action"), { target: { value: "set" } });
    fireEvent.change(screen.getByLabelText("New description"), { target: { value: "complete" } });
    review(); fireEvent.click(screen.getByText("Changes for Interview"));
    expect(screen.getByText("Before: pending")).toBeInTheDocument();
    expect(screen.getByText("After: complete")).toBeInTheDocument();
  });
  it("requires a deliberate discard and keeps focus inside the dialog", () => {
    editor(); setTagAction();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Keep editing" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByText("Discard batch changes?")).not.toBeInTheDocument();
  });
  it("reports an uncertain save and stops without retrying subsequent files", async () => {
    vi.mocked(updateSourceMediaMetadata).mockRejectedValueOnce(new Error("Network error"));
    editor(); setTagAction(); review();
    fireEvent.click(screen.getByRole("button", { name: "Apply to 2 videos" }));
    await screen.findByRole("heading", { name: "Batch results" });
    expect(updateSourceMediaMetadata).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Save unconfirmed")).toBeInTheDocument();
    expect(screen.getByText("Not attempted")).toBeInTheDocument();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Back to library" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Return with unresolved batch results?")).toBeInTheDocument();
  });
  it("can stop while token acquisition is pending without sending any saves", async () => {
    let resolve!: (token: string) => void;
    getIdToken.mockImplementationOnce(() => new Promise<string>(done => { resolve = done; }));
    editor(); setTagAction(); review();
    fireEvent.click(screen.getByRole("button", { name: "Apply to 2 videos" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop after current file" }));
    await act(async () => { resolve("token"); });
    expect(updateSourceMediaMetadata).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Batch results" })).toBeInTheDocument();
  });
  it("does not continue a batch after the editor unmounts during authentication", async () => {
    let resolve!: (token: string) => void;
    getIdToken.mockImplementationOnce(() => new Promise<string>(done => { resolve = done; }));
    const view = editor(); setTagAction(); review();
    fireEvent.click(screen.getByRole("button", { name: "Apply to 2 videos" }));
    view.unmount(); await act(async () => { resolve("token"); });
    expect(updateSourceMediaMetadata).not.toHaveBeenCalled();
  });
  it("keeps the dialog open during an in-flight save and settles that file before stopping", async () => {
    let resolve!: (value: Awaited<ReturnType<typeof updateSourceMediaMetadata>>) => void;
    vi.mocked(updateSourceMediaMetadata).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    editor(); setTagAction(); review();
    fireEvent.click(screen.getByRole("button", { name: "Apply to 2 videos" })); await settle();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Stop after current file" }));
    await act(async () => { resolve({ success: true, asset: { ...first, version: 5, tags: ["Interview", "Newark"] } }); });
    expect(screen.getByText("1 saved · 0 already matched · 1 not confirmed saved.")).toBeInTheDocument();
    expect(updateSourceMediaMetadata).toHaveBeenCalledTimes(1);
  });
  it("classifies conflicts, denied access, rate limits and uncertain server errors explicitly", () => {
    expect(classifyBulkSaveFailure(new HttpError(409, "Conflict"))).toMatchObject({ status: "conflict", stop: false });
    for (const status of [401, 403, 429]) expect(classifyBulkSaveFailure(new HttpError(status, "Stop"))).toMatchObject({ status: "failed", stop: true });
    expect(classifyBulkSaveFailure(new HttpError(400, "Invalid tag"))).toMatchObject({ status: "failed", stop: false });
    for (const error of [new HttpError(408, "Timeout"), new HttpError(500, "Server error"), new Error("Offline")]) expect(classifyBulkSaveFailure(error)).toMatchObject({ status: "unconfirmed", stop: true });
  });
});

describe("image batch review adapter", () => {
  it("opens the frozen inspector draft in review, names excluded images, and returns to editing", () => {
    const onBackToEditing = vi.fn();
    imageEditor({ canEdit: asset => asset.id === firstImage.id, onBackToEditing });

    expect(screen.getByRole("dialog", { name: "Edit selected images" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Review changes" })).toHaveFocus();
    expect(screen.queryByLabelText("Tag action")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Images left out" })).toBeInTheDocument();
    expect(screen.getByText("Studio")).toBeInTheDocument();
    expect(screen.getByText(/Your role cannot edit this image/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply to 1 image" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Back to editing" }));
    expect(onBackToEditing).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("describes a batch that includes a PDF as items", () => {
    const pdf = { ...firstImage, id: "packet", name: "Board packet", originalName: "packet.pdf", mimeType: "application/pdf", kind: "document" as const, width: null, height: null };
    imageEditor({ assets: [firstImage, pdf] });
    expect(screen.getByRole("dialog", { name: "Edit selected items" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply to 2 items" })).toBeInTheDocument();
  });

  it("uses each image summary and ETag through one-token serial saves", async () => {
    vi.useFakeTimers();
    imageEditor();
    fireEvent.click(screen.getByRole("button", { name: "Apply to 2 images" }));
    await settle();

    expect(getIdToken).toHaveBeenCalledTimes(1);
    expect(cmsUpdateMediaMetadata).toHaveBeenCalledTimes(1);
    expect(vi.mocked(cmsUpdateMediaMetadata).mock.calls[0][1]).toBe(firstImage);
    expect(cmsUpdateMediaMetadata).toHaveBeenCalledWith("token", firstImage, { tags: ["Trenton", "Newark"] });
    await act(async () => { await vi.advanceTimersByTimeAsync(BULK_SAVE_INTERVAL_MS - 1); });
    expect(cmsUpdateMediaMetadata).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    expect(vi.mocked(cmsUpdateMediaMetadata).mock.calls[1][1]).toBe(secondImage);
    expect(cmsUpdateMediaMetadata).toHaveBeenLastCalledWith("token", secondImage, { tags: ["Studio", "Newark"] });
    expect(screen.getByText("2 saved · 0 already matched · 0 not confirmed saved.")).toBeInTheDocument();
  });

  it("marks an image ETag conflict, waits, and continues without retrying it", async () => {
    vi.useFakeTimers();
    vi.mocked(cmsUpdateMediaMetadata).mockRejectedValueOnce(new HttpError(412, "Precondition failed"));
    imageEditor();
    fireEvent.click(screen.getByRole("button", { name: "Apply to 2 images" }));
    await settle();

    expect(screen.getByText("Changed elsewhere")).toBeInTheDocument();
    expect(cmsUpdateMediaMetadata).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(BULK_SAVE_INTERVAL_MS); });

    expect(cmsUpdateMediaMetadata).toHaveBeenCalledTimes(2);
    expect(vi.mocked(cmsUpdateMediaMetadata).mock.calls.map(call => call[1].id)).toEqual([firstImage.id, secondImage.id]);
    expect(screen.getByText("1 saved · 0 already matched · 1 not confirmed saved.")).toBeInTheDocument();
    expect(screen.getByText(/Reopen this file and review its latest details/)).toBeInTheDocument();
  });
});

describe("bulk video selection", () => {
  it("retains off-page selections, marks mixed selection, and never selects unloaded results", () => {
    const view = render(<Harness />);
    // The bar, with its Select this page, appears only once something is selected.
    expect(screen.queryByRole("group", { name: "Video selection" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Select Interview"));
    expect(within(bar()).getByRole("checkbox", { name: "Select this page" })).toBePartiallyChecked();
    view.rerender(<Harness records={[second]} />);
    expect(bar()).toHaveTextContent("1 of 100 selected · 1 not on this page");
    fireEvent.click(within(bar()).getByRole("checkbox", { name: "Select this page" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit selected" }));
    expect(screen.getByRole("complementary", { name: "Edit selected" })).toBeInTheDocument();
    expect(screen.getByText("2 videos · 1 not on this page")).toBeInTheDocument();
    expect(listSourceMedia).not.toHaveBeenCalled();
    expect(createSourceMediaRead).not.toHaveBeenCalled();
  });
  it("supports shift selection within the visible page", () => {
    render(<Harness records={[first, second, { ...second, id: "c", name: "Third" }]} />);
    fireEvent.click(screen.getByLabelText("Select Interview"));
    fireEvent.click(screen.getByLabelText("Select Third"), { shiftKey: true });
    expect(screen.getByLabelText("Select B-roll")).toBeChecked();
    expect(within(bar()).getByRole("checkbox", { name: "Select this page" })).toBeChecked();
  });
  it("adds selected video references to a collection and returns focus to the card that last had focus", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText("Select Interview"));
    fireEvent.click(screen.getByRole("button", { name: "Add to collection" }));
    fireEvent.click(await screen.findByRole("radio", { name: /Shared package/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Add selected to collection" })).getByRole("button", { name: "Add to collection" }));
    await waitFor(() => expect(collectionMocks.setItems).toHaveBeenCalledWith("token", expect.objectContaining({
      collectionId: "c".repeat(64),
      refs: [{ backend: "s3", sourceId: "video-library", id: "a" }],
      present: true,
    })));
    // Decision 3: after a bulk action, focus returns to the card that last had focus.
    await waitFor(() => expect(cardName("Interview")).toHaveFocus());
    expect(screen.queryByRole("group", { name: "Video selection" })).not.toBeInTheDocument();
    expect(updateSourceMediaMetadata).not.toHaveBeenCalled();
  });
  it("keeps collection organization available for a read-only source and hides metadata editing", () => {
    const view = render(<Harness />);
    fireEvent.click(screen.getByLabelText("Select Interview"));
    expect(within(bar()).getByRole("button", { name: "Edit selected" })).toBeEnabled();
    view.rerender(<Harness mediaSource={{ ...source, canEditMetadata: false }} />);
    // A change of access starts a new selection, so the bar closes.
    expect(screen.getByLabelText("Select Interview")).not.toBeChecked();
    expect(screen.queryByRole("group", { name: "Video selection" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Select Interview"));
    expect(within(bar()).getByRole("button", { name: "Add to collection" })).toBeEnabled();
    expect(within(bar()).queryByRole("button", { name: "Edit selected" })).not.toBeInTheDocument();
    view.rerender(<Harness />);
    expect(screen.queryByRole("button", { name: "Edit selected" })).not.toBeInTheDocument();
  });
  it("clears user-scoped selections when identity changes", () => {
    const view = render(<Harness />); fireEvent.click(screen.getByLabelText("Select Interview"));
    expect(within(bar()).getByRole("button", { name: "Edit selected" })).toBeEnabled();
    view.rerender(<Harness userId="different-staff" />);
    expect(screen.getByLabelText("Select Interview")).not.toBeChecked();
    expect(screen.queryByRole("button", { name: "Edit selected" })).not.toBeInTheDocument();
  });
  it("rejects a selection above 100 atomically", () => {
    render(<Harness records={Array.from({ length: 101 }, (_, i) => ({ ...first, id: String(i), name: `Video ${i}` }))} />);
    fireEvent.click(screen.getByLabelText("Select Video 0"));
    fireEvent.click(within(bar()).getByRole("checkbox", { name: "Select this page" }));
    expect(within(bar()).getByRole("alert")).toHaveTextContent("Select no more than 100 videos");
    expect(bar()).toHaveTextContent("1 of 100 selected");
  });
  it("keeps the exact 100-video cap sentence and leaves the earlier selection unchanged", () => {
    const records = Array.from({ length: 101 }, (_, i) => ({ ...first, id: String(i), name: `Video ${i}` }));
    render(<Harness records={records} />);
    fireEvent.click(screen.getByLabelText("Select Video 0"));
    const pageSelection = within(bar()).getByRole("checkbox", { name: "Select this page" });
    expect(pageSelection).toHaveProperty("indeterminate", true);
    fireEvent.click(pageSelection);
    expect(pageSelection).toHaveProperty("indeterminate", true);
    expect(pageSelection).not.toBeChecked();
    fireEvent.click(pageSelection);
    expect(pageSelection).toHaveProperty("indeterminate", true);
    expect(pageSelection).not.toBeChecked();
    expect(screen.getByRole("alert")).toHaveTextContent(/^Select no more than 100 videos in one batch\. No additional videos were selected\.$/);
    expect(screen.getByLabelText("Select Video 0")).toBeChecked();
    expect(screen.getByLabelText("Select Video 1")).not.toBeChecked();
  });
  it("announces how many videos were added to the collection, in the real library", async () => {
    const router = createMemoryRouter([{ path: "/media", element: <SourceMediaLibrary source={source} userId="staff" getIdToken={getIdToken} /> }], { initialEntries: ["/media"] });
    render(<RouterProvider router={router} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Interview" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select B-roll" }));
    fireEvent.click(screen.getByRole("button", { name: "Add to collection" }));
    fireEvent.click(await screen.findByRole("radio", { name: /Shared package/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Add selected to collection" })).getByRole("button", { name: "Add to collection" }));
    expect(await screen.findByText("2 videos were added to Shared package.")).toBeInTheDocument();
    expect(screen.getByText("Items added to collection")).toBeInTheDocument();
    expect(listSourceMedia).toHaveBeenCalledTimes(1);
  });
  it("keeps only the collection Undo notice after the video bulk picker closes", async () => {
    const refs = [first, second].map(asset => ({ backend: "s3" as const, sourceId: asset.sourceId, id: asset.id }));
    collectionMocks.setItems
      .mockResolvedValueOnce({ success: true, collectionId: "c".repeat(64), changed: true, replayed: false,
        version: 1, membershipVersion: 3, changedRefs: refs })
      .mockResolvedValueOnce({ success: true, collectionId: "c".repeat(64), changed: true, replayed: false,
        version: 1, membershipVersion: 4, changedRefs: refs });
    const router = createMemoryRouter([{ path: "/media", element: <SuccessNoticeProvider routeKey="staff:media">
      <SourceMediaLibrary source={source} userId="staff" getIdToken={getIdToken} />
    </SuccessNoticeProvider> }], { initialEntries: ["/media"] });
    render(<RouterProvider router={router} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Interview" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select B-roll" }));
    fireEvent.click(screen.getByRole("button", { name: "Add to collection" }));
    fireEvent.click(await screen.findByRole("radio", { name: /Shared package/ }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Add selected to collection" })).getByRole("button", { name: "Add to collection" }));
    const notice = await screen.findByRole("region", { name: "Notifications" });
    expect(await within(notice).findByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(screen.queryByText("Items added to collection")).toBeNull();
    fireEvent.click(within(notice).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(collectionMocks.setItems).toHaveBeenCalledTimes(2));
    expect(notice).toHaveTextContent("2 items removed from Shared package.");
    expect(screen.queryByText("2 videos were added to Shared package.")).toBeNull();
  });
  it("removes successful files, retains a conflict, and refreshes only once when closing results", async () => {
    vi.useFakeTimers();
    vi.mocked(updateSourceMediaMetadata).mockRejectedValueOnce(new HttpError(409, "Conflict"));
    render(<Harness />); fireEvent.click(screen.getByLabelText("Select Interview"));
    fireEvent.click(within(bar()).getByRole("checkbox", { name: "Select this page" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit selected" })); setInspectorTagAndReview();
    fireEvent.click(screen.getByRole("button", { name: "Apply to 2 videos" })); await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(BULK_SAVE_INTERVAL_MS); });
    expect(onRefresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Back to library" }));
    expect(screen.getByText("Return with unresolved batch results?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Return to library" }));
    expect(screen.getByLabelText("Select Interview")).toBeChecked();
    expect(screen.getByLabelText("Select B-roll")).not.toBeChecked();
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onTagsSaved).toHaveBeenCalledOnce();
    expect(onTagsSaved).toHaveBeenCalledWith(["B-roll", "Newark"]);
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    // Decision 3: the batch was a bulk action, so focus returns to the card that last had it.
    expect(cardName("Interview")).toHaveFocus();
  });
  it("integrates into the real library without opening a player or requesting more records", async () => {
    const router = createMemoryRouter([{ path: "/media", element: <SourceMediaLibrary source={source} userId="staff" getIdToken={getIdToken} /> }], { initialEntries: ["/media"] });
    render(<RouterProvider router={router} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Interview" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select B-roll" }));
    fireEvent.click(screen.getAllByRole("button", { name: "More actions: 2 items" })[0]);
    expect(screen.getByRole("menuitem", { name: "Edit selected" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Edit selected" }));
    expect(screen.getByRole("complementary", { name: "Edit selected" })).toBeInTheDocument();
    expect(createSourceMediaRead).not.toHaveBeenCalled();
    expect(listSourceMedia).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("combobox", { name: "Tags" })).toHaveValue("");
    setInspectorTagAndReview();
    expect(screen.getByRole("dialog", { name: "Edit selected videos" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Review changes" })).toHaveFocus();
    expect(listSourceMedia).toHaveBeenCalledTimes(1);
  });
  it("guards navigation from a dirty video bulk inspector and keeps the grid inactive", async () => {
    const router = createMemoryRouter([
      { path: "/media", element: <SourceMediaLibrary source={source} userId="staff" getIdToken={getIdToken} /> },
      { path: "/away", element: <h1>Away</h1> },
    ], { initialEntries: ["/media"] });
    render(<RouterProvider router={router} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Interview" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select B-roll" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit selected" }));
    const grid = screen.getByRole("grid", { name: "Videos", hidden: true });
    expect(grid).toHaveAttribute("inert");
    fireEvent.click(within(grid).getByRole("button", { name: /^Interview, video/, hidden: true }));
    expect(screen.queryByRole("dialog", { name: "Interview" })).toBeNull();
    const tags = screen.getByRole("combobox", { name: "Tags" });
    fireEvent.change(tags, { target: { value: "Newark" } });
    fireEvent.keyDown(tags, { key: "Enter" });

    await act(async () => { await router.navigate("/away"); });
    const prompt = await screen.findByRole("dialog", { name: "Leave with unsaved changes?" });
    fireEvent.click(within(prompt).getByRole("button", { name: "Keep editing" }));
    expect(router.state.location.pathname).toBe("/media");
    await act(async () => { await router.navigate("/away"); });
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Leave with unsaved changes?" })).getByRole("button", { name: "Discard and leave" }));
    expect(await screen.findByRole("heading", { name: "Away" })).toBeInTheDocument();
  });
});
