import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../src/lib/functions";
import { MemoryRouter } from "react-router";
import {
  MediaUploadForm,
  type MediaUploadBatchReceipt,
  type MediaUploader,
} from "../src/components/MediaUploadForm";
import type {
  MediaAssetSummary,
  MediaCategoryDefinition,
} from "../src/lib/functions";

const categories: MediaCategoryDefinition[] = [
  {
    id: "news",
    label: "News",
    description: "Newsroom images",
    order: 1,
    active: true,
    reserved: false,
    canUpload: true,
    canManage: true,
    etag: '"media-category.news.1"',
    version: 1,
    createdAt: null,
    createdBy: null,
    updatedAt: "2026-08-29T00:00:00.000Z",
    updatedBy: "editor-1",
  },
];

function asset(id: string, name: string): MediaAssetSummary {
  return {
    id,
    name,
    originalName: `${id}.png`,
    category: "news",
    categories: ["news"],
    tags: [],
    description: null,
    altText: null,
    license: "NJ PBS owned",
    credit: null,
    mimeType: "image/png",
    kind: "image",
    sizeBytes: 20,
    width: 100,
    height: 100,
    url: `https://media.njpbs.org/${id}.png`,
    source: "upload",
    lifecycle: "active",
    version: 1,
    etag: `"media.${id}.1"`,
    createdAt: "2026-08-29T00:00:00.000Z",
    createdBy: "editor-1",
    updatedAt: "2026-08-29T00:00:00.000Z",
    updatedBy: "editor-1",
  };
}

function renderUploader(overrides: {
  uploadMedia?: ReturnType<typeof vi.fn>;
  canOpenRecycleBin?: boolean;
  librarySearch?: string;
  uploadScope?: Parameters<typeof MediaUploadForm>[0]["uploadScope"];
  incomingFiles?: readonly File[];
  onBatchComplete?: (receipt: MediaUploadBatchReceipt) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onQueueChange?: Parameters<typeof MediaUploadForm>[0]["onQueueChange"];
  uploadController?: Parameters<typeof MediaUploadForm>[0]["uploadController"];
} = {}) {
  const uploadMedia =
    overrides.uploadMedia ??
    vi.fn().mockResolvedValue({ success: true, asset: asset("one", "One") });
  const onBatchComplete = overrides.onBatchComplete ?? vi.fn();
  const onDirtyChange = overrides.onDirtyChange ?? vi.fn();
  render(
    <MemoryRouter><MediaUploadForm
      canOpenRecycleBin={overrides.canOpenRecycleBin}
      librarySearch={overrides.librarySearch}
      uploadScope={overrides.uploadScope ?? "image"}
      defaultCategory="news"
      categories={categories}
      canUploadCategory={() => true}
      onBatchComplete={onBatchComplete}
      onCancel={() => {}}
      onDirtyChange={onDirtyChange}
      onQueueChange={overrides.onQueueChange}
      uploadController={overrides.uploadController}
      incomingFiles={overrides.incomingFiles}
      onUploaded={() => {}}
      uploadMedia={uploadMedia as MediaUploader}
    /></MemoryRouter>,
  );
  return { uploadMedia, onBatchComplete, onDirtyChange };
}

beforeEach(() => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:media-preview");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("MediaUploadForm batch queue", () => {
  it("applies batch assignment only to missing values and keeps per-file metadata requests", async () => {
    const first = new File(["first"], "first.png", { type: "image/png" });
    const second = new File(["second"], "second.png", { type: "image/png" });
    const uploadMedia = vi.fn<MediaUploader>(async file => ({ success: true, asset: asset(file.name, file.name) }));
    renderUploader({ uploadMedia });
    expect(screen.getByRole("checkbox", { name: "Request metadata update for the batch" })).not.toBeChecked();
    fireEvent.change(screen.getByLabelText("Batch title default"), { target: { value: "Election assignment" } });
    fireEvent.change(screen.getByLabelText("Batch description default"), { target: { value: "Election night coverage" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Request metadata update for the batch" }));
    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [first, second] } });
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Person's title" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Description" }), { target: { value: "Person's description" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Request metadata update" }));
    fireEvent.change(screen.getByLabelText("Batch title default"), { target: { value: "Updated assignment" } });
    fireEvent.click(screen.getByRole("button", { name: "Upload all files" }));
    await waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(2));
    expect(uploadMedia.mock.calls[0][1]).toMatchObject({ name: "Person's title", description: "Person's description", metadataUpdateRequested: false });
    expect(uploadMedia.mock.calls[1][1]).toMatchObject({ name: "Updated assignment", description: "Election night coverage", metadataUpdateRequested: true });
  });

  it("accepts browser WAV types in Audio and names Images for a rejected image", async () => {
    const uploaded = {
      ...asset("interview", "Interview"),
      kind: "audio" as const,
      mimeType: "audio/wav",
      width: null,
      height: null,
    };
    const uploadMedia = vi.fn<MediaUploader>(async () => ({ success: true, asset: uploaded }));
    const incomingFiles = [
      new File(["PCM audio"], "interview.wav", { type: "audio/x-wav" }),
      new File(["image"], "portrait.jpg", { type: "image/jpeg" }),
    ];
    render(<MemoryRouter><MediaUploadForm
      uploadScope="audio"
      defaultCategory="news"
      categories={categories}
      canUploadCategory={() => true}
      onCancel={() => {}}
      onDirtyChange={() => {}}
      onUploaded={() => {}}
      incomingFiles={incomingFiles}
      uploadMedia={uploadMedia}
    /></MemoryRouter>);
    const input = screen.getByLabelText(/^Add files/);
    expect(input.getAttribute("accept")).toContain("audio/x-wav");
    expect(input.getAttribute("accept")).toContain("video/*");
    expect(input.getAttribute("accept")).not.toContain("image/");

    expect(screen.getByRole("alert")).toHaveTextContent("portrait.jpg: Upload images and PDFs from Images.");
    expect(screen.getByRole("button", { name: /interview\.wav/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(uploadMedia).toHaveBeenCalledOnce());
    expect(uploadMedia.mock.calls[0][0]).toMatchObject({ name: "interview.wav", type: "audio/wav" });
  });

  it("accepts images and PDFs in Images and names Audio for a rejected WAV", () => {
    renderUploader({
      uploadScope: "images-and-documents",
      incomingFiles: [
        new File(["image"], "portrait.jpg", { type: "image/jpeg" }),
        new File(["document"], "brief.pdf", { type: "application/pdf" }),
        new File(["PCM audio"], "interview.wav", { type: "audio/wav" }),
      ],
    });
    const input = screen.getByLabelText(/^Add files/);
    expect(input.getAttribute("accept")).toContain("application/pdf");
    expect(input.getAttribute("accept")).not.toContain("audio/");
    expect(input.getAttribute("accept")).toContain("video/*");

    expect(screen.getByRole("button", { name: /portrait\.jpg/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /brief\.pdf/ })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("interview.wav: Upload WAV files from Audio.");
  });

  it("uploads Audio without image fields or a license and warns about stale extra categories", async () => {
    const uploaded = { ...asset("interview", "Interview"), kind: "audio" as const, mimeType: "audio/wav", width: null, height: null };
    const uploadMedia = vi.fn<MediaUploader>(async () => ({ success: true, asset: uploaded }));
    render(<MediaUploadForm defaultCategory="news" categories={categories} canUploadCategory={() => true}
      onCancel={() => {}} onDirtyChange={() => {}} onUploaded={() => {}}
      initialState={{ file: new File(["PCM audio"], "interview.wav", { type: "audio/wav" }), categories: ["news", "retired"] }}
      uploadMedia={uploadMedia} />);
    expect(screen.queryByLabelText("Alt-text suggestion")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Optimize JPEG/ })).toBeNull();
    expect(screen.getByText(/You can upload without a license/)).toBeInTheDocument();
    expect(screen.getByText(/Inactive or excess extra categories/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {name:"Upload"}));
    await waitFor(() => expect(uploadMedia).toHaveBeenCalledOnce());
    expect(uploadMedia.mock.calls[0][1]).toMatchObject({ category: "news", categories: ["news"], license: undefined, altText: undefined });
  });
  it.each([
    ["application/pdf", "binned-pdf"],
    ["image/png", null],
  ])("does not offer an image-bin pointer for %s with id %s", async (type, duplicateAssetId) => {
    render(<MediaUploadForm defaultCategory="news" categories={categories} canUploadCategory={() => true}
      onCancel={() => {}} onDirtyChange={() => {}} onUploaded={() => {}}
      initialState={{ file: new File(["file"], "duplicate", { type }), license: "Owned" }}
      uploadMedia={vi.fn().mockRejectedValue(new HttpError(409, "Duplicate file", { duplicateAssetId }))} />);
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    expect(await screen.findByText("Duplicate file")).toBeVisible();
    expect(screen.queryByRole("link", { name: "Find it in the Recycle bin" })).not.toBeInTheDocument();
  });
  it("points a disclosed duplicate to its bin item and offers restoration", async () => {
    renderUploader({ canOpenRecycleBin: true, librarySearch: "q=harbor&category=news", uploadMedia: vi.fn().mockRejectedValue(new HttpError(409, "This file is already in the media library", { duplicateAssetId: "binned-image" })) });
    fireEvent.change(screen.getByLabelText(/Files/), { target: { files: [new File(["image"], "duplicate.png", { type: "image/png" })] } });
    fireEvent.change(screen.getByRole("textbox", { name: "Batch license default" }), { target: { value: "Owned" } });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    const pointer = await screen.findByRole("link", { name: "Find it in the Recycle bin" });
    expect(pointer).toHaveAttribute("href", "/media/images?q=harbor&category=news&bin=1&binAsset=binned-image");
    pointer.focus();
    expect(pointer).toHaveFocus();
    expect(screen.getByRole("alert")).toHaveTextContent("may be in the Recycle bin");
    fireEvent.change(screen.getByRole("textbox", { name: "Tags" }), { target: { value: "x".repeat(41) } });
    fireEvent.click(screen.getByRole("button", { name: "Retry upload" }));
    expect(await screen.findByText("Keep each tag under 41 characters.")).toBeVisible();
    expect(screen.queryByRole("link", { name: "Find it in the Recycle bin" })).not.toBeInTheDocument();
  });
  it.each([
    [false, "q=harbor"], [true, undefined], [false, undefined],
  ])("keeps duplicate guidance in place with bin access %s and library context %s", async (canOpenRecycleBin, librarySearch) => {
    renderUploader({ canOpenRecycleBin, librarySearch, uploadMedia: vi.fn().mockRejectedValue(new HttpError(409, "Duplicate file", { duplicateAssetId: "binned-image" })) });
    fireEvent.change(screen.getByLabelText(/Files/), { target: { files: [new File(["image"], "duplicate.png", { type: "image/png" })] } });
    fireEvent.change(screen.getByRole("textbox", { name: "Batch license default" }), { target: { value: "Owned" } });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    expect(await screen.findByText(canOpenRecycleBin
      ? "The matching image may be in the Recycle bin. Restore it from the Media library's Recycle bin."
      : "The matching image may be in the Recycle bin. Ask a media manager to restore it.")).toBeVisible();
    expect(screen.queryByRole("link", { name: "Find it in the Recycle bin" })).not.toBeInTheDocument();
  });
  it("adds files dropped on the upload area", () => {
    renderUploader();
    const dropArea = document.querySelector(".media-upload-file");
    expect(dropArea).not.toBeNull();
    const file = new File(["one"], "dropped.png", { type: "image/png" });

    fireEvent.dragOver(dropArea!, {
      dataTransfer: { files: [file], types: ["Files"] },
    });
    expect(dropArea).toHaveAttribute("data-dragging");
    fireEvent.drop(dropArea!, {
      dataTransfer: { files: [file], types: ["Files"] },
    });

    expect(screen.getByText("dropped.png")).toBeVisible();
    expect(dropArea).not.toHaveAttribute("data-dragging");
  });

  it("projects queue status and confirmed assets without moving upload ownership", async () => {
    const onQueueChange = vi.fn();
    renderUploader({ onQueueChange });
    fireEvent.change(screen.getByLabelText(/Files/), {
      target: { files: [new File(["one"], "projected.png", { type: "image/png" })] },
    });
    await waitFor(() => expect(onQueueChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ name: "projected.png", status: "pending", asset: null }),
    ]));

    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(onQueueChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ name: "projected.png", status: "succeeded", asset: expect.objectContaining({ id: "one" }) }),
    ]));
  });

  it("starts a fresh batch when files are added after every queued file succeeded", async () => {
    const onBatchComplete = vi.fn();
    const onDirtyChange = vi.fn();
    const uploadMedia = vi.fn(async (file: File) => ({
      success: true as const,
      asset: asset(file.name, file.name),
    }));
    renderUploader({ onBatchComplete, onDirtyChange, uploadMedia });
    const input = screen.getByLabelText(/Files/);
    fireEvent.change(screen.getByRole("textbox", { name: "Batch license default" }), {
      target: { value: "NJ PBS owned" },
    });
    fireEvent.change(input, {
      target: { files: [new File(["one"], "first.png", { type: "image/png" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(onBatchComplete).toHaveBeenCalledTimes(1));

    const dirtyCallsBeforeNextBatch = onDirtyChange.mock.calls.length;
    fireEvent.change(input, {
      target: { files: [new File(["two"], "second.png", { type: "image/png" })] },
    });
    expect(onDirtyChange.mock.calls.slice(dirtyCallsBeforeNextBatch)).toContainEqual([true]);
    expect(screen.queryByText("first.png")).not.toBeInTheDocument();
    expect(screen.getByText("second.png")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    await waitFor(() => expect(onBatchComplete).toHaveBeenCalledTimes(2));
    expect(onBatchComplete.mock.calls[1][0]).toMatchObject({
      succeeded: [expect.objectContaining({ id: "second.png" })],
      failed: [],
    });
  });

  it("shows only the shared license before file selection and tracks it as unsaved", async () => {
    const onDirtyChange = vi.fn();
    renderUploader({ onDirtyChange });

    expect(screen.queryByRole("textbox", { name: "License" })).toBeNull();
    const batchLicense = screen.getByRole("textbox", {
      name: "Batch license default",
    });
    fireEvent.change(batchLicense, { target: { value: "NJ PBS owned" } });
    await waitFor(() =>
      expect(onDirtyChange).toHaveBeenLastCalledWith(true),
    );

    fireEvent.change(batchLicense, { target: { value: "" } });
    await waitFor(() =>
      expect(onDirtyChange).toHaveBeenLastCalledWith(false),
    );
  });

  it("applies a batch license only to untouched and newly added files", () => {
    renderUploader();
    const first = new File(["one"], "first.png", { type: "image/png" });
    const second = new File(["two"], "second.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText(/Files/), {
      target: { files: [first, second] },
    });

    const batchLicense = screen.getByRole("textbox", {
      name: "Batch license default",
    });
    const fileLicense = screen.getByRole("textbox", { name: "License" });
    fireEvent.change(batchLicense, { target: { value: "NJ PBS owned" } });
    expect(fileLicense).toHaveValue("NJ PBS owned");
    expect(screen.getByText(/Using the batch license default/)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /2\. second\.png/ }));
    expect(fileLicense).toHaveValue("NJ PBS owned");
    fireEvent.change(fileLicense, { target: { value: "Partner license" } });
    expect(screen.getByText(/Custom license for this file/)).toBeVisible();

    fireEvent.change(batchLicense, { target: { value: "PBS distribution" } });
    expect(fileLicense).toHaveValue("Partner license");
    fireEvent.click(screen.getByRole("button", { name: /1\. first\.png/ }));
    expect(fileLicense).toHaveValue("PBS distribution");

    const third = new File(["three"], "third.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText(/Add files/), {
      target: { files: [third] },
    });
    expect(screen.getByText("File 3 of 3")).toBeVisible();
    expect(fileLicense).toHaveValue("PBS distribution");
    expect(screen.getByText(/Using the batch license default/)).toBeVisible();
  });

  it("warns about an empty license and still uploads the file", async () => {
    const { uploadMedia } = renderUploader();
    fireEvent.change(screen.getByLabelText(/Files/), {
      target: {
        files: [new File(["one"], "first.png", { type: "image/png" })],
      },
    });

    expect(screen.getByRole("textbox", { name: "License" })).not.toBeRequired();
    expect(screen.getByText("No license entered")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    await waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(1));
    expect(uploadMedia.mock.calls[0][1].license).toBeUndefined();
  });

  it("does not replace a completed file when the batch default changes", async () => {
    const firstAsset = asset("first", "First");
    const uploadMedia = vi.fn().mockResolvedValue({
      success: true,
      asset: firstAsset,
    });
    renderUploader({ uploadMedia });
    fireEvent.change(screen.getByLabelText(/Files/), {
      target: {
        files: [
          new File(["one"], "first.png", { type: "image/png" }),
          new File(["two"], "second.png", { type: "image/png" }),
        ],
      },
    });
    const batchLicense = screen.getByRole("textbox", {
      name: "Batch license default",
    });
    fireEvent.change(batchLicense, { target: { value: "Original license" } });
    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));

    expect(await screen.findByText("File 2 of 2")).toBeVisible();
    fireEvent.change(batchLicense, { target: { value: "Later license" } });
    fireEvent.click(screen.getByRole("button", { name: "Previous file" }));

    expect(screen.getByRole("textbox", { name: "License" })).toHaveValue(
      "Original license",
    );
    expect(uploadMedia.mock.calls[0][1]).toEqual(
      expect.objectContaining({ license: "Original license" }),
    );
  });

  it("keeps a failed file's unrelated error when the batch default changes", async () => {
    const uploadMedia = vi.fn().mockRejectedValue(new Error("Network failed."));
    renderUploader({ uploadMedia });
    fireEvent.change(screen.getByLabelText(/Files/), {
      target: {
        files: [new File(["one"], "first.png", { type: "image/png" })],
      },
    });
    const batchLicense = screen.getByRole("textbox", {
      name: "Batch license default",
    });
    fireEvent.change(batchLicense, { target: { value: "Original license" } });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    expect(await screen.findByText("Network failed.")).toBeVisible();
    fireEvent.change(batchLicense, { target: { value: "Later license" } });

    expect(screen.getByText("Network failed.")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "License" })).toHaveValue(
      "Later license",
    );
  });

  it("validates every selected file at intake and preserves per-file metadata", () => {
    renderUploader();
    const input = screen.getByLabelText(/Files/);
    expect(input).toHaveAttribute("multiple");
    const first = new File(["one"], "first.png", { type: "image/png" });
    const second = new File(["two"], "second.png", { type: "image/png" });
    const rejected = new File(["text"], "notes.txt", { type: "text/plain" });

    fireEvent.change(input, { target: { files: [first, second, rejected] } });

    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(
      screen.getByText(/Choose a JPEG, PNG, WebP, GIF, or AVIF file\./),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "First license" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Tags" }), {
      target: { value: "first, desk" },
    });
    fireEvent.click(screen.getByRole("button", { name: /2\. second\.png/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "Second license" },
    });
    fireEvent.click(screen.getByRole("button", { name: /1\. first\.png/ }));

    expect(screen.getByRole("textbox", { name: "License" })).toHaveValue(
      "First license",
    );
    expect(screen.getByRole("textbox", { name: "Tags" })).toHaveValue(
      "first, desk",
    );
  });

  it("lists an existing asset once when two files reuse it", async () => {
    const existing = asset("existing", "Existing");
    const uploadMedia = vi
      .fn()
      .mockResolvedValue({ success: true, asset: existing, reusedDuplicate: true });
    const onBatchComplete = vi.fn();
    renderUploader({ uploadMedia, onBatchComplete });
    fireEvent.change(screen.getByLabelText(/Files/), {
      target: {
        files: [
          new File(["same"], "copy-a.png", { type: "image/png" }),
          new File(["same"], "copy-b.png", { type: "image/png" }),
        ],
      },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "NJ PBS owned" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));
    expect(await screen.findByText("File 2 of 2")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "NJ PBS owned" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));

    await waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(onBatchComplete).toHaveBeenCalledWith({
        succeeded: [existing],
        failed: [],
        reused: [
          { fileName: "copy-a.png", asset: existing },
          { fileName: "copy-b.png", asset: existing },
        ],
      }),
    );
  });

  it("uploads one file at a time and completes after the final success", async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    const firstAsset = asset("first", "First");
    const secondAsset = asset("second", "Second");
    const uploadMedia = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({ success: true, asset: secondAsset });
    const onBatchComplete = vi.fn();
    renderUploader({ uploadMedia, onBatchComplete });
    const first = new File(["one"], "first.png", { type: "image/png" });
    const second = new File(["two"], "second.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText(/Files/), {
      target: { files: [first, second] },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "First license" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));

    await waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(1));
    fireEvent.submit(screen.getByRole("button", { name: /^.+: Uploading…$/ }).closest("form")!);
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    resolveFirst?.({ success: true, asset: firstAsset });

    expect(await screen.findByText("File 2 of 2")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "Second license" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));

    await waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(2));
    expect(uploadMedia.mock.calls[0][0]).toBe(first);
    expect(uploadMedia.mock.calls[1][0]).toBe(second);
    await waitFor(() =>
      expect(onBatchComplete).toHaveBeenCalledWith({
        succeeded: [firstAsset, secondAsset],
        failed: [],
      }),
    );
  });

  it("uploads a selected batch with one action and optional metadata", async () => {
    let resolveFirst!: (value: unknown) => void;
    const firstAsset = asset("first", "First");
    const secondAsset = asset("second", "Second");
    const uploadMedia = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolveFirst = resolve; }),
      )
      .mockResolvedValueOnce({ success: true, asset: secondAsset });
    const onBatchComplete = vi.fn();
    renderUploader({ uploadMedia, onBatchComplete });
    const first = new File(["one"], "first.png", { type: "image/png" });
    const second = new File(["two"], "second.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText(/Files/), {
      target: { files: [first, second] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next file" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Second title" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "Second license" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Upload all files" }));

    await waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(1));
    expect(uploadMedia.mock.calls[0][0]).toBe(first);
    expect(uploadMedia.mock.calls[0][1]).toMatchObject({
      name: undefined,
      description: undefined,
      altText: undefined,
      license: undefined,
      credit: undefined,
      tags: [],
    });
    resolveFirst({ success: true, asset: firstAsset });

    await waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(2));
    expect(uploadMedia.mock.calls[1][0]).toBe(second);
    expect(uploadMedia.mock.calls[1][1]).toMatchObject({
      name: "Second title",
      license: "Second license",
    });
    await waitFor(() => expect(onBatchComplete).toHaveBeenCalledWith({
      succeeded: [firstAsset, secondAsset],
      failed: [],
    }));
  });

  it("continues a selected batch after one file fails and keeps recovery open", async () => {
    const secondAsset = asset("second", "Second");
    const uploadMedia = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network failed."))
      .mockResolvedValueOnce({ success: true, asset: secondAsset });
    const onBatchComplete = vi.fn();
    renderUploader({ uploadMedia, onBatchComplete });
    fireEvent.change(screen.getByLabelText(/Files/), {
      target: {
        files: [
          new File(["one"], "first.png", { type: "image/png" }),
          new File(["two"], "second.png", { type: "image/png" }),
        ],
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Upload all files" }));

    await waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Network failed.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry upload" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Finish batch" })).toBeEnabled();
    expect(onBatchComplete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Finish batch" }));

    expect(onBatchComplete).toHaveBeenCalledWith({
      succeeded: [secondAsset],
      failed: [{ fileName: "first.png", message: "Network failed." }],
    });
  });

  it("stops a selected batch and keeps the remaining files", async () => {
    const onBatchComplete = vi.fn();
    const onQueueChange = vi.fn();
    const uploadMedia = vi.fn<MediaUploader>(
      async (_file, _metadata, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("The upload was canceled.")),
          { once: true },
        );
      }),
    );
    renderUploader({ onBatchComplete, onQueueChange, uploadMedia });
    fireEvent.change(screen.getByLabelText(/Files/), {
      target: {
        files: [
          new File(["one"], "first.png", { type: "image/png" }),
          new File(["two"], "second.png", { type: "image/png" }),
          new File(["three"], "third.png", { type: "image/png" }),
        ],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload all files" }));

    fireEvent.click(await screen.findByRole("button", { name: "Stop batch" }));

    await waitFor(() => expect(onQueueChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ name: "first.png", status: "failed" }),
      expect.objectContaining({ name: "second.png", status: "pending" }),
      expect.objectContaining({ name: "third.png", status: "pending" }),
    ]));
    expect(onBatchComplete).not.toHaveBeenCalled();
    expect(uploadMedia).toHaveBeenCalledTimes(1);
  });

  it("keeps pending files when the upload tray stops a batch", async () => {
    const uploadController = { current: null as AbortController | null };
    const onBatchComplete = vi.fn();
    const onQueueChange = vi.fn();
    const uploadMedia = vi.fn<MediaUploader>(
      async (_file, _metadata, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("The upload was canceled.")),
          { once: true },
        );
      }),
    );
    renderUploader({
      onBatchComplete,
      onQueueChange,
      uploadController,
      uploadMedia,
    });
    fireEvent.change(screen.getByLabelText(/Files/), {
      target: {
        files: [
          new File(["one"], "first.png", { type: "image/png" }),
          new File(["two"], "second.png", { type: "image/png" }),
          new File(["three"], "third.png", { type: "image/png" }),
        ],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload all files" }));
    await waitFor(() => expect(uploadController.current).not.toBeNull());

    uploadController.current?.abort();

    await waitFor(() => expect(onQueueChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ name: "first.png", status: "failed" }),
      expect.objectContaining({ name: "second.png", status: "pending" }),
      expect.objectContaining({ name: "third.png", status: "pending" }),
    ]));
    expect(onBatchComplete).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Upload all files" })).toBeEnabled();
  });

  it("keeps routed files that arrive during an active upload", async () => {
    let finishFirst!: (value: unknown) => void;
    const uploadMedia = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValue({ success: true, asset: asset("second", "Second") });
    const onBatchComplete = vi.fn();
    const form = (incomingFiles: readonly File[] | null) => <MediaUploadForm
      uploadScope="image"
      defaultCategory="news"
      categories={categories}
      canUploadCategory={() => true}
      incomingFiles={incomingFiles}
      onBatchComplete={onBatchComplete}
      onCancel={() => {}}
      onDirtyChange={() => {}}
      onUploaded={() => {}}
      uploadMedia={uploadMedia as MediaUploader}
    />;
    const view = render(form(null));
    fireEvent.change(screen.getByLabelText(/Files/), {
      target: { files: [new File(["first"], "first.png", { type: "image/png" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(1));

    view.rerender(form([new File(["second"], "second.png", { type: "image/png" })]));
    view.rerender(form([new File(["third"], "third.png", { type: "image/png" })]));
    expect(screen.getByText("2 files are waiting for the current upload to finish.")).toBeInTheDocument();
    finishFirst({ success: true, asset: asset("first", "First") });
    expect(await screen.findByRole("button", { name: /second\.png/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /third\.png/ })).toBeInTheDocument();
    expect(onBatchComplete).not.toHaveBeenCalled();
  });

  it.each([
    ["duplicate", "This file is already in station media."],
    [
      "recovery 503",
      "Upload recovery is still in progress. Retry with attempt attempt-1.",
    ],
    ["library-capacity 503", "The active media library is full."],
  ])("keeps a %s failure retryable while the batch continues", async (_case, failureMessage) => {
    const secondAsset = asset("second", "Second");
    const uploadMedia = vi
      .fn()
      .mockRejectedValueOnce(new Error(failureMessage))
      .mockResolvedValueOnce({ success: true, asset: secondAsset });
    const onBatchComplete = vi.fn();
    renderUploader({ uploadMedia, onBatchComplete });
    fireEvent.change(screen.getByLabelText(/Files/), {
      target: {
        files: [
          new File(["one"], "duplicate.png", { type: "image/png" }),
          new File(["two"], "fresh.png", { type: "image/png" }),
        ],
      },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "First license" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next file" }));
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "Second license" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Previous file" }));
    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));

    expect(
      await screen.findByText(failureMessage),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Continue with remaining files" }),
    );
    expect(screen.getByRole("textbox", { name: "License" })).toHaveValue(
      "Second license",
    );
    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));

    expect(await screen.findByText("File 1 of 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry upload" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Finish batch" }));
    expect(onBatchComplete).toHaveBeenCalledWith({
      succeeded: [secondAsset],
      failed: [
        {
          fileName: "duplicate.png",
          message: failureMessage,
        },
      ],
    });
  });

  it("removes a pending item without losing another file's metadata", () => {
    renderUploader();
    fireEvent.change(screen.getByLabelText(/Files/), {
      target: {
        files: [
          new File(["one"], "keep.png", { type: "image/png" }),
          new File(["two"], "remove.png", { type: "image/png" }),
        ],
      },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "Keep this" },
    });
    fireEvent.click(screen.getByRole("button", { name: /2\. remove\.png/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove file" }));

    expect(screen.queryByText("remove.png")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "License" })).toHaveValue(
      "Keep this",
    );
  });

  it("returns to clean after the only queued file is removed", async () => {
    const onDirtyChange = vi.fn();
    renderUploader({ onDirtyChange });
    fireEvent.change(screen.getByLabelText(/Files/), {
      target: {
        files: [
          new File(["one"], "remove.png", { type: "image/png" }),
        ],
      },
    });
    await waitFor(() =>
      expect(onDirtyChange).toHaveBeenLastCalledWith(true),
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove file" }));

    await waitFor(() =>
      expect(onDirtyChange).toHaveBeenLastCalledWith(false),
    );
    expect(screen.getByText("Choose one or more files to begin.")).toBeVisible();
  });

  it("bounds intake at 20 files and names every rejected overflow file", () => {
    renderUploader();
    const files = Array.from(
      { length: 21 },
      (_, index) =>
        new File([String(index)], `file-${index + 1}.png`, {
          type: "image/png",
        }),
    );
    fireEvent.change(screen.getByLabelText(/Files/), {
      target: { files },
    });

    expect(screen.getByText("file-21.png")).toBeInTheDocument();
    expect(
      screen.getByText("A batch can contain up to 20 files."),
    ).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Batch progress" })).toHaveAttribute(
      "max",
      "20",
    );
  });

  it("does not let an invalid selection consume an available queue slot", () => {
    renderUploader();
    const files = [
      new File(["text"], "invalid.txt", { type: "text/plain" }),
      ...Array.from(
        { length: 20 },
        (_, index) =>
          new File([String(index)], `valid-${index + 1}.png`, {
            type: "image/png",
          }),
      ),
    ];

    fireEvent.change(screen.getByLabelText(/Files/), {
      target: { files },
    });

    expect(screen.getByText("invalid.txt")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Batch progress" })).toHaveAttribute(
      "max",
      "20",
    );
    expect(screen.getByRole("button", { name: /20\. valid-20\.png/ })).toBeInTheDocument();
  });

  it("rejects server-invalid filenames before they consume queue slots", () => {
    renderUploader();
    const files = [
      new File(["valid"], "valid.png", { type: "image/png" }),
      new File(["slash"], "nested/path.png", { type: "image/png" }),
      new File(["control"], `bad${String.fromCharCode(31)}name.png`, {
        type: "image/png",
      }),
      new File(["long"], `${"a".repeat(252)}.png`, { type: "image/png" }),
    ];

    fireEvent.change(screen.getByLabelText(/Files/), {
      target: { files },
    });

    expect(
      screen.getAllByText(
        "Choose a filename without control characters, slashes, or backslashes.",
      ),
    ).toHaveLength(2);
    expect(
      screen.getByText("Choose a filename that is 255 characters or fewer."),
    ).toBeVisible();
    expect(
      screen.getByRole("progressbar", { name: "Batch progress" }),
    ).toHaveAttribute("max", "1");
    expect(
      screen.getByRole("button", { name: /1\. valid\.png/ }),
    ).toBeVisible();
  });

  it("stops only the active request and preserves completed assets and pending metadata", async () => {
    const firstAsset = asset("first", "First");
    const uploadMedia = vi
      .fn()
      .mockResolvedValueOnce({ success: true, asset: firstAsset })
      .mockImplementationOnce(
        async (_file, _metadata, signal: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new Error("The upload was canceled.")),
              { once: true },
            );
          }),
      );
    renderUploader({ uploadMedia });
    fireEvent.change(screen.getByLabelText(/Files/), {
      target: {
        files: [
          new File(["one"], "first.png", { type: "image/png" }),
          new File(["two"], "second.png", { type: "image/png" }),
          new File(["three"], "third.png", { type: "image/png" }),
        ],
      },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "First license" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next file" }));
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "Second license" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Next file" }));
    fireEvent.change(screen.getByRole("textbox", { name: "License" }), {
      target: { value: "Third license" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Tags" }), {
      target: { value: "preserved" },
    });
    fireEvent.click(screen.getByRole("button", { name: /1\. first\.png/ }));
    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));
    expect(await screen.findByText("File 2 of 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Upload file" }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop upload" }));

    expect(
      await screen.findByText("The upload was canceled."),
    ).toBeInTheDocument();
    expect(screen.getByText("Uploaded files are safe")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /3\. third\.png/ }));
    expect(screen.getByRole("textbox", { name: "License" })).toHaveValue(
      "Third license",
    );
    expect(screen.getByRole("textbox", { name: "Tags" })).toHaveValue(
      "preserved",
    );
  });
});
